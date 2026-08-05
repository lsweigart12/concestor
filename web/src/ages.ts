/**
 * How an age in Ma is written as a figure, in one place.
 *
 * Two things live here and nothing else: the threshold under which an age is
 * the present rather than a number, and the ladder of digits a figure gets.
 * They were written out four times — the drill lane's `maLabel`, the canvas
 * mark's `ageLabel`, the detail card's `figure` and the witness card's
 * `gapLabel` — with the threshold inline at five sites and no test tying any
 * copy to any other. Three of those surfaces can be on screen at once, so a
 * change to either rule would have disagreed with itself in front of the
 * reader.
 *
 * **The wording stays on the surfaces, because it is genuinely theirs.** The
 * lane says "present" bare and the card says "the present"; the mark carries
 * `≤ ` where the tier is `interpolated`; `endedSpanLabel` refuses the word
 * outright and keeps a significant figure instead, because its tier is only
 * applied where nothing below the node is alive and *Homo erectus* rendering as
 * "5.3 Ma – present" is a plain falsehood. Four sentences about one figure.
 * `ages.test.ts` pins each of them to the figure and censuses the corpus so a
 * fifth copy cannot appear quietly.
 */

/**
 * Under this, an age is a place and not a quantity.
 *
 * Every age in the dataset comes from a chronogram of extant species, so the
 * tips sit at zero and `layout_ages` collapses a good many nodes onto a bound
 * within a rounding error of it. A figure there prints "0.0 Ma", which claims a
 * precision the arrays do not have about the one position the axis already
 * shows. So each surface says a word instead. *Which* word is the surface's
 * business; that there is one is not.
 */
export const PRESENT_MA = 0.05;

/**
 * NaN is not the present. It is not anything, and guarding it is the caller's:
 * `ageLabel` returns null on it and `figure` says "the present", which are
 * different right answers to different questions.
 */
export function isPresent(ma: number): boolean {
  return ma < PRESENT_MA;
}

/**
 * The figure alone — no unit, no word, no bound marker.
 *
 * A tenth of a Ma is worth a character at 4.5 and is noise at 450, so the digit
 * goes at 10. **There is no second rung at 100**, and the three copies that
 * carried one were carrying nothing: `String(Math.round(ma))` and
 * `ma.toFixed(0)` produce the same string for every value this can be handed,
 * infinities included, which is why `gapLabel` never had it. The claim is
 * measured rather than reasoned — `ages.test.ts` holds all four original
 * ladders verbatim and sweeps them against this one, the way `induced.test.ts`
 * pins its port to `render.py`.
 */
export function maFigure(ma: number): string {
  if (ma >= 10) return ma.toFixed(0);
  return ma.toFixed(1);
}

/**
 * A distance in Ma, for the gap between a fork and a witness's range.
 *
 * The documented variant, and it sits here rather than beside its one caller so
 * that the thing it varies from is the paragraph above it. A gap is a
 * *quantity* and not a position, so both shared rules are wrong for it: "the
 * range stops present short" is nonsense, and rounding to whole numbers from 10
 * is what made the horse–rhino fork show 56 Ma beside a 56–51 Ma range and then
 * deny they meet. So it keeps a digit wherever one is load-bearing, never
 * collapses to a word, and floors at a tenth rather than at `PRESENT_MA`.
 */
export function gapLabel(ma: number): string {
  if (ma < 0.1) return "under 0.1 Ma";
  if (ma < 10) return `${ma.toFixed(1)} Ma`;
  return `${Math.round(ma)} Ma`;
}
