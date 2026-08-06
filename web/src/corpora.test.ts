import { describe, expect, it } from "vitest";
import {
  FOSSIL_BADGE,
  FOSSIL_BADGE_HINT,
  pickFrom,
  RANDOM_FOSSIL_CHANCE,
  randomKind,
  rowScore,
  SPECIES_PHRASE,
  TREE_SPECIES,
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

describe("the species count a reader is told", () => {
  // SPECIES_PHRASE is the rounded form of TREE_SPECIES. It has been wrong
  // twice by taking the tip total or the node total instead of the species
  // count, so pin the phrase to the constant it summarises.
  it("rounds TREE_SPECIES to the phrase every surface prints", () => {
    const m = /^([\d.]+) million species$/.exec(SPECIES_PHRASE);
    expect(m, `SPECIES_PHRASE reads "${SPECIES_PHRASE}"`).toBeTruthy();
    expect(Number(m![1])).toBe(Math.round(TREE_SPECIES / 100_000) / 10);
  });
});

describe("pickFrom", () => {
  const pool = [10, 20, 30, 40, 50];
  const none = () => false;

  it("draws from the pool", () => {
    expect(pool).toContain(pickFrom(pool, none, 0.5));
  });

  it("spans the pool across the range, ends included", () => {
    // The first and last entries have to be reachable. An off-by-one in the
    // index arithmetic that made either unreachable would still return valid
    // picks forever, which is the failure this exists to catch.
    expect(pickFrom(pool, none, 0)).toBe(10);
    expect(pickFrom(pool, none, 0.999999)).toBe(50);
    const drawn = new Set(
      Array.from({ length: 200 }, (_, i) => pickFrom(pool, none, i / 200)),
    );
    expect([...drawn].sort((a, b) => Number(a) - Number(b))).toEqual(pool);
  });

  it("never draws something the canvas already holds", () => {
    // The one invariant a reader could not check by looking: a pick that came
    // back already-present would toast "Added X" over an unchanged canvas.
    const taken = new Set([10, 20, 30, 40]);
    for (let i = 0; i < 100; i++) {
      expect(pickFrom(pool, (n) => taken.has(n), i / 100)).toBe(50);
    }
  });

  it("reports exhaustion rather than repeating a pick", () => {
    expect(pickFrom(pool, () => true, 0.5)).toBeNull();
  });

  it("reports an empty pool the same way", () => {
    // Empty and exhausted are different conditions with different causes — a
    // build with no silhouette resolution against a canvas holding everything —
    // and `randomPick` says each of them differently. Both arrive here as null,
    // which is why the caller distinguishes them before asking.
    expect(pickFrom([], none, 0.5)).toBeNull();
  });

  it("clamps a roll of exactly 1 instead of running off the end", () => {
    // `Math.random()` cannot return 1, but this takes a number rather than a
    // promise, and the signature says it returns a member of the pool or null.
    expect(pickFrom(pool, none, 1)).toBe(50);
  });
});
