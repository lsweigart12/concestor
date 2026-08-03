/**
 * The numbers the shaders are assembled from, and the one bound that is not a
 * matter of taste.
 *
 * `tuning.ts` says why this file exists at all: GLSL cannot be unit-tested in
 * node, it runs on a device the test runner has no access to, and it fails by
 * drawing something slightly wrong rather than by throwing. So every judgement
 * the renderer makes is a constant or a pure function *here*, and the shader is
 * a layout of them. This is where the ones with a property worth stating get
 * stated.
 *
 * The property that matters most is {@link ampFor}'s. The rest — a quota that
 * scales with a branch's length, a decay that starts at one and ends at zero, a
 * branch that is the same river on every render — are the sort of thing that
 * looks fine on screen while being subtly wrong, which is the whole reason they
 * are functions rather than expressions inside a template literal.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DRAW_MS } from "../TraceEdge";
import {
  bezierEase,
  DRAW_BEZIER,
  revealAt,
  CROSS_MAX_S,
  CROSS_MIN_S,
  FLOW_SPEED,
  HALF_W_MIN,
  HALF_W_SPAN,
  MAX_FOLD,
  MAX_PER_BRANCH,
  MIN_PER_BRANCH,
  PINPOINTS_PER_PX,
  WAVE_AMP,
  ampFor,
  branchParams,
  decay,
  quotaFor,
} from "./tuning";

const TAU = 2 * Math.PI;

/** Seeds a branch can actually arrive with, grafts (negative) included. */
const SEEDS = [0, 1, -1, 7, 41, 512, 99991, 588427, -108454, 2 ** 31 - 1];

/** Lengths a branch can actually be drawn at, from a hominin split upward. */
const LENGTHS = [0, 3, 30, 140, 420, 900, 4000];

/**
 * The fold bound, plus a double's last bit.
 *
 * On the clamped arm the product is `2πk · (MAX_FOLD / 2πk)`, which is exactly
 * `MAX_FOLD` in the reals and `0.8000000000000002` in binary64 — the reciprocal
 * and the multiply do not cancel. The slack is deliberately far below anything
 * that could hide a real breach: a clamp that had simply been dropped overshoots
 * by 70% at the top of `branchParams`' wavenumber range, not by 2 parts in
 * 10¹⁶.
 */
const CEILING = MAX_FOLD * (1 + 1e-12);

describe("ampFor", () => {
  /**
   * **The one bound in this file that is not a matter of taste.**
   *
   * The stream advances uniformly and is then displaced by a wave,
   * `s' = s + a·sin(2π(k·s − f·t))`, so its derivative is `1 + 2πka·cos(…)`.
   * Past `2πka = 1` that derivative changes sign and the map folds: every
   * pinpoint in the folded interval lands in the same place. On screen that is
   * a caustic — a hard-edged white block sitting on the branch — and it is not
   * a clipping artefact, so no tone map removes it. The light really is that
   * concentrated. `tuning.ts` records that it took three wrong diagnoses first,
   * because a caustic looks exactly like a rendering bug.
   *
   * Swept far past anything `branchParams` can produce, because the bound is a
   * property of the closed form rather than of the current wavenumber range,
   * and the next person to widen that range should not have to know this.
   */
  it("never folds the stream, whatever wavenumber a branch draws", () => {
    for (const seed of SEEDS) {
      for (const len of LENGTHS) {
        const { waveK } = branchParams(seed, len);
        expect(TAU * waveK * ampFor(waveK), `${seed}/${len}`).toBeLessThanOrEqual(CEILING);
      }
    }
    for (let k = 0.01; k < 1e4; k *= 1.07) {
      expect(TAU * k * ampFor(k), `k ${k}`).toBeLessThanOrEqual(CEILING);
    }
  });

  /**
   * A bound that met itself by going to zero would pass the test above and draw
   * a river with no bunching in it at all — a conveyor belt, which is the cut
   * this design threw away twice. The displacement has to survive the clamp.
   */
  it("still displaces the stream, however hard it has to clamp", () => {
    for (let k = 0.01; k < 1e4; k *= 1.07) {
      expect(ampFor(k), `k ${k}`).toBeGreaterThan(0);
      expect(Number.isFinite(ampFor(k)), `k ${k}`).toBe(true);
    }
    // A wavenumber of zero is a wave with no wave in it; nothing produces one,
    // but a reciprocal is a reciprocal and it must not come back as `Infinity`.
    expect(ampFor(0)).toBe(WAVE_AMP);
  });

  /**
   * Neither half of the `min` is decoration, and this says so with numbers.
   *
   * At the bottom of `branchParams`' range the wave gets its full amplitude, so
   * `WAVE_AMP` is what a slow branch actually draws. Above `MAX_FOLD / (2π ·
   * WAVE_AMP)` the clamp takes over — and that threshold sits inside the range,
   * not above it, so most branches on the canvas are clamped rather than a
   * theoretical few. A change that moved either constant far enough to make one
   * arm unreachable would be silently changing what the river looks like.
   */
  it("gives a slow branch its whole amplitude and a fast one the clamp", () => {
    const threshold = MAX_FOLD / (TAU * WAVE_AMP);
    expect(threshold).toBeGreaterThan(1.1);
    expect(threshold).toBeLessThan(2.6);
    expect(ampFor(threshold * 0.5)).toBe(WAVE_AMP);
    expect(ampFor(threshold * 2)).toBeLessThan(WAVE_AMP);

    let clamped = 0;
    let full = 0;
    for (let seed = 0; seed < 400; seed++) {
      const { waveK } = branchParams(seed, 400);
      if (ampFor(waveK) < WAVE_AMP) clamped++;
      else full++;
    }
    expect(clamped).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(0);
  });
});

