/**
 * The canvas.
 *
 * React Flow / xyflow v12 handles pan, zoom and hit-testing; positions come
 * entirely from our own layout pass and node dragging is off. The rendered set
 * is at most `2|L| − 1` nodes — ten species is nineteen — so we are drawing
 * dozens of elements, not millions, which is what makes a DOM/SVG renderer the
 * right call here even though the source dataset is 2.4M leaves. Reaching for
 * WebGL because the *source* is large would be optimising the wrong number.
 *
 * The signature interaction lives here, and it is the product:
 *
 *   t=0    existing nodes begin spring reflow to their new positions
 *   t=80   the MRCA flares — the connection beat, and the subject
 *   t=120  the new traces draw from the MRCA *outward*, ~613ms ease-out,
 *          one wave of branches at a time and a wave every 96ms
 *   t=733  each decays from flare-bright to steady over ~1400ms
 *
 * Reflow and draw overlap. Sequential feels laggy; overlapping feels alive.
 * Siblings share a wave: two lineages that parted at the same node leave it
 * together, so a whole restored tree opens outward from its root rather than
 * unspooling along one route to one leaf.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
  type FossilTaxon,
  type PathNode,
  type TimescaleInterval,
} from "../api";
import {
  ageFrac,
  fracToAgeIn,
  layout,
  orthPath,
  PAD_X,
  PLOT_W,
  type AxisMode,
  type LabelText,
} from "../tree/layout";
import { dotRect, labelRect } from "../tree/labels";
import {
  cardReserve,
  fitContentPad,
  fitViewport,
  freeRect,
  revealShift,
  toScreenRect,
  union,
} from "./viewport";
import type { Induced } from "../tree/induced";
import type { AddDelta } from "../tree/induced";
import { isGraftIdx, type Graft } from "../tree/graft";
import { divergenceFor, markName, UNNAMED, type LabelMode } from "../tree/naming";
import {
  markAge,
  DIVERGENCE_META,
  isScientificItalic,
  metaLine,
  NodeMark,
  type MarkData,
} from "./NodeMark";
import { DECAY_MS, DRAW_MS, TraceEdge, type TraceEdgeData } from "./TraceEdge";
import { TimeAxis } from "./TimeAxis";
import { Legend, type TracePattern } from "./Legend";
import { DrillLane, useSegment, type Drill, type LaneEndpoint } from "./DrillLane";
import { laneHeight, laneRows } from "./lane";
import { mayDrawExemplar, witnessOn } from "./witness";
import { Water } from "./Water";
import type { Emitter } from "./biolum";
import { EMIT_BASE } from "./particles";
import { BiolumToggle } from "../chrome/BiolumToggle";
import { AgesToggle, LabelsToggle } from "../chrome/LabelModes";
import { prefersReduced } from "../chrome/motion";

const nodeTypes = { mark: NodeMark };
const edgeTypes = { trace: TraceEdge };

/**
 * Side of the square node box, in px. React Flow positions a node by its
 * top-left corner, so every position is offset by half of this to put the
 * node's *centre* — the dot, and therefore its position in time — exactly on
 * the coordinate the layout computed. See the `.mark` rules in styles.css.
 */
const NODE_BOX = 10;

/**
 * Breathing room around the content bounds, in layout px.
 *
 * This used to be four asymmetric label reserves, guessed from wherever labels
 * happened to be pinned. The placement pass now reports where every label
 * actually landed, so the fit frames measured content and only needs a margin.
 */
const EDGE_PAD = 26;

/**
 * Horizontal room the layout gives itself, before the fit scales it.
 *
 * This has to follow the container rather than being a constant. Node labels
 * live inside the transformed viewport, so they scale with zoom — and a fixed
 * 1240px layout squeezed into an 800px panel fits at ~0.45, which renders
 * 12.5px type at under 6px, which is a name nobody can read.
 *
 * Shrinking the *layout* instead keeps the fit near 1:1, so text stays at its
 * designed size. The graph gets narrower in a narrow panel, which is the honest
 * trade — and it matters more now than it did: the names no longer tier off
 * when the type gets small, so this is the only thing keeping them legible.
 */
const MIN_PLOT_W = 340;
/** The time axis is fixed to the bottom and would otherwise cover a lineage. */
const AXIS_RESERVE = 104;
const MAX_FIT_ZOOM = 1.4;

/**
 * Margin the reveal keeps between the subject and every edge it clears, and the
 * shortest it will ever wait before deciding there is anything to do.
 *
 * The wait is not a polish delay, and it is a *floor* rather than the whole
 * answer — `scheduleFit` raises it past any reframe already on its way. A
 * selection very often arrives together with something that moves the viewport
 * on its own: an add, a lane, the card's own reframe. A pan computed against a
 * transform that is still animating cancels that animation and lands somewhere
 * neither of them asked for.
 */
const REVEAL_PAD = 18;
const REVEAL_DELAY = 140;

