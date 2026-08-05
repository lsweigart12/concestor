/**
 * Whether this reader has asked for less movement.
 *
 * One function, because three surfaces now branch on it — the canvas drops the
 * draw-on and the reframe, the carousel stops rotating, and an opening draws
 * its taxa in one go rather than in sequence — and three copies of a media
 * query is three places for the string to be typed slightly differently.
 *
 * Read at the moment it is asked rather than subscribed to. The answer is
 * consulted at the start of an animation, and a reader who changes the setting
 * mid-draw is asking about the next one.
 */
export function prefersReduced(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}
