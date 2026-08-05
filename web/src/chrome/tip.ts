/**
 * Where a tooltip goes and when it opens. `Tooltip.tsx` is the component; the
 * arithmetic lives here so it can be tested, this project having no DOM to
 * render into.
 *
 * **Why there is a component at all.** Every hover explanation in this app was
 * a `title` attribute, which is the browser's own tooltip: unstyleable, about a
 * second late, wrapped wherever the platform feels like wrapping it, gone on a
 * touch screen, and positioned under the cursor rather than against the control
 * — so the bioluminescence switch, which sits bottom left, explained itself
 * *over the timeline*. It is also the only widget in the app a reader cannot
 * dismiss, cannot enlarge, and cannot reach with a keyboard.
 *
 * That is the mechanism. The copy was the other half: `title` is a slot with no
 * cost to filling, so it filled with the reasoning that belongs in these header
 * comments — 372 characters of taxonomy policy on one segment of one switch,
 * delivered by an OS tooltip that cannot be selected or scrolled. A tooltip is
 * a sentence. What needs a paragraph needs the about page, and `AboutPage.tsx`
 * is where the paragraphs went.
 *
 * **Placement is prefer, flip, then shift.**
 *
 * The preference is the part that answers the actual complaint, and "below by
 * default, flip when it does not fit" would not have. The bioluminescence
 * switch sits about 100px off the foot of an 800px window, and a 48px tip below
 * it *fits* — it fits straight across the timeline, which is what the native
 * tooltip was already doing. Fitting is not the test. So a trigger in the lower
 * half of the window opens **upward** and one in the upper half opens
 * downward: a tip goes towards the middle of the window, away from whatever
 * edge its trigger is pinned to, which is where the room actually is on a
 * layout whose chrome lives on the edges. It needs no per-caller
 * configuration and cannot be forgotten at a call site, which the alternative —
 * a `side` prop on `useTip` — could and would.
 *
 * The flip is then the fallback: preferred side, the other side if the
 * preferred one does not fit, and the roomier of the two if neither does.
 *
 * The shift is the half that gets forgotten. The mode panel is pinned to the
 * *left* edge, so a 260px tip centred on a 44px switch at x=24 starts at −87
 * and loses the beginning of its sentence off-screen.
 *
 * Nothing here reads the DOM or the clock. `place` is given three rectangles
 * and returns a point, so the awkward cases — a tip taller than the window, a
 * trigger already off-screen — are ordinary arithmetic with a test each rather
 * than something to reproduce in a browser at the right window size.
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
 * The gap between a trigger and its tip.
 *
 * It is not only decoration: the tip is hoverable — WCAG 1.4.13 requires that,
 * so a reader magnifying the screen can put the pointer on the words — and the
 * pointer has to cross this gap to get there without the tip closing under it.
 * `CLOSE_MS` is what covers the crossing, and the two numbers are a pair.
 */
export const GAP = 8;

/** Closest a tip may come to the window's edge. */
export const EDGE = 8;

/**
 * The widest a tip may be drawn, and `tooltip.test.ts` pins it to the
 * stylesheet by reading it. The measure matters more than the number: past
 * about 45 characters a line the eye loses the return sweep, and a tooltip is
 * read once, quickly, off to the side of whatever the reader was doing.
 */
export const MAX_W = 260;

/**
 * How long a pointer must rest before a tip opens.
 *
 * Long enough that crossing a row of controls on the way somewhere else opens
 * nothing — the mode panel is three switches with eight segments between them,
 * and a tip per segment on the way past is the flicker that makes people turn
 * tooltips off. Short enough to feel like an answer rather than a wait.
 */
export const OPEN_MS = 400;

/**
 * The grace after the pointer leaves, before the tip goes.
 *
 * Covers `GAP` in both directions: the pointer moving onto the tip to read it,
 * and the small overshoot on the way out of a 20px-tall segment.
 */
export const CLOSE_MS = 140;

/**
 * How long the reader stays "in" the tooltips after one closes.
 *
 * Inside this window the next tip is instant. Once somebody has asked what
 * *off* means, moving one segment right to ask about *on* should answer, not
 * make them wait again — the delay exists to suppress tips nobody asked for,
 * and by then they have asked. Every segmented control in this app is a row of
 * neighbours, so this is the common case and not the clever one.
 */
export const CHAIN_MS = 400;

/**
 * Towards the middle of the window, the other way if there is no room, and
 * always inside it.
 *
 * `anchor` and the result are both in viewport coordinates, which is what
 * `getBoundingClientRect` returns and what a `position: fixed` layer wants —
 * no scroll offset enters this at any point.
 */
export function place(anchor: Rect, tip: Size, vp: Size): Placement {
  /*
    Away from the nearer horizontal edge — and this one line is also "whichever
    side has more room", which is worth the proof because it is why there is no
    flip below.

    Writing r₊ for the room under the trigger and r₋ for the room over it, with
    the same tip on either side:

      r₋ = y − GAP − h_tip − EDGE
      r₊ = H − EDGE − (y + h + GAP + h_tip)
      r₋ − r₊ = 2y + h − H

    So r₋ ≥ r₊ exactly when y + h/2 ≥ H/2. The test below *is* the comparison,
    and a separate "flip if it does not fit" pass can therefore never fire for
    a trigger inside the window: it would have to prefer the side with less
    room. The clamps are what handle the rest — a tip taller than the window, a
    trigger scrolled off the edge of a card — and they handle it in one place
    for both axes instead of two rules that have to agree.
  */
  const side: Side = anchor.y + anchor.h / 2 > vp.h / 2 ? "top" : "bottom";

  const y =
    side === "bottom" ? anchor.y + anchor.h + GAP : anchor.y - GAP - tip.h;
  // Centred on the trigger, then shifted back inside the window. The order is
  // load-bearing: clamping a centred x is one line, while choosing an edge to
  // align to needs a rule for which edge, and gets it wrong on the trigger
  // that sits in the middle.
  const x = anchor.x + anchor.w / 2 - tip.w / 2;

  return { x: clamp(x, tip.w, vp.w), y: clamp(y, tip.h, vp.h), side };
}

/**
 * Inside the window on one axis.
 *
 * The `limit < EDGE` arm is the degenerate case — a tip larger than the window
 * it is being drawn in — and it resolves to the near edge rather than to a
 * negative offset, so what is lost is the end of the sentence rather than the
 * start of it.
 */
function clamp(v: number, size: number, extent: number): number {
  const limit = extent - EDGE - size;
  return limit < EDGE ? EDGE : Math.max(EDGE, Math.min(v, limit));
}

/**
 * How long this tip should wait, given when the last one closed.
 *
 * `null` means none has been shown, or the chain has lapsed. Kept as a function
 * of two numbers rather than a flag on the store so the boundary is a test
 * rather than a thing to sit and observe.
 */
export function openDelay(now: number, lastClosed: number | null): number {
  if (lastClosed === null) return OPEN_MS;
  return now - lastClosed <= CHAIN_MS ? 0 : OPEN_MS;
}