/**
 * Per design-reference.md's signature sequence, in ms. `T_FLARE` and `T_DRAW`
 * are the lead-in beats — when the sequence starts — while the pace of the
 * drawing itself is `STAGGER` here plus `DRAW_MS` and `DECAY_MS` in
 * `TraceEdge`. Those three move together: stretching the draw without
 * stretching the gap between waves collapses the travel into a fade-in.
 */
const T_FLARE = 80;
const T_DRAW = 120;
const STAGGER = 96;

export interface GraphProps {
  induced: Induced;
  nodes: Map<number, PathNode>;
  delta: (AddDelta & { token: number }) | null;
  onDeltaPlayed: () => void;
  focusedIdx: number | null;
  onFocus: (idx: number | null) => void;
  isolate: boolean;
  axisMode: AxisMode;
  /** The axis footer is a switch as well as a label. */
  onAxisMode: (m: AxisMode) => void;
  /**
   * Which words the marks carry, and whether they print an age.
   *
   * Two switches rather than one, both view state, both in the URL. They land
   * on the canvas rather than the control bar for the reason `BiolumToggle`
   * states: the bottom edge holds the controls that change *how the canvas is
   * drawn*, and the top bar the ones that change *what is on it*.
   */
  labels: LabelMode;
  onLabels: (m: LabelMode) => void;
  ages: boolean;
  onAges: (v: boolean) => void;
  intervals: TimescaleInterval[] | null;
  fitSignal: { kind: "all" | "selection"; token: number } | null;
  /** Reports whether the canvas is already showing the fit. */
  onFitState?: (fit: boolean) => void;
  /**
   * A detail card is on screen, over the top-right of the canvas.
   *
   * The canvas cannot ask — the card is a sibling, `position: fixed`, and
   * measuring it from here would make the layout depend on the DOM it produces.
   * What it does with the answer is `canvas/viewport.ts`.
   */
  cardOpen: boolean;
  /** The segment whose drill-down lane is open. Lives in the URL. */
  drill: Drill | null;
  onDrill: (d: Drill | null) => void;
  /** A fossil row was clicked; the app opens its action menu. */
  onPickFossil: (f: FossilTaxon) => void;
  /** Fossils drawn against the tree. See `tree/graft.ts`. */
  grafts: readonly Graft[];
  /**
   * Hold the time axis out to at least this age. Null is the ordinary case.
   *
   * Set only while an opening is drawing itself in sequence, so that four adds
   * in five seconds do not rescale the axis four times. `tree/layout.ts` has
   * the argument, including why the pullback is left to the fit.
   */
  holdMaxAge?: number | null;
  /**
   * The optional light. See `canvas/biolum.ts` for what it does and, more to
   * the point, for what it is not allowed to do.
   */
  biolum: boolean;
  onBiolum: (v: boolean) => void;
}

