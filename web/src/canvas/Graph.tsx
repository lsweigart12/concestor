/**
 * The canvas.
 *
 * React Flow / xyflow v12 handles pan, zoom and hit-testing; positions come
 * entirely from our own layout pass and node dragging is off. The rendered set
 * is at most `2|L| − 1` nodes, so a DOM/SVG renderer is right here even though
 * the source dataset is 2.4M leaves.
 *
 * The signature interaction lives here, and it is the product. Every beat is
 * measured from `lead` — the moment the viewport comes to rest — because an add
 * both moves the canvas and draws on it, and marks appearing under a moving
 * canvas are marks no eye can follow:
 *
 *   t=0     existing nodes begin spring reflow to their new positions
 *   t=80    the MRCA flares — the connection beat, and the subject
 *   t=160   the new traces draw from the MRCA *outward*, ~1300ms ease-out,
 *           one wave of branches at a time and a wave every 200ms
 *   t=1460  each new mark appears under the line that reached it, the taxon
 *           that was added blooms, and the traces settle over ~1400ms
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
  fracToAge,
  layout,
  orthPath,
  PAD_X,
  PLOT_W,
  type LabelText,
} from "../tree/layout";
import { dotRect, labelRect, type Rect } from "../tree/labels";
import {
  cardReserve,
  comfortRect,
  fitContentPad,
  fitViewport,
  freeRect,
  plotWidthToFill,
  revealShift,
  toScreenRect,
  union,
  unlaidOut,
} from "./viewport";
import type { AddDelta, Induced } from "../tree/induced";
import { isGraftIdx, type Graft } from "../tree/graft";
import { makeWheelClassifier, type WheelMode } from "./wheel";
import {
  divergenceFor,
  markName,
  UNNAMED,
  type LabelMode,
} from "../tree/naming";
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
import {
  DrillLane,
  useSegment,
  type Drill,
  type LaneEndpoint,
} from "./DrillLane";
import { laneHeight, laneRows } from "./lane";
import { mayDrawExemplar, witnessOn } from "./witness";
import { useReflow } from "./reflow";
import { Water } from "./Water";
import { useBootLights } from "./bootLight";
import type { Emitter } from "./biolum";
import { arriveMark, arriveOf, flareOf } from "./biolum";
import { land } from "./flow";
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
 * Horizontal room the layout gives itself, before the fit scales it. Follows the
 * container: labels scale with zoom, so a fixed layout squeezed into a narrow
 * panel fits at a scale that renders the type unreadable. Shrinking the layout
 * keeps the fit near 1:1 and the text at its designed size.
 */
const MIN_PLOT_W = 340;
/**
 * The bottom strip the fit keeps clear, in screen px: the time axis (`--axis-h`)
 * plus the provenance key above it (`.canvas-legend`) plus a margin.
 */
const AXIS_RESERVE = 96;
const MAX_FIT_ZOOM = 1.4;

/**
 * Breathing room the fit keeps between the tree and the frame, in screen px.
 * `EDGE_PAD` is layout units and all but vanishes at a deep zoom-out; this is
 * measured in the reader's pixels, so a big tree gets the same clearance a
 * small one does.
 */
const FIT_MARGIN = 44;

/**
 * How far the plot may be stretched past its designed width, as a hard ceiling
 * on the laid-out width. A hundred-leaf selection asking to fill a 5K display
 * sideways is a legitimate ask; an unbounded one is a float error with a
 * scrollbar. The floor is `MIN_PLOT_W`, shared with the narrow-panel rule.
 */
const MAX_PLOT_W = PLOT_W * 6;

/**
 * One press of the axis-stretch control, as a factor, and how far the reader's
 * preference may run in either direction. The preference is a *bias on the
 * fill* — the fit first solves the width that squares the tree with the frame,
 * then multiplies by this — so it survives refits, resizes and adds instead of
 * being undone by the next reframe.
 */
const STRETCH_STEP = 1.3;
const STRETCH_BIAS_MIN = 1 / STRETCH_STEP ** 3;
const STRETCH_BIAS_MAX = STRETCH_STEP ** 3;

const clampPlotW = (w: number) => Math.min(MAX_PLOT_W, Math.max(MIN_PLOT_W, w));

/**
 * Whether two stretches are the same stretch, on the same 5% band the fit uses
 * to decide a width is not worth a relayout. `null` — nowhere yet — is near
 * nothing.
 */
const near = (a: number, b: number | null) =>
  b !== null && Math.abs(a - b) <= b * 0.05;

/**
 * Margin the reveal keeps between the subject and every edge, and the shortest
 * it waits before acting. The wait is a floor, not a polish delay: `scheduleFit`
 * raises it past any reframe already animating, or a pan lands mid-animation.
 */
const REVEAL_PAD = 18;
const REVEAL_DELAY = 140;
/** How long the pan takes. Shared with `fitUntil`, which it feeds. */
const REVEAL_MS = 320;

/**
 * The signature sequence's lead-in beats, in ms. The drawing's own pace is
 * `STAGGER` here plus `DRAW_MS`/`DECAY_MS` in `TraceEdge`; the three move
 * together, or the travel collapses into a fade-in.
 */
const T_FLARE = 80;
const T_DRAW = 140;
const STAGGER = 170;

/**
 * How long the arrival bloom lasts, and how far ahead of the line's nominal end
 * the mark lands, in ms.
 *
 * The stroke eases out on `cubic-bezier(.16,.9,.3,1)`, which is within a hair
 * of its endpoint well before `DRAW_MS` elapses. Timing the mark to the last
 * pixel therefore waits on a pixel nobody can see move, and the whole beat
 * reads as sluggish; a moment early it reads as the line delivering something.
 */
const ARRIVE_MS = 1400;
const ARRIVE_LEAD = 240;

/**
 * The prop-drilling channel from `App` through `Graph` to `TimeAxis`,
 * `DrillLane` and `NodeMark`. Exported (though nothing imports it) as the seam
 * between the two largest components, kept as the starting point for a refactor.
 */
