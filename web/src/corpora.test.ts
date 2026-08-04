import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FOSSIL_BADGE,
  FOSSIL_BADGE_HINT,
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

/**
 * The headline species count, against the dataset it claims to count.
 *
 * This is the `meta.test.ts` idea applied to prose: every assertion reads the
 * *other* artifact — `docs/data-sources.md`, and then every source file that
 * could print a figure — rather than a second copy of the number. The failure
 * it exists for was silent in exactly the way that file describes. "2.7
 * million species" is grammatical, plausible, larger than the truth by a
 * flattering 14%, and wrong in the one way this product cannot be wrong: 2.7
 * million is the node total, and 339,807 of those nodes are groups rather than
 * species.
 *
 * Nothing caught it because nothing could. No gate reads copy, the number
 * appears in five components that share no test, and it arrived by editing a
 * sentence rather than by changing any data.
 */
describe("the species count a reader is told", () => {
  const url = (p: string) => new URL(p, import.meta.url);
  const read = (u: URL) => readFileSync(u, "utf8");
  const DATA_SOURCES = read(url("../../docs/data-sources.md"));
  const num = (s: string) => Number(s.replace(/,/g, ""));

  /** `- **2,725,682 nodes total**: 2,385,875 tips + 339,807 internal.` */
  const split = /([\d,]+) tips \+ ([\d,]+) internal/.exec(DATA_SOURCES);

  it("is reading the dataset's own figures at all", () => {
    expect(DATA_SOURCES.length).toBeGreaterThan(1000);
    expect(split, "data-sources.md no longer states the tip/internal split").toBeTruthy();
  });

  it("counts tips, because a tip is what a species is here", () => {
    expect(TREE_SPECIES).toBe(num(split![1]!));
  });

  it("rounds to the phrase every surface prints", () => {
    const m = /^([\d.]+) million species$/.exec(SPECIES_PHRASE);
    expect(m, `SPECIES_PHRASE reads "${SPECIES_PHRASE}"`).toBeTruthy();
    expect(Number(m![1])).toBe(Math.round(TREE_SPECIES / 100_000) / 10);
  });

  it("is not the node total, which is the figure that got in", () => {
    // Stated forwards, so this test also records *how* the wrong number is
    // arrived at rather than only that it is absent.
    const nodes = num(split![1]!) + num(split![2]!);
    expect(Math.round(nodes / 100_000) / 10).toBe(2.7);
    expect(SPECIES_PHRASE).not.toContain("2.7");
  });

  /**
   * Every file a reader's copy could be written in, minus this one.
   *
   * `import.meta.glob` and not a directory walk, on `ambient.d.ts`'s rule:
   * `@types/node` would put `process` and `Buffer` into the type space of a
   * browser bundle, so the one Node call this project declares is
   * `readFileSync`. `styles.test.ts` reads every component the same way. The
   * three files outside `src/` are named individually because they are known,
   * fixed and only three — and because `?raw` returns an empty string for CSS,
   * which Vite's own plugin claims before the raw loader sees it, so the
   * stylesheet could not come through the glob even if it lived here.
   *
   * Excluding this file is not squeamishness about a self-match: a test that
   * scans itself can only be written by hiding its own needle, and a needle
   * assembled from fragments is one nobody can grep for — which is the whole
   * failure being guarded against.
   */
  const FILES: [string, string][] = [
    ...Object.entries(
      import.meta.glob<string>("./**/*.{ts,tsx}", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    ).filter(([f]) => !f.endsWith("corpora.test.ts")),
    ["src/styles.css", read(url("./styles.css"))],
    ["index.html", read(url("../index.html"))],
    ["README.md", read(url("../../README.md"))],
  ];

  it("found the files it means to scan", () => {
    expect(FILES.length).toBeGreaterThan(30);
    for (const [name, text] of FILES) expect(text.length, name).toBeGreaterThan(0);
    // The three hand-named ones, since a typo in a path here would read as a
    // clean scan of nothing.
    expect(FILES.map(([f]) => f)).toEqual(
      expect.arrayContaining(["src/styles.css", "index.html", "README.md"]),
    );
  });

  /**
   * The positive control, and it is not ceremony.
   *
   * A scan that silently read nothing passes, reports no offenders, and looks
   * exactly like a clean codebase — which is the shape of every gate this repo
   * has been bitten by. The first draft of the check below did catch a real
   * instance, but that was a different scanner: this one goes through
   * `import.meta.glob`, where a pattern matching no files is not an error.
   * So prove the text is real by finding something that is in it.
   */
  it("is looking at the text and not at an empty list", () => {
    const found = FILES.filter(([, t]) => /2,385,875/.test(t)).map(([f]) => f);
    expect(found).toContain("./corpora.ts");
  });

  it("appears nowhere as the node count, in any surface or comment", () => {
    const offenders = FILES.filter(([, text]) =>
      /2\.7 million species/.test(text),
    ).map(([f]) => f);
    expect(offenders).toEqual([]);
  });
});