describe("branchParams", () => {
  /**
   * A branch is the same river on every render, and that is not tidiness.
   *
   * Reseeding from `Math.random` on a React pass would visibly restart the
   * stream every time an unrelated node was added, and the eye reads a restart
   * as an event — the app would be announcing something that did not happen.
   * Same argument `biolum.ts` gives for hashing an edge id rather than parsing
   * it.
   */
  it("gives a branch the same river every time it is asked", () => {
    for (const seed of SEEDS) {
      for (const len of LENGTHS) {
        expect(branchParams(seed, len), `${seed}/${len}`).toEqual(
          branchParams(seed, len),
        );
      }
    }
  });

  /**
   * And a different river to its neighbour. Two adjacent branches sharing a
   * phase pulse together, which reads as a relationship between two taxa that
   * have nothing to do with each other — the effect encoding a data value,
   * which is the one thing this mode may not do.
   */
  it("gives two different branches different rivers", () => {
    const seen = new Set(
      SEEDS.map((s) => {
        const p = branchParams(s, 400);
        return `${p.u0}/${p.waveK}/${p.waveHz}/${p.wavePh}/${p.halfW}`;
      }),
    );
    expect(seen.size).toBe(SEEDS.length);
  });

  /**
   * Everything goes into a float texture and out again in a vertex shader,
   * where a `NaN` does not throw: it propagates into `gl_Position` and the
   * branch is simply not there. A branch with no light on it looks like a
   * branch the reader has not hovered yet.
   */
  it("hands the shader nothing it cannot draw", () => {
    for (const seed of SEEDS) {
      for (const len of LENGTHS) {
        const p = branchParams(seed, len);
        const where = `${seed}/${len}`;
        for (const [name, v] of Object.entries(p)) {
          expect(Number.isFinite(v), `${where} ${name}`).toBe(true);
        }
        expect(p.u0, where).toBeGreaterThan(0);
        expect(p.waveK, where).toBeGreaterThan(0);
        expect(p.waveHz, where).toBeGreaterThan(0);
        expect(p.halfW, where).toBeGreaterThan(0);
        // The tube has to have an interior wide enough to hold a river, and a
        // ceiling, because the glass is drawn 1.3× proud of it.
        expect(p.halfW, where).toBeGreaterThanOrEqual(HALF_W_MIN);
        expect(p.halfW, where).toBeLessThanOrEqual(HALF_W_MIN + HALF_W_SPAN);
        // A phase is a position in a cycle, so it belongs in one.
        expect(p.wavePh, where).toBeGreaterThanOrEqual(0);
        expect(p.wavePh, where).toBeLessThan(1);
      }
    }
  });

  /**
   * **The reaction crosses every branch at roughly the same physical rate.**
   *
   * That is what makes `u0` a function of length at all: a nine-hundred-pixel
   * eukaryote stem and a three-pixel hominin split are the same normalised
   * `s ∈ [0, 1]`, so one speed for both would send the short one across in a
   * frame and leave the long one apparently stationary. The bounds are a floor
   * and a ceiling on the *crossing*, not on the speed.
   *
   * The asserted bound is the jittered one, not the nominal one: the function
   * multiplies by `0.85 + r()·0.3`, and `r()` is in `[0, 1)`, so a crossing
   * runs from `CROSS_MIN_S / 1.15` to `CROSS_MAX_S / 0.85`. Asserting the
   * nominal bounds would fail on roughly half the seeds in this file.
   */
  it("crosses a branch of any length inside the jittered bounds", () => {
    const fastest = CROSS_MIN_S / 1.15;
    const slowest = CROSS_MAX_S / 0.85;
    for (const seed of SEEDS) {
      for (const len of LENGTHS) {
        const crossing = 1 / branchParams(seed, len).u0;
        expect(crossing, `${seed}/${len}`).toBeGreaterThan(fastest);
        expect(crossing, `${seed}/${len}`).toBeLessThanOrEqual(slowest);
      }
    }
  });

  it("keeps every branch within 15% of its own length's crossing time", () => {
    for (const seed of SEEDS) {
      for (const len of LENGTHS) {
        const nominal = Math.min(CROSS_MAX_S, Math.max(CROSS_MIN_S, len / FLOW_SPEED));
        const crossing = 1 / branchParams(seed, len).u0;
        expect(crossing / nominal, `${seed}/${len}`).toBeGreaterThan(1 / 1.15);
        expect(crossing / nominal, `${seed}/${len}`).toBeLessThanOrEqual(1 / 0.85);
      }
    }
  });

  /** A long branch really does take longer, which is the point of the clamp. */
  it("takes longer over a long branch than a short one", () => {
    const short = 1 / branchParams(3, CROSS_MIN_S * FLOW_SPEED).u0;
    const long = 1 / branchParams(3, CROSS_MAX_S * FLOW_SPEED).u0;
    expect(long).toBeGreaterThan(short * 3);
  });
});

