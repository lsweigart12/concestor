/**
 * What the mode still decides in JavaScript, now that the light is on the GPU.
 *
 * The river used to be integrated here — tracers, an emission rate, a velocity
 * field — and most of this file was about that. None of it survives: a
 * pinpoint's position is a closed-form function of its index and the clock,
 * evaluated in a vertex shader, and the numbers that function is built from
 * live in `gl/tuning.ts` with their own tests beside them.
 *
 * What is left here is everything the shaders cannot reach and the canvas
 * cannot show you is wrong. A seed that ramped with the topology would make the
 * effect encode a data value, which reads as "those two happen to pulse
 * together". A tier brightness that drifted would let a bright river shout over
 * a dashed line at the moment the dash is making its only statement. A pump on
 * a fossil's tether would animate a lineage nobody has resolved. And a strum
 * that moved the ends of a branch would detach it from the dots it connects —
 * or, at the degenerate pluck positions, put `NaN` in a path string and blank
 * the edge outright. All four are invisible; all four are wrong.
 */

import { describe, expect, it } from "vitest";
import { hashKey, seeded } from "./biolum";
import { tierBrightness } from "./flow";
import {
  TIER_INTERPOLATED,
  TIER_MEASURED,
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
} from "../api";
import { mayPump } from "./TraceEdge";
import { land, onLanding } from "./flow";
import {
  nearestOn,
  samplePath,
  strumAt,
  strumPath,
  warpTo,
  STRUM_MS,
  type Samplable,
} from "./strum";

const sum = (ns: readonly number[]) => ns.reduce((a, b) => a + b, 0);

describe("seeds", () => {
  it("are stable, so nothing restarts on an unrelated render", () => {
    expect(seeded(7)()).toBe(seeded(7)());
    expect(hashKey("770315-417950")).toBe(hashKey("770315-417950"));
  });

  it("stays inside [0, 1) whatever it is seeded with", () => {
    // Grafts are indexed `-(pbdb_taxon_no)` so a topology lookup fails loudly,
    // and their edge ids reach `seeded` like any other. A generator that went
    // negative here would put a pump's delay in the future and freeze it.
    for (const n of [0, 1, -1, 588427, -108454, 2 ** 31 - 1]) {
      const r = seeded(n);
      for (let i = 0; i < 8; i++) {
        const v = r();
        expect(v, String(n)).toBeGreaterThanOrEqual(0);
        expect(v, String(n)).toBeLessThan(1);
      }
    }
  });

  /**
   * The whole reason edge ids are *hashed* rather than parsed.
   *
   * Node indices are preorder, so a clade's members are a run of consecutive
   * integers — sister taxa in a selection land next to each other constantly. A
   * seed taken linearly from an index would give every sibling a near-identical
   * one, and whatever it drove would follow the topology: an effect encoding a
   * data value, which is the one thing this mode may not do.
   */
  it("scatters consecutive ids instead of ramping through them", () => {
    const run = Array.from({ length: 24 }, (_, i) => seeded(hashKey(`${500000 + i}-7`))());
    const gaps = run.slice(1).map((p, i) => Math.abs(p - run[i]!));
    expect(sum(gaps) / gaps.length).toBeGreaterThan(0.2);
  });
});

describe("tierBrightness", () => {
  /**
   * The dash channel's concession, which moved out of CSS when the stream moved
   * onto the canvas — canvas has no cascade, and GLSL has less of one. The rule
   * is unchanged: a bright stream running along a dashed line may not compete
   * with the dashes at the moment they are making their only statement.
   */
  it("concedes more the less anyone knows about the date", () => {
    const measured = tierBrightness(TIER_MEASURED, false);
    const interpolated = tierBrightness(TIER_INTERPOLATED, false);
    const structural = tierBrightness(TIER_STRUCTURAL, false);
    const unbounded = tierBrightness(TIER_STRUCTURAL, true);
    expect(measured).toBe(1);
    expect(interpolated).toBeLessThan(measured);
    expect(structural).toBeLessThan(interpolated);
    expect(unbounded).toBeLessThan(structural);
    expect(unbounded).toBeGreaterThan(0);
  });

  it("treats an occurrence node as undated, exactly as the dash does", () => {
    // `TIER_CLASS` maps occurrence onto the structural dash for one reason —
    // nobody has estimated an age for either — and the stream has to agree, or
    // a fossil-dated branch would run brighter than the line it is inside.
    expect(tierBrightness(TIER_OCCURRENCE, false)).toBe(
      tierBrightness(TIER_STRUCTURAL, false),
    );
  });
});

