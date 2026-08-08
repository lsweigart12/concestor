/**
 * Deterministic layout. Positions are computed, never simulated. No graph-layout
 * engine (no d3-hierarchy / ELK / dagre): they assign `x` by depth, and here `x`
 * is time (architecture §7).
 *
 *   x = symlog(age_layout)      linear below t0 = 1 Ma, logarithmic above
 *   y = tip lane                assigned by preorder idx
 *
 * Preorder `idx` gives both motion properties for free: sorting leaves by it is
 * a canonical vertical order, so adding a leaf inserts in place, and an internal
 * node sits at its children's midpoint so a lane keeps its position.
 */

import type { PathNode } from "../api";
import type { Induced } from "./induced";
import type { Graft } from "./graft";
import {
  labelBounds,
  placeLabels,
  type LabelBox,
  type LabelInput,
  type Rect,
  type TraceRun,
} from "./labels";

/** Below this the axis is linear; above it, logarithmic. */
export const SYMLOG_T0 = 1.0;
/** Share of the axis given to the linear stretch. */
const LIN_SHARE = 0.07;

/** Which scale the axis is on. A real change of scale, not a caption. */
export type AxisMode = "log" | "linear";

export const ROW_H = 74;
export const PLOT_W = 1240;
export const PAD_X = 150;

/**
 * Two marks closer than this in x are one mark — a node dot is 16 layout units
 * across, so nearer centres cannot be told apart at any zoom. Read by the row
 * rule and the graft connector to ask whether a branch has any length to draw
 * along.
 */
const MARK_MIN_SEP = 18;

/**
 * Fraction of the axis for an age, present at 0 and deep time at 1. log(0) is
 * undefined at the present, so there is a linear stretch below `SYMLOG_T0` (the
 * knee gets a visible tick). Not the default scale, but the only one that holds
 * a hominin divergence and the Cambrian at once.
 */
export function symlogFrac(age: number, maxAge: number): number {
  if (!Number.isFinite(age) || age <= 0) return 0;
  if (age <= SYMLOG_T0) return (age / SYMLOG_T0) * LIN_SHARE;
  const span = Math.log10(Math.max(maxAge, SYMLOG_T0 * 10) / SYMLOG_T0);
  return LIN_SHARE + (1 - LIN_SHARE) * (Math.log10(age / SYMLOG_T0) / span);
}

/** Inverse of {@link symlogFrac}, for axis ticks and hit-testing. */
export function fracToAge(frac: number, maxAge: number): number {
  if (frac <= LIN_SHARE) return (frac / LIN_SHARE) * SYMLOG_T0;
  const span = Math.log10(Math.max(maxAge, SYMLOG_T0 * 10) / SYMLOG_T0);
  return SYMLOG_T0 * 10 ** (((frac - LIN_SHARE) / (1 - LIN_SHARE)) * span);
}

/**
 * Proportional time: deepest node at the far edge, present at 0. Unclamped, so
 * it stays invertible off the ends of the plot (the axis inverts panned x).
 */
function linearFrac(age: number, maxAge: number): number {
  if (!Number.isFinite(age)) return 0;
  return age / Math.max(maxAge, SYMLOG_T0);
}

/** The scale in force, given the mode. Everything drawn against time uses it. */
export function ageFrac(age: number, maxAge: number, mode: AxisMode): number {
  return mode === "linear" ? linearFrac(age, maxAge) : symlogFrac(age, maxAge);
}

/** Inverse of {@link ageFrac}. */
export function fracToAgeIn(
  frac: number,
  maxAge: number,
  mode: AxisMode,
): number {
  return mode === "linear"
    ? frac * Math.max(maxAge, SYMLOG_T0)
    : fracToAge(frac, maxAge);
}

export interface Placed {
  idx: number;
  x: number;
  y: number;
  node: PathNode;
  /** One of the chosen selections, as opposed to an inferred divergence. */
  isLeaf: boolean;
  isMRCA: boolean;
  /** Stable across renders — see {@link laneHue}. */
  hue: number;
  /** Set on a fossil drawn against the tree; carries the graft for its connector. */
  graft?: Graft;
}

