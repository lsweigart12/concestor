import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

/**
 * The headline species count, against the dataset it claims to count.
 *
 * This is the `meta.test.ts` idea applied to prose: every assertion reads the
 * *other* artifact — `docs/data-sources.md`, and then every file that could
 * print a figure — rather than a second copy of the number.
 *
 * It exists because this one number has now been wrong twice, in two different
 * ways, and neither was catchable. "2.7 million species" was the node total.
 * "2.4 million species" was the tip total, written *while fixing the first
 * one*, by a reader who had the tip/internal split in front of them and took
 * the wrong half. Both are grammatical, plausible, close enough to look
 * checked, and reachable by no gate in the repo — copy is the only output here
 * that nothing validates.
 *
 * So the guard is on the **invariant** and not on the two known-bad strings:
 * a figure of this shape may appear in `corpora.ts` and nowhere else. Banning
 * the strings that have already been wrong only ever stops the mistake
 * somebody has already made.
 */
describe("the species count a reader is told", () => {
  const url = (p: string) => new URL(p, import.meta.url);
  const read = (u: URL) => readFileSync(u, "utf8");
  const DATA_SOURCES = read(url("../../docs/data-sources.md"));
  const num = (s: string) => Number(s.replace(/,/g, ""));

  /** `- **2,295,972 of them are \`rank='species'\`**, and …` */
  const species = /\*\*([\d,]+) of them are `rank='species'`\*\*/.exec(
    DATA_SOURCES,
  );
  /** `- **2,725,682 nodes total**: 2,385,875 tips + 339,807 internal.` */
  const split = /([\d,]+) tips \+ ([\d,]+) internal/.exec(DATA_SOURCES);

  it("is reading the dataset's own figures at all", () => {
    expect(DATA_SOURCES.length).toBeGreaterThan(1000);
    expect(
      species,
      "data-sources.md no longer states the species count",
    ).toBeTruthy();
    expect(
      split,
      "data-sources.md no longer states the tip/internal split",
    ).toBeTruthy();
  });

  it("counts species, and not the two neighbouring figures that are not", () => {
    expect(TREE_SPECIES).toBe(num(species![1]!));
    // Stated forwards, so this records *how* each wrong number is arrived at
    // rather than only that it is absent. Both were shipped.
    const tips = num(split![1]!);
    const nodes = tips + num(split![2]!);
    expect(TREE_SPECIES).not.toBe(tips);
    expect(TREE_SPECIES).not.toBe(nodes);
    expect(Math.round(nodes / 100_000) / 10).toBe(2.7);
    expect(Math.round(tips / 100_000) / 10).toBe(2.4);
  });

  it("rounds to the phrase every surface prints", () => {
    const m = /^([\d.]+) million species$/.exec(SPECIES_PHRASE);
    expect(m, `SPECIES_PHRASE reads "${SPECIES_PHRASE}"`).toBeTruthy();
    expect(Number(m![1])).toBe(Math.round(TREE_SPECIES / 100_000) / 10);
  });

  /**
   * Every file a reader's copy could be written in.
   *
   * `import.meta.glob` and not a directory walk, on `ambient.d.ts`'s rule:
   * `@types/node` would put `process` and `Buffer` into the type space of a
   * browser bundle, so the one Node call this project declares is
   * `readFileSync`. `styles.test.ts` reads every component the same way.
   *
   * The four hand-named files are the ones the glob cannot reach and a reader
   * can still be shown: the stylesheet (`?raw` returns an empty string for
   * CSS, which Vite's own plugin claims before the raw loader sees it), the
   * document, the README, and **the Worker** — which serves the SPA and is the
   * natural home for anything injected at the edge. The first version of this
   * scan claimed to cover "anywhere in `web/`" and covered `web/src` only.
   */
  const FILES: [string, string][] = [
    ...Object.entries(
      import.meta.glob<string>("./**/*.{ts,tsx}", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    ),
    ["src/styles.css", read(url("./styles.css"))],
    ["index.html", read(url("../index.html"))],
    ["worker/index.ts", read(url("../worker/index.ts"))],
    ["README.md", read(url("../../README.md"))],
  ];

  it("found the files it means to scan", () => {
    expect(FILES.length).toBeGreaterThan(30);
    for (const [name, text] of FILES)
      expect(text.length, name).toBeGreaterThan(0);
    expect(FILES.map(([f]) => f)).toEqual(
      expect.arrayContaining([
        "./corpora.ts",
        "src/styles.css",
        "index.html",
        "worker/index.ts",
        "README.md",
      ]),
    );
  });

  /**
   * The positive control, and it is not ceremony.
   *
   * A scan that silently read nothing passes, reports no offenders, and looks
   * exactly like a clean codebase — the shape of every gate this repo has been
   * bitten by. `import.meta.glob` matching no files is not an error, so prove
   * the text is real by finding something that is in it.
   */
  it("is looking at the text and not at an empty list", () => {
    const found = FILES.filter(([, t]) => t.includes(SPECIES_PHRASE)).map(
      ([f]) => f,
    );
    expect(found).toContain("./corpora.ts");
  });

  /**
   * Two exemptions, and they are the rule rather than holes in it.
   *
   * `corpora.ts` is where the figure is *written down*, so it is the one file
   * that must contain it. Tests are exempt because the guard is about what a
   * **reader** can be shown and a test renders to nobody — and because this
   * file has to be able to name both wrong numbers to record what happened,
   * which a rule with no exemption would have forced into fragments nobody can
   * grep for. Everything a browser can put on a screen is in scope.
   */
  const OWNS_THE_FIGURE = (f: string) =>
    f === "./corpora.ts" || /\.test\.tsx?$/.test(f);

  it("is written down once, and read everywhere else", () => {
    // Any figure of this shape, not the two that have been wrong: a guard on
    // the known-bad strings cannot catch the next surface writing its own.
    const offenders = FILES.filter(
      ([f, t]) => !OWNS_THE_FIGURE(f) && /\d\.\d million species/.test(t),
    ).map(([f]) => f);
    expect(offenders).toEqual([]);
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
