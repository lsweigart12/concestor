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
import type { Induced } from "../tree/induced";
import type { AddDelta } from "../tree/induced";
import { isGraftIdx, type Graft } from "../tree/graft";
import { divergenceFor, UNNAMED } from "../tree/naming";
import {
  markAge,
  DIVERGENCE_META,
  isScientificItalic,
  metaLine,
  NodeMark,
  type MarkData,
  type ZoomTier,
} from "./NodeMark";
import { DECAY_MS, DRAW_MS, TraceEdge, type TraceEdgeData } from "./TraceEdge";
import { TimeAxis } from "./TimeAxis";
import { Legend, type TracePattern } from "./Legend";
import { DrillLane, useSegment, type Drill, type LaneEndpoint } from "./DrillLane";
import { laneHeight, laneRows } from "./lane";
import { mayDrawExemplar, witnessOn } from "./witness";

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
 * 12.5px type at under 6px. Semantic zoom would then correctly drop to the
 * point tier and the tree would lose every name it has.
 *
 * Shrinking the *layout* instead keeps the fit near 1:1, so text stays at its
 * designed size and the tiers mean what they say. The graph gets narrower in a
 * narrow panel, which is the honest trade.
 */
const MIN_PLOT_W = 340;
/** The time axis is fixed to the bottom and would otherwise cover a lineage. */
const AXIS_RESERVE = 104;
const MAX_FIT_ZOOM = 1.4;

/**
 * The two semantic-zoom thresholds, in scale factors.
 *
 * `Z_LABEL` is a legibility floor: below it the name renders under 7px and the
 * silhouette is the only thing left carrying meaning, which is the trade the
 * header of `NodeMark.tsx` describes.
 *
 * `Z_DETAIL` is where the age row joins it, and it sat at **1.15** — above the
 * 1.144 the fit lands at for six species, so the figure was absent from the
 * default view and for almost the whole band in which a label is drawn at all.
 * The tiering rule stands (the age is last on, because x is time and there is a
 * ruler under it) but it was being applied as if the ruler answered the same
 * question, and it does not: the axis gives a node's *position*, and only the
 * row gives its number and its tier. So the age now arrives a hair after the
 * name rather than half a zoom range later, and the gap between the two is what
 * is left of the rule.
 *
 * They cannot be equal. The age is set at 11px against the name's 12.5, so the
 * band exists to spend the smaller row first — and a reader who wants figures
 * below `Z_LABEL` is asking for text at 6px, which is a different request.
 */
const Z_LABEL = 0.55;
const Z_DETAIL = 0.62;

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
  intervals: TimescaleInterval[] | null;
  fitSignal: { kind: "all" | "selection"; token: number } | null;
  /** Reports whether the canvas is already showing the fit. */
  onFitState?: (fit: boolean) => void;
  /** The segment whose drill-down lane is open. Lives in the URL. */
  drill: Drill | null;
  onDrill: (d: Drill | null) => void;
  /** A fossil row was clicked; the app opens its action menu. */
  onPickFossil: (f: FossilTaxon) => void;
  /** Fossils drawn against the tree. See `tree/graft.ts`. */
  grafts: readonly Graft[];
}

