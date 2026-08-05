/**
 * What to say about where an undated node was drawn, given what the build
 * actually knows.
 *
 * ## Why this is four cases and not one sentence
 *
 * The card used to say the node "sits between its nearest dated ancestor and
 * descendant". That phrase is doing two things wrong at once. It names nothing,
 * so a reader cannot check it against the canvas in front of them; and it is
 * *true of 2.8% of the nodes it appears on*. Measured over the 186,317
 * structural nodes in the shipped build:
 *
 *   5,168   (2.8%)   have a dated descendant older than the present
 *   181,149 (97.2%)  do not — the lower end of the span *is* the present
 *   45,428  (24.4%)  have an `mrcaott…` upper bound, which has no name to print
 *   49,240  (26.4%)  have an upper bound sitting at the present itself
 *   91,680  (49.2%)  can name an ancestor that is older than the present
 *
 * Every age in the dataset comes from a chronogram of **extant** species, which
 * is the whole reason: a dated descendant is nearly always a tip at the present,
 * so the fill runs from the ancestor down to zero. That is not a missing value
 * to be papered over with "and descendant" — it is the actual lower end of the
 * span, and saying so is what makes the dashed run legible.
 *
 * The last case is the one the old phrasing hid completely. Where the nearest
 * dated relative is *itself* at the present there is no gap to spread into, and
 * `layout_ages` collapses the node onto that bound rather than inventing room.
 * A card claiming it was positioned "between" two things would be describing an
 * interpolation that did not happen.
 *
 * ## The shape
 *
 * A discriminated union rather than a formatted string, because the ancestor and
 * the descendant are both **links** — every name on this card that names a taxon
 * opens that taxon's card — and a sentence assembled here could not carry them.
 * Rendering lives in `Detail.tsx`; choosing lives here, where it can be tested
 * against the four cases without a DOM.
 */

import { isPresent, maFigure } from "../ages";
import type { LayoutSpread } from "../api";

/** A bound the card can print, with the words already decided. */
export interface SpreadEnd {
  key: string;
  /** `null` name renders as the unnamed-divergence phrase, still linked. */
  name: string | null;
  rank: string | null;
  /** "112.6 Ma", or "the present" where the figure rounds to zero. */
  age: string;
}

export type SpreadProse =
  /** Both ends are real taxa: the strongest thing the card can say. */
  | { kind: "between"; above: SpreadEnd; below: SpreadEnd }
  /** An ancestor above, the present below. The ordinary case, 70.4%. */
  | { kind: "toPresent"; above: SpreadEnd }
  /** The nearest dated relative is at the present too: no span at all. */
  | { kind: "collapsed"; above: SpreadEnd }
  /** Nothing nameable on either side. Say nothing rather than something vague. */
  | null;

/**
 * The card's wording for the shared rule in `ages.ts`.
 *
 * The threshold is the canvas label's, and has to be: a bound the axis draws at
 * zero must not be described in this paragraph as a number the label refuses to
 * print. Only the word differs — this is prose, so it takes the article the
 * mark's one-line slot cannot afford.
 */
function figure(ma: number): string {
  if (!Number.isFinite(ma) || isPresent(ma)) return "the present";
  return `${maFigure(ma)} Ma`;
}

function end(b: LayoutSpread["above"]): SpreadEnd | null {
  if (!b) return null;
  return { key: b.key, name: b.name, rank: b.rank, age: figure(b.age_ma) };
}

/**
 * Which of the four the data supports.
 *
 * A `below` older than `above` is refused rather than printed. It cannot happen
 * — the layout's monotonicity sweep guarantees an ancestor is at least as old
 * as everything under it — but the sentence built from it would read "spread
 * between 40 Ma above and 90 Ma below", which is a picture of nothing, and a
 * card is not the place to discover that an invariant broke.
 */
export function spreadProse(spread: LayoutSpread | null | undefined): SpreadProse {
  if (!spread) return null;
  const above = end(spread.above);
  if (!above) return null;

  const below = end(spread.below);
  if (below && spread.below && spread.above) {
    if (spread.below.age_ma > spread.above.age_ma) return { kind: "toPresent", above };
    return { kind: "between", above, below };
  }
  // No dated descendant. Either there is a span down to the present, or the
  // ancestor is at the present and there is no span at all.
  if (above.age === "the present") return { kind: "collapsed", above };
  return { kind: "toPresent", above };
}
