/**
 * An opening, drawn one taxon at a time.
 *
 * `openings.ts` authors each opening's taxa in a deliberate order — "the pair
 * that makes the point goes first and the taxon that loses the argument goes
 * last", and the fish opening puts its two rulers last because they are staging
 * rather than claim. Drawing the whole set in one `open()` discarded that
 * ordering, and with it the thing the file's own thesis rests on: three or more
 * taxa draw an *argument* rather than a number, and **the nesting is the
 * proof**. A nesting is an ordering. A finished tree shows a shape and asks the
 * reader to reconstruct the argument out of the `reveal` sentence; drawn in
 * sequence, the salmon joins you and only then does the shark arrive outside
 * both, and the canvas states the claim itself.
 *
 * It also teaches the interaction. A reader watching a species join and the
 * tree reorganise around it has been shown, without a word, the one thing they
 * have to do next.
 *
 * **The shape is `open()` with the first taxon, then `add()` for the rest.**
 * That keeps the one thing `store.ts`'s `open` is really protecting — the
 * animation baseline is reset exactly once, on the same path a cold `?n=…` load
 * takes — while turning the per-key `addDelta` that comment used to call a
 * defect into the point of the feature. The objection it recorded was that
 * repeated `add` leaves the previous canvas standing. Open-then-step does not.
 *
 * Starting from *one* taxon is deliberate: a single silhouette alone at the
 * present, and then a trace reaching back hundreds of millions of years when
 * the second one lands.
 *
 * Four rules govern it, and they are the same discipline
 * `chrome/OpeningCarousel.tsx` is built on — an auto-advancing surface is only
 * honest while every one of them holds:
 *
 * 1. **A step waits on its lineage, not on the clock.** Each key needs
 *    `/v1/path`. The whole set is prefetched on the press and a step lands when
 *    its path has arrived *and* the floor below has elapsed, so a cold cache
 *    delays the sequence rather than desynchronising it from the canvas.
 * 2. **Any interaction ends it, immediately, at the finished tree.** A
 *    keypress, a click, the palette, a scroll. Nobody who has taken the wheel is
 *    made to wait for an animation.
 * 3. **`prefers-reduced-motion` collapses to one `open()` with the full set** —
 *    today's behaviour exactly, not a faster sequence. {@link plan} is the only
 *    place that decision is made.
 * 4. **It fires on a press and never on boot.** An autoplaying build on the
 *    empty canvas is an advertisement, and the empty canvas is where the
 *    carousel already lives.
 *
 * This module is the decision half and holds no timers, no DOM and no state of
 * its own. `store.ts` drives it.
 */

/**
 * The floor between steps, in ms.
 *
 * Long enough for the signature draw to arrive and the reframe to settle:
 * `Graph.tsx` starts a trace at `T_DRAW` and finishes it a wave-stagger plus
 * `DRAW_MS` later — about 830ms for a two-wave add — and schedules the fit
 * 260ms in for 520ms. The decay overlaps into the next step on purpose, because
 * a settle is not something the next beat has to wait for.
 *
 * It is a floor and not an interval. The step lands at `max(this, whenever the
 * path arrives)`, so on a cold container the pacing is the network's and the
 * canvas never runs ahead of the data it is drawing.
 */
export const STEP_MS = 1300;

export interface Sequence {
  /** The opening's keys, in `openings.ts` order. Includes the one already drawn. */
  keys: readonly string[];
  /** How many are on the canvas. Never 0 — `open()` drew the first. */
  drawn: number;
  /** When the last step landed, on the same clock as `step`'s `now`. */
  since: number;
  /**
   * The prefetch has answered for every key, however it answered.
   *
   * Load-bearing, and not merely an optimisation: a key that resolves to
   * nothing never appears in `paths`, so a sequence gated on arrival alone
   * would stall for ever on one stale id. Once the batch has settled, what is
   * absent is absent, and the step is allowed through to draw nothing — which
   * is what a single `open()` of the same set does today.
   */
  settled: boolean;
}

/**
 * What to do now.
 *
 * A `hold` carries the key it is holding for, so the driver can arm a timer
 * that draws directly rather than waking up to ask again. `after` is `null`
 * when the only thing that can move this along is an arrival — there is nothing
 * to time, and the store's `paths` changing is the wake-up.
 */
export type Step =
  | { kind: "hold"; key: string; after: number | null }
  | { kind: "draw"; key: string }
  | { kind: "done" };

/**
 * How an opening's keys are split between the opening press and the sequence.
 *
 * The single place rule 3 is decided. Reduced motion — and any opening too
 * short to have an ordering worth showing — puts every key in `first`, which is
 * exactly today's call and produces no sequence at all.
 */
export function plan(
  keys: readonly string[],
  reduced: boolean,
): { first: string[]; rest: string[] } {
  if (reduced || keys.length < 2) return { first: [...keys], rest: [] };
  return { first: [keys[0]!], rest: keys.slice(1) };
}

/**
 * The next move, given the clock and what has arrived.
 *
 * Pure, and the argument order says why: `now` and `arrived` are both handed
 * in, so the rule "arrival first, then the floor" is a thing a test can state
 * rather than a thing a test has to wait for.
 */
export function step(
  seq: Sequence,
  now: number,
  arrived: (key: string) => boolean,
): Step {
  if (seq.drawn >= seq.keys.length) return { kind: "done" };
  const key = seq.keys[seq.drawn]!;
  // Arrival is the gate. Nothing about the elapsed time can open it, which is
  // rule 1 stated in one line.
  if (!seq.settled && !arrived(key)) return { kind: "hold", key, after: null };
  const waited = now - seq.since;
  if (waited < STEP_MS) return { kind: "hold", key, after: STEP_MS - waited };
  return { kind: "draw", key };
}

/** The keys not yet on the canvas. What an abort draws, all at once. */
export function remaining(seq: Sequence): string[] {
  return seq.keys.slice(seq.drawn);
}