export interface GraphProps {
  induced: Induced;
  nodes: Map<number, PathNode>;
  delta: (AddDelta & { token: number }) | null;
  onDeltaPlayed: () => void;
  /**
   * The draw has *landed* — the last trace has arrived and the new marks are
   * on screen — which is a different and much earlier moment than
   * {@link GraphProps.onDeltaPlayed}, whose job is to hold the delta open until
   * every settle has finished.
   *
   * It exists so the draw queue can release the next taxon without waiting on
   * a decay. A settle is not something the next beat has to wait for; a draw
   * arriving on top of one is.
   */
  onDeltaLanded?: () => void;
  focusedIdx: number | null;
  onFocus: (idx: number | null) => void;
  /** Which words the marks carry, and whether they print a date. Switched in the sidebar. */
  labels: LabelMode;
  ages: boolean;
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
   *
   * `vw` is the *canvas's* width rather than the window's now that the sidebar
   * takes its own width out of the layout, so every threshold below is measured
   * against the strip the tree actually has. That makes `MIN_FREE_W`'s refusal
   * sharper rather than looser: a wide panel and an open card can leave too
   * little to reframe into, and the reserve is refused exactly there.
   */
  cardOpen: boolean;
  /** The segment whose drill-down lane is open. Lives in the URL. */
  drill: Drill | null;
  onDrill: (d: Drill | null) => void;
  /** A fossil row was clicked; the app selects it, which opens its card. */
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
  /**
   * What a plain scroll does: pan (the trackpad convention) or zoom (the mouse
   * one). `canvas/wheel.ts` is the argument; the sidebar chip is the switch.
   */
  wheel: WheelMode;
  /**
   * The classifier's verdict on a wheel event, when it has one that differs
   * from the current mode. Left unwired once the chip has pinned a mode —
   * absence is what tells this component to stop classifying.
   */
  onWheelSample?: (m: WheelMode) => void;
}