describe("quotaFor", () => {
  /**
   * **Per unit length, not per branch**, and that is the whole reason it is a
   * function. One population for every branch draws a nine-hundred-pixel
   * eukaryote stem and a three-pixel hominin split with the same number of
   * pinpoints, which makes the short one a bead of light and the long one dust.
   * A hundred points strung along a line reads as beads on a wire, and that is
   * the failure the CPU tracers shipped with.
   */
  it("gives a short branch fewer pinpoints than a long one", () => {
    // Both well inside the clamps, so this is measuring the ramp and not the
    // floor meeting the ceiling.
    const short = quotaFor(20);
    const long = quotaFor(400);
    expect(short).toBeGreaterThan(MIN_PER_BRANCH);
    expect(long).toBeLessThan(MAX_PER_BRANCH);
    expect(long).toBeGreaterThan(short);
    expect(short).toBe(20 * PINPOINTS_PER_PX);
  });

  it("never gives a longer branch fewer than a shorter one", () => {
    let last = -Infinity;
    for (let len = 0; len < 2000; len += 0.5) {
      const q = quotaFor(len);
      expect(q, `len ${len}`).toBeGreaterThanOrEqual(last);
      last = q;
    }
  });

  /**
   * The floor is so a graft's stub is not drawn as a single spark; the ceiling
   * is the frame budget, and the draw is one instanced call at
   * {@link MAX_PER_BRANCH} whatever this returns. Over the ceiling the surplus
   * leaves through the clip volume, which costs a vertex and not one fragment —
   * but only if this never asks for more than the call has instances.
   */
  it("stays between the floor and the frame budget at any length", () => {
    for (const len of [0, 1, 3, 10, 140, 666, 900, 1e5, 1e9]) {
      expect(quotaFor(len), `len ${len}`).toBeGreaterThanOrEqual(MIN_PER_BRANCH);
      expect(quotaFor(len), `len ${len}`).toBeLessThanOrEqual(MAX_PER_BRANCH);
    }
    expect(quotaFor(0)).toBe(MIN_PER_BRANCH);
    expect(quotaFor(1e9)).toBe(MAX_PER_BRANCH);
  });
});

describe("decay", () => {
  /**
   * A pluck and a flare are both one float, read every frame and never written
   * back. Nothing clears them: a surge ends because this returns zero, and if
   * it stopped doing so the branch would stay lit for the life of the page.
   */
  it("is nothing at all where nobody has touched anything", () => {
    expect(decay(undefined, 12345, 1.1)).toBe(0);
  });

  it("starts at full and is out by the time it is over", () => {
    expect(decay(1000, 1000, 1.1)).toBe(1);
    expect(decay(1000, 1000 + 1100, 1.1)).toBe(0);
    expect(decay(1000, 1000 + 5000, 1.1)).toBe(0);
  });

  it("only ever fades, from the moment it starts until it is gone", () => {
    let last = Infinity;
    for (let ms = 0; ms <= 1100; ms += 5) {
      const v = decay(0, ms, 1.1);
      expect(v, `ms ${ms}`).toBeLessThanOrEqual(last);
      last = v;
    }
    expect(last).toBe(0);
  });

  /**
   * It is multiplied into a gain, so a value over 1 is not a slightly brighter
   * branch: it is a branch past the tone map's shoulder, which goes white, and
   * a white rectangle is exactly what `EXPOSURE` exists to prevent.
   *
   * The clock going backwards is the case that produces one. `performance.now`
   * is monotonic, but a surge is stamped when the pointer crosses the branch
   * and read on the next frame, and a caller passing a fixed `nowMs` — a test,
   * a replay, a frame timestamp taken before the event — puts the start in the
   * future. `(1 − t)²` at `t = −2` is 9.
   */
  it("stays inside [0, 1] even when the touch is in the future", () => {
    expect(decay(5000, 1000, 1.1)).toBe(0);
    expect(decay(5000, 4999, 1.1)).toBe(0);
    for (let ms = -5000; ms <= 5000; ms += 25) {
      const v = decay(0, ms, 1.1);
      expect(v, `ms ${ms}`).toBeGreaterThanOrEqual(0);
      expect(v, `ms ${ms}`).toBeLessThanOrEqual(1);
    }
  });
});


