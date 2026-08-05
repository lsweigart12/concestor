/**
 * The rule for writing an age, pinned to the four places it used to be written.
 *
 * The ladder and the "this is the present" threshold were implemented four
 * times, and three of those surfaces can be on screen at once — a mark's label,
 * a bracket in the drill lane, and the detail card beside them. Nothing tied
 * any copy to any other, so changing one would have disagreed with the rest
 * silently, in front of the reader, and every test in the repo would still have
 * passed.
 *
 * This file is the tie, in the shape the project already uses for
 * `induced_subtree`: the originals are held here verbatim as the reference, and
 * the shared rule is swept against them. What that pins is not that the
 * originals were right — it is that **nothing a reader sees changed** when they
 * were folded into one, which is the only claim a refactor gets to make.
 *
 * The census at the foot is the durable half. A fifth copy costs one line to
 * write and nothing notices it; that is exactly how there came to be four.
 */

import { describe, expect, it } from "vitest";
import { gapLabel, isPresent, maFigure, PRESENT_MA } from "./ages";
import { TIER_INTERPOLATED, TIER_MEASURED } from "./api";
import { endedSpanLabel, maLabel, spanLabel } from "./canvas/Bracket";
import { ageLabel } from "./canvas/NodeMark";
import { spreadProse } from "./detail/spread";

// ------------------------------------------------------------ the originals --

/**
 * The four ladders as they stood at 896ddd4, copied unchanged.
 *
 * `gapLabel` is here too even though it moved rather than merged: it is the
 * documented variant, and a variant nobody re-measures is just a fourth copy
 * with a paragraph attached.
 */
const original = {
  /** `Bracket.tsx` — the drill lane's positions. */
  maLabel(ma: number): string {
    if (ma < 0.05) return "present";
    if (ma >= 100) return String(Math.round(ma));
    if (ma >= 10) return ma.toFixed(0);
    return ma.toFixed(1);
  },

  /** `NodeMark.tsx` — a canvas mark's age row, tier and unit included. */
  ageLabel(age: number, interpolated: boolean): string {
    if (age < 0.05) return "present";
    const n =
      age >= 100
        ? Math.round(age)
        : age >= 10
          ? age.toFixed(0)
          : age.toFixed(1);
    return `${interpolated ? "≤ " : ""}${n} Ma`;
  },

  /** `detail/spread.ts` — the card's prose. */
  figure(ma: number): string {
    if (!Number.isFinite(ma) || ma < 0.05) return "the present";
    const n =
      ma >= 100 ? Math.round(ma) : ma >= 10 ? ma.toFixed(0) : ma.toFixed(1);
    return `${n} Ma`;
  },

  /** `Bracket.tsx` — the witness gap, which never shared the rule. */
  gapLabel(ma: number): string {
    if (ma < 0.1) return "under 0.1 Ma";
    if (ma < 10) return `${ma.toFixed(1)} Ma`;
    return `${Math.round(ma)} Ma`;
  },
};

/**
 * Ages to sweep: every boundary in every ladder, the values either side of
 * them, the real figures the other tests in this repo pin, and a deterministic
 * spread across the axis to the root at ~4,600 Ma.
 *
 * Seeded rather than random, because a formatting test that fails once a week
 * on a value nobody can name teaches the reader to re-run it.
 */
const SWEEP: number[] = (() => {
  const edges = [
    0, 1e-9, 0.0117, 0.03, 0.049, 0.0499999, 0.05, 0.0500001, 0.051, 0.09, 0.1,
    0.11, 0.5, 0.94, 0.95, 0.99, 1, 4.48, 4.5, 5.333, 6.9, 9.44, 9.45, 9.94,
    9.95, 9.99, 10, 10.4, 15.8, 50, 51, 56, 56.0, 56.26, 66, 82.5603, 99.4,
    99.5, 99.9, 100, 100.4, 110.4, 112.5877, 137.05, 161.5, 239.48, 500.5,
    1000.5, 4600,
  ];
  // An LCG, so the spread is the same on every machine and in every run.
  let s = 20260804;
  for (let i = 0; i < 400; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    edges.push((s / 2147483648) * 4600);
  }
  return edges;
})();

