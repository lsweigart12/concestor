/**
 * The draw queue: taxa wait their turn to be added, and are animated one at a
 * time.
 *
 * **Nothing here knows how long a draw takes.** That was the design this
 * replaces — a `STEP_MS` floor tuned to match `Graph.tsx`'s `T_DRAW`, `STAGGER`
 * and `DRAW_MS`, restated as prose in a comment, and silently wrong the moment
 * any of the three moved. It also only ever paced *openings*: an ordinary add
 * landing mid-draw cut the previous animation off at the knees, and holding `R`
 * down drew nothing at all.
 *
 * So the queue is the general case and an opening is one caller of it. A taxon
 * may be enqueued at any moment; the head is released when its lineage has
 * arrived and the canvas is not mid-draw; the canvas says when that is, by
 * reporting each draw as it lands. The one timing anybody has to get right
 * lives in the component doing the animating.
 *
 * What an opening still needs is the *ordering* — `openings.ts` authors each
 * one so the pair that makes the point goes first and the taxon that loses the
 * argument goes last, and three or more taxa draw an argument rather than a
 * number because **the nesting is the proof**. A finished tree shows a shape
 * and asks the reader to reconstruct that; drawn in order, the salmon joins you
 * and only then does the shark arrive outside both.
 *
 * Two rules survive from the version that held a clock:
 *
 * 1. **Any interaction ends an opening, immediately, at the finished tree.**
 *    Nobody who has taken the wheel is made to wait for an animation. That is
 *    {@link flush}.
 * 2. **`prefers-reduced-motion` collapses an opening to one `open()` with the
 *    full set** — today's behaviour exactly, not a faster sequence.
 *    {@link plan} is the only place that is decided.
 *
 * This module holds no timers, no DOM and no state. `store.ts` drives it.
 */

/**
 * Why a taxon is being drawn, which is the only thing the queue carries beside
 * the key.
 *
 * It rides here rather than being set when the key is released because release
 * happens some time later, on a different tick, and `store.ts` reports the
 * cause of a change by reading a ref at the moment `view` changes. A queue that
 * did not carry it would attribute an opening's fourth taxon to whatever the
 * reader did while waiting.
 */
export type Queued = {
  key: string;
  cause: "add" | "sequence";
};

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
  queue: readonly Queued[],
  drawing: boolean,
  arrived: (key: string) => boolean,
): Queued | null {
  const head = queue[0];
  if (!head || drawing) return null;
  return arrived(head.key) ? head : null;
}

/**
 * How an opening's keys are split between the opening press and the queue.
 *
 * The single place rule 2 is decided. Reduced motion — and any opening too
 * short to have an ordering worth showing — puts every key in `first`, which
 * produces no queue at all.
 *
 * Starting from *one* taxon is deliberate: a single silhouette alone at the
 * present, and then a trace reaching back hundreds of millions of years when
 * the second one lands.
 */
export function plan(
  keys: readonly string[],
  reduced: boolean,
): { first: string[]; rest: string[] } {
  if (reduced || keys.length < 2) return { first: [...keys], rest: [] };
  return { first: [keys[0]!], rest: keys.slice(1) };
}

/**
 * Everything still waiting, in order and without duplicates — what an
 * interruption draws all at once.
 */
export function flush(queue: readonly Queued[]): string[] {
  return [...new Set(queue.map((q) => q.key))];
}
