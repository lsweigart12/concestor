import { describe, expect, it } from "vitest";
import type { FossilTaxon, PathNode } from "../api";
import {
  capNote,
  laneHeight,
  laneRows,
  rankIntermediates,
  spineLabels,
  unplacedNote,
  LANE_ROWS,
} from "./lane";

function fossil(name: string, n: number, interval = true): FossilTaxon {
  return {
    name,
    rank: "genus",
    attach_idx: 1,
    n_occs: n,
    is_extant: false,
    ...(interval
      ? { fea: 83.6, fla: 72.2, lea: 72.2, lla: 66 }
      : { fea: null, fla: null, lea: null, lla: null }),
  };
}

function node(
  idx: number,
  name: string | null,
  rank: string | null,
  tips: number,
): PathNode {
  return {
    idx,
    key: `n${idx}`,
    ott_id: null,
    name,
    rank,
    age_ma: null,
    age_layout: 100 - idx,
    tier: 2,
    tip_count: tips,
    depth: idx,
    phylopic_id: null,
    silhouette_source_idx: null,
  };
}

describe("laneRows", () => {
  it("caps the bracket rows and keeps the count honest", () => {
    const many = Array.from({ length: 40 }, (_, i) => fossil(`T${i}`, 100 - i));
    const rows = laneRows(many, 6197);
    expect(rows.placed).toHaveLength(LANE_ROWS);
    // Ranked by n_occs upstream, so the cap keeps the most-recorded taxa.
    expect(rows.placed[0]!.name).toBe("T0");
    expect(rows.total).toBe(6197);
    expect(capNote(rows)).toBe("showing 8 of 6,197 · most notable first");
  });

  it("says nothing when the lane is complete", () => {
    const rows = laneRows(
      [fossil("Tyrannosaurus", 87), fossil("T. rex", 70)],
      2,
    );
    expect(rows.shown).toBe(2);
    expect(capNote(rows)).toBeNull();
  });

  /**
   * A truncated lane must never claim to be whole. The server caps at 200 and
   * deduplicates afterwards, so a returned list shorter than `fossils_total`
   * is the ordinary case on a deep segment.
   */
  it("never reports more shown than the segment holds", () => {
    const rows = laneRows([fossil("A", 3)], 0);
    expect(rows.total).toBe(1);
    expect(capNote(rows)).toBeNull();
  });

  it("separates taxa with no interval instead of placing them at zero", () => {
    const rows = laneRows(
      [fossil("Tyrannosaurus", 87), fossil("Nanotyrannus", 4, false)],
      2,
    );
    expect(rows.placed.map((f) => f.name)).toEqual(["Tyrannosaurus"]);
    expect(rows.unplaced.map((f) => f.name)).toEqual(["Nanotyrannus"]);
    expect(unplacedNote(rows.unplaced)).toBe(
      "no appearance interval recorded, so not placed in time: Nanotyrannus",
    );
    expect(unplacedNote([])).toBeNull();
  });

  it("counts the unnamed remainder of the unplaced rather than dropping it", () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      fossil(`U${i}`, 1, false),
    );
    const note = unplacedNote(eight);
    expect(note).toContain("U0, U1, U2, U3, U4 and 3 more");
  });

  it("reserves a row of height even when nothing is placed", () => {
    const empty = laneRows([], 0);
    expect(laneHeight(empty)).toBeGreaterThan(laneHeight(empty) - 1);
    expect(laneHeight(laneRows([fossil("A", 1)], 1))).toBe(laneHeight(empty));
  });
});

describe("rankIntermediates", () => {
  it("puts a named rank above a bigger unnamed clade", () => {
    const ranked = rankIntermediates([
      node(1, null, null, 900_000),
      node(2, "Synapsida", "class", 6_000),
      node(3, "Amniota", "no rank", 25_000),
    ]);
    expect(ranked.map((n) => n.name)).toEqual(["Synapsida", "Amniota", null]);
  });
});

describe("spineLabels", () => {
  it("drops the names that would collide, keeping the ranked ones", () => {
    const ranked = rankIntermediates([
      node(1, "Cynodontia", "order", 6_000),
      node(2, "Therapsida", "order", 5_900),
      node(3, "Synapsida", "class", 6_100),
    ]);
    // All three land within a few px of each other, so only the first ranked
    // one can print — and every node still gets its tick from the caller.
    const labels = spineLabels(ranked, () => 400, { width: 1000 });
    expect(labels).toHaveLength(1);
    expect(labels[0]!.text).toBe("Synapsida");
  });

  it("refuses a label that would run off the strip", () => {
    const ranked = [node(1, "Cynodontia", "order", 10)];
    expect(spineLabels(ranked, () => 2, { width: 1000 })).toEqual([]);
  });
});