// ------------------------------------------------------- the shared rule --

describe("the shared age rule", () => {
  it("prints exactly what the four copies printed", () => {
    for (const ma of SWEEP) {
      expect(isPresent(ma)).toBe(ma < 0.05);
      expect(maLabel(ma)).toBe(original.maLabel(ma));
      expect(ageLabel(ma, TIER_MEASURED)).toBe(original.ageLabel(ma, false));
      expect(ageLabel(ma, TIER_INTERPOLATED)).toBe(original.ageLabel(ma, true));
      expect(cardFigure(ma)).toBe(original.figure(ma));
      expect(gapLabel(ma)).toBe(original.gapLabel(ma));
    }
    // A sweep is only worth its assertions if it actually swept.
    expect(SWEEP.length).toBeGreaterThan(400);
  });

  /**
   * The rung that was carrying nothing.
   *
   * Three of the four copies branched at 100 to use `Math.round` instead of
   * `toFixed(0)`, which reads as a decision about deep time and is not one:
   * the two produce the same string everywhere, which is why `gapLabel` — the
   * copy written last — never had the branch. Dropping it is the only change
   * in this refactor, and it is a change to the source and not the screen.
   */
  it("needs no second rung at 100, and this is why", () => {
    for (const ma of SWEEP.filter((v) => v >= 10)) {
      expect(String(Math.round(ma))).toBe(ma.toFixed(0));
    }
    // Including the two values that are not numbers a reader would type.
    expect(String(Math.round(Infinity))).toBe(Infinity.toFixed(0));
    expect(maFigure(Infinity)).toBe("Infinity");
  });

  it("puts the digit where a tenth is worth a character", () => {
    expect(maFigure(4.48)).toBe("4.5");
    // 9.95 is 9.9499999… in binary, so it keeps its tenth rather than rounding
    // into a two-figure string. Worth writing down: the rung is at 10 and the
    // value below it stays below it.
    expect(maFigure(9.95)).toBe("9.9");
    expect(maFigure(10)).toBe("10");
    expect(maFigure(161.5)).toBe("162");
  });
});

// -------------------------------------------------- the surfaces' wording --

/**
 * The card's figure, which is private, read through the union it feeds.
 *
 * A bound at the present collapses the span, so both of those cases are ends of
 * the same sweep rather than a distinction this file cares about.
 */
function cardFigure(ma: number): string {
  const p = spreadProse({
    above: {
      idx: 1,
      key: "ott770315",
      name: "Hominidae",
      rank: "family",
      age_ma: ma,
    },
    below: null,
  });
  if (p?.kind !== "toPresent" && p?.kind !== "collapsed") {
    throw new Error(`expected a single bound, got ${String(p?.kind)}`);
  }
  return p.above.age;
}

/**
 * Four sentences about one figure.
 *
 * Each surface owns its wording and shares the number, which is the whole shape
 * of this change. If a later reader is tempted to unify the words too, the
 * reasons they must not are in the doc comments beside each of these.
 */
