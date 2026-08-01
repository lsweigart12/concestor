/**
 * Deterministic layout. Positions are computed, never simulated.
 *
 * design-reference.md asks for a deterministic hierarchical layout and
 * suggests d3-hierarchy / ELK / dagre. **We use none of them**, and that is a
 * settled decision (architecture §7, handoff.md §1a): a graph-layout engine
 * assigns `x` by *depth*, and here `x` is *time*. Running one would silently
 * destroy the axis the layout exists for. Every other principle in that
 * document holds — deterministic, computed, not simulated, not draggable —
 * and this file is all of them.
 *
 *   x = symlog(age_layout)      linear below t0 = 1 Ma, logarithmic above
 *   y = tip lane                assigned by preorder idx
 *
 * Both properties the motion design depends on fall out of preorder numbering
 * rather than being maintained here: sorting leaves by `idx` is a canonical
 * vertical order, so adding a leaf inserts it in place and never permutes the
 * others, and an internal node sits at the midpoint of its children's extent
 * so a lane keeps its position across renders.
 */

import type { PathNode } from "../api";
import type { Induced } from "./induced";

/** Below this the axis is linear; above it, logarithmic. */
export const SYMLOG_T0 = 1.0;
/** Share of the axis given to the linear stretch. */
export const LIN_SHARE = 0.07;

export const ROW_H = 74;
export const PLOT_W = 1240;
export const PAD_X = 150;

/**
 * Fraction of the axis for an age, present at 0 and deep time at 1.
 *
 * log(0) is undefined at the present, which is where a naive implementation
 * emits -Infinity and the layout silently collapses. Linear time is also
 * useless here: it puts every hominin divergence inside one pixel next to the
 * Cambrian. The knee gets a visible tick, because a scale that bends without
 * saying so misleads.
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
}

export interface Layout {
  placed: Map<number, Placed>;
  maxAge: number;
  height: number;
  width: number;
}

/**
 * A lane's hue, derived from the node's own `idx` rather than its row.
 *
 * design-reference.md requires that "a lane keeps its hue across renders".
 * Keying hue on row position would break that the moment a new species slots
 * in above an existing one and shifts every row below it. Keying on `idx` —
 * which is immutable, assigned once by the preorder traversal in phase 1 —
 * makes the hue a property of the organism, not of the current view.
 *
 * The set is deliberately tight and cool: cyan through teal to pale green,
 * low chroma. Distinguishable, never candy.
 */
const LANE_HUES = [186, 172, 200, 158, 212, 145, 194];

export function laneHue(idx: number): number {
  // A cheap integer hash so adjacent idx values (sister taxa, very common in a
  // selection) do not land on adjacent hues.
  let h = idx * 2654435761;
  h ^= h >>> 15;
  return LANE_HUES[Math.abs(h) % LANE_HUES.length]!;
}

export function layout(
  ind: Induced,
  nodes: Map<number, PathNode>,
  opts: { rowHeight?: number; plotWidth?: number } = {},
): Layout {
  const rowH = opts.rowHeight ?? ROW_H;
  const plotW = opts.plotWidth ?? PLOT_W;
  const placed = new Map<number, Placed>();
  if (ind.rendered.length === 0) {
    return { placed, maxAge: 4247, height: 0, width: plotW + PAD_X * 2 };
  }

  const ageOf = (v: number) => nodes.get(v)?.age_layout ?? 0;
  const maxAge = Math.max(...ind.rendered.map(ageOf), 1);

  // The present sits at the right edge and deep time runs left, so an older
  // node is further from the reader's starting point rather than closer.
  const xOf = (v: number) => PAD_X + plotW * (1 - symlogFrac(ageOf(v), maxAge));

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
  const rows = ind.rendered.filter((v) => !kids.has(v));
  const yOf = new Map<number, number>();
  rows.forEach((v, i) => yOf.set(v, i * rowH));

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

  const leafSet = new Set(ind.leaves);
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

  return {
    placed,
    maxAge,
    height: Math.max(rows.length, 1) * rowH,
    width: plotW + PAD_X * 2,
  };
}

/**
 * Axis ticks that survive a symlog scale.
 *
 * Chosen as round numbers plus the boundaries a reader is likely to recognise
 * — 66 Ma is the K–Pg, 252 the end-Permian, 541 the base of the Cambrian —
 * because on a log axis evenly-spaced ticks are neither even nor meaningful.
 */
export const AXIS_TICKS = [0, 1, 10, 66, 100, 252, 541, 1000, 2500, 4000];

/**
 * Orthogonal edge path with a small consistent corner radius.
 *
 * No bezier: design-reference.md is explicit that curves make convergent
 * branches ambiguous, and with a dozen lineages meeting at one divergence
 * point that ambiguity is the whole failure mode.
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
