/**
 * The properties the light rests on, and one refusal.
 *
 * None of these is checkable by looking at the canvas. A phase collision reads
 * as "those two happen to pulse together", a duration that ignores length reads
 * as "that branch is slow", and a keyframe list that is not strictly increasing
 * throws inside the Web Animations API and silently leaves one branch dark. All
 * three are exactly what the effect looks like when it is working.
 */

import { describe, expect, it } from "vitest";
import { hashKey, seeded, spill, onSpill, type Spill } from "./biolum";
import {
  Flow,
  MAX_PER_BRANCH,
  SAMPLES_MAX,
  SAMPLES_MIN,
  samplesFor,
  tierBrightness,
  type Tracer,
} from "./flow";
import {
  TIER_INTERPOLATED,
  TIER_MEASURED,
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
} from "../api";
import { mayPump } from "./TraceEdge";
import { alphaOf, Field, LIFE_MAX, MAX_PARTICLES, type Particle } from "./particles";
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

const run = (f: Flow, seconds: number, h = 1 / 60) => {
  for (let i = 0; i < Math.round(seconds / h); i++) f.step(h);
};

/** Mean position of the stream along the branch. */
const centre = (f: Flow) =>
  f.tracers.length
    ? f.tracers.reduce((a, p) => a + p.s, 0) / f.tracers.length
    : 0;

/** Spacing between consecutive tracers, ordered along the branch. */
const gaps = (f: Flow) => {
  const ss = f.tracers.map((p) => p.s).sort((a, b) => a - b);
  return ss.slice(1).map((v, i) => v - ss[i]!);
};