function Inner(props: GraphProps) {
  const {
    induced: ind,
    nodes: nodeMap,
    delta,
    onDeltaPlayed,
    focusedIdx,
    onFocus,
    isolate,
    axisMode,
    onAxisMode,
    labels,
    onLabels,
    ages,
    onAges,
    intervals,
    fitSignal,
    onFitState,
    cardOpen,
    drill,
    onDrill,
    onPickFossil,
    grafts,
    holdMaxAge = null,
    biolum,
    onBiolum,
  } = props;

  const rf = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const tx = useStore((s) => s.transform[0]);
  const ty = useStore((s) => s.transform[1]);
  const vw = useStore((s) => s.width);
  const vh = useStore((s) => s.height);
  const reduced = useMemo(prefersReduced, []);
  const [flaring, setFlaring] = useState<number | null>(null);
  const playedToken = useRef<number | null>(null);

  /**
   * Whether the canvas is showing its own fit.
   *
   * The same answer `reportFit` sends the app, kept here as well because the
   * card reserve turns on it: reframing the tree is the right response to the
   * canvas getting smaller only while the frame is ours to move. A reader who
   * has zoomed into a corner and then clicks a mark to read about it has not
   * asked for the whole tree back.
   *
   * Starts true so the first card opened on a freshly fitted canvas reserves
   * rather than waiting for the first report.
   */
  const [atFit, setAtFit] = useState(true);

  /**
   * Whether the layout is currently arranged around an open card.
   *
   * State rather than a derived value, because it may **lag** what the card is
   * doing. Taking or releasing the reserve re-lays out the tree — the plot
   * width follows the free width — so it happens only at a moment when the
   * canvas is about to be reframed anyway. Off the fit, the card opens over a
   * canvas that does not move at all and {@link revealShift} does the work.
   *
   * A reserve left standing after its card closed is reconciled the next time
   * the reader returns to the fit, which costs an empty strip on the right and
   * never a jump under their hands.
   */
  const [reserved, setReserved] = useState(false);
  const wantReserve = cardReserve(vw, cardOpen) > 0;
  const reserve = reserved ? cardReserve(vw, true) : 0;

  useEffect(() => {
    if (reserved !== wantReserve && atFit) setReserved(wantReserve);
  }, [reserved, wantReserve, atFit]);

  // Reserve for the leaf labels that hang off the right edge, proportional in
  // a small panel and capped in a large one.
  // Leave roughly a third of the panel for labels, which hang off both sides
  // of the graph. The exact reserve no longer has to be right — the fit reads
  // the real bounds afterwards — but the plot must still shrink in a narrow
  // panel so the fit stays near 1:1 and text stays legible. An open card is a
  // narrow panel by another route, so it is subtracted here and nowhere else:
  // the layout is told how much canvas there is, not what is sitting on it.
  const plotWidth = vw
    ? Math.max(MIN_PLOT_W, Math.min(PLOT_W, (vw - reserve) * 0.62 - PAD_X))
    : PLOT_W;

  /**
   * What each label will say, handed to the layout so the placement pass can
   * measure the real strings. Keeping this next to the renderer is what stops
   * the two drifting — a label measured at one width and drawn at another
   * collides exactly as badly as no placement pass at all.
   *
   * It reads the two label switches, and that is safe in a way reading the
   * *zoom* was not. The old tiering had to be measured at its widest variant
   * whatever was showing, because the fit reads the placement's bounds and then
   * sets the zoom: letting placement depend on the zoom tier closes a loop —
   * layout → fit → zoom → tier → layout — and React Flow never finishes
   * measuring, leaving every node `visibility: hidden`. `labels` and `ages` are
   * outside that loop. They come from the reader, the layout recomputes once
   * when they change, and the fit that follows is the same reframe a window
   * resize takes.
   */
  const describeLabel: LabelText = useCallback(
    (p) => {
      const withSil =
        witnessOn(p) !== null || (mayDrawExemplar(p) && Boolean(p.node.phylopic_id));
      const div = divergenceFor(p.idx, ind, nodeMap, labels);
      // The same parts NodeMark renders, or the collision pass reserves a box
      // the label does not fit. A fossil range with its glyph is materially
      // wider than the age it stands in for.
      const age = ages
        ? markAge(p.node.age_ma, p.node.tier, p.node.occurrence)
        : null;
      const words = labels !== "off";
      return {
        name: words ? (markName(p.node, labels)?.text ?? div?.text ?? UNNAMED) : "",
        trailing: age?.text ?? "",
        trailingGlyph: age?.glyph != null,
        // A derived name says so where a rank would otherwise go. Without it
        // "Homo / Pan" sits in the same position as every real taxon name and
        // reads as one.
        meta: !words ? "" : div ? DIVERGENCE_META : metaLine(p.node.rank, true),
        hasSilhouette: withSil,
      };
    },
    [nodeMap, ind, labels, ages],
  );

  const lay = useMemo(
    () =>
      layout(ind, nodeMap, {
        plotWidth,
        label: describeLabel,
        axis: axisMode,
        grafts,
        holdMaxAge,
      }),
    [ind, nodeMap, plotWidth, describeLabel, axisMode, grafts, holdMaxAge],
  );

  /**
   * The open lane's segment, or null.
   *
   * Checked against the induced subtree rather than trusted: the URL carries
   * `seg`, and an add can promote a suppressed node to a rendered one and split
   * the very segment the link was made against. A lane for a segment the canvas
   * is not drawing would annotate a branch that is not there.
   */
  const activeDrill = useMemo(
    () =>
      drill && ind.segments.get(drill.lower)?.anc === drill.upper ? drill : null,
    [drill, ind],
  );

  const segment = useSegment(activeDrill);

  // The suppressed nodes are already in memory from the layout pass, so the
  // spine draws in the same frame as the click and only the fossils wait on
  // the round trip. The response's own copies are the fallback.
  const laneIntermediates = useMemo(() => {
    if (!activeDrill) return [];
    const byIdx = new Map(segment.data?.intermediates.map((n) => [n.idx, n]) ?? []);
    return (ind.segments.get(activeDrill.lower)?.suppressed ?? [])
      .map((i) => nodeMap.get(i) ?? byIdx.get(i))
      .filter((n): n is PathNode => n !== undefined);
  }, [activeDrill, ind, nodeMap, segment.data]);

  const laneRowsData = useMemo(
    () => laneRows(segment.data?.fossils ?? [], segment.data?.fossils_total ?? 0),
    [segment.data],
  );

  const laneH = activeDrill ? laneHeight(laneRowsData) : 0;

  // The lineage from the focused node to the induced root. `⌘\` isolates it;
  // otherwise it is what "selected path burns bright" is measured against.
  const focusLineage = useMemo(() => {
    const out = new Set<number>();
    let cur: number | null = focusedIdx;
    // A focused graft has no ancestry of its own — it is not in the topology.
    // Its lineage is the branch it hangs on, so the walk starts at the anchor
    // and the fossil rides along. Without this the set is the graft alone and
    // focusing one dims the entire tree it is annotating.
    if (cur !== null && isGraftIdx(cur)) {
      out.add(cur);
      cur = grafts.find((g) => g.idx === cur)?.anchor ?? null;
    }
    while (cur !== null && cur !== undefined) {
      out.add(cur);
      cur = ind.segments.get(cur)?.anc ?? null;
    }
    return out;
  }, [focusedIdx, ind, grafts]);

  // Bloom is the first thing to go when frames are tight, and dropping to flat
  // strokes at low zoom is the documented acceptable answer.
  const bloomOff = zoom < 0.5;

  /**
   * Which marks are leaking light into the water, and how much.
   *
   * The whole of bioluminescence's claim to be legal under "the data is the
   * light source" rests on this list: the particle field has no emitters of its
   * own, so with nothing on the canvas the water is genuinely black. Positions
   * are the layout's, so the light drifts in the same space the branches
   * occupy and pan and zoom carry both together.
   *
   * The rate ladder is **the selection channel**, which is the one thing
   * luminance is already allowed to encode: a species the reader chose and the
   * common ancestor they came for shed more light than an intermediate
   * divergence. That is the same statement the corona and the label brightness
   * already make, said a third way, rather than a new channel carrying a new
   * fact. It is deliberately *not* keyed to age, tier or tip count — those are
   * data values, and a mark that glittered harder because a clade was large
   * would be exactly the failure this mode is written to avoid.
   *
   * Recomputed with the layout, and cheap: it is at most `2|L| − 1` entries.
   */
  const emitters: Emitter[] = useMemo(() => {
    if (!biolum) return [];
    return [...lay.placed.values()].map((p) => ({
      x: p.x,
      y: p.y,
      hue: p.hue,
      rate: EMIT_BASE * (p.isMRCA ? 1.9 : p.isLeaf ? 1.5 : 1),
    }));
  }, [lay, biolum]);

  /**
   * Counter-scale for silhouettes as the canvas shrinks.
   *
   * Images live in the transformed viewport, so pulling back shrinks them with
   * everything else — and they are the one element that is *more* useful when
   * pulled back, because a shape survives at sizes where a name does not.
   *
   * The cap is not timidity. Lanes are `ROW_H` apart in layout space and the
   * icon is 34 of that, so anything past ~2x has neighbouring rows colliding;
   * and at the minimum zoom the whole tree is a few hundred pixels tall, which
   * bounds how much any icon can say regardless of policy. 1.6x is what fits
   * without collisions, and it is worth roughly +60% at the zoom levels people
   * actually use to see a whole tree. A transform, so it costs no relayout and
   * cannot move the text it sits beside.
   */
  const iconScale = Math.min(1.6, Math.max(1, 1 / Math.max(zoom, 0.05)));

  const drawDelay = useMemo(() => {
    const m = new Map<number, number>();
    if (!delta) return m;
    // Root-ward → leaf-ward, lightly staggered. All-at-once reads as a
    // fade-in; staggered reads as travel. The stagger is per *wave*, so
    // sibling branches leave their shared ancestor together rather than the
    // tree unspooling along one route.
    delta.drawOrder.forEach((wave, i) => {
      for (const v of wave) m.set(v, T_DRAW + i * STAGGER);
    });
    return m;
  }, [delta]);

  // Fire the flare at t=80 and hand the delta back once the whole sequence
  // has had time to run, so a rapid second add interrupts cleanly rather than
  // queueing.
  useEffect(() => {
    if (!delta || playedToken.current === delta.token) return;
    playedToken.current = delta.token;
    const flareAt = window.setTimeout(
      () => setFlaring(delta.flare),
      reduced ? 0 : T_FLARE,
    );
    const clearAt = window.setTimeout(
      () => {
        setFlaring(null);
        onDeltaPlayed();
      },
      // The last wave starts latest and still has to draw and then settle, so
      // the tail is both durations plus a frame or two of slack.
      reduced ? 60 : T_DRAW + delta.drawOrder.length * STAGGER + DRAW_MS + DECAY_MS + 100,
    );
    return () => {
      window.clearTimeout(flareAt);
      window.clearTimeout(clearAt);
    };
  }, [delta, onDeltaPlayed, reduced]);

  const rfNodes: Node[] = useMemo(
    () =>
      [...lay.placed.values()].map((p) => {
        const dim =
          (isolate && !focusLineage.has(p.idx)) ||
          (!isolate && focusedIdx !== null && !focusLineage.has(p.idx));
        // The clade travels on the node itself, deliberately. The drawing's
        // own node is usually a *cousin* and so is not in the induced subtree
        // at all — looking it up in `nodeMap` returned undefined and silently
        // dropped the caption in exactly the cases that most need one.
        const showSilhouette = mayDrawExemplar(p);
        const data: MarkData = {
          node: p.node,
          hue: p.hue,
          isLeaf: p.isLeaf,
          isMRCA: p.isMRCA,
          dim,
          focused: focusedIdx === p.idx,
          flaring: flaring === p.idx,
          labels,
          ages,
          label: lay.labels.get(p.idx),
          divergence: divergenceFor(p.idx, ind, nodeMap, labels),
          showSilhouette,
          // A fossil drawn against the tree rather than a node in it. The mark
          // renders the same way — it is an occurrence-tier node carrying its
          // own picture — but the caption has to state how firmly it is placed,
          // and only the graft knows that.
          graft: p.graft ?? null,
          witness: witnessOn(p),
          // Only worth saying when the picture is not a portrait. "Silhouette
          // of Homo sapiens" on Homo sapiens is noise.
          // Layout coordinates, so a hovered mark knows where in the water to
          // puff. Nothing else on a mark needs them — React Flow does the
          // positioning — and nothing else may read them for layout.
          x: p.x,
          y: p.y,
          biolum,
          silhouetteClade:
            showSilhouette && p.node.silhouette_source_idx !== p.idx
              ? {
                  name: p.node.silhouette_clade_name ?? null,
                  tips: p.node.silhouette_clade_tips ?? null,
                }
              : null,
        };
        return {
          id: String(p.idx),
          type: "mark",
          position: { x: p.x - NODE_BOX / 2, y: p.y - NODE_BOX / 2 },
          data: data as unknown as Record<string, unknown>,
          draggable: false,
          selectable: true,
          connectable: false,
          // Declared, not measured. React Flow is fully controlled here, so the
          // `nodes` array we hand it every render replaces its store — and with
          // it any dimensions its ResizeObserver had recorded. A node it
          // believes has no size is rendered `visibility: hidden`, which is how
          // the entire graph silently disappeared while every element sat at
          // the right coordinates in the DOM. The box is a fixed 10px square by
          // design, so telling it the size outright removes the measurement
          // round-trip and the race with it.
          width: NODE_BOX,
          height: NODE_BOX,
        };
      }),
    [lay, focusedIdx, focusLineage, isolate, flaring, labels, ages, nodeMap, ind, biolum],
  );

  const rfEdges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const [v, seg] of ind.segments) {
      if (seg.anc === null) continue;
      const a = lay.placed.get(seg.anc);
      const b = lay.placed.get(v);
      if (!a || !b) continue;

      // A structural node with nothing dated below it is bracketed on one side
      // only — its position is a guess toward the present rather than an
      // interpolation between two known ages. It says so by fading out.
      const unbounded =
        b.node.tier === TIER_STRUCTURAL &&
        !hasDatedDescendant(v, ind, nodeMap);

      const dim =
        (isolate && !(focusLineage.has(v) && focusLineage.has(seg.anc))) ||
        (!isolate && focusedIdx !== null && !focusLineage.has(v));

      const data: TraceEdgeData = {
        d: orthPath(a.x, a.y, b.x, b.y),
        hue: b.hue,
        tier: b.node.tier,
        dim,
        unbounded,
        drilled: activeDrill?.upper === seg.anc && activeDrill.lower === v,
        attachment: false,
        drawToken: drawDelay.has(v) ? (delta?.token ?? null) : null,
        delay: drawDelay.get(v) ?? 0,
        reduced,
        biolum,
      };
      out.push({
        id: `${seg.anc}-${v}`,
        source: String(seg.anc),
        target: String(v),
        type: "trace",
        data: data as unknown as Record<string, unknown>,
      });
    }

    // A graft's connector. It leaves the lineage at the fossil's own first
    // appearance and arrives at its last, so the vertical drop is the
    // unresolved attachment and the horizontal run is the observed extent.
    for (const l of lay.graftLinks) {
      const anchor = lay.placed.get(l.graft.anchor);
      const data: TraceEdgeData = {
        d: orthPath(l.joinX, l.joinY, l.x, l.y),
        hue: anchor?.hue ?? 200,
        // Occurrence, matching the fossil itself: nobody has dated this, and
        // the dash channel answers exactly that question.
        tier: TIER_OCCURRENCE,
        dim:
          (isolate && !focusLineage.has(l.graft.anchor)) ||
          (!isolate && focusedIdx !== null && focusedIdx !== l.idx &&
            !focusLineage.has(l.graft.anchor)),
        unbounded: false,
        drilled: false,
        attachment: true,
        drawToken: null,
        delay: 0,
        reduced,
        biolum,
      };
      out.push({
        id: `graft-${l.idx}`,
        source: String(l.graft.anchor),
        target: String(l.idx),
        type: "trace",
        data: data as unknown as Record<string, unknown>,
      });
    }
    return out;
  }, [
    ind,
    lay,
    focusedIdx,
    focusLineage,
    isolate,
    drawDelay,
    delta,
    reduced,
    nodeMap,
    activeDrill,
    biolum,
  ]);

  // The legend reads the edges that were actually built rather than
  // recomputing which tiers are on screen. Anything else is a second copy of
  // the `unbounded` rule waiting to disagree with this one.
  const patterns: TracePattern[] = useMemo(
    () =>
      rfEdges.map((e) => {
        const d = e.data as unknown as TraceEdgeData;
        return { tier: d.tier, unbounded: d.unbounded, attachment: d.attachment };
      }),
    [rfEdges],
  );

  /**
   * Fit the *content*, not the nodes.
   *
   * React Flow's `fitView` frames node boxes, and our node box is a 10px dot —
   * so it happily fits a tree whose leaf labels run 260px off the right edge
   * and whose root name is cut in half by the left one. Padding cannot fix
   * that: the overflow is asymmetric and measured in pixels, while padding is
   * a symmetric fraction of the viewport.
   *
   * So compute the transform directly from the layout bounds plus the space
   * labels are known to need. Same principle as everything else here —
   * positions are computed, never guessed at by a solver.
   */
  const fitTarget = useCallback((): Viewport | null => {
    const c = lay.content;
    if (!c || !vw || !vh) return null;
    return fitViewport({
      // The bounds already include every placed label, so the fit frames what
      // is actually drawn rather than the dots plus a guessed margin.
      content: fitContentPad(c, EDGE_PAD),
      vw,
      vh,
      // The card owns a strip on the right, and the axis owns one at the
      // bottom that an open drill-down lane makes taller. Fitting into the
      // whole container would slide content under all three.
      reserve,
      bottom: AXIS_RESERVE + laneH,
      maxZoom: MAX_FIT_ZOOM,
    });
  }, [lay, vw, vh, laneH, reserve]);

  /**
   * When the last fit animation is expected to have landed, as a timestamp.
   *
   * The reveal below reads the live transform, so it must not read one that is
   * still moving — a pan computed from a half-finished fit both cancels the fit
   * and lands somewhere neither of them asked for.
   */
  const fitUntil = useRef(0);

  const fitToContent = useCallback(
    (duration: number) => {
      const t = fitTarget();
      if (!t) return;
      rf.setViewport(t, { duration });
      fitUntil.current = Date.now() + duration;
      // About to be, and said now rather than 480ms from now: the reserve is
      // reconciled off this, and a reader who opens a card immediately after an
      // add should get the reframe rather than the deferred path.
      setAtFit(true);
    },
    [fitTarget, rf],
  );

  /**
   * Fit after `delay`, and record *now* when it will have landed.
   *
   * Recording it at scheduling time is the whole point. Every automatic reframe
   * here waits a beat before it starts — for a draw to read, for a lane to reach
   * its real height — and the reveal below computes its own wait from
   * `fitUntil`. Set only when the fit *starts*, that timestamp is still in the
   * past during the delay, so the reveal took its 140ms floor, fired partway
   * into the animation, read a transform that was still moving and panned from
   * wherever it had got to. The reframe stopped a few tens of pixels short of
   * its target — which is exactly enough to leave the last label under the card.
   *
   * **It must not close over `fitToContent`, and that is not a style
   * preference.** Every caller below arms this on a change to the one thing it
   * watches and clears it on cleanup, then guards its body on that same thing —
   * so an effect re-run for any *other* reason clears the pending timer and
   * returns early without re-arming it. `fitToContent` is rebuilt whenever the
   * layout is, so a `useCallback` depending on it makes every one of those
   * effects re-run on a layout change, and a layout change inside the delay
   * then silently cancels the reframe it scheduled.
   *
   * That is latent until something changes the layout in the two or three
   * hundred milliseconds after an add. An opening drawn in sequence does
   * exactly that: the sequence ends on the frame its last taxon lands,
   * `holdMaxAge` is released with it, and the layout that moves underneath is
   * the one whose fit is 260ms out. The whole tree stayed at the zoom the last
   * species was framed at, with every divergence off the left edge.
   *
   * So the live fit is reached through a ref and this callback is built once.
   * Firing through the *latest* fit is what was wanted anyway: a reframe should
   * frame the layout as it is when it runs, not as it was when it was booked.
   */
  const fitNow = useRef(fitToContent);
  useEffect(() => {
    fitNow.current = fitToContent;
  }, [fitToContent]);

  const scheduleFit = useCallback((delay: number, duration: number) => {
    fitUntil.current = Date.now() + delay + duration;
    const t = window.setTimeout(() => fitNow.current(duration), delay);
    return () => window.clearTimeout(t);
  }, []);

  /**
   * Tell the app whether the canvas is already showing the fit.
   *
   * Asked of the viewport rather than remembered, because "have we fitted?" is
   * the wrong question — the tree reframes itself on an add and on a lane
   * opening, the target moves when the window resizes, and a flag set at the
   * last `fitToContent` would be stale after any of those. Comparing the live
   * transform against the target it would be given answers it in every case.
   *
   * On `onMoveEnd` and on layout change only, never per frame: React Flow pans
   * by transform without re-rendering subscribers, and taking a viewport
   * subscription here to keep a palette row up to date would trade a smooth
   * drag for it. The palette is opened between gestures, not during one.
   */
  const reportFit = useCallback(() => {
    const t = fitTarget();
    if (!t) {
      // Nothing drawn is not a view worth protecting, so the reserve may still
      // take effect — but there is no fit to offer the reader either.
      onFitState?.(false);
      return;
    }
    const v = rf.getViewport();
    // A whole pixel of pan and a half percent of zoom are both invisible, and
    // the animated fit lands a hair off its own target often enough that an
    // exact test would report "not fit" immediately after fitting.
    const fit =
      Math.abs(v.x - t.x) < 1.5 &&
      Math.abs(v.y - t.y) < 1.5 &&
      Math.abs(v.zoom - t.zoom) < t.zoom * 0.005;
    setAtFit(fit);
    onFitState?.(fit);
  }, [onFitState, fitTarget, rf]);

  // The target moves when the layout, the viewport size or the lane does, so
  // re-answer then as well as after a gesture. Deferred a frame because an
  // in-flight fit animation is still running when these change.
  useEffect(() => {
    const t = window.setTimeout(reportFit, 480);
    return () => window.clearTimeout(t);
  }, [reportFit, fitSignal]);

  // Opening or closing the lane changes how much canvas there is, so the tree
  // reframes into what is left rather than sliding underneath it. Keyed on the
  // *height* and not merely on whether a lane is open: the strip is one row
  // tall until the fossils land and its final height a moment later, and
  // fitting only to the first of those leaves the lowest lineage covered by
  // the rows that arrive after it.
  const lastLaneH = useRef(laneH);
  useEffect(() => {
    if (lastLaneH.current === laneH) return;
    lastLaneH.current = laneH;
    return scheduleFit(30, reduced ? 0 : 380);
  }, [laneH, scheduleFit, reduced]);

  // And the card, for exactly the reason above: it is the same event on the
  // other axis. Taking the reserve has already narrowed the plot by the time
  // this runs, so the fit is being asked to frame a tree that is genuinely a
  // different shape, not the old one pushed left.
  const lastReserved = useRef(reserved);
  useEffect(() => {
    if (lastReserved.current === reserved) return;
    lastReserved.current = reserved;
    return scheduleFit(30, reduced ? 0 : 380);
  }, [reserved, scheduleFit, reduced]);

  useEffect(() => {
    if (!fitSignal) return;
    if (fitSignal.kind === "selection" && focusedIdx !== null) {
      rf.fitView({
        duration: reduced ? 0 : 420,
        padding: 0.35,
        nodes: [{ id: String(focusedIdx) }],
        maxZoom: 1.6,
      });
      return;
    }
    fitToContent(reduced ? 0 : 420);
  }, [fitSignal, rf, focusedIdx, reduced, fitToContent]);

  // Fit whenever the rendered set changes size, so an add never leaves the new
  // lineage off-screen — but only after the draw has had time to read.
  const lastCount = useRef(0);
  useEffect(() => {
    if (ind.rendered.length === lastCount.current) return;
    const first = lastCount.current === 0;
    lastCount.current = ind.rendered.length;
    return scheduleFit(first ? 0 : 260, reduced || first ? 0 : 520);
  }, [ind.rendered.length, scheduleFit, reduced]);

  // Switching scales moves every node in x, and by a lot — the point of linear
  // is that it collapses the recent past against the present. Reframing is what
  // makes that legible as a change rather than as the tree wandering off-screen.
  const lastAxis = useRef(axisMode);
  useEffect(() => {
    if (lastAxis.current === axisMode) return;
    lastAxis.current = axisMode;
    return scheduleFit(20, reduced ? 0 : 420);
  }, [axisMode, scheduleFit, reduced]);

  /**
   * The floor under all of it: whatever else happened, the thing the card is
   * about is on screen and not underneath the card.
   *
   * Runs on the subject and on the card's footprint, never on the live
   * transform — a reader who deliberately drags a mark under the card is
   * panning, and a viewport that pans back is a viewport fighting its own
   * reader. So this fires when the *selection* changes, or when the card
   * appears or goes, and is otherwise silent.
   *
   * The subject is the mark **and its label**, because a dot on the seam with
   * its name printed underneath the card is not visible in any sense a reader
   * would recognise. Where the two together are wider than the free strip, the
   * shift centres them rather than picking an edge — see `revealShift`.
   *
   * Deliberately last: it reads the settled transform, so if the reframe above
   * has already brought the subject into the clear there is nothing to do and
   * nothing happens.
   */
  useEffect(() => {
    if (focusedIdx === null || !vw || !vh) return;
    const p = lay.placed.get(focusedIdx);
    if (!p) return;
    const box = lay.labels.get(focusedIdx);
    const dot = dotRect(p.x, p.y);
    const subject = box ? union(dot, labelRect(p.x, p.y, box)) : dot;
    const wait = Math.max(REVEAL_DELAY, fitUntil.current - Date.now() + 60);
    const t = window.setTimeout(() => {
      const v = rf.getViewport();
      const { dx, dy } = revealShift(
        toScreenRect(subject, v),
        freeRect({
          vw,
          vh,
          bottom: AXIS_RESERVE + laneH,
          cardOpen,
          pad: REVEAL_PAD,
        }),
      );
      if (dx === 0 && dy === 0) return;
      rf.setViewport(
        { x: v.x + dx, y: v.y + dy, zoom: v.zoom },
        { duration: reduced ? 0 : 320 },
      );
    }, wait);
    return () => window.clearTimeout(t);
  }, [focusedIdx, cardOpen, lay, vw, vh, laneH, rf, reduced]);

  const toScreenX = useCallback(
    (age: number) =>
      (PAD_X + plotWidth * (1 - ageFrac(age, lay.maxAge, axisMode))) * zoom + tx,
    [lay.maxAge, zoom, tx, plotWidth, axisMode],
  );

  /**
   * The inverse, so the axis can ask what is under the viewport rather than
   * assume it is showing the whole tree. Without it the ticks are a fixed set
   * generated from `maxAge` and every one of them leaves the screen on the
   * first zoom.
   */
  const toAge = useCallback(
    (x: number) =>
      fracToAgeIn(
        1 - ((x - tx) / zoom - PAD_X) / plotWidth,
        lay.maxAge,
        axisMode,
      ),
    [lay.maxAge, zoom, tx, plotWidth, axisMode],
  );

  const onNodeClick = useCallback(
    (_: unknown, n: Node) => onFocus(Number(n.id)),
    [onFocus],
  );

  /**
   * Clicking a segment opens it; clicking the open one closes it.
   *
   * The mouse path for interaction 3. It is a convenience, never the only way
   * in — the same toggle is a contextual command in the palette, and `esc`
   * closes the lane the way it closes everything else.
   */
  const onEdgeClick = useCallback(
    (_: unknown, e: Edge) => {
      // A graft's connector is not a segment — there is no chain of suppressed
      // nodes between its ends to open. It has no hit target either, so this is
      // the belt to that brace rather than the only guard.
      if (e.id.startsWith("graft-")) return;
      const upper = Number(e.source);
      const lower = Number(e.target);
      const open = drill?.upper === upper && drill.lower === lower;
      onDrill(open ? null : { upper, lower });
    },
    [drill, onDrill],
  );

  return (
    <div
      className={`canvas${bloomOff ? " bloom-off" : ""}${biolum ? " biolum" : ""}`}
      style={
        {
          "--icon-scale": iconScale,
          // The bioluminescence switch sits above the axis, and an open lane
          // stacks on top of the axis — so the one number that says how far up
          // it has to start is `laneH`, which only this component knows.
          "--lane-h": `${laneH}px`,
        } as React.CSSProperties
      }
    >
      {/*
        The water, behind everything and holding only what the tree has spilled
        into it. A real element rather than a pseudo on `.canvas`: `::before` is
        already the grid, and `::after` paints *above* the element's real
        children, which would put the particles in front of the names.
      */}
      <Water
        tx={tx}
        ty={ty}
        zoom={zoom}
        emitters={emitters}
        active={biolum}
        reduced={reduced}
      />
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => onFocus(null)}
        onMoveEnd={reportFit}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnScroll
        selectionOnDrag={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.12}
        maxZoom={3}
        defaultEdgeOptions={{ type: "trace" }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={56}
          size={1}
          color={biolum ? "rgba(90,220,235,0.13)" : "rgba(120,190,200,0.07)"}
        />
      </ReactFlow>
      {/*
        The three canvas-mode chips, stacked bottom-left above the axis.

        One stack, because they are one set: controls that change how the canvas
        is *drawn* rather than what is on it. The reading order is the reader's
        — the words first, then the figure that annotates them, then the light —
        so the two that change what a label says sit above the one that changes
        nothing about the data at all.
      */}
      <div className="canvas-modes">
        <LabelsToggle mode={labels} onChange={onLabels} />
        <AgesToggle on={ages} onChange={onAges} />
        <BiolumToggle on={biolum} onChange={onBiolum} />
      </div>
      {activeDrill && (
        <DrillLane
          upper={endpoint(activeDrill.upper, ind, nodeMap)}
          lower={endpoint(activeDrill.lower, ind, nodeMap)}
          intermediates={laneIntermediates}
          rows={laneRowsData}
          segment={segment}
          available={segment.data?.fossils_available ?? true}
          toScreenX={toScreenX}
          width={vw || window.innerWidth}
          onClose={() => onDrill(null)}
          onPick={onPickFossil}
        />
      )}
      <TimeAxis
        maxAge={lay.maxAge}
        width={vw || window.innerWidth}
        toScreenX={toScreenX}
        toAge={toAge}
        intervals={intervals}
        axisMode={axisMode}
        onAxisMode={onAxisMode}
        legend={<Legend edges={patterns} />}
      />
    </div>
  );
}

/**
 * How the lane names one end of the segment it is annotating.
 *
 * Through `divergenceFor`, so a node the taxonomy never named reads the same
 * in the lane's title as it does on the canvas — "Homo / Pan" in both places,
 * rather than a name above and a placeholder below.
 */
function endpoint(
  idx: number,
  ind: Induced,
  nodeMap: Map<number, PathNode>,
): LaneEndpoint {
  const n = nodeMap.get(idx);
  const div = divergenceFor(idx, ind, nodeMap);
  return {
    name: n?.name ?? div?.text ?? UNNAMED,
    italic: !div && isScientificItalic(n?.rank ?? null),
    age: n?.age_layout ?? 0,
  };
}

/** Does anything at or below `v` in the rendered subtree carry a real age? */
function hasDatedDescendant(
  v: number,
  ind: Induced,
  nodeMap: Map<number, PathNode>,
): boolean {
  for (const [child, seg] of ind.segments) {
    if (seg.anc !== v) continue;
    const n = nodeMap.get(child);
    if (n && n.tier !== TIER_STRUCTURAL) return true;
    if (hasDatedDescendant(child, ind, nodeMap)) return true;
  }
  return false;
}

export function Graph(props: GraphProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