/**
 * A graft's connector: from a point on a drawn branch down to the fossil.
 * `(joinX, joinY)` is on the lineage at the fossil's first appearance (clamped
 * to the branch); `(x, y)` is the fossil at its last.
 */
interface GraftLink {
  idx: number;
  joinX: number;
  joinY: number;
  x: number;
  y: number;
  graft: Graft;
}

export interface Layout {
  placed: Map<number, Placed>;
  maxAge: number;
  height: number;
  width: number;
  /** Where each label goes, after collision resolution. See `labels.ts`. */
  labels: Map<number, LabelBox>;
  /** Bounds of nodes *and* labels, which is what the viewport should frame. */
  content: Rect | null;
  /** One per drawn graft. Empty when no fossil is on the canvas. */
  graftLinks: GraftLink[];
}

/**
 * A lane's hue, keyed on the node's immutable `idx` so it stays constant across
 * renders (a row-keyed hue would shift when a species slots in above). A tight,
 * cool set. Exported because `canvas/bootLight.ts` needs the first member by
 * name — it cannot go through {@link laneHue}, which is deliberately unpredictable.
 */
export const LANE_HUES = [186, 172, 200, 158, 212, 145, 194];

export function laneHue(idx: number): number {
  // A cheap integer hash so adjacent idx values (sister taxa) do not land on
  // adjacent hues.
  let h = idx * 2654435761;
  h ^= h >>> 15;
  return LANE_HUES[Math.abs(h) % LANE_HUES.length]!;
}

/**
 * Row order for grafts sharing a slot: ascending `joinAge`, so `joinX` only
 * decreases down the rows. That makes connector crossings unsatisfiable — no
 * crossings by construction. Ascending `joinAge` rather than `joinX` states it
 * without reference to the scale, so it holds under both axis modes and every
 * zoom. Stable, so the picture stays a function of the URL.
 */
export function graftOrder(a: Graft, b: Graft): number {
  return a.joinAge - b.joinAge;
}

