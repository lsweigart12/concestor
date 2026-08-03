/**
 * That the GLSL is made of the numbers next door, and not of copies of them.
 *
 * This is the only test a shader in this directory can have. There is no GL
 * context in the test runner, nothing here is executed, and a shader fails by
 * drawing something slightly wrong rather than by throwing — `tuning.ts` opens
 * with that argument and this file is its enforcement. What can be checked is
 * the one property the arrangement rests on: **a number a reader might want to
 * argue with is interpolated in, so the argument happens somewhere a test can
 * reach.** A constant written out a second time inside a template literal is
 * outside every test in this repo the moment it is typed, and it goes wrong by
 * drifting away from the one that is tested rather than by disagreeing with it
 * loudly.
 *
 * The other half is cheaper and catches the failure that costs the most time: a
 * mis-named import interpolates as the string `undefined`, which is not a GLSL
 * float, so the program fails to compile and the canvas is simply black. That
 * is indistinguishable from the mode being off.
 */

import { describe, expect, it } from "vitest";
import * as S from "./shaders";
import * as T from "./tuning";

/**
 * GLSL's float literal rule, restated rather than imported.
 *
 * `shaders.ts` keeps its own copy private, and this is deliberately a second
 * one: a shared helper would let a broken formatter agree with itself, which is
 * exactly the class of bug this file exists to catch. `9` has to reach the
 * source as `9.0` or it is an int, and an int where a float belongs is a
 * compile error in one place and an integer division in another.
 */
const g = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

/** Everything exported here that is a program: a vertex and a fragment stage. */
const programs = Object.entries(S).filter(
  (e): e is [string, { vs: string; fs: string }] =>
    typeof e[1] === "object" && e[1] !== null && "vs" in e[1] && "fs" in e[1],
);

describe("the shader sources", () => {
  it("are all present, both stages of each", () => {
    // A guard on the guard: if the filter above ever stops matching, every
    // assertion below passes over an empty list and this file tests nothing.
    expect(programs.length).toBeGreaterThanOrEqual(7);
    for (const [name, p] of programs) {
      expect(typeof p.vs, name).toBe("string");
      expect(typeof p.fs, name).toBe("string");
      expect(p.vs.trim().length, name).toBeGreaterThan(0);
      expect(p.fs.trim().length, name).toBeGreaterThan(0);
      expect(p.vs, name).toContain("void main()");
      expect(p.fs, name).toContain("void main()");
    }
  });

  /**
   * The failure this catches is a blank canvas and nothing else.
   *
   * Rename a constant in `tuning.ts` and the interpolation is not a type error
   * — `${T.WALL_GAINN}` is `undefined`, which stringifies happily, and what
   * reaches the driver is `tint * wall * (0.04 + undefined * g)`. The program
   * does not link, the mode draws nothing, and the reader's report is that
   * bioluminescence stopped working. `NaN` is the same mistake arriving through
   * arithmetic instead of a name.
   */
  it("carry no constant that failed to resolve", () => {
    for (const [name, p] of programs) {
      for (const [stage, src] of [["vs", p.vs], ["fs", p.fs]] as const) {
        expect(src, `${name}.${stage}`).not.toContain("undefined");
        expect(src, `${name}.${stage}`).not.toContain("NaN");
      }
    }
  });
});

describe("the tuning reaches the GLSL", () => {
  /**
   * **The bound that keeps the river from folding, in the shader that folds
   * it.**
   *
   * `ampFor` is tested next door and is not what runs: this line is, once per
   * pinpoint per frame. Matched as the whole clamp rather than as two loose
   * numbers, because both of them appear elsewhere in this source as fragments
   * of unrelated coefficients — `0.8` sits inside `bias * 0.86` — and a test
   * that would pass on that is not testing anything. `6.28318` is 2π; the
   * expression is `min(WAVE_AMP, MAX_FOLD / (2π·k))`, which is `ampFor` written
   * out.
   */
  it("gives the river its fold bound rather than a copy of it", () => {
    expect(S.river.vs).toContain(
      `min(${g(T.WAVE_AMP)}, ${g(T.MAX_FOLD)} / (6.28318 * waveK))`,
    );
  });

  /**
   * The snow emits nothing, so both of these are the whole of what it looks
   * like. `SNOW_AMBIENT` is at the threshold of visible on purpose — the
   * field's job over most of the canvas is to be the reason the void has depth
   * — and `SNOW_RESPONSE` is how fast a lit flake saturates, which is what
   * stops a flake crossing a bright river from climbing into a white dot.
   * Neither is arguable from the shader, and both are arguable from `tuning.ts`.
   */
  it("gives the snow its base and its response", () => {
    expect(S.snow.vs).toContain(`exp(-amt * ${g(T.SNOW_RESPONSE)})`);
    expect(S.snow.vs).toContain(`${g(T.SNOW_AMBIENT)} * z`);
  });

  /**
   * The glass reads the vicinity field twice — once for the lit wall and once
   * for the bounce off the far side — and each read has its own gain. They were
   * one number in the first cut and what it drew was a bar.
   */
  it("gives the glass both of its gains", () => {
    expect(S.glass.fs).toContain(`${g(T.WALL_GAIN)} * g`);
    expect(S.glass.fs).toContain(`fres * ${g(T.REFLECT_GAIN)}`);
  });

  /**
   * Exposure is the last decision made about any pixel, and it is the one that
   * decides whether a region summing past 1 turns toward white or goes flat
   * white with a straight edge on it.
   */
  it("gives the tone map its exposure and the void its colour", () => {
    expect(S.tone.fs).toContain(`exp(-c * ${g(T.EXPOSURE)})`);
    for (const c of [...T.VOID_NEAR, ...T.VOID_FAR]) expect(S.tone.fs).toContain(g(c));
  });

  it("gives the compose pass its bloom", () => {
    expect(S.compose.fs).toContain(`* ${g(T.BLOOM)}`);
  });

  /** The wall's shape, every term of which varies across the tube. */
  it("gives the glass the profile of its wall", () => {
    expect(S.glass.fs).toContain(`smoothstep(${g(T.WALL_INNER)}, ${g(T.WALL_OUTER)}, av)`);
    expect(S.glass.fs).toContain(`smoothstep(${g(T.WALL_FADE)}, 0.90, av)`);
    expect(S.glass.fs).toContain(`${g(T.REFLECT_PEAK)}, av)`);
    expect(S.glass.fs).toContain(`* ${g(T.BODY_TRACE)}`);
    expect(S.glass.fs).toContain(`${g(T.END_TAPER)}, vS)`);
  });

  /** The snow's fall and its depth, which is most of why a flat rain has volume. */
  it("gives the snow its fall rate and its depth range", () => {
    expect(S.snow.vs).toContain(g(T.SNOW_Z_MIN));
    expect(S.snow.vs).toContain(g(T.SNOW_Z_SPAN));
    expect(S.snow.vs).toContain(`${g(T.SNOW_FALL_MIN)} + g.x * ${g(T.SNOW_FALL_SPAN)}`);
  });
});