const prefersReduced = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

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
    intervals,
    fitSignal,
    onFitState,
    drill,
    onDrill,
    onPickFossil,
    grafts,
  } = props;

  const rf = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const tx = useStore((s) => s.transform[0]);
  const vw = useStore((s) => s.width);
  const vh = useStore((s) => s.height);
  const reduced = useMemo(prefersReduced, []);
  const [flaring, setFlaring] = useState<number | null>(null);
  const playedToken = useRef<number | null>(null);

  // Reserve for the leaf labels that hang off the right edge, proportional in
  // a small panel and capped in a large one.
  // Leave roughly a third of the panel for labels, which hang off both sides
  // of the graph. The exact reserve no longer has to be right — the fit reads
  // the real bounds afterwards — but the plot must still shrink in a narrow
  // panel so the fit stays near 1:1 and text stays legible.
  const plotWidth = vw
    ? Math.max(MIN_PLOT_W, Math.min(PLOT_W, vw * 0.62 - PAD_X))
    : PLOT_W;

  /**
   * Semantic zoom tiers. Nodes change what they render, not just their size.
   */
  const zoomTier: ZoomTier =
    zoom < Z_LABEL ? "point" : zoom < Z_DETAIL ? "label" : "detail";

  /**
   * What each label will say, handed to the layout so the placement pass can
   * measure the real strings. Keeping this next to the renderer is what stops
   * the two drifting — a label measured at one width and drawn at another
   * collides exactly as badly as no placement pass at all.
   *
   * Always measured at the *detail* tier, even when a coarser tier is showing.
   * Two reasons, and the first is not optional: the fit reads the placement's
   * bounds and then sets the zoom, so letting placement depend on the zoom
   * tier closes a feedback loop — layout → fit → zoom → tier → layout — and
   * React Flow never finishes measuring, leaving every node `visibility:
   * hidden`. The second is that reserving the largest variant means labels
   * keep their positions as you zoom through a threshold instead of jumping.
   */
  const describeLabel: LabelText = useCallback(
    (p) => {
      const withSil =
        witnessOn(p) !== null || (mayDrawExemplar(p) && Boolean(p.node.phylopic_id));
      const div = divergenceFor(p.idx, ind, nodeMap);
      // The same parts NodeMark renders, or the collision pass reserves a box
      // the label does not fit. A fossil range with its glyph is materially
      // wider than the age it stands in for.
      const age = markAge(p.node.age_ma, p.node.tier, p.node.occurrence);
      return {
        name: p.node.name ?? div?.text ?? UNNAMED,
        trailing: age?.text ?? "",
        trailingGlyph: age?.glyph != null,
        // A derived name says so where a rank would otherwise go. Without it
        // "Homo / Pan" sits in the same position as every real taxon name and
        // reads as one.
        meta: div ? DIVERGENCE_META : metaLine(p.node.rank, true),
        hasSilhouette: withSil,
      };
    },
    [nodeMap, ind],
  );

  const lay = useMemo(
    () =>
      layout(ind, nodeMap, {
        plotWidth,
        label: describeLabel,
        axis: axisMode,
        grafts,
      }),
    [ind, nodeMap, plotWidth, describeLabel, axisMode, grafts],
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
          zoom: zoomTier,
          label: lay.labels.get(p.idx),
          divergence: divergenceFor(p.idx, ind, nodeMap),
          showSilhouette,
          // A fossil drawn against the tree rather than a node in it. The mark
          // renders the same way — it is an occurrence-tier node carrying its
          // own picture — but the caption has to state how firmly it is placed,
          // and only the graft knows that.
          graft: p.graft ?? null,
          witness: witnessOn(p),
          // Only worth saying when the picture is not a portrait. "Silhouette
          // of Homo sapiens" on Homo sapiens is noise.
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
    [lay, focusedIdx, focusLineage, isolate, flaring, zoomTier, nodeMap, ind],
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
    // The bounds already include every placed label, so the fit frames what
    // is actually drawn rather than the dots plus a guessed margin.
    const minX = c.x - EDGE_PAD;
    const maxX = c.x + c.w + EDGE_PAD;
    const minY = c.y - EDGE_PAD;
    const maxY = c.y + c.h + EDGE_PAD;
    // The axis owns the bottom strip, and an open drill-down lane owns more
    // of it; fitting into the full height would slide the lowest lineage
    // underneath whichever is there.
    const usableH = Math.max(vh - AXIS_RESERVE - laneH, 160);
    const z = Math.min(
      vw / Math.max(maxX - minX, 1),
      usableH / Math.max(maxY - minY, 1),
      MAX_FIT_ZOOM,
    );
    return {
      x: (vw - (minX + maxX) * z) / 2,
      y: (usableH - (minY + maxY) * z) / 2,
      zoom: z,
    };
  }, [lay, vw, vh, laneH]);

  const fitToContent = useCallback(
    (duration: number) => {
      const t = fitTarget();
      if (t) rf.setViewport(t, { duration });
    },
    [fitTarget, rf],
  );

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
    if (!onFitState) return;
    const t = fitTarget();
    if (!t) {
      onFitState(false);
      return;
    }
    const v = rf.getViewport();
    // A whole pixel of pan and a half percent of zoom are both invisible, and
    // the animated fit lands a hair off its own target often enough that an
    // exact test would report "not fit" immediately after fitting.
    onFitState(
      Math.abs(v.x - t.x) < 1.5 &&
        Math.abs(v.y - t.y) < 1.5 &&
        Math.abs(v.zoom - t.zoom) < t.zoom * 0.005,
    );
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
    const t = window.setTimeout(() => fitToContent(reduced ? 0 : 380), 30);
    return () => window.clearTimeout(t);
  }, [laneH, fitToContent, reduced]);

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
    const t = window.setTimeout(
      () => fitToContent(reduced || first ? 0 : 520),
      first ? 0 : 260,
    );
    return () => window.clearTimeout(t);
  }, [ind.rendered.length, fitToContent, reduced]);

  // Switching scales moves every node in x, and by a lot — the point of linear
  // is that it collapses the recent past against the present. Reframing is what
  // makes that legible as a change rather than as the tree wandering off-screen.
  const lastAxis = useRef(axisMode);
  useEffect(() => {
    if (lastAxis.current === axisMode) return;
    lastAxis.current = axisMode;
    const t = window.setTimeout(() => fitToContent(reduced ? 0 : 420), 20);
    return () => window.clearTimeout(t);
  }, [axisMode, fitToContent, reduced]);

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
      className={`canvas${bloomOff ? " bloom-off" : ""}`}
      style={{ "--icon-scale": iconScale } as React.CSSProperties}
    >
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
          color="rgba(120,190,200,0.07)"
        />
      </ReactFlow>
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
