/**
 * Where the viewport sits when something else is sitting on the canvas.
 *
 * The detail card is `position: fixed` over the top-right corner, and the
 * canvas did not know it was there. Clicking a mark therefore routinely opened
 * a 360px panel directly on top of the mark that had just been clicked — the
 * one element on screen the reader has said they are looking at.
 *
 * Two answers, to two different questions:
 *
 *   - {@link cardReserve} narrows the canvas the *fit* is computed against, so
 *     the whole tree reframes into what is left. This is the same thing a real
 *     window resize already does and it works for the same reason: the plot
 *     width follows the free width, so the fit stays near 1:1 and the labels
 *     keep their designed size rather than being scaled into illegibility.
 *   - {@link revealShift} is the floor under that. The reserve is refused where
 *     it would leave too little canvas to draw a legible tree in, and it is not
 *     applied at all while the reader has a view of their own that reframing
 *     would destroy — so in both of those cases the subject can still end up
 *     under the card, and the smallest pan that brings it back out is what
 *     happens instead.
 *
 * Everything here is screen pixels and pure arithmetic. The layout knows
 * nothing about the card; only the transform does.
 */

import type { Rect } from "../tree/labels";

/**
 * `.detail`'s own width and the gap it keeps from the window edge, in px.
 *
 * Pinned to styles.css by `viewport.test.ts`, on the same principle as
 * `labels.ts`'s font constants: a number that is measured in one file and drawn
 * in another drifts, and here the drift is silent — the tree simply starts
 * sliding a little way under the card again.
 */
export const CARD_W = 360;
export const CARD_GAP = 16;

/**
 * At or below this width the card stops hanging in the corner and spans the
 * window instead, under the control bar. It is then covering the *top* of the
 * canvas rather than the right of it, so there is no right-hand reserve to
 * take — and 620 − 392 is 228px of canvas, which is not a canvas.
 */
export const CARD_STACK_W = 620;

/** The card's whole footprint: its width, its margin, and a gap to the tree. */
export const CARD_RESERVE = CARD_W + CARD_GAP * 2;

/**
 * Where the stacked card ends: its `top`, plus its `max-height`, as a share of
 * the window. Both are pinned to styles.css alongside the width.
 */
export const CARD_STACK_TOP = 46;
export const CARD_STACK_MAX_H = 0.58;

/**
 * The narrowest canvas worth reframing a tree into.
 *
 * Below this the reserve stops being a kindness. The plot floors at
 * `MIN_PLOT_W` (340) and the labels hanging off both sides are worth another
 * 250–300 between them, so a free strip under ~420px fits that content at a
 * scale that renders 12.5px type at around 7px. The names no longer *vanish*
 * there — the semantic-zoom tiers that used to drop them are gone — which makes
 * this threshold matter more rather than less: what is left is names nobody can
 * read, and the reader has no way to tell that from names badly drawn. A tree
 * with a corner covered is the better answer, so under this width the reserve
 * is refused and {@link revealShift} is the whole of the remedy.
 */
export const MIN_FREE_W = 420;

/** Never let the fit collapse to nothing, whatever the container reports. */
const MIN_USABLE = 160;

/**
 * How much of the right edge an open card owns, in screen px.
 *
 * Zero when no card is open, when the card is stacked across the top instead,
 * and when honouring it would leave less canvas than {@link MIN_FREE_W}.
 */
export function cardReserve(vw: number, open: boolean): number {
  if (!open || vw <= CARD_STACK_W) return 0;
  return vw - CARD_RESERVE >= MIN_FREE_W ? CARD_RESERVE : 0;
}

/** As much of an element as the question below needs. */
export interface Measured {
  clientWidth: number;
  clientHeight: number;
}

/**
 * Whether the canvas is a container the browser has not laid out yet.
 *
 * **Nothing here may move the viewport while this is true**, and asking React
 * Flow instead of measuring cannot answer it. `useResizeHandler` writes
 * `size.width || 500` into the store, so a container measuring zero is filed
 * as a square 500px canvas — "no canvas yet" and "a 500px canvas" are the same
 * two numbers, and every `vw`/`vh` in this file inherits that. Hand the
 * resulting move to d3-zoom with a duration and its tween divides by the
 * container's *real* extent, which is zero: `interpolateZoom` resolves to NaN
 * and the store transform is NaN for the length of the animation.
 *
 * That is one value, and everything downstream goes with it — React Flow's own
 * background `<pattern>` and the dots inside it, `--icon-scale`, and every tick
 * the axis projects. The axis is the visible half: `buildTicks` refuses a tick
 * it cannot place, correctly, so the whole ruler empties rather than drawing
 * one tick in the wrong place. A reader on a cold load watches every date
 * vanish and come back.
 *
 * **Refusing costs nothing**, which is what makes this the fix rather than a
 * guard. Every caller re-runs on a size change, so the move lands the moment
 * there is a canvas to land it in — and it is then computed against the real
 * one rather than against an invented 500.
 *
 * A ref that has not attached yet reports `null`, and that is *not* a refusal:
 * there is nothing to measure, so there is nothing to disagree with.
 */
