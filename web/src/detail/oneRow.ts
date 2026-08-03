/**
 * How many items of a wrapping list fit on its first row, leaving room for a
 * "+N more" control at the end.
 *
 * Separated from the component because the component cannot be tested: the
 * suite runs in `node` with no layout engine, so `offsetTop` is 0 for
 * everything and a DOM test would pass on a rule that is wrong. The arithmetic
 * is the part with the mistakes in it, so the arithmetic is what gets pinned.
 *
 * The same split is why `labels.ts` computes canvas label geometry in a pure
 * function rather than measuring the rendered SVG.
 */

/** One laid-out item, in the container's own coordinates. */
export interface Box {
  /** Offset from the container's content-box left edge. */
  left: number;
  width: number;
  /** Offset from the container's content-box top edge. Row identity. */
  top: number;
}

/**
 * Rows are identified by `top`, and sub-pixel layout means they are never
 * exactly equal. A row of 12.5px text is ~21px tall, so anything under a
 * couple of pixels is the same row and nothing legitimate falls in between.
 */
const SAME_ROW_PX = 2;

/**
 * The count to render when collapsed.
 *
 * Returns `items.length` when everything already fits on one row — the caller
 * reads that as *no control needed*, which is the only signal it gets and the
 * reason this returns a count rather than a boolean pair.
 *
 * `reserve` is the control's width **plus the gap before it**; folding the gap
 * in here keeps this function ignorant of the layout's spacing, which is a CSS
 * concern that would otherwise have to be duplicated as a constant.
 *
 * At least one item always survives. A single name wider than the whole row is
 * a name that will be clipped either way, and answering "0 names, +6 more" is
 * strictly worse than showing the one the ranking says matters most.
 */
export function fitOneRow(
  items: readonly Box[],
  reserve: number,
  rowWidth: number,
): number {
  if (items.length === 0) return 0;
  const top = items[0]!.top;
  let onFirstRow = 0;
  for (const b of items) {
    if (Math.abs(b.top - top) > SAME_ROW_PX) break;
    onFirstRow += 1;
  }
  // Everything fits unaided, so no control is needed and none of its width has
  // to be found. Checked before the reserve loop rather than after: a list that
  // exactly fills its row must not lose its last name to make room for a
  // control that would then have nothing to count.
  if (onFirstRow === items.length) return items.length;

  let n = 0;
  for (let i = 0; i < onFirstRow; i += 1) {
    const b = items[i]!;
    if (b.left + b.width + reserve > rowWidth) break;
    n = i + 1;
  }
  return Math.max(1, n);
}