export function layout(
  ind: Induced,
  nodes: Map<number, PathNode>,
  opts: {
    rowHeight?: number;
    plotWidth?: number;
    /**
     * The plot width *before* the fit's axis stretch, which is the only width
     * the row rule is allowed to see. Defaults to `plotWidth`.
     *
     * `plotWidth` is partly solved from the tree's own height — a tall tree
     * gets a wider plot so its aspect matches the frame
     * ({@link plotWidthToFill}) — so anything that decides the *row count* from
     * `plotWidth` closes a loop through the fit. {@link MARK_MIN_SEP} did:
     * Sauropsida sits 23 Ma from its only rendered child and the two are one
     * mark below a plot of about 1670 units and two above it, so the tree was
     * four rows tall, asked to be wider, came back three rows tall, asked to be
     * narrower, and the canvas shook between the two arrangements forever.
     *
     * The width the *reader's window* gives is not part of that loop and still
     * counts: on a narrow panel the marks really do crowd. So the rule is asked
     * at the width the window alone decided, and the stretch — which is an
     * answer computed from the rows — is kept out of the question that decides
     * them.
     */
    baseWidth?: number;
    label?: LabelText;
    axis?: AxisMode;
    /** Fossils drawn against the tree. See `graft.ts`; empty is the default. */
    grafts?: readonly Graft[];
    /**
     * Hold the axis out to at least this age, whatever is on the canvas. For a
     * draining draw queue (`state/queue.ts`): the scale is recomputed between
     * arrivals rather than tweened, so pinning it to the queue's final extent
     * from the first frame avoids a hard rescale per taxon — a reader holding
     * `R` down is the case that shows it — and the viewport's own fit does the
     * pullback. A floor, never a ceiling (`Math.max`).
     */
    holdMaxAge?: number | null;
  } = {},
): Layout {
  const rowH = opts.rowHeight ?? ROW_H;
  const plotW = opts.plotWidth ?? PLOT_W;
  const baseW = opts.baseWidth ?? plotW;
  const mode = opts.axis ?? "log";
  const grafts = opts.grafts ?? [];
  const placed = new Map<number, Placed>();
  if (ind.rendered.length === 0) {
    return {
      placed,
      maxAge: 4247,
      height: 0,
      width: plotW + PAD_X * 2,
      labels: new Map(),
      content: null,
      graftLinks: [],
    };
  }

  const ageOf = (v: number) => nodes.get(v)?.age_layout ?? 0;
  // Grafts count toward the extent, or a fossil older than every node lands off
  // the left edge.
  const maxAge = Math.max(
    ...ind.rendered.map(ageOf),
    ...grafts.map((g) => g.node.age_layout),
    opts.holdMaxAge ?? 0,
    1,
  );

  // The present sits at the right edge and deep time runs left, so an older
  // node is further from the reader's starting point rather than closer.
  const xAt = (age: number) => PAD_X + plotW * (1 - ageFrac(age, maxAge, mode));
  const xOf = (v: number) => xAt(ageOf(v));
  // The same axis at {@link baseWidth}, for the one question that must not be
  // answered from a stretch the answer will be used to compute.
  const xBaseOf = (v: number) => baseW * (1 - ageFrac(ageOf(v), maxAge, mode));

  // y: one row per rendered leaf in preorder order, internal nodes at the
  // midpoint of their children's extent. Rendered leaves are the selections
  // plus, in principle, any rendered node with no rendered children.
  const kids = new Map<number, number[]>();
  for (const [v, seg] of ind.segments) {
    if (seg.anc !== null) {
      const list = kids.get(seg.anc);
      if (list) list.push(v);
      else kids.set(seg.anc, [v]);
    }
  }
  const leafSet = new Set(ind.leaves);
  // Only a node with exactly one rendered child can share another mark's y.
  const collidesWithOnlyChild = (v: number): boolean => {
    const cs = kids.get(v) ?? [];
    if (cs.length !== 1) return false;
    return Math.abs(xBaseOf(v) - xBaseOf(cs[0]!)) < MARK_MIN_SEP;
  };
  /**
   * A row belongs to a lineage that ends here: a node with rendered descendants
   * is drawn *on* the lineage that continues past it, never on a row of its own,
   * even when chosen. Rows ascend by `idx` (preorder), so a chosen internal node
   * given its own row would take the first row of its block, above its children.
   *
   * One exception: where a node would land within {@link MARK_MIN_SEP} of its
   * single child (both at `age_layout` 0, e.g. *H. sapiens* and its subspecies),
   * it keeps a row so the zero-length trace becomes a visible drop — a row, not
   * an x offset, since x is time.
   *
   * That exception is asked at {@link baseWidth} and not at `plotWidth`, and it
   * has to be: the number of rows is an *input* to the width the fit solves, so
   * a row that comes and goes with the width makes the canvas oscillate. See
   * the option's own note.
   */
  const rows = ind.rendered.filter(
    (v) => !kids.has(v) || (leafSet.has(v) && collidesWithOnlyChild(v)),
  );

  /**
   * Grafts take rows of their own, just outside the block of rows the lineage
   * they hang from occupies — on the far side of the block from the anchor's
   * own fork, so an inserted row cannot drag the fork's midpoint onto the graft
   * (which would read as the fossil hanging off the divergence). Within a slot
   * the deeper join goes furthest, so connectors do not cross. See
   * {@link graftsAbove} and {@link graftOrder}.
   */
  const basePos = new Map<number, number>();
  rows.forEach((v, i) => basePos.set(v, i));
  const lastRowIn = (v: number): number => {
    let m = basePos.get(v) ?? -1;
    for (const c of kids.get(v) ?? []) m = Math.max(m, lastRowIn(c));
    return m;
  };
  const firstRowIn = (v: number): number => {
    let m = basePos.get(v) ?? Infinity;
    for (const c of kids.get(v) ?? []) m = Math.min(m, firstRowIn(c));
    return m;
  };
  const graftsAbove = (anchor: number): boolean => {
    const anc = ind.segments.get(anchor)?.anc ?? null;
    if (anc === null) return false;
    const sibs = kids.get(anc) ?? [];
    return sibs.length > 1 && Math.min(...sibs) === anchor;
  };

  const before = new Map<number, Graft[]>();
  const after = new Map<number, Graft[]>();
  for (const g of grafts) {
    const above = graftsAbove(g.anchor);
    const at = above ? firstRowIn(g.anchor) : lastRowIn(g.anchor);
    const into = above ? before : after;
    const slot =
      Number.isFinite(at) && at >= 0 ? at : above ? 0 : rows.length - 1;
    const list = into.get(slot);
    if (list) list.push(g);
    else into.set(slot, [g]);
  }
  for (const list of after.values()) list.sort(graftOrder);
  for (const list of before.values()) list.sort((a, b) => graftOrder(b, a));

  const yOf = new Map<number, number>();
  const graftY = new Map<number, number>();
  let row = 0;
  rows.forEach((v, i) => {
    for (const g of before.get(i) ?? []) graftY.set(g.idx, row++ * rowH);
    yOf.set(v, row++ * rowH);
    for (const g of after.get(i) ?? []) graftY.set(g.idx, row++ * rowH);
  });
  const totalRows = row;

  const resolveY = (v: number): number => {
    const known = yOf.get(v);
    if (known !== undefined) return known;
    const cs = kids.get(v) ?? [];
    if (cs.length === 0) {
      yOf.set(v, 0);
      return 0;
    }
    const ys = cs.map(resolveY);
    const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
    yOf.set(v, mid);
    return mid;
  };
  for (const v of ind.rendered) resolveY(v);

  for (const v of ind.rendered) {
    const node = nodes.get(v);
    if (!node) continue;
    placed.set(v, {
      idx: v,
      x: xOf(v),
      y: yOf.get(v) ?? 0,
      node,
      isLeaf: leafSet.has(v),
      isMRCA: v === ind.mrca,
      hue: laneHue(v),
    });
  }

  /**
   * Where the connector leaves the branch. Held clear of the branch's own
   * corner: when a fossil is older than the whole branch, `xAt(joinAge)` lands
   * on the branch's vertical and the connector would be drawn along the line it
   * is meant to be distinguished from. Pushed to the first point of the run
   * clear of the corner, never past the anchor's mark. `joinAge`/`joinAt` untouched.
   */
  const joinXFor = (g: Graft): number => {
    const ancIdx = ind.segments.get(g.anchor)?.anc ?? null;
    const raw = xAt(g.joinAge);
    if (ancIdx === null) return raw;
    const clear = xOf(ancIdx) + MARK_MIN_SEP;
    return Math.min(Math.max(raw, clear), xOf(g.anchor));
  };

  // Grafts join `placed` so that labels, collision resolution and the content
  // bounds all treat them as first-class marks — which on the canvas they are.
  // They are deliberately *not* in `ind`, so nothing that walks the topology
  // can reach them.
  const graftLinks: GraftLink[] = [];
  for (const g of grafts) {
    const y = graftY.get(g.idx);
    if (y === undefined) continue;
    const x = xAt(g.node.age_layout);
    placed.set(g.idx, {
      idx: g.idx,
      x,
      y,
      node: g.node,
      isLeaf: false,
      isMRCA: false,
      // The anchor's hue: a graft belongs to the lineage it hangs from.
      hue: laneHue(g.anchor),
      graft: g,
    });
    graftLinks.push({
      idx: g.idx,
      joinX: joinXFor(g),
      joinY: yOf.get(g.anchor) ?? y,
      x,
      y,
      graft: g,
    });
  }

  // Labels are laid out from the finished node positions, against the traces
  // those positions imply — so placement knows about every line it could be
  // drawn through, not just about the other labels.
  const describe = opts.label ?? defaultLabelText;
  const inputs: LabelInput[] = [...placed.values()].map((p) => ({
    idx: p.idx,
    x: p.x,
    y: p.y,
    // Terminal means "nothing continues past this mark", not `isLeaf`
    // (chosen): a graft is terminal, and a chosen clade with a rendered
    // descendant sits on that descendant's line and is not.
    terminal: (p.isLeaf && !kids.has(p.idx)) || p.graft !== undefined,
    medium: p.isMRCA,
    // A graft outranks every divergence and yields only to a chosen leaf: the
    // reader asked for it by name, so `tip_count` alone would crowd it out.
    priority:
      (p.isLeaf ? 1e9 : 0) +
      (p.graft ? 8e8 : 0) +
      (p.isMRCA ? 5e8 : 0) +
      p.node.tip_count,
    ...describe(p),
  }));

  const runs: TraceRun[] = [];
  for (const [v, seg] of ind.segments) {
    if (seg.anc === null) continue;
    const a = placed.get(seg.anc);
    const b = placed.get(v);
    if (a && b) runs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
  }
  // Graft connectors are lines on the canvas too, so labels must be placed
  // against them or a fossil's own name lands across the stub it hangs on.
  for (const l of graftLinks) {
    runs.push({ ax: l.joinX, ay: l.joinY, bx: l.x, by: l.y });
  }

  const labels = placeLabels(inputs, runs, {
    rowH,
    maxTextWidth: Math.max(150, Math.min(300, plotW * 0.3)),
  });

  const lb = labelBounds(inputs, labels);
  const xs = [...placed.values()].map((p) => p.x);
  const ys = [...placed.values()].map((p) => p.y);
  const minX = Math.min(...xs, lb ? lb.x : Infinity);
  const maxX = Math.max(...xs, lb ? lb.x + lb.w : -Infinity);
  const minY = Math.min(...ys, lb ? lb.y : Infinity);
  const maxY = Math.max(...ys, lb ? lb.y + lb.h : -Infinity);

  return {
    placed,
    maxAge,
    height: Math.max(totalRows, 1) * rowH,
    width: plotW + PAD_X * 2,
    labels,
    content: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    graftLinks,
  };
}

