import { describe, expect, it } from "vitest";
import {
  FOSSIL_BADGE,
  FOSSIL_BADGE_HINT,
  RANDOM_FOSSIL_CHANCE,
  randomKind,
  rowScore,
} from "./corpora";

describe("randomKind", () => {
  it("draws a fossil for the bottom fifth of the range", () => {
    expect(randomKind(0)).toBe("fossil");
    expect(randomKind(0.19)).toBe("fossil");
    // The boundary belongs to species, so the share of fossils is exactly the
    // constant rather than a hair over it.
    expect(randomKind(RANDOM_FOSSIL_CHANCE)).toBe("species");
    expect(randomKind(0.99)).toBe("species");
  });

  it("lands within a point of one in five over the whole range", () => {
    // The constant is the product decision; this asserts the *function* honours
    // it, which is the part that can silently drift under an off-by-one.
    let fossils = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      if (randomKind(i / n) === "fossil") fossils++;
    }
    expect(Math.abs(fossils / n - RANDOM_FOSSIL_CHANCE)).toBeLessThan(0.01);
  });
});

describe("rowScore", () => {
  it("puts the two corpora on one scale", () => {
    // A fossil ranked second by the server outranks a node ranked third. Under
    // the old bases — 4000 for a node and 2000 for a fossil — it could not,
    // whatever it matched, and that gap *was* the pinned Fossils section.
    expect(rowScore(1, 99)).toBeGreaterThan(rowScore(2, 0));
  });

  it("is monotone in the server's order and nothing else", () => {
    const scores: number[] = [0, 1, 2, 5, 23].map((o) => rowScore(o, 0));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThan(scores[i - 1]!);
    }
  });

  it("falls back to array position against a server with no `order`", () => {
    // A build predating the field still ranks each list internally; the two
    // just cannot interleave. Nothing may crash and nothing may collapse to a
    // single score, which would let `sessionBoost` decide the whole page.
    expect(rowScore(undefined, 0)).toBeGreaterThan(rowScore(undefined, 1));
    expect(rowScore(null, 3)).toBe(rowScore(3, 999));
  });
});

describe("the fossil badge", () => {
  it("does not claim the row is extinct", () => {
    // The tree holds *Tyrannosaurus rex* as a node, so it would go unbadged.
    // A badge reading "fossil" or "extinct" would therefore be a label that is
    // wrong about the one animal everybody tests it with.
    expect(FOSSIL_BADGE.toLowerCase()).not.toContain("extinct");
    expect(FOSSIL_BADGE.toLowerCase()).not.toContain("fossil");
  });

  it("says what will happen rather than naming a category", () => {
    expect(FOSSIL_BADGE_HINT).toContain("no lineage");
    expect(FOSSIL_BADGE_HINT).toContain("pinned to the branch");
  });

  it("stays short enough to sit on a row beside a binomial", () => {
    expect(FOSSIL_BADGE.length).toBeLessThanOrEqual(14);
  });
});