export function unlaidOut(el: Measured | null | undefined): boolean {
  return !!el && (el.clientWidth === 0 || el.clientHeight === 0);
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Content bounds with a margin on every side. */
export function fitContentPad(content: Rect, pad: number): Rect {
  return {
    x: content.x - pad,
    y: content.y - pad,
    w: content.w + pad * 2,
    h: content.h + pad * 2,
  };
}

interface FitBox {
  /** Content bounds in layout units, margin already included. */
  content: Rect;
  vw: number;
  vh: number;
  /** Screen px the card owns on the right. */
  reserve: number;
  /** Screen px the axis and any open lane own at the bottom. */
  bottom: number;
  maxZoom: number;
}

/**
 * The transform that frames `content` inside the part of the container nothing
 * else is sitting on.
 *
 * Centred in the free region rather than in the container, which is the whole
 * of what the reserve does to the fit: the same tree, the same scale rule, one
 * narrower box to put it in.
 */
export function fitViewport(b: FitBox): Viewport {
  const usableW = Math.max(b.vw - b.reserve, MIN_USABLE);
  const usableH = Math.max(b.vh - b.bottom, MIN_USABLE);
  const zoom = Math.min(
    usableW / Math.max(b.content.w, 1),
    usableH / Math.max(b.content.h, 1),
    b.maxZoom,
  );
  return {
    x: (usableW - (2 * b.content.x + b.content.w) * zoom) / 2,
    y: (usableH - (2 * b.content.y + b.content.h) * zoom) / 2,
    zoom,
  };
}

/**
 * The part of the canvas a reader can actually see a mark in.
 *
 * Not the same question as {@link cardReserve}, and the difference is the whole
 * reason both exist. The reserve asks whether it is worth *re-laying out* the
 * tree around the card, and answers no on a narrow window and no while the
 * reader has a view of their own. This asks where the card physically is, which
 * has one answer whatever the layout decided — a card refused a reserve is
 * still 360px of opaque panel over the tree.
 *
 * On a stacked card that panel is across the **top** rather than the right, so
 * the free region is the strip below it. Narrow and often short, but it is
 * where the subject has to go, and the alternative is a mark nobody can see.
 */
export function freeRect(opts: {
  vw: number;
  vh: number;
  /** Screen px the axis and any open lane own at the bottom. */
  bottom: number;
  cardOpen: boolean;
  /** Breathing room from every edge. */
  pad: number;
}): Rect {
  const { vw, vh, bottom, cardOpen, pad } = opts;
  const stacked = cardOpen && vw <= CARD_STACK_W;
  const top = stacked ? CARD_STACK_TOP + vh * CARD_STACK_MAX_H + pad : pad;
  const right = cardOpen && !stacked ? CARD_RESERVE : 0;
  return {
    x: pad,
    y: top,
    w: Math.max(vw - right - pad * 2, 1),
    h: Math.max(vh - bottom - top, 1),
  };
}

/**
 * The smallest pan that puts `subject` inside `free`. Both in screen px.
 *
 * Exactly `{0, 0}` when it is already inside, so the caller can treat this as
 * "is there anything to do" without a second predicate that could disagree
 * with it.
 */
export function revealShift(
  subject: Rect,
  free: Rect,
): { dx: number; dy: number } {
  return {
    dx: shift1(subject.x, subject.w, free.x, free.w),
    dy: shift1(subject.y, subject.h, free.y, free.h),
  };
}

function shift1(a: number, len: number, lo: number, span: number): number {
  // Wider than the space it has to go in — a chosen leaf's label can be, and a
  // narrow window makes it common. Centring is the least-bad placement and,
  // more to the point, it is stable: clamping both edges of something too large
  // resolves to whichever edge the code happens to test first, so the mark
  // would jump left or right depending on which way it was already overflowing.
  if (len >= span) return lo + (span - len) / 2 - a;
  if (a < lo) return lo - a;
  if (a + len > lo + span) return lo + span - (a + len);
  return 0;
}

/** A layout-space rect under a viewport transform. */
export function toScreenRect(r: Rect, v: Viewport): Rect {
  return {
    x: r.x * v.zoom + v.x,
    y: r.y * v.zoom + v.y,
    w: r.w * v.zoom,
    h: r.h * v.zoom,
  };
}

/** The union of two rects, which is a subject's dot and its label. */
export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}