describe("mayPump", () => {
  /**
   * The pump animates descent, and an attachment tether is not descent.
   *
   * Same line `trace-hit` already draws — the tether gets no click target
   * because the one interaction a branch offers is the one thing it cannot
   * honestly do. A reaction travelling from a node down to a fossil would
   * animate a lineage nobody has resolved; architecture §3.4's claim is only
   * that the taxon sits *somewhere* below that branch.
   */
  it("refuses a fossil's tether and allows a branch", () => {
    expect(mayPump({ attachment: true })).toBe(false);
    expect(mayPump({ attachment: false })).toBe(true);
  });
});

/* ------------------------------------------------------------------ strum -- */

/** A straight horizontal path, which is what most traces mostly are. */
function line(len: number): Samplable {
  return {
    getTotalLength: () => len,
    getPointAtLength: (l: number) => ({ x: l, y: 50 }),
  };
}

describe("strum", () => {
  it("takes a normal perpendicular to the path", () => {
    const pts = samplePath(line(100), 8);
    expect(pts.length).toBe(9);
    // A path running in +x has a normal in ±y, and nothing in x.
    for (const p of pts) {
      expect(Math.abs(p.nx)).toBeLessThan(1e-9);
      expect(Math.abs(Math.abs(p.ny) - 1)).toBeLessThan(1e-9);
    }
    expect(pts[0]!.t).toBe(0);
    expect(pts[8]!.t).toBe(1);
  });

  /**
   * The mode shape is the part that is not decoration. A string fixed at both
   * ends does not move at its ends — and here the ends are the two *nodes*, so
   * a ring that displaced them would detach the branch from the dots it
   * connects and the trace would stop arriving where the mark is.
   *
   * Checked at every pluck position, including the degenerate ones: `warpTo`
   * divides by the distance to each end, so an unclamped pluck at 0 or 1 would
   * put `NaN` into the path string and blank the branch outright.
   */
  it("never moves the ends, wherever it is plucked", () => {
    for (const at of [0, 0.02, 0.25, 0.5, 0.83, 0.98, 1]) {
      for (let t = 0; t < STRUM_MS; t += 11) {
        expect(Math.abs(strumAt(0, t, undefined, at)), `at ${at}`).toBeLessThan(1e-9);
        expect(Math.abs(strumAt(1, t, undefined, at)), `at ${at}`).toBeLessThan(1e-9);
        expect(Number.isFinite(strumAt(0.5, t, undefined, at)), `at ${at}`).toBe(true);
      }
    }
  });

  /**
   * **It bends where you touched it.** A branch that always bowed at its
   * midpoint regardless of where the pointer crossed reads as a canned
   * animation rather than as a response, which is the whole point of the
   * gesture.
   */
  it("puts the antinode at the pluck point", () => {
    for (const at of [0.15, 0.35, 0.5, 0.72, 0.9]) {
      // Sampled at one instant of the ring, so the sign is fixed and the
      // largest magnitude is the peak of the shape.
      let bestT = -1;
      let best = -1;
      for (let k = 0; k <= 200; k++) {
        const v = Math.abs(strumAt(k / 200, 34, undefined, at));
        if (v > best) {
          best = v;
          bestT = k / 200;
        }
      }
      expect(bestT, `at ${at}`).toBeCloseTo(at, 1);
    }
  });

  it("maps the pluck point to the half-way mark and pins the ends", () => {
    for (const at of [0.1, 0.5, 0.9]) {
      expect(warpTo(0, at)).toBe(0);
      expect(warpTo(1, at)).toBe(1);
      expect(warpTo(at, at)).toBeCloseTo(0.5, 9);
    }
  });

  it("swings both ways and decays to nothing", () => {
    const mid = Array.from({ length: 120 }, (_, i) => strumAt(0.5, i * 5));
    expect(Math.max(...mid)).toBeGreaterThan(1);
    expect(Math.min(...mid)).toBeLessThan(-1);
    // The tail is inaudible well before the caller stops, so the branch settles
    // rather than snapping back to rest.
    expect(Math.abs(strumAt(0.5, STRUM_MS - 20))).toBeLessThan(0.6);
  });

  it("is silent once it is over, which is how the caller knows to stop", () => {
    expect(strumAt(0.5, STRUM_MS)).toBe(0);
    expect(strumAt(0.5, STRUM_MS + 500)).toBe(0);
  });

  it("draws the rest shape at rest and something else while ringing", () => {
    const pts = samplePath(line(100), 4);
    const rest = strumPath(pts, STRUM_MS);
    expect(rest).toBe("M0.00 50.00 L25.00 50.00 L50.00 50.00 L75.00 50.00 L100.00 50.00");
    expect(strumPath(pts, 30)).not.toBe(rest);
  });

  /**
   * The pointer lands anywhere in a 16px hit target, and the light a pluck
   * sheds has to come off the *branch* rather than off the cursor — so the
   * contact is projected onto the line, not snapped to the nearest sample.
   * Snapping would also quantise the pluck into ~16px steps along a line a
   * reader is dragging smoothly across.
   */
  describe("nearestOn", () => {
    const line8 = samplePath(line(100), 8);

    it("projects onto the line rather than snapping to a sample", () => {
      // Between two samples, and well off the ink.
      const hit = nearestOn(line8, 43, 61);
      expect(hit).not.toBeNull();
      expect(hit!.x).toBeCloseTo(43, 6);
      expect(hit!.y).toBeCloseTo(50, 6);
      expect(hit!.t).toBeCloseTo(0.43, 6);
    });

    it("clamps to the ends rather than running off them", () => {
      expect(nearestOn(line8, -40, 50)!.t).toBe(0);
      expect(nearestOn(line8, 400, 50)!.t).toBe(1);
    });

    it("carries a unit normal, so a burst is aimed across the branch", () => {
      const hit = nearestOn(line8, 60, 44)!;
      expect(Math.hypot(hit.nx, hit.ny)).toBeCloseTo(1, 9);
    });

    it("has nothing to project onto on a degenerate path", () => {
      expect(nearestOn([], 1, 1)).toBeNull();
      expect(nearestOn([line8[0]!], 1, 1)).toBeNull();
    });
  });

  it("gives an unmeasurable path nothing to ring", () => {
    // A degenerate trace — two nodes at one point — must not produce `NaN` in a
    // path string, which silently blanks the whole edge.
    expect(samplePath(line(0))).toEqual([]);
    expect(strumPath([], 10)).toBe("");
  });
});


describe("the landing", () => {
  /*
    One ring across every branch, fired from a clock rather than a pointer.

    A bus rather than a prop, and the same reasoning the spill bus had: the
    thing that knows the draw has finished is `Graph.tsx` and the things that
    ring are the edges. What is checkable here is only that it reaches all of
    them and lets go cleanly — an edge that stays subscribed after unmounting
    rings a branch that is not on the canvas any more, which throws inside a
    handler holding a detached path.
  */
  it("reaches every branch at once and stops on unsubscribe", () => {
    const rung: string[] = [];
    const offA = onLanding(() => rung.push("a"));
    const offB = onLanding(() => rung.push("b"));
    land();
    expect(rung.sort()).toEqual(["a", "b"]);

    rung.length = 0;
    offA();
    land();
    expect(rung).toEqual(["b"]);

    rung.length = 0;
    offB();
    land();
    expect(rung).toEqual([]);
  });

  it("is safe to fire with nothing listening", () => {
    expect(() => land()).not.toThrow();
  });
});
