/**
 * The reaction running down a branch: a river of light-emitting pinpoints
 * inside a near-transparent tube.
 *
 * Three earlier cuts are worth recording, because each was wrong in a way the
 * next fixed.
 *
 * A **`stroke-dasharray` train** swept along the path came first. A dash
 * pattern can only translate rigidly — every swell keeps its length and its
 * spacing forever — so what travelled was a row of solid objects sliding down a
 * tube. No amount of jitter fixes that; the information is not in the pattern.
 *
 * A **variable-width ribbon** driven by a 1-D density solver came second, and it
 * was real fluid. But it showed the flow by *distending the tube*, and a branch
 * that swells is a branch whose width is saying something.
 *
 * **Lagrangian tracers on the CPU** came third and shipped. It was the right
 * physics and the wrong budget: every tracer was an object to advance, so a
 * branch could afford about a hundred, and a hundred points strung along a line
 * reads as beads on a wire. What a jellyfish lighting up a tentacle looks like
 * is *thousands*, dense enough that their haloes merge into a continuous glow
 * with texture in it — and that is not a number you can reach while each one
 * costs a step of JavaScript.
 *
 * So: **nothing is integrated at all.** A pinpoint's position is a closed-form
 * function of its index and the clock, evaluated in a vertex shader, and this
 * file's job is only to say what each branch's *constants* are. The bunching
 * survives intact — see `gl/tuning.ts`'s `ampFor`, which is the same
 * peristaltic wave written as a displacement rather than a velocity, plus the
 * bound that keeps it from folding.
 *
 * Everything is in **normalised arc length** `s ∈ [0, 1]`, so one branch's
 * constants serve a three-pixel hominin split and a nine-hundred-pixel
 * eukaryote stem without caring which it is. Only the speed and the population
 * are denormalised, so the reaction crosses every branch at the same *physical*
 * rate and every branch carries the same pinpoints per pixel.
 */

import { hashKey } from "./biolum";
import {
  TIER_INTERPOLATED,
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
  type Tier,
} from "../api";
import { branchParams } from "./gl/tuning";
import type { BranchSource } from "./gl/renderer";

export { PATH_SAMPLES } from "./gl/renderer";
export type { BranchSource } from "./gl/renderer";

/**
 * How bright a branch's river may be, given what is known about its date.
 *
 * **This is the dash channel's concession, and it moved out of CSS when the
 * stream moved onto the canvas.** The rule it enforces has not changed: the
 * dash pattern says whether anybody has estimated a date, it is the claim this
 * app can least afford to blur, and a bright river running along a dashed line
 * may not compete with the dashes at the moment they are making their only
 * statement. A river concedes most where the line concedes most.
 *
 * A plain function rather than a stylesheet rule because neither canvas nor
 * GLSL has a cascade — which also makes it directly testable, where the CSS
 * version needed a test that read the stylesheet as text.
 */
export function tierBrightness(tier: Tier, unbounded: boolean): number {
  if (unbounded) return 0.22;
  if (tier === TIER_STRUCTURAL || tier === TIER_OCCURRENCE) return 0.32;
  if (tier === TIER_INTERPOLATED) return 0.55;
  return 1;
}

/**
 * When each branch was last plucked.
 *
 * Module-level rather than per-source, because a pluck outlives the React pass
 * that started it: the layout can be rebuilt mid-ring, and a surge held on the
 * source object would be thrown away with it. Keyed by edge id, which survives.
 */
const surges = new Map<string, number>();

export function surgeBranch(id: string, at: number = performance.now()): void {
  surges.set(id, at);
}

export function surgeOf(id: string): number | undefined {
  return surges.get(id);
}

/**
 * The landing: every branch rings at once, when the last one has arrived.
 *
 * The entrance reaches out of the root a wave at a time, and then the whole
 * tree **locks in** — one pluck across every branch on the canvas, with the
 * rivers surging into it. Deliberately simultaneous where the draw is
 * staggered: a staggered settle reads as the animation still going, and the
 * whole point of this beat is that it has stopped.
 *
 * A bus rather than a prop, for the reason the spill bus had before it: the
 * thing that knows the sequence is finished is `Graph.tsx` and the things that
 * ring are eighteen memoised edges. Threading a callback through React Flow's
 * `data` bag would re-create it on every layout pass and defeat the memo on
 * every edge on the canvas, to deliver an event that has nothing to do with
 * React's render at all. A tree landing is not state. It is a thing that
 * happened.
 */
type LandingListener = () => void;
const landings = new Set<LandingListener>();

export function land(): void {
  for (const fn of landings) fn();
}

export function onLanding(fn: LandingListener): () => void {
  landings.add(fn);
  return () => {
    landings.delete(fn);
  };
}

/**
 * A branch's river, and where to draw it.
 *
 * Registered rather than drawn in place, because every pinpoint belongs in the
 * renderer's single light buffer: that buffer is what the marine snow reads to
 * know how much light is near it, and what the glass reads to know what to
 * reflect. A branch drawing its own would light nothing and be lit by nothing.
 *
 * It also collapses every branch on the canvas into one instanced draw call.
 */
const sources = new Map<string, BranchSource>();
let generation = 0;

export function registerFlow(src: BranchSource): () => void {
  sources.set(src.id, src);
  generation++;
  return () => {
    sources.delete(src.id);
    surges.delete(src.id);
    generation++;
  };
}

export function flowSources(): readonly BranchSource[] {
  return [...sources.values()];
}

/** Bumped whenever the set changes, so the renderer knows to re-upload. */
export function flowGeneration(): number {
  return generation;
}

export { branchParams, hashKey };
