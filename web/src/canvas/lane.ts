/**
 * What goes in a drill-down lane, and how much of it.
 *
 * The lane is interaction 3 (architecture §7, §8): clicking a segment expands
 * it into a strip beneath the chronogram, sharing the time axis so a fossil
 * bracket and a divergence above it are read against the same scale. Two kinds
 * of thing go in it and they are not the same kind of claim —
 *
 *   intermediates   OTT nodes suppressed out of the segment. Positions in the
 *                   tree, at `age_layout`, ranked by `tip_count` and whether
 *                   they carry a named rank
 *   fossils         PBDB taxa attached anywhere along it. *Observations from
 *                   rock*, ranked by `n_occs`, drawn as brackets
 *
 * — which is why this file computes them separately and the lane draws them in
 * separate registers. A fossil range must never read as a divergence age.
 *
 * The geometry lives here rather than in the component so the cap and the
 * ranking can be tested without a DOM, which is the same split `tree/labels.ts`
 * uses against `NodeMark`.
 */

import type { FossilTaxon, PathNode } from "../api";
import { textWidth } from "../tree/labels";

/** Must match the `.drill-*` rules in styles.css. */
export const HEAD_H = 22;
export const SPINE_H = 30;
export const ROW_H = 16;
export const FOOT_H = 22;

/**
 * How many fossil taxa get a bracket.
 *
 * The server caps at 200 and a segment can genuinely have thousands —
 * Amniota → Tyrannosauridae is 6,197 — so a lane that drew everything it was
 * given would be taller than the canvas it annotates. Eight rows is what fits
 * in a strip that still leaves the chronogram the majority of the viewport,
 * and `n_occs` ordering means the eight are the ones a reader has a chance of
 * recognising. Truncation is always stated: a silent one reads as completeness.
 */
export const LANE_ROWS = 8;

/** How many unplaced taxa are named before the rest become a count. */
const UNPLACED_NAMES = 5;

export interface LaneRows {
  /** Taxa with an appearance interval, capped, most-recorded first. */
  placed: FossilTaxon[];
  /**
   * Taxa PBDB records with no interval at all — 21.4% of the corpus. They
   * cannot go anywhere on a time axis, so they are named rather than drawn.
   */
  unplaced: FossilTaxon[];
  /** Taxa this lane accounts for, by a bracket or by name. */
  shown: number;
  /** Distinct taxa attached to the whole segment, before any cap. */
  total: number;
}

function hasInterval(f: FossilTaxon): boolean {
  return [f.fea, f.fla, f.lea, f.lla].some(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
}

/**
 * Split and cap the server's ranked list.
 *
 * `total` is the server's `fossils_total`, which counts *distinct names* over
 * the whole segment — the same thing the returned rows are deduplicated to, so
 * "showing 8 of 6,197" compares two counts of the same object.
 */
export function laneRows(
  fossils: readonly FossilTaxon[],
  total: number,
  cap: number = LANE_ROWS,
): LaneRows {
  const placed: FossilTaxon[] = [];
  const unplaced: FossilTaxon[] = [];
  for (const f of fossils) {
    if (hasInterval(f)) {
      if (placed.length < cap) placed.push(f);
    } else {
      unplaced.push(f);
    }
  }
  return {
    placed,
    unplaced,
    shown: placed.length + unplaced.length,
    total: Math.max(total, placed.length + unplaced.length),
  };
}

/**
 * "showing 8 of 6,197", or nothing when there is nothing to admit.
 *
 * Null rather than "showing 3 of 3": a cap notice on a complete lane trains a
 * reader to ignore the one place it matters.
 */
export function capNote(rows: Pick<LaneRows, "shown" | "total">): string | null {
  if (rows.shown >= rows.total) return null;
  return `showing ${rows.shown.toLocaleString()} of ${rows.total.toLocaleString()} · most-recorded first`;
}

/** How the unplaced taxa are named, or null when there are none. */
export function unplacedNote(unplaced: readonly FossilTaxon[]): string | null {
  if (unplaced.length === 0) return null;
  const names = unplaced.slice(0, UNPLACED_NAMES).map((f) => f.name);
  const rest = unplaced.length - names.length;
  const list = rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
  return `no appearance interval recorded, so not placed in time: ${list}`;
}

export function laneHeight(rows: LaneRows): number {
  return HEAD_H + SPINE_H + Math.max(rows.placed.length, 1) * ROW_H + FOOT_H;
}

/** A rank OTT actually gave the node, as opposed to the "no rank" filler. */
export function isNamedRank(rank: string | null): boolean {
  return Boolean(rank) && rank !== "no rank";
}

/**
 * Intermediates, most notable first.
 *
 * A named rank first, then `tip_count` — architecture §7's two signals, in
 * that order. The order matters more than it looks: on the way to Mammalia the
 * chain is mostly `mrcaott…` nodes with no name at all, and the entries worth
 * pointing at (Synapsida, Therapsida, Cynodontia) are exactly the ones the
 * taxonomy bothered to rank. Sorting on `tip_count` alone would put an unnamed
 * node above every one of them.
 */
export function rankIntermediates(nodes: readonly PathNode[]): PathNode[] {
  return [...nodes].sort((a, b) => {
    const an = a.name ? (isNamedRank(a.rank) ? 2 : 1) : 0;
    const bn = b.name ? (isNamedRank(b.rank) ? 2 : 1) : 0;
    if (an !== bn) return bn - an;
    return b.tip_count - a.tip_count;
  });
}

export interface SpineLabel {
  idx: number;
  text: string;
  x: number;
  /** Half the measured text width, so the caller can centre and clip it. */
  half: number;
}

const SPINE_FONT = "10.5px ui-sans-serif, -apple-system, sans-serif";
const SPINE_GAP = 10;

/**
 * Which intermediates get a name printed under the spine.
 *
 * Every intermediate gets a tick; only some get words, because a segment can
 * hold 35 of them inside 900px. Offering the ranked list to a greedy
 * non-overlap pass means the names that survive crowding are the notable ones
 * rather than whichever happened to be leftmost — the same principle as the
 * canvas label placement, at a tenth of the cost, because these are one line
 * of text on one row.
 */
export function spineLabels(
  ranked: readonly PathNode[],
  toX: (ma: number) => number,
  opts: { width: number; limit?: number } = { width: 0 },
): SpineLabel[] {
  const out: SpineLabel[] = [];
  const limit = opts.limit ?? 6;
  for (const n of ranked) {
    if (out.length >= limit) break;
    if (!n.name) continue;
    const half = textWidth(n.name, SPINE_FONT) / 2;
    const x = toX(n.age_layout);
    if (opts.width > 0 && (x - half < 0 || x + half > opts.width)) continue;
    if (out.some((o) => Math.abs(o.x - x) < o.half + half + SPINE_GAP)) continue;
    out.push({ idx: n.idx, text: n.name, x, half });
  }
  return out;
}
