/**
 * The draw queue: taxa wait their turn to be added, and are animated one at a
 * time.
 *
 * **Nothing here knows how long a draw takes.** A taxon may be enqueued at any
 * moment — a palette row, a press of `R` held down, a fossil — and the head is
 * released when its lineage has arrived and the canvas is not mid-draw. The
 * canvas says when that is, by reporting each draw as it lands, so the pace is
 * the animation's and the one timing anybody has to get right lives in the
 * component doing the animating.
 *
 * This module holds no timers, no DOM and no state. `store.ts` drives it.
 */

/**
 * Whether the head may be released now.
 *
 * `arrived` is the gate and `drawing` is the pace. Arrival first: a step waits
 * on its lineage rather than on anything else, so a cold cache delays the queue
 * instead of desynchronising it from the canvas.
 *
 * Pure, and the argument order says why — both facts are handed in, so "arrival
 * first, then the canvas" is something a test can state rather than wait for.
 */
export function releasable(
  queue: readonly string[],
  drawing: boolean,
  arrived: (key: string) => boolean,
): string | null {
  const head = queue[0];
  if (head === undefined || drawing) return null;
  return arrived(head) ? head : null;
}
