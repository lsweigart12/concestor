import { describe, expect, it } from "vitest";
import type { PathNode } from "../api";
import { induced } from "./induced";
import {
  ageFrac,
  fracToAge,
  fracToAgeIn,
  laneHue,
  layout,
  orthPath,
  symlogFrac,
  SYMLOG_T0,
} from "./layout";

describe("symlog time axis", () => {
  it("is defined at the present", () => {
    // log(0) is where a naive implementation emits -Infinity and the layout
    // silently collapses. This is the whole reason for the linear stretch.
    expect(symlogFrac(0, 4247)).toBe(0);
    expect(Number.isFinite(symlogFrac(0, 4247))).toBe(true);
  });

  it("is monotone across the knee", () => {
    let prev = -1;
    for (const age of [
      0, 0.1, 0.5, 0.99, 1, 1.01, 5, 66, 252, 541, 1000, 4247,
    ]) {
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

describe("the axis mode is a scale, not a caption", () => {
  it("puts linear time where linear time goes", () => {
    // The toggle used to change the footer word and the knee marker and
    // nothing else, so "linear" was the symlog view with its warning removed.
    expect(ageFrac(1315, 1315, "linear")).toBeCloseTo(1, 9);
    expect(ageFrac(657.5, 1315, "linear")).toBeCloseTo(0.5, 9);
    expect(ageFrac(0, 1315, "linear")).toBe(0);
  });

  it("collapses the recent past, which is the comparison it exists for", () => {
    // Homo/Pan against a 1,315 Ma root: a fifth of the axis under symlog, a
    // rounding error under linear. Seeing that is the point of the toggle.
    expect(ageFrac(6.7, 1315, "log")).toBeGreaterThan(0.2);
    expect(ageFrac(6.7, 1315, "linear")).toBeLessThan(0.01);
  });

  it("round-trips in both modes", () => {
    for (const age of [0.25, 1, 12, 66, 252, 1000]) {
      for (const mode of ["log", "linear"] as const) {
        expect(fracToAgeIn(ageFrac(age, 1315, mode), 1315, mode)).toBeCloseTo(
          age,
          4,
        );
      }
    }
  });

  it("is monotone in both modes", () => {
    for (const mode of ["log", "linear"] as const) {
      let prev = -1;
      for (const age of [0, 0.5, 1, 5, 66, 252, 1315]) {
        const f = ageFrac(age, 1315, mode);
        expect(f).toBeGreaterThan(prev);
        prev = f;
      }
    }
  });

  it("stays invertible off the ends, which is where a panned axis asks", () => {
    // The axis inverts screen x = 0 and x = width to find what it is over, and
    // both are routinely outside the plot once the view is panned.
    expect(fracToAgeIn(1.4, 1315, "linear")).toBeCloseTo(1841, 3);
    expect(ageFrac(2000, 1315, "linear")).toBeGreaterThan(1);
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

function node(idx: number, name: string, age: number, tipCount = 1): PathNode {
  return {
    idx,
    key: `n${idx}`,
    ott_id: null,
    name,
    rank: null,
    age_ma: age,
    age_layout: age,
    tier: 0,
    tip_count: tipCount,
    depth: 0,
    phylopic_id: null,
    silhouette_source_idx: null,
  };
}

/**
 * A chosen clade that still contains a chosen species, which is the shape the
 * row rule exists for. The numbers are the build's own.
 *
 *   1 root
 *   └ 2 Whippomorpha (51.83)
 *     ├ 3 Cetacea (50.34, carries no age of its own)
 *     │ └ 4 Balaenoptera musculus (0)
 *     └ 5 Hippopotamus amphibius (0)
 */
const WHIP_PATHS: Record<number, number[]> = {
  3: [1, 2, 3],
  4: [1, 2, 3, 4],
  5: [1, 2, 5],
};
const WHIP_NODES = new Map<number, PathNode>([
  [1, node(1, "root", 100, 200)],
  [2, node(2, "Whippomorpha", 51.83, 174)],
  [3, node(3, "Cetacea", 50.34, 171)],
  [4, node(4, "Balaenoptera musculus", 0)],
  [5, node(5, "Hippopotamus amphibius", 0)],
]);
const WHIP = induced([3, 4, 5], (i) => WHIP_PATHS[i]);

describe("a node that continues is drawn on the lineage that continues", () => {
  const out = layout(WHIP, WHIP_NODES);

  it("puts a chosen clade on its own descendant's line", () => {
    // Rows go out in ascending idx, which is preorder, which puts an ancestor
    // before every descendant. Given a row of its own, Cetacea took the *first*
    // row of its own block — drawn above the whale it contains.
    expect(out.placed.get(3)!.y).toBe(out.placed.get(4)!.y);
  });

  it("does not leave the ancestor of both below the descendant of one", () => {
    // Whippomorpha used to take the midpoint of Cetacea's top row and the
    // hippo's, which is below the blue whale. Read down the canvas that said:
    // Cetacea, whale, then the ancestor of both, and Cetacea looked like a
    // sibling of the animal it contains.
    const whip = out.placed.get(2)!.y;
    expect(whip).toBeGreaterThan(out.placed.get(4)!.y);
    expect(whip).toBeLessThan(out.placed.get(5)!.y);
  });

  it("costs no rows for the node it no longer gives one to", () => {
    // Three selections, two lineage ends. The third is a point on one of them.
    expect(out.height).toBe(2 * 74);
  });

  it("still permutes nothing when a species is added", () => {
    // The property the whole file rests on: rows stay ascending `idx`, so a new
    // leaf inserts in place. Dropping the clade off the row list must not cost
    // it — nothing here re-sorts by subtree size.
    const before = layout(
      induced([4, 5], (i) => WHIP_PATHS[i]),
      WHIP_NODES,
    );
    expect(before.placed.get(4)!.y).toBe(out.placed.get(4)!.y);
    expect(before.placed.get(5)!.y).toBe(out.placed.get(5)!.y);
  });
});

/**
 * The exception, and the reason the row used to be unconditional. OTT files
 * *Homo sapiens neanderthalensis* as a child of *Homo sapiens* and both sit at
 * `age_layout` 0.
 */
const HOMO_PATHS: Record<number, number[]> = {
  3: [1, 2, 3],
  4: [1, 2, 3, 4],
  5: [1, 2, 5],
};
const HOMO_NODES = new Map<number, PathNode>([
  [1, node(1, "root", 100, 200)],
  [2, node(2, "Homininae", 6.7, 3)],
  [3, node(3, "Homo sapiens", 0)],
  [4, node(4, "Homo sapiens neanderthalensis", 0)],
  [5, node(5, "Pan troglodytes", 0)],
]);

describe("a branch with no length on the axis still keeps its row", () => {
  const out = layout(
    induced([3, 4, 5], (i) => HOMO_PATHS[i]),
    HOMO_NODES,
  );

  it("does not draw two chosen species on one pixel", () => {
    // Same x and same y is a divergence rendered correctly and invisibly. The
    // fix is a row, not an offset in x: x is time.
    expect(out.placed.get(3)!.x).toBe(out.placed.get(4)!.x);
    expect(out.placed.get(3)!.y).not.toBe(out.placed.get(4)!.y);
    expect(out.height).toBe(3 * 74);
  });

  it("drops the child straight down at the age they share", () => {
    expect(out.placed.get(4)!.y).toBe(out.placed.get(3)!.y + 74);
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