/** What a node's label says. Kept here so the layout can measure it. */
export type LabelText = (p: Placed) => {
  name: string;
  trailing: string;
  trailingGlyph: boolean;
  meta: string;
  hasSilhouette: boolean;
};

const defaultLabelText: LabelText = (p) => ({
  name: p.node.name ?? "unnamed divergence",
  trailing: "",
  trailingGlyph: false,
  meta: "",
  hasSilhouette: false,
});

/**
 * Boundaries a reader may recognise (66 K–Pg, 252 end-Permian, 541 Cambrian),
 * offered ahead of a nearby round number. Not the tick set — the axis generates
 * its ladder from the on-screen range (see `TimeAxis.tsx`).
 */
export const LANDMARK_TICKS = [66, 252, 541];

/**
 * Orthogonal edge path with a small corner radius. No bezier: curves make
 * convergent branches ambiguous where a dozen lineages meet at one point.
 */
export function orthPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r = 9,
): string {
  if (Math.abs(y1 - y2) < 0.5) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const dy = Math.sign(y2 - y1);
  const dx = Math.sign(x2 - x1);
  const rr = Math.min(r, Math.abs(y2 - y1) / 2, Math.abs(x2 - x1) / 2);
  return [
    `M ${x1} ${y1}`,
    `L ${x1} ${y2 - dy * rr}`,
    `Q ${x1} ${y2} ${x1 + dx * rr} ${y2}`,
    `L ${x2} ${y2}`,
  ].join(" ");
}