describe("what each surface does with the figure", () => {
  it("agrees on the number and differs only in the words", () => {
    const ma = 56.26;
    expect(maFigure(ma)).toBe("56");
    expect(maLabel(ma)).toBe("56");
    expect(ageLabel(ma, TIER_MEASURED)).toBe("56 Ma");
    expect(ageLabel(ma, TIER_INTERPOLATED)).toBe("≤ 56 Ma");
    expect(cardFigure(ma)).toBe("56 Ma");
    expect(spanLabel(ma, 6.9)).toBe("56–6.9 Ma");
  });

  it("agrees on where the present starts and differs on what to call it", () => {
    const ma = PRESENT_MA / 2;
    expect(maLabel(ma)).toBe("present");
    expect(ageLabel(ma, TIER_MEASURED)).toBe("present");
    expect(cardFigure(ma)).toBe("the present");
    // And the one surface that may not say it at all. *Homo erectus* ended at
    // 0.0117 Ma; the `occurrence` tier is applied only where nothing below the
    // node is alive, so "present" there is a plain falsehood.
    expect(endedSpanLabel(5.333, 0.0117)).toBe("5.3–0.01 Ma");
  });

  /**
   * The gap between a fork and its witness's range is a *quantity* and not a
   * position, which is why it varies from the shared rule rather than using it.
   *
   * The case that forced it: Perissodactyla is dated 56.26 Ma and *Eohippus*
   * tops out at 56.0. The shared ladder rounds both to "56", so the card showed
   * two identical figures and then said the range does not reach the split.
   * Every number was right and the reader could see only a contradiction.
   */
  it("keeps the witness gap out of the shared rule, on purpose", () => {
    // Where they diverge, and what each is right about.
    expect(gapLabel(0.03)).toBe("under 0.1 Ma");
    expect(maLabel(0.03)).toBe("present"); // a place, not a distance
    expect(gapLabel(0.26)).toBe("0.3 Ma");
    expect(gapLabel(4.48)).toBe("4.5 Ma");
    expect(gapLabel(56.26 - 56.0)).toBe("0.3 Ma");
    expect(maLabel(56.26 - 56.0)).toBe("0.3"); // agrees here, and only here
    // And where they meet again: above 10 the digit stops mattering to both.
    expect(gapLabel(110.4)).toBe("110 Ma");
    expect(maLabel(110.4)).toBe("110");
  });
});

// -------------------------------------------------------------- the census --

/** Every module in the app, as source text, this file and the tests apart. */
const SOURCES: [string, string][] = Object.entries(
  import.meta.glob<string>("./**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).filter(([f]) => !f.includes(".test.") && !f.endsWith("/ages.ts"));

/** Comments stripped, so a paragraph about the rule cannot trip the check. */
function bare(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the rule is written once", () => {
  /**
   * Both checks below search for an absence and pass for free against an empty
   * corpus — a moved file or a changed Vite option would leave them green and
   * measuring nothing, which is the failure `docs/ci.md` §2 is about.
   */
  it("is reading the modules at all", () => {
    expect(SOURCES.length).toBeGreaterThan(30);
    expect(SOURCES.every(([, s]) => s.length > 0)).toBe(true);
    // And reading the thing that replaced them, so a wholesale revert fails
    // here rather than passing quietly.
    const users = SOURCES.filter(([, s]) => /from "\.\.?\/ages"/.test(s));
    expect(users.length).toBeGreaterThan(3);
  });

  /**
   * A copy of the ladder needs `toFixed(0)` or `toFixed(1)` to exist, and
   * nothing else in this app formats a number to nought or one decimal place —
   * the axis uses `toPrecision`, the paths use `toFixed(2)`, the shaders their
   * own precision constant. So the search is exact and needs no allowlist.
   */
  it("holds the only ladder", () => {
    const found: string[] = [];
    for (const [file, src] of SOURCES) {
      if (/\.toFixed\([01]\)/.test(bare(src))) found.push(file);
    }
    expect(found).toEqual([]);
  });

  /**
   * And a copy of the threshold has to compare against it. `0.05` appears
   * elsewhere as a frame clamp, a zoom floor and a shader edge, none of which
   * is a comparison, so this catches the duplication without policing the
   * number.
   */
  it("holds the only present threshold", () => {
    const found: string[] = [];
    for (const [file, src] of SOURCES) {
      if (/(?:[<>]=?\s*0\.05(?!\d))|(?:0\.05(?!\d)\s*[<>]=?)/.test(bare(src))) {
        found.push(file);
      }
    }
    expect(found).toEqual([]);
  });
});
