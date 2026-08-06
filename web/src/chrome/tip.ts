/**
 * Where a tooltip goes and when it opens. `Tooltip.tsx` is the component; the
 * arithmetic lives here so it can be tested without a DOM.
 *
 * A tip opens towards the middle of the window — away from whatever edge its
 * trigger is pinned to, since the chrome lives on the edges and the room is in
 * the middle — then shifts back inside the window on both axes. `place` takes
 * three rectangles and returns a point; it reads neither the DOM nor the clock.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Size {
  w: number;
  h: number;
}

export type Side = "top" | "bottom";

export interface Placement {
  x: number;
  y: number;
  side: Side;
}

/**
 * The gap between a trigger and its tip. The pointer must cross it to reach the
 * hoverable tip without it closing, which `CLOSE_MS` covers — the two are a pair.
 */
export const GAP = 8;

/** Closest a tip may come to the window's edge. */
export const EDGE = 8;

/** The widest a tip may be drawn; `tooltip.test.ts` pins it to the stylesheet. */
export const MAX_W = 260;

/** How long a pointer must rest before a tip opens. */
export const OPEN_MS = 400;

/** The grace after the pointer leaves, before the tip goes. Covers `GAP`. */
export const CLOSE_MS = 140;

/** After a tip closes, the next one within this window opens instantly. */
export const CHAIN_MS = 400;

/**
 * Towards the middle of the window, the other way if there is no room, and
 * always inside it. Coordinates are viewport-relative for a `position: fixed`
 * layer; no scroll offset enters.
 */
export function place(anchor: Rect, tip: Size, vp: Size): Placement {
  // Open away from the nearer horizontal edge, which is provably the side with
  // more room (r₋ ≥ r₊ ⇔ y + h/2 ≥ H/2), so no separate flip pass is needed.
  const side: Side = anchor.y + anchor.h / 2 > vp.h / 2 ? "top" : "bottom";

  const y =
    side === "bottom" ? anchor.y + anchor.h + GAP : anchor.y - GAP - tip.h;
  // Centred on the trigger, then clamped back inside the window.
  const x = anchor.x + anchor.w / 2 - tip.w / 2;

  return { x: clamp(x, tip.w, vp.w), y: clamp(y, tip.h, vp.h), side };
}

/**
 * Inside the window on one axis. When the tip is larger than the window
 * (`limit < EDGE`), resolve to the near edge so the end of the sentence is lost
 * rather than the start.
 */
function clamp(v: number, size: number, extent: number): number {
  const limit = extent - EDGE - size;
  return limit < EDGE ? EDGE : Math.max(EDGE, Math.min(v, limit));
}

/**
 * How long this tip should wait, given when the last one closed. `null` means
 * none has been shown or the chain has lapsed.
 */
export function openDelay(now: number, lastClosed: number | null): number {
  if (lastClosed === null) return OPEN_MS;
  return now - lastClosed <= CHAIN_MS ? 0 : OPEN_MS;
}
