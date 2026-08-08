import { describe, expect, it } from "vitest";
import type { PathNode } from "../api";
import { induced } from "./induced";
import { ageFrac, fracToAge, laneHue, layout, orthPath } from "./layout";

describe("the time axis", () => {
  it("is proportional time, present at 0 and the deepest node at 1", () => {
    expect(ageFrac(1315, 1315)).toBeCloseTo(1, 9);
    expect(ageFrac(657.5, 1315)).toBeCloseTo(0.5, 9);
    expect(ageFrac(0, 1315)).toBe(0);
  });

  it("is defined at the present", () => {
    // Where the symlog this replaced needed a linear stretch to keep log(0)
    // from emitting -Infinity and collapsing the layout. Nothing to bend now.
    expect(ageFrac(0, 4247)).toBe(0);
    expect(Number.isFinite(ageFrac(0, 4247))).toBe(true);
  });

  it("draws a tree at the present without dividing by zero", () => {
    // Every node at age 0 — one species and its subspecies — used to lean on
    // the symlog threshold as the floor. `MIN_MAX_AGE` is that floor now.
    expect(ageFrac(0, 0)).toBe(0);
    expect(Number.isFinite(ageFrac(0, 0))).toBe(true);
  });

  it("round-trips through its inverse", () => {
    for (const age of [0.25, 1, 12, 66, 252, 1000, 4000]) {
      expect(fracToAge(ageFrac(age, 4247), 4247)).toBeCloseTo(age, 4);
    }
  });

  it("is monotone", () => {
    let prev = -1;
    for (const age of [0, 0.5, 1, 5, 66, 252, 1315]) {
      const f = ageFrac(age, 1315);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });

  it("stays invertible off the ends, which is where a panned axis asks", () => {
    // The axis inverts screen x = 0 and x = width to find what it is over, and
    // both are routinely outside the plot once the view is panned.
    expect(fracToAge(1.4, 1315)).toBeCloseTo(1841, 3);
    expect(ageFrac(2000, 1315)).toBeGreaterThan(1);
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

/**
 * `/?n=639642,188297,125642,480673,90224,611099,1033570,677394,732716,1089003,650443,832438`
 * — twelve taxa, which drew a canvas that shook and never settled.
 *
 * Sauropsida is chosen, so it is a leaf; it is also the ancestor of exactly one
 * rendered node, Sauria, 23 Ma along the axis from it. Against a 652 Ma root
 * that gap is 3.6% of the plot, so the two are one mark below about 500 units
 * of plot and two above it — and the row rule used to read the
 * *stretched* width. The fit solves that width from the tree's height
 * (`plotWidthToFill`), so: four rows asks for a wider plot, the wider plot drops
 * a row, three rows asks for a narrower one, and nothing ever settles. The 5%
 * band in `Graph.tsx` cannot catch it — the two fixed points are 46% apart.
 *
 * The ages are the build's own, read back from `/v1/paths`.
 */
const SHAKE_PATHS: Record<number, number[]> = {
  2: [1, 2],
  3: [1, 3],
  5: [1, 3, 4, 5],
  6: [1, 3, 4, 6],
};
const SHAKE_NODES = new Map<number, PathNode>([
  [1, node(1, "Bilateria", 652.4237670898438, 1463849)],
  [2, node(2, "Lumbricus terrestris complex", 5.181147575378418, 3)],
  [3, node(3, "Sauropsida", 323.18280029296875, 32043)],
  [4, node(4, "Sauria", 299.8999938964844, 32042)],
  [5, node(5, "Ornithischia", 237, 3)],
  [6, node(6, "Locustella naevia", 0)],
]);
const SHAKE = induced([2, 3, 5, 6], (i) => SHAKE_PATHS[i]);

describe("the row count is not a function of the axis stretch", () => {
  // Every width the fit may solve for, from the narrow-panel floor to
  // `PLOT_W * 6`, either side of the ~500 the real selection straddles.
  const widths = [340, 800, 1240, 1600, 1700, 2000, 2480, 4000, 7440];

  it("keeps one height across every stretch of the same tree", () => {
    // The property, and the whole of the bug: `baseWidth` is what the window
    // decided and does not move with the fit, so the fit cannot change the
    // thing it is solving from. Were this to fail, the canvas oscillates.
    const heights = widths.map(
      (w) =>
        layout(SHAKE, SHAKE_NODES, { plotWidth: w, baseWidth: 1240 }).height,
    );
    expect(new Set(heights).size).toBe(1);
  });

  it("still lets the reader's own window decide it", () => {
    // The narrow panel is not part of the loop — `vw` does not depend on the
    // layout — and on one the marks really do crowd, so the row is still owed.
    const narrow = layout(SHAKE, SHAKE_NODES, {
      plotWidth: 340,
      baseWidth: 340,
    });
    const wide = layout(SHAKE, SHAKE_NODES, {
      plotWidth: 2480,
      baseWidth: 2480,
    });
    expect(narrow.height).toBe(wide.height + 74);
  });

  it("defaults to the width it is drawn at, so callers keep today's answer", () => {
    expect(layout(SHAKE, SHAKE_NODES, { plotWidth: 800 }).height).toBe(
      layout(SHAKE, SHAKE_NODES, { plotWidth: 800, baseWidth: 800 }).height,
    );
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
