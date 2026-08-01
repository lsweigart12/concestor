import { describe, expect, it } from "vitest";
import { fracToAge, laneHue, orthPath, symlogFrac, SYMLOG_T0 } from "./layout";

describe("symlog time axis", () => {
  it("is defined at the present", () => {
    // log(0) is where a naive implementation emits -Infinity and the layout
    // silently collapses. This is the whole reason for the linear stretch.
    expect(symlogFrac(0, 4247)).toBe(0);
    expect(Number.isFinite(symlogFrac(0, 4247))).toBe(true);
  });

  it("is monotone across the knee", () => {
    let prev = -1;
    for (const age of [0, 0.1, 0.5, 0.99, 1, 1.01, 5, 66, 252, 541, 1000, 4247]) {
      const f = symlogFrac(age, 4247);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });

  it("round-trips through its inverse", () => {
    for (const age of [0.25, 1, 12, 66, 252, 1000, 4000]) {
      expect(fracToAge(symlogFrac(age, 4247), 4247)).toBeCloseTo(age, 4);
    }
  });

  it("gives the last million years real estate linear time would not", () => {
    // Linear time puts every hominin divergence inside one pixel next to the
    // Cambrian; the point of the toggle is that it does not.
    const share = symlogFrac(SYMLOG_T0, 4247);
    expect(share).toBeGreaterThan(1 / 4247);
    expect(share).toBeGreaterThan(0.05);
  });
});

describe("lane hue", () => {
  it("is a property of the organism, not of its row", () => {
    // design-reference.md requires a lane keep its hue across renders. Keying
    // on row position would break the moment a species slots in above.
    expect(laneHue(770315)).toBe(laneHue(770315));
  });

  it("separates sister taxa, which land on adjacent idx values", () => {
    const hues = new Set([0, 1, 2, 3, 4].map((d) => laneHue(594485 + d)));
    expect(hues.size).toBeGreaterThan(1);
  });

  it("stays inside the cool set", () => {
    for (let i = 0; i < 500; i++) {
      const h = laneHue(i * 7919);
      expect(h).toBeGreaterThanOrEqual(140);
      expect(h).toBeLessThanOrEqual(215);
    }
  });
});

describe("orthogonal edges", () => {
  it("never emits a cubic bezier", () => {
    // Curves make convergent branches ambiguous, and a dozen lineages meeting
    // at one divergence point is exactly when that matters.
    const d = orthPath(0, 0, 200, 90);
    expect(d).not.toMatch(/[Cc]/);
    expect(d).toMatch(/^M /);
  });

  it("degenerates to a straight line on the same row", () => {
    expect(orthPath(0, 40, 200, 40)).toBe("M 0 40 L 200 40");
  });

  it("keeps the corner radius inside the segment it turns in", () => {
    const d = orthPath(0, 0, 6, 4, 9);
    for (const n of d.match(/-?\d+(\.\d+)?/g) ?? []) {
      expect(Math.abs(Number(n))).toBeLessThanOrEqual(200);
    }
    expect(d).toContain("Q");
  });
});