function Inner(props: GraphProps) {
  const {
    induced: ind,
    nodes: nodeMap,
    delta,
    onDeltaPlayed,
    onDeltaLanded,
    focusedIdx,
    onFocus,
    labels,
    ages,
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
    wheel,
    onWheelSample,
  } = props;

  const rf = useReactFlow();
  /**
   * The canvas itself, so a fit can ask whether there is anything to fit into.
   *
   * React Flow's store cannot answer that: it substitutes 500 for a dimension
   * that measures zero, so "no canvas yet" and "a 500px canvas" are the same
   * two numbers. {@link fitTarget} has the rest.
   */
  const canvasRef = useRef<HTMLDivElement>(null);
  /**
   * When the viewport is expected to have stopped moving, as a timestamp.
   *
   * Written by both movers, `scheduleFit` and `scheduleReveal`, and read by two
   * things that must not start under a moving canvas: the reveal, which
   * computes a pan from the live transform, and the draw sequence's `lead`.
   * Declared here rather than beside the fit because `lead` is a memo — memos
   * run during render, and a `useRef` further down is in its dead zone.
   */
  const fitUntil = useRef(0);
  /**
   * One classifier for this canvas's wheel stream (it keeps the previous
   * event's timestamp — see `wheel.ts`). It observes on the wrapper in the
   * capture phase, before React Flow's own wheel handling, and never swallows
   * the event: the one wheel tick that arrives under the old mode acts under
   * the old mode, and the next one behaves. That single soft tick is the whole
   * cost of guessing, and cheaper than eating an event React Flow expected.
   */
  const classifyWheel = useMemo(() => makeWheelClassifier(), []);
  const onWheelCapture = useCallback(
    (e: React.WheelEvent) => {
      if (!onWheelSample) return;
      const m = classifyWheel(e, e.timeStamp);
      if (m !== null && m !== wheel) onWheelSample(m);
    },
    [classifyWheel, onWheelSample, wheel],
  );
  const zoom = useStore((s) => s.transform[2]);
  const tx = useStore((s) => s.transform[0]);
  const ty = useStore((s) => s.transform[1]);
  const vw = useStore((s) => s.width);
  const vh = useStore((s) => s.height);
  const reduced = useMemo(prefersReduced, []);
  const [flaring, setFlaring] = useState<number | null>(null);
  const playedToken = useRef<number | null>(null);

  // Whether the canvas is showing its own fit. Reframing on a shrink is right
  // only while the frame is ours to move. Starts true so a cold load reframes.
  const [atFit, setAtFit] = useState(true);

  /**
   * Whether the layout is arranged around an open card. State, not derived,
   * because it lags: taking or releasing the reserve re-lays out the tree, and
   * a relayout is a reframe by another name. So it is reconciled inside
   * {@link fitToContent} and nowhere else — at a moment the tree was going to
   * be reframed anyway.
   *
   * **Opening a card is not one of those moments.** A click says which taxon
   * and nothing about the scale, so the whole response is `revealShift`'s pan
   * and the reserve arrives with the next fit. A stale reserve costs an empty
   * strip on the right until then, and never a jump.
   */
  const [reserved, setReserved] = useState(false);
  const reserve = reserved ? cardReserve(vw, true) : 0;

  // Read at fit time rather than depended on: this changes whenever a card
  // opens, and a value in `fitToContent`'s deps rebuilds `scheduleFit`'s target
  // — see its comment. Opening a card must not cancel a booked reframe.
  const wantReserve = useRef(false);
  useEffect(() => {
    wantReserve.current = cardReserve(vw, cardOpen) > 0;
  }, [vw, cardOpen]);

  // Reserve for the leaf labels that hang off the right edge, proportional in
  // a small panel and capped in a large one.
  // Leave roughly a third of the panel for labels, which hang off both sides
  // of the graph. The exact reserve no longer has to be right — the fit reads
  // the real bounds afterwards — but the plot must still shrink in a narrow
  // panel so the fit stays near 1:1 and text stays legible. An open card is a
  // narrow panel by another route, so it is subtracted here and nowhere else:
  // the layout is told how much canvas there is, not what is sitting on it.
  const basePlotW = vw
    ? Math.max(MIN_PLOT_W, Math.min(PLOT_W, (vw - reserve) * 0.62 - PAD_X))
    : PLOT_W;

  /**
   * How far the time axis is stretched past the base plot, as a multiplier.
   *
   * A tall selection makes a tree far taller than it is wide, and no transform
   * fixes that — the fit can only shrink it into a strip down the middle of an
   * empty frame. So the *layout* changes shape instead: the fit solves the
   * plot width whose tree fills the frame both ways (`plotWidthToFill`) and
   * hands off to this state, exactly as it hands off to the card's reserve —
   * the relayout lands, and the effect watching it schedules the fit that
   * frames it. The stretch control on the axis nudges the same state, through
   * {@link stretchBias}, so a reader's "wider than that, please" survives the
   * next reframe instead of being solved away by it.
   */
  const [stretch, setStretch] = useState(1);
  const [stretchBias, setStretchBias] = useState(1);
  const plotWidth = clampPlotW(basePlotW * stretch);

  /**
   * The stretch the current run of relayouts came away from, or null once it
   * has settled. Read by `fitToContent` to refuse a width it has already left,
   * which is what makes a disagreement terminate instead of oscillate.
   */
  const cameFrom = useRef<number | null>(null);

  /**
   * What each label will say, handed to the layout so the placement pass
   * measures the real strings and cannot drift from the renderer. Reads the two
   * label switches — safe where reading the zoom was not, because zoom feeds the
   * fit and letting placement depend on it closes a layout→fit→zoom→layout loop.
   */
  const describeLabel: LabelText = useCallback(
    (p) => {
      const withSil =
        witnessOn(p) !== null ||
        (mayDrawExemplar(p) && Boolean(p.node.phylopic_id));
      const div = divergenceFor(p.idx, ind, nodeMap, labels);
      // The same parts NodeMark renders, or the collision pass reserves a box
      // the label does not fit. A fossil range with its glyph is materially
      // wider than the age it stands in for.
      const age = ages
        ? markAge(p.node.age_ma, p.node.tier, p.node.occurrence)
        : null;
      const words = labels !== "off";
      return {
        name: words
          ? (markName(p.node, labels)?.text ?? div?.text ?? UNNAMED)
          : "",
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
        // Not `plotWidth`: the stretch is solved from the row count, so the row
        // count must not be solved from the stretch. See `layout`'s `baseWidth`.
        baseWidth: basePlotW,
        label: describeLabel,
        grafts,
        holdMaxAge,
      }),
    [ind, nodeMap, plotWidth, basePlotW, describeLabel, grafts, holdMaxAge],
  );

  /**
   * The x extent of the placed marks alone — the part of the content that
   * scales with the plot width, which is what makes the fill solvable. Labels
   * hang off both ends at fixed size and are the difference between this and
   * `lay.content.w`.
   */
  const nodeSpan = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const p of lay.placed.values()) {
      if (p.x < min) min = p.x;
      if (p.x > max) max = p.x;
    }
    return max > min ? max - min : 0;
  }, [lay]);

  /**
   * Where the *traces* are drawn this frame, which during a rearrangement is
   * not where the layout says they are.
   *
   * **The marks are not in here, and that is forced.** React Flow owns node
   * positions, and handing it a new `nodes` array every frame makes it drop
   * every edge on the canvas for the length of the tween — measured at 60fps,
   * 580ms with nothing drawn. So the marks are given their settled positions
   * once, and glide by a CSS transition on `.react-flow__node`; only the edges'
   * geometry, which is ours, is interpolated here. `reflow.ts` holds the curve
   * both sides share.
   *
   * `lay.placed` also stays the answer for anything reasoning about where the
   * tree *will* be — the fit's content bounds, the reveal's subject — since
   * those are about the settled tree and must not chase a tween.
   */
  const placed = useReflow(lay.placed, reduced);

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
      drill && ind.segments.get(drill.lower)?.anc === drill.upper
        ? drill
        : null,
    [drill, ind],
  );

  const segment = useSegment(activeDrill);

  // The suppressed nodes are already in memory from the layout pass, so the
  // spine draws in the same frame as the click and only the fossils wait on
  // the round trip. The response's own copies are the fallback.
  const laneIntermediates = useMemo(() => {
    if (!activeDrill) return [];
    const byIdx = new Map(
      segment.data?.intermediates.map((n) => [n.idx, n]) ?? [],
    );
    return (ind.segments.get(activeDrill.lower)?.suppressed ?? [])
      .map((i) => nodeMap.get(i) ?? byIdx.get(i))
      .filter((n): n is PathNode => n !== undefined);
  }, [activeDrill, ind, nodeMap, segment.data]);

  const laneRowsData = useMemo(
    () =>
      laneRows(segment.data?.fossils ?? [], segment.data?.fossils_total ?? 0),
    [segment.data],
  );

  const laneH = activeDrill ? laneHeight(laneRowsData) : 0;

  // The lineage from the focused node to the induced root. It is what "selected
  // path burns bright" is measured against: everything off it dims.
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
   * The power ladder is **the selection channel** — see `Emitter` in
   * `biolum.ts` for why that is the one thing luminance is allowed to encode
   * here, and why it may not be keyed to age, tier or tip count.
   *
   * Recomputed with the layout, and cheap: it is at most `2|L| − 1` entries.
   */
  const emitters: Emitter[] = useMemo(() => {
    if (!biolum) return [];
    return [...placed.values()].map((p) => ({
      x: p.x,
      y: p.y,
      hue: p.hue,
      power: p.isMRCA ? 1 : p.isLeaf ? 0.8 : 0.45,
      // Read live rather than captured: a hover that starts between layout
      // passes must not wait for the next one to be seen.
      flareAt: () => flareOf(String(p.idx)),
      arriveAt: () => arriveOf(String(p.idx)),
    }));
  }, [placed, biolum]);

  // What is lit when there is no tree. `bootLight.ts` scopes the panel's own
  // sources to `.boot`, so they go out on the first species; the one source that
  // outlives the panel (the palette control) is the exception.
  const bootLights = useBootLights(biolum, reduced);

  /**
   * Counter-scale for silhouettes as the canvas shrinks — they are the one
   * element more useful pulled back, since a shape survives where a name does
   * not. Capped at 1.6x, past which neighbouring rows collide. A transform, so
   * it costs no relayout.
   */
  const iconScale = Math.min(1.6, Math.max(1, 1 / Math.max(zoom, 0.05)));

  /**
   * How long the whole sequence waits for the canvas to stop moving.
   *
   * An add reframes or pans *and* draws the new lineage on. Started together,
   * the new marks appeared while the ground was moving — the one condition
   * under which an eye cannot follow anything, so a reader watched the tree
   * change and then had to hunt for what had changed in it.
   *
   * Read during render, not in an effect: `drawDelay` is a memo and the edges
   * take their delay from it, so an effect would put the marks on one clock and
   * the traces on another. That is why `fitUntil` is declared at the top of the
   * component — further down it is in this memo's temporal dead zone.
   */
  const lead = useMemo(
    () => (delta && !reduced ? Math.max(0, fitUntil.current - Date.now()) : 0),
    [delta, reduced],
  );

  const drawDelay = useMemo(() => {
    const m = new Map<number, number>();
    if (!delta) return m;
    // Root-ward → leaf-ward, staggered per wave (all-at-once reads as a fade-in),
    // so sibling branches leave their shared ancestor together.
    delta.drawOrder.forEach((wave, i) => {
      for (const v of wave) m.set(v, lead + T_DRAW + i * STAGGER);
    });
    return m;
  }, [delta, lead]);

  /**
   * When each new mark appears: at the far end of the line reaching it, not the
   * near end.
   *
   * A node stands for the segment *above* it, so its trace starts at
   * `drawDelay` and takes `DRAW_MS` to arrive. Showing the node when the line
   * leaves draws the destination before the journey. Held back, the line
   * reaches into empty canvas and the taxon is what it finds.
   *
   * The join point is not in here and must not be — it is where the draw leaves
   * from, and it was on screen before the press.
   */
  const enterDelay = useMemo(() => {
    const m = new Map<number, number>();
    if (reduced) return m;
    for (const [v, at] of drawDelay) m.set(v, at + DRAW_MS - ARRIVE_LEAD);
    return m;
  }, [drawDelay, reduced]);

  /** See the landing below: the mode is read, never depended on. */
  const biolumRef = useRef(biolum);
  biolumRef.current = biolum;

  // Fire the flare at t=80 and hand the delta back once the whole sequence
  // has had time to run, so a rapid second add interrupts cleanly rather than
  // queueing.
  useEffect(() => {
    if (!delta || playedToken.current === delta.token) return;
    playedToken.current = delta.token;
    const flareAt = window.setTimeout(
      () => setFlaring(delta.flare),
      reduced ? 0 : lead + T_FLARE,
    );
    /*
      The arrival, in the water.

      The mark's own bloom is CSS and needs no timer — it hangs off the same
      `animation-delay` as its entrance, so the two cannot drift. This is the
      bioluminescent half of the same event, and it must be a timer because the
      light is not in the DOM: `biolum.ts` keeps an arrival clock the renderer
      samples, exactly as it keeps the pointer's.

      Both, rather than one or the other, which is the shape the mode already
      has — pointing at a mark scales the dot *and* fires `flareMark`.
    */
    const arriveAt =
      biolumRef.current && !reduced && delta.leaf !== null
        ? window.setTimeout(
            () => arriveMark(String(delta.leaf)),
            enterDelay.get(delta.leaf) ?? lead + T_DRAW + DRAW_MS - ARRIVE_LEAD,
          )
        : 0;
    /*
      The landing, and it is *not* the same moment as the cleanup below.

      The draw reaches out of the root a wave at a time; the last wave starts
      at `T_DRAW + (waves − 1) · STAGGER` and takes `DRAW_MS` to arrive. That
      instant — not `DECAY_MS` later, when the flare has finished settling — is
      when the tree has stopped moving, and it is where the ring belongs. Fired
      a decay later it reads as a second, unrelated event.

      Only in the bioluminescent mode. The ring is that mode's physics and
      `TraceEdge`'s own listener refuses it otherwise; this is the cheaper half
      of the same refusal, so a neutral canvas never schedules the timer at all.

      **Read from a ref, and the mode is deliberately not a dependency.** This
      effect is guarded by `playedToken`, so re-running it for any reason other
      than a new delta hits that guard and returns — after the cleanup has
      already cancelled every timer it owns. Adding the toggle to the array
      therefore means: press `B` while a tree is drawing, and `onDeltaPlayed`
      never fires, the delta is never handed back, and the flare stays on the
      canvas. The switch would leave the app wedged, once, for anyone who
      pressed it at the wrong second.
    */
    const landedAt =
      lead +
      T_DRAW +
      Math.max(0, delta.drawOrder.length - 1) * STAGGER +
      DRAW_MS;
    // The queue's release, in both modes and however the draw was paced.
    //
    // At the moment the last *mark* enters rather than the last pixel of the
    // last trace — the same `ARRIVE_LEAD` the entrance takes, and for the same
    // reason. The reader has the new taxon once it is on screen, and the next
    // step opens with a reframe rather than a draw, so letting that overlap the
    // tail of this one is not two draws at once. It is what the `STEP_MS`
    // version meant by letting the decay run into the next beat.
    const arrivedAt = window.setTimeout(
      () => onDeltaLanded?.(),
      reduced ? 0 : Math.max(0, landedAt - ARRIVE_LEAD),
    );
    const landAt =
      biolumRef.current && !reduced ? window.setTimeout(land, landedAt) : 0;
    const clearAt = window.setTimeout(
      () => {
        setFlaring(null);
        onDeltaPlayed();
      },
      // The last wave starts latest and still has to draw, settle, and let the
      // bloom finish, so the tail is every duration plus a frame or two of
      // slack. Handing the delta back early cancels whatever is still running.
      reduced
        ? 60
        : lead +
            T_DRAW +
            delta.drawOrder.length * STAGGER +
            DRAW_MS +
            Math.max(DECAY_MS, ARRIVE_MS) +
            100,
    );
    return () => {
      window.clearTimeout(flareAt);
      window.clearTimeout(clearAt);
      window.clearTimeout(arrivedAt);
      if (landAt) window.clearTimeout(landAt);
      if (arriveAt) window.clearTimeout(arriveAt);
    };
  }, [delta, onDeltaPlayed, onDeltaLanded, reduced, lead, enterDelay]);

  const rfNodes: Node[] = useMemo(
    () =>
      [...lay.placed.values()].map((p) => {
        const dim = focusedIdx !== null && !focusLineage.has(p.idx);
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
          // Both as a delay off one clock, both carrying the token, because a
          // `key` built from it is what restarts a CSS animation on a node
          // React is reusing. Null on everything already drawn.
          enter: enterDelay.has(p.idx)
            ? { at: enterDelay.get(p.idx) ?? 0, token: delta?.token ?? 0 }
            : null,
          arrive:
            delta?.leaf === p.idx && enterDelay.has(p.idx)
              ? { at: enterDelay.get(p.idx) ?? 0, token: delta.token }
              : null,
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
    [
      lay,
      focusedIdx,
      focusLineage,
      flaring,
      labels,
      ages,
      nodeMap,
      ind,
      biolum,
      enterDelay,
      delta,
    ],
  );

  const rfEdges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const [v, seg] of ind.segments) {
      if (seg.anc === null) continue;
      const a = placed.get(seg.anc);
      const b = placed.get(v);
      if (!a || !b) continue;

      // A structural node with nothing dated below it is bracketed on one side
      // only — its far end is placed toward the present rather than
      // interpolated between two known ages. It says so by fading out.
      const unbounded =
        b.node.tier === TIER_STRUCTURAL && !hasDatedDescendant(v, ind, nodeMap);

      const dim = focusedIdx !== null && !focusLineage.has(v);

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
    //
    // It draws itself on from the same clock as any branch, and the delay comes
    // from the same map: a fossil arriving is an event, and it used to be the
    // one thing on this canvas that simply appeared. What stays different is
    // what the *line* says — widest dashes, no halo, no hit target, no river —
    // because none of that is about the fossil being lesser. See `mayPump`.
    for (const l of lay.graftLinks) {
      const anchor = placed.get(l.graft.anchor);
      const data: TraceEdgeData = {
        d: orthPath(l.joinX, l.joinY, l.x, l.y),
        hue: anchor?.hue ?? 200,
        // Occurrence, matching the fossil itself: nobody has dated this, and
        // the dash channel answers exactly that question.
        tier: TIER_OCCURRENCE,
        dim:
          focusedIdx !== null &&
          focusedIdx !== l.idx &&
          !focusLineage.has(l.graft.anchor),
        unbounded: false,
        drilled: false,
        attachment: true,
        drawToken: drawDelay.has(l.idx) ? (delta?.token ?? null) : null,
        delay: drawDelay.get(l.idx) ?? 0,
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
    placed,
    focusedIdx,
    focusLineage,
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
        return {
          tier: d.tier,
          unbounded: d.unbounded,
          attachment: d.attachment,
        };
      }),
    [rfEdges],
  );

  /**
   * Fit the content, not the nodes. React Flow's `fitView` frames node boxes,
   * and ours is a 10px dot, so it fits a tree whose labels run off both edges;
   * padding cannot fix an asymmetric pixel overflow. So compute the transform
   * from the layout bounds, which already include every placed label.
   */
  const fitTarget = useCallback((): Viewport | null => {
    const c = lay.content;
    if (!c || !vw || !vh) return null;
    // `vw`/`vh` can be numbers React Flow made up — see `unlaidOut`. A size
    // change re-arms `owedFit`, so nothing is lost by refusing.
    if (unlaidOut(canvasRef.current)) return null;
    return fitViewport({
      content: fitContentPad(c, EDGE_PAD),
      vw,
      vh,
      // The card owns a strip on the right, and the axis owns one at the
      // bottom that an open drill-down lane makes taller. Fitting into the
      // whole container would slide content under all three.
      reserve,
      bottom: AXIS_RESERVE + laneH,
      maxZoom: MAX_FIT_ZOOM,
      margin: FIT_MARGIN,
    });
  }, [lay, vw, vh, laneH, reserve]);

  /**
   * The stretch a fit wants: the width that squares the tree with the frame,
   * times the reader's bias, as a multiplier on the base plot. Null when the
   * question has no answer (nothing placed, or no spread in x worth scaling).
   */
  const fillStretch = useCallback((): number | null => {
    const c = lay.content;
    if (!c || !vw || !vh || nodeSpan < 40) return null;
    const fill = plotWidthToFill({
      plotW: plotWidth,
      nodeSpan,
      content: fitContentPad(c, EDGE_PAD),
      vw,
      vh,
      reserve,
      bottom: AXIS_RESERVE + laneH,
      margin: FIT_MARGIN,
      maxZoom: MAX_FIT_ZOOM,
    });
    if (fill === null) return null;
    // Clamped before the bias as well as after, so the reader's presses have a
    // width to multiply. The fill comes back below `MIN_PLOT_W` whenever the
    // aspect cap asks for a tree squarer than its own labels allow — a handful
    // of leaves on a large display — and scaling that by even the largest bias
    // lands back on the floor, which is a stretch control that looks live and
    // does nothing.
    return clampPlotW(clampPlotW(fill) * stretchBias) / basePlotW;
  }, [
    lay,
    vw,
    vh,
    laneH,
    reserve,
    nodeSpan,
    plotWidth,
    stretchBias,
    basePlotW,
  ]);

  const fitToContent = useCallback(
    (duration: number) => {
      // The card's reserve is reconciled here and nowhere else, because this is
      // the only place a relayout is already paid for. It hands off rather than
      // fitting: `setReserved` moves every node, so a transform computed
      // against the old layout frames a tree about to stop existing. The effect
      // watching `reserved` schedules the fit that lands.
      if (reserved !== wantReserve.current) {
        setReserved(wantReserve.current);
        return;
      }
      const t = fitTarget();
      if (!t) return;
      // The axis stretch is reconciled here too, for the reserve's reason: it
      // re-lays out the tree, so only a moment already paying for a reframe may
      // take it. Within tolerance the layout stands — the band is what stops a
      // fit and its own relayout handing the width back and forth forever.
      const want = fillStretch();
      const handoff =
        want !== null &&
        Math.abs(want - stretch) > stretch * 0.05 &&
        // And a stop for the case the band cannot see, which is the one that
        // reached production: two widths that each ask for the other, far
        // enough apart that every step clears the tolerance. The band only
        // refuses a width close to where we already are; this refuses the width
        // we just came *away* from. Two arrangements that disagree are then a
        // relayout and a settle rather than a shake, and the reader gets the
        // first of the two rather than neither.
        !near(want, cameFrom.current);
      if (handoff && duration > 0) {
        cameFrom.current = stretch;
        setStretch(want);
        return;
      }
      // An instant fit — a cold load — still lands a viewport before the
      // handoff, or the boot transform stays on screen while the relayout runs.
      rf.setViewport(t, { duration });
      fitUntil.current = Date.now() + duration;
      if (handoff) {
        cameFrom.current = stretch;
        setStretch(want);
        return;
      }
      // Settled: the next reframe is a fresh question and may travel anywhere.
      cameFrom.current = null;
      setAtFit(true);
    },
    [fitTarget, rf, reserved, fillStretch, stretch],
  );

  /**
   * Fit after `delay`, recording *now* when it will have landed, so the reveal
   * below can compute its wait from `fitUntil` and not fire mid-animation.
   *
   * It must not close over `fitToContent`: that is rebuilt on every layout
   * change, so a `useCallback` depending on it would re-run the guarded effects
   * that arm this and silently cancel a pending reframe. So the live fit is
   * reached through a ref and this callback is built once — which also fires the
   * latest fit, framing the layout as it is when it runs.
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
   * Bring `nodes` comfortably into view by panning, and by nothing else.
   *
   * The zoom is not this function's to touch, which is the whole distinction
   * from {@link fitToContent}. A fit answers "show me the tree"; this answers "I
   * am looking at *that*", which says nothing about scale. The subject is each
   * mark **and its label** — a dot on the seam with its name under the card is
   * not visible in any sense a reader would recognise.
   *
   * It reads the live transform, so it may only be called when what the reader
   * is looking at changed, never on the transform itself. Refuses an unlaid-out
   * canvas as `fitTarget` does; every caller re-runs on a size change.
   */
  const revealNodes = useCallback(
    (nodes: readonly number[]) => {
      if (!vw || !vh || unlaidOut(canvasRef.current)) return;
      let subject: Rect | null = null;
      for (const idx of nodes) {
        const p = lay.placed.get(idx);
        if (!p) continue;
        const box = lay.labels.get(idx);
        const dot = dotRect(p.x, p.y);
        const one = box ? union(dot, labelRect(p.x, p.y, box)) : dot;
        subject = subject ? union(subject, one) : one;
      }
      if (!subject) return;
      const v = rf.getViewport();
      const { dx, dy } = revealShift(
        toScreenRect(subject, v),
        // The band, not the region: a subject already well inside is left where
        // it is, and one that is not lands clear of the frame.
        comfortRect(
          freeRect({
            vw,
            vh,
            bottom: AXIS_RESERVE + laneH,
            cardOpen,
            pad: REVEAL_PAD,
          }),
        ),
      );
      if (dx === 0 && dy === 0) return;
      rf.setViewport(
        { x: v.x + dx, y: v.y + dy, zoom: v.zoom },
        { duration: reduced ? 0 : REVEAL_MS },
      );
    },
    [lay, vw, vh, laneH, cardOpen, rf, reduced],
  );

  /**
   * Reveal after a wait, through a ref, for `scheduleFit`'s reason — and here
   * the hazard is not hypothetical. `revealNodes` is rebuilt whenever the
   * layout is, and the caller that most needs this is the *add*, which changes
   * the layout by definition: a `useCallback` depending on it would re-run that
   * effect inside its own delay and cancel the reveal it just booked.
   */
  const revealNow = useRef(revealNodes);
  useEffect(() => {
    revealNow.current = revealNodes;
  }, [revealNodes]);

  const scheduleReveal = useCallback(
    (nodes: readonly number[], delay: number) => {
      // `fitUntil` is "when the viewport stops moving", and a reveal moves it
      // as a fit does. Both writers matter now the draw sequence waits on it.
      fitUntil.current = Math.max(
        fitUntil.current,
        Date.now() + delay + REVEAL_MS,
      );
      const t = window.setTimeout(() => revealNow.current(nodes), delay);
      return () => window.clearTimeout(t);
    },
    [],
  );

  /**
   * Tell the app whether the canvas is showing the fit, asked of the live
   * viewport rather than remembered (a flag would go stale on any reframe). On
   * `onMoveEnd` and layout change only, never per frame.
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
    // Tolerances, because the animated fit lands a hair off its own target.
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

  /**
   * The panel moved, so the tree must not appear to. The canvas is
   * `left: var(--sidebar-w)`, so every pixel the panel's edge moves slides the
   * tree sideways. Two answers, the same question the card's reserve asks: on
   * the fit, refit into the new size; zoomed into a corner, take the opposite
   * shift so the picture stays put. Runs off `vw` (a resize changes `vw` and not
   * the offset, so the delta is zero — the browser moving the canvas, not us).
   */
  const lastLeft = useRef<number | null>(null);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || unlaidOut(el)) return;
    const left = el.getBoundingClientRect().left;
    const was = lastLeft.current;
    lastLeft.current = left;
    // The first measurement establishes the baseline and moves nothing. There
    // is no "before" to hold still against on the frame the canvas appears.
    if (was === null || was === left) return;
    if (atFit) return scheduleFit(30, reduced ? 0 : 300);
    const v = rf.getViewport();
    rf.setViewport({ x: v.x + (was - left), y: v.y, zoom: v.zoom });
    return;
  }, [vw, rf, atFit, scheduleFit, reduced]);

  // And the card: the same event on the other axis, the reserve having already
  // narrowed the plot. The sidebar's own width is deliberately not in this set —
  // dragging it is an ordinary resize and must not take the view away.
  const lastReserved = useRef(reserved);
  useEffect(() => {
    if (lastReserved.current === reserved) return;
    lastReserved.current = reserved;
    return scheduleFit(30, reduced ? 0 : 380);
  }, [reserved, scheduleFit, reduced]);

  useEffect(() => {
    if (!fitSignal) return;
    // Guarded like the rest, though a fit signal is a key press and a reader
    // pressing a key has a canvas.
    if (unlaidOut(canvasRef.current)) return;
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

  /**
   * The rendered set changed size, so the new lineage has to end up on screen —
   * but only after the draw has had time to read.
   *
   * **Two answers, split the way everything else here is.** On the fit the
   * reader is looking at the whole tree and the whole tree just got bigger, so
   * it reframes: the new lineage is often outside the old bounds and no pan
   * reaches what the frame does not contain. Zoomed in they are looking at
   * *something*, and an add already moves every node under them; the new branch
   * is brought into view and the zoom left alone, which is usually no motion at
   * all since an add attaches to a branch already on screen.
   *
   * **Only a pure add takes the second path.** An opening replaces the canvas
   * and a remove takes lineages out of it, and no pan answers those. Length
   * alone cannot tell them apart, hence the previous set.
   *
   * `atFit` is read through a ref for `scheduleFit`'s reason: this arms a timer
   * on a count change and clears it on cleanup, so a re-run for any other
   * reason cancels a reframe and then declines to book another.
   */
  const lastCount = useRef(0);
  const lastRendered = useRef<ReadonlySet<number>>(new Set());
  const atFitNow = useRef(atFit);
  useEffect(() => {
    atFitNow.current = atFit;
  }, [atFit]);
  useEffect(() => {
    if (ind.rendered.length === lastCount.current) return;
    const first = lastCount.current === 0;
    const prev = lastRendered.current;
    lastCount.current = ind.rendered.length;
    lastRendered.current = new Set(ind.rendered);
    const fresh = ind.rendered.filter((v) => !prev.has(v));
    // Nothing left, so nothing the reader was looking at has gone.
    const pureAdd = !first && fresh.length === ind.rendered.length - prev.size;
    if (pureAdd && !atFitNow.current) {
      return scheduleReveal(fresh, reduced ? 0 : 160);
    }
    // The delay is a settle, not a beat: the draw now waits on this rather than
    // running under it, so every millisecond here is dead time in front of the
    // animation. Long enough for the layout to have landed and no longer.
    return scheduleFit(first ? 0 : 160, reduced || first ? 0 : 440);
  }, [ind.rendered, scheduleFit, scheduleReveal, reduced]);

  // A stretch change is the same event by another route — every node moves in
  // x — and it is also the landing half of the fit's handoff: `fitToContent`
  // sets the stretch and returns, and this is what frames the relaid tree.
  const lastStretch = useRef(stretch);
  useEffect(() => {
    if (lastStretch.current === stretch) return;
    lastStretch.current = stretch;
    return scheduleFit(20, reduced ? 0 : 420);
  }, [stretch, scheduleFit, reduced]);

  /**
   * The axis-stretch control's press. It moves the applied stretch at once —
   * the tree redraws wider or narrower on this keypress, not at the next fit —
   * and records the same step in the bias, so the fits that follow solve for
   * "the fill, times what the reader asked for" and the preference holds.
   * Refused at the plot's hard bounds; the bias saturates with the width, so
   * the two cannot drift apart at a clamp.
   */
  const nudgeStretch = useCallback(
    (dir: 1 | -1) => {
      const k = dir === 1 ? STRETCH_STEP : 1 / STRETCH_STEP;
      const next = clampPlotW(plotWidth * k) / basePlotW;
      if (Math.abs(next - stretch) < 1e-3) return;
      // A press is a fresh question, not a continuation of the fit's search, so
      // the width it may travel to is unrestricted — including straight back to
      // one a previous run declined.
      cameFrom.current = null;
      setStretch(next);
      setStretchBias((b) =>
        Math.min(STRETCH_BIAS_MAX, Math.max(STRETCH_BIAS_MIN, b * k)),
      );
    },
    [plotWidth, basePlotW, stretch],
  );

  const canWiden =
    plotWidth < MAX_PLOT_W - 1 && stretchBias < STRETCH_BIAS_MAX - 1e-3;
  const canNarrow =
    plotWidth > MIN_PLOT_W + 1 && stretchBias > STRETCH_BIAS_MIN + 1e-3;

  /**
   * And when the container itself changes size, which is the same event again
   * by the third route.
   *
   * `plotWidth` follows `vw`, so a resize has *already* re-laid the tree out by
   * the time this runs — the old transform is framing a tree that is no longer
   * that shape, and the reader is left off-centre with no way to ask for the
   * fit back except the `F` key. The container starting at 0×0, as it does in
   * the preview pane on first load, is the same bug at its worst: the first fit
   * is computed against nothing, and without this nothing ever corrects it.
   *
   * Gated on `atFit` for the reason the card reserve is: a reader who has
   * zoomed into a corner keeps their view across a resize, exactly as they keep
   * it across a card opening. `atFit` starts true, so the 0×0 case is covered.
   *
   * The delay is doing real work here and is longer than the others. A window
   * drag emits a resize per frame; each one clears the pending timeout, so the
   * tree holds still through the gesture and reframes once, when it stops.
   */
  const lastSize = useRef({ vw, vh });
  /**
   * Whether a resize is still owed its reframe.
   *
   * The intent has to outlive the effect that formed it. This effect re-runs
   * whenever `scheduleFit` changes identity, which is whenever the layout does
   * — and its cleanup then cancels the pending reframe while the size guard,
   * already satisfied, declines to schedule another. That is not hypothetical:
   * it is the first-load case exactly. The container is 0×0 until the browser
   * lays it out, the tree data lands a moment later, and the layout change
   * arriving inside the delay ate the only fit the canvas was ever going to
   * get. Held here, the reframe survives the re-run and is rescheduled by it.
   */
  const owedFit = useRef(false);
  useEffect(() => {
    if (lastSize.current.vw !== vw || lastSize.current.vh !== vh) {
      lastSize.current = { vw, vh };
      owedFit.current = atFit;
    }
    if (!owedFit.current) return;
    const cancel = scheduleFit(60, reduced ? 0 : 380);
    // Same delay, registered second, so it clears the debt just after the fit
    // it belongs to has been asked for and never before.
    const settle = window.setTimeout(() => (owedFit.current = false), 60);
    return () => {
      cancel();
      window.clearTimeout(settle);
    };
  }, [vw, vh, atFit, scheduleFit, reduced]);

  /**
   * The whole response to a selection: the taxon is comfortably in view and not
   * under the card. Fires on the selection and on the card appearing or going,
   * never on pan. The wait still reads `fitUntil` because an add, a lane or an
   * `F` press can put a reframe in flight in the same beat.
   */
  useEffect(() => {
    if (focusedIdx === null) return;
    const wait = Math.max(REVEAL_DELAY, fitUntil.current - Date.now() + 60);
    return scheduleReveal([focusedIdx], wait);
    // `vw`/`vh` so a canvas the browser had not sized yet re-arms this:
    // `revealNodes` refuses one, and refusing is only free if something asks
    // again.
  }, [focusedIdx, cardOpen, vw, vh, scheduleReveal]);

  const toScreenX = useCallback(
    (age: number) =>
      (PAD_X + plotWidth * (1 - ageFrac(age, lay.maxAge))) * zoom + tx,
    [lay.maxAge, zoom, tx, plotWidth],
  );

  /**
   * The inverse, so the axis can ask what is under the viewport rather than
   * assume it is showing the whole tree. Without it the ticks are a fixed set
   * generated from `maxAge` and every one of them leaves the screen on the
   * first zoom.
   */
  const toAge = useCallback(
    (x: number) =>
      fracToAge(1 - ((x - tx) / zoom - PAD_X) / plotWidth, lay.maxAge),
    [lay.maxAge, zoom, tx, plotWidth],
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
      ref={canvasRef}
      className={`canvas${bloomOff ? " bloom-off" : ""}${biolum ? " biolum" : ""}`}
      onWheelCapture={onWheelCapture}
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
        lights={bootLights}
        active={biolum}
        reduced={reduced}
      />
      {/*
        The name on React Flow's own `role="application"`.

        It sets that role itself and there is no prop to turn it off, which is
        defensible — an application region hands the arrow keys to the thing
        inside it, and a pannable, zoomable canvas is the case the role exists
        for. What is not defensible is an unnamed one: a reader is told they
        have entered something that has taken their keys and not what. The prop
        reaches the wrapper because `ReactFlowProps` extends the div's own
        attributes and the component spreads the rest onto it.

        It says what is drawn rather than what to press. The keys are the
        palette's business and it is one landmark away.
      */}
      <ReactFlow
        aria-label="The tree, drawn against deep time"
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
        /*
          The wheel, by device. A trackpad scroll pans (pinch, delivered as a
          ctrl+wheel, still zooms via zoomOnPinch); a mouse wheel zooms, the
          maps convention, because a mouse pans by dragging and a wheel spent
          on vertical-only pan duplicates the drag. Which device is `wheel`'s
          business — the classifier above, unless the sidebar chip has spoken.
        */
        panOnScroll={wheel === "pan"}
        zoomOnScroll={wheel === "zoom"}
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
        The canvas-mode chips and the palette button both stood here, on the
        bottom edge, and both are gone rather than moved twice.

        The chips were labels, dates and the light, stacked bottom left above
        the axis, with the time scale wearing the same anatomy on the axis
        footer — one set of four spread over two edges because each had a local
        argument for where it sat. They are together in the sidebar now, and
        `sidebar/Sidebar.tsx` records why the strongest of those local arguments
        lost: a control belongs on the thing it changes, but a *set* has to be
        beside itself or nobody reads it as one.

        The palette button was the whole of the chrome below 620px. It has no
        job left: `sidebar/SearchEntry.tsx` is the way in at every width, and it
        is the same object collapsed as expanded rather than a second control
        standing in for a bar that is not drawn.
      */}
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
      {/*
        The key, on the canvas rather than under the ruler.

        It rode a footer line below the axis for as long as that line had three
        cells in it — the scale switch at one end, the provenance links at the
        other, the key between them. Both ends moved into the sidebar, and what
        was left was a 26px caption row holding the whole strip that far off the
        bottom of the window for one centred phrase. So the strip became the
        ruler alone and sits flush, and the key took the shelf the mode panel
        used to have: bottom left, riding `--axis-h + --lane-h` so an open drill
        lane pushes it up rather than swallowing it.

        It is still the only thing on this edge that is about the *picture* —
        the ticks say when, and this says how to read what is drawn between
        them — which is why it stays down here rather than joining the panel.
      */}
      <div className="canvas-legend">
        <Legend edges={patterns} />
      </div>
      <TimeAxis
        maxAge={lay.maxAge}
        width={vw || window.innerWidth}
        toScreenX={toScreenX}
        toAge={toAge}
        intervals={intervals}
        onStretch={nudgeStretch}
        canWiden={canWiden}
        canNarrow={canNarrow}
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