describe("the stream", () => {
  it("scales its centreline sampling to the branch, within bounds", () => {
    expect(samplesFor(4)).toBe(SAMPLES_MIN);
    expect(samplesFor(100000)).toBe(SAMPLES_MAX);
    expect(samplesFor(400)).toBeGreaterThan(SAMPLES_MIN);
    expect(samplesFor(400)).toBeLessThan(SAMPLES_MAX);
  });

  /**
   * The one thing that really has to hold: this runs unattended for the life of
   * the page on every branch on the canvas, under any step size a stalled tab
   * or a slow frame can produce.
   */
  it("stays inside the branch and bounded, under any step size", () => {
    for (const len of [30, 140, 420, 900]) {
      for (const seed of [1, 17, 512, 99991]) {
        const f = new Flow(len, seed);
        for (const h of [1 / 120, 1 / 60, 1 / 15, 0.05, 3, 0]) run(f, 5, h || 1);
        expect(f.tracers.length, `${len}/${seed}`).toBeLessThanOrEqual(
          MAX_PER_BRANCH,
        );
        for (const p of f.tracers) {
          expect(Number.isFinite(p.s), `${len}/${seed}`).toBe(true);
          expect(p.s, `${len}/${seed}`).toBeGreaterThanOrEqual(0);
          expect(p.s, `${len}/${seed}`).toBeLessThan(1);
        }
      }
    }
  });

  /**
   * Descent, ancestor to descendant, always. A velocity that went negative
   * anywhere would run light back up a lineage, which is the one direction this
   * canvas may never animate.
   */
  it("never flows backwards, anywhere, at any moment", () => {
    for (const seed of [2, 40, 777, 31337]) {
      const f = new Flow(400, seed);
      for (let i = 0; i < 400; i++) {
        f.step(1 / 60);
        for (let k = 0; k <= 20; k++) {
          expect(f.velocityAt(k / 20), `seed ${seed}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("carries tracers from the ancestor end to the descendant end", () => {
    const f = new Flow(400, 3);
    run(f, 0.35);
    expect(f.tracers.length).toBeGreaterThan(0);
    expect(centre(f)).toBeLessThan(0.25);
    run(f, 6);
    expect(centre(f)).toBeGreaterThan(0.3);
    expect(f.tracers.some((p) => p.s > 0.75)).toBe(true);
  });

  it("primes to a running stream, so no branch is ever drawn empty", () => {
    for (const len of [80, 300, 800]) {
      const f = new Flow(len, 11);
      f.prime();
      expect(f.tracers.length, String(len)).toBeGreaterThan(3);

      // Reaching the far end is checked over a window, not at an instant. The
      // stream arrives in clumps with lulls between them — which is the whole
      // point of the surging inflow — so on a short branch there are moments
      // when everything present was born in the last half second and the
      // furthest tracer is genuinely a third of the way down. The first
      // version of this asserted the instant and failed on an 80px branch for
      // a reason that had nothing to do with priming.
      let reached = 0;
      let emptiedAt = -1;
      for (let i = 0; i < 240; i++) {
        f.step(1 / 60);
        reached = Math.max(reached, ...f.tracers.map((p) => p.s), 0);
        if (f.tracers.length === 0) emptiedAt = i;
      }
      expect(reached, String(len)).toBeGreaterThan(0.85);
      expect(emptiedAt, String(len)).toBe(-1);
    }
  });

  /**
   * **The claim the whole feature rests on.**
   *
   * A conveyor belt moves every particle at one speed, so the spacing between
   * them is whatever the emission rate laid down and never changes again. A
   * fluid does not: the peristaltic field is faster in some places than others,
   * so tracers close up where it converges and string out where it diverges.
   * That is the pumping, and after the ribbon was dropped it is the *only*
   * thing left showing it — the tube no longer moves at all.
   *
   * Measured as the spread of gaps between neighbours changing over time. A
   * uniform field would hold it constant to rounding.
   */
  it("bunches and strings out rather than moving as one", () => {
    const f = new Flow(600, 23);
    f.prime();
    const spreadOfGaps = () => {
      const g = gaps(f);
      if (g.length < 3) return 0;
      const mean = g.reduce((a, b) => a + b, 0) / g.length;
      return Math.sqrt(g.reduce((a, b) => a + (b - mean) ** 2, 0) / g.length);
    };
    const seen: number[] = [];
    for (let i = 0; i < 30; i++) {
      run(f, 0.2);
      seen.push(spreadOfGaps());
    }
    const lo = Math.min(...seen);
    const hi = Math.max(...seen);
    expect(lo).toBeGreaterThan(0);
    expect(hi - lo).toBeGreaterThan(lo * 0.25);
  });

  it("surges, so the stream has clumps and not an even file", () => {
    const f = new Flow(400, 8);
    const rates: number[] = [];
    for (let i = 0; i < 300; i++) {
      f.step(1 / 30);
      rates.push(f.inflow());
    }
    expect(Math.min(...rates)).toBeGreaterThan(0);
    expect(Math.max(...rates)).toBeGreaterThan(Math.min(...rates) * 2);
  });

  it("runs every branch on its own clock", () => {
    const a = new Flow(400, 1);
    const b = new Flow(400, 2);
    a.prime();
    b.prime();
    expect(Math.abs(centre(a) - centre(b))).toBeGreaterThan(0.01);
  });

  it("is the same stream on every render, given the same branch", () => {
    const a = new Flow(400, 42);
    const b = new Flow(400, 42);
    a.prime();
    b.prime();
    expect(b.tracers.length).toBe(a.tracers.length);
    expect(centre(b)).toBeCloseTo(centre(a), 9);
  });

  it("fades a tracer in and out rather than popping it", () => {
    const f = new Flow(400, 5);
    const p: Tracer = { s: 0, lat: 0, r: 3, bright: 1, twinkle: 1e6, twinklePhase: 0 };
    expect(f.alphaOf(p)).toBe(0);
    p.s = 0.5;
    const mid = f.alphaOf(p);
    expect(mid).toBeGreaterThan(0.4);
    p.s = 0.999;
    expect(f.alphaOf(p)).toBeLessThan(mid * 0.15);
  });
});

describe("tierBrightness", () => {
  /**
   * The dash channel's concession, which moved out of CSS when the stream moved
   * onto the canvas — canvas has no cascade. The rule is unchanged: a bright
   * stream running along a dashed line may not compete with the dashes at the
   * moment they are making their only statement.
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

describe("the spill bus", () => {
  it("delivers to every listener and stops on unsubscribe", () => {
    const got: Spill[] = [];
    const off = onSpill((s) => got.push(s));
    const one: Spill = { x: 1, y: 2, hue: 186, count: 3, speed: 20 };
    spill(one);
    off();
    spill({ ...one, x: 9 });
    expect(got).toEqual([one]);
  });
});

describe("the field", () => {
  const emitters = [{ x: 0, y: 0, hue: 186, rate: 4 }];

  it("is black until something spills into it", () => {
    const f = new Field();
    f.trickle([], 10);
    f.step(1);
    expect(f.size).toBe(0);
  });

  it("fills from the marks and empties again when they stop", () => {
    const f = new Field();
    f.trickle(emitters, 1);
    expect(f.size).toBeGreaterThan(0);
    // Driven off `LIFE_MAX` rather than a fixed count of steps: this loop used
    // to run twenty seconds, which stopped being "longer than the longest life"
    // the moment the lives were tripled, and the test then failed for a reason
    // that had nothing to do with the invariant. Nothing may outlive its fade.
    const steps = Math.ceil((LIFE_MAX + 1) / 0.05);
    for (let i = 0; i < steps; i++) f.step(0.05);
    expect(f.size).toBe(0);
  });

  /**
   * The cap is a frame budget, and it has to hold under the one thing that can
   * breach it: a reader dragging the pointer along a big tree, plucking every
   * branch. Over the cap the field thins rather than the frame rate dropping.
   */
  it("never exceeds the cap, however hard it is driven", () => {
    const f = new Field();
    for (let i = 0; i < 400; i++) {
      f.emit({ x: 0, y: 0, hue: 186, count: 20, speed: 40 });
    }
    expect(f.size).toBe(MAX_PARTICLES);
  });

  it("does not discharge a backgrounded minute in one frame", () => {
    const f = new Field();
    f.trickle([{ x: 0, y: 0, hue: 186, rate: 30 }], 120);
    expect(f.size).toBeLessThanOrEqual(24);
  });

  it("carries the hue of the mark it came from", () => {
    const f = new Field();
    f.emit({ x: 0, y: 0, hue: 145, count: 5, speed: 10 });
    expect(f.particles.every((p) => p.hue === 145)).toBe(true);
  });

  it("moves what it holds", () => {
    const f = new Field();
    f.emit({ x: 0, y: 0, hue: 186, count: 30, speed: 40 });
    const before = f.particles.map((p) => `${p.x},${p.y}`);
    f.step(0.5);
    expect(f.particles.map((p) => `${p.x},${p.y}`)).not.toEqual(before);
  });
});

describe("alphaOf", () => {
  const at = (age: number, over: Partial<Particle> = {}): Particle => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    hue: 186,
    age,
    life: 10,
    r: 1,
    bright: 1,
    twinkle: 1,
    twinklePhase: 0.5,
    curl: 0,
    ...over,
  });

  it("is dark before it is born and after it dies", () => {
    expect(alphaOf(at(10))).toBe(0);
    expect(alphaOf(at(11))).toBe(0);
    expect(alphaOf(at(0))).toBe(0);
  });

  it("goes out slowly rather than being cut off", () => {
    // The last frame of life must be near zero, or every particle in the field
    // vanishes at full brightness and the water flickers.
    expect(alphaOf(at(9.98, { twinkle: 1000 }))).toBeLessThan(0.02);
  });

  it("stays inside [0, 1] across a whole life", () => {
    for (let age = 0; age < 10; age += 0.05) {
      const a = alphaOf(at(age));
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The twinkle has to spend most of its time dark, or the field reads as one
   * dimmer rather than as a suspension of individuals.
   */
  it("twinkles low more often than high", () => {
    let lit = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      if (alphaOf(at(2 + (i / n) * 4, { twinkle: 1.3 })) > 0.5) lit++;
    }
    expect(lit / n).toBeLessThan(0.4);
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