describe("the entrance", () => {
  /*
    The draw-on and the river inside it are driven by two different clocks — the
    browser's animation of a `stroke-dashoffset`, and this curve evaluated per
    frame in JavaScript. They agree only because they are the same easing, and
    nothing at runtime checks that. A mismatch does not throw; the light runs
    ahead of the line it is supposed to be inside, or trails the tip, and the
    branch reads as two objects.
  */
  it("uses the same easing the stylesheet's animation was handed", () => {
    const src = readFileSync(new URL("../TraceEdge.tsx", import.meta.url), "utf8");
    const m = src.match(/cubic-bezier\(([^)]+)\)/);
    expect(m, "TraceEdge no longer names a cubic-bezier").not.toBeNull();
    const written = m![1]!.split(",").map((n) => Number(n.trim()));
    expect(written).toEqual([...DRAW_BEZIER]);
  });

  it("is pinned at both ends and never leaves the unit interval", () => {
    expect(bezierEase(0)).toBe(0);
    expect(bezierEase(1)).toBe(1);
    // Out of range on both sides: a delay not yet elapsed is a negative t, and
    // a frame that lands late is greater than one. Neither may reach the shader
    // as a reveal outside [0, 1] — below zero draws nothing forever, above one
    // is a texture read past the end of a branch.
    for (const t of [-5, -0.001, 0, 0.5, 1, 1.001, 12]) {
      const y = bezierEase(t);
      expect(y, String(t)).toBeGreaterThanOrEqual(0);
      expect(y, String(t)).toBeLessThanOrEqual(1);
    }
  });

  it("rises monotonically, so a branch never un-draws itself", () => {
    let prev = -1;
    for (let i = 0; i <= 500; i++) {
      const y = bezierEase(i / 500);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it("inverts x accurately rather than approximating it", () => {
    // The solver finds u with x(u) = t and returns y(u). Checked against a
    // bisection carried far past the working precision, because "looks about
    // right" is exactly the failure this curve would have.
    const [x1, y1, x2, y2] = DRAW_BEZIER;
    const cx = (u: number) => 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u * u * x2 + u ** 3;
    const cy = (u: number) => 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u * u * y2 + u ** 3;
    for (let i = 1; i < 200; i++) {
      const t = i / 200;
      let lo = 0;
      let hi = 1;
      let u = 0;
      for (let k = 0; k < 60; k++) {
        u = (lo + hi) / 2;
        if (cx(u) < t) lo = u;
        else hi = u;
      }
      expect(bezierEase(t)).toBeCloseTo(cy(u), 9);
    }
  });

  /*
    The one clause that is not about the curve: a branch that is not drawing is
    **fully lit**, not dark. Every other state in this file can be wrong and
    show a slightly odd animation; this one wrong is a permanently black tree
    on a settled canvas, which is the mode simply not working.
  */
  it("lights a branch completely when it is not drawing", () => {
    expect(revealAt(0, null, 0, DRAW_MS)).toBe(1);
    expect(revealAt(1e9, null, 5000, DRAW_MS)).toBe(1);
  });

  it("holds a branch dark until its own delay has elapsed, then fills it", () => {
    const start = 1000;
    const delay = 300;
    expect(revealAt(start, start, delay, DRAW_MS)).toBe(0);
    expect(revealAt(start + delay - 1, start, delay, DRAW_MS)).toBe(0);
    expect(revealAt(start + delay + DRAW_MS / 2, start, delay, DRAW_MS)).toBeGreaterThan(0);
    expect(revealAt(start + delay + DRAW_MS, start, delay, DRAW_MS)).toBe(1);
    // And it stays lit. A branch that finished drawing and then went dark again
    // because the clock kept running is the same black-tree failure as above.
    expect(revealAt(start + delay + DRAW_MS * 40, start, delay, DRAW_MS)).toBe(1);
  });

  it("staggers, so a later wave is still dark while an earlier one is filling", () => {
    const start = 0;
    const t = 200;
    expect(revealAt(t, start, 120, DRAW_MS)).toBeGreaterThan(0);
    expect(revealAt(t, start, 984, DRAW_MS)).toBe(0);
  });
});
