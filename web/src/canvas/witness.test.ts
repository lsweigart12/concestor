/**
 * The divergence witness — the second silhouette, and the second caption.
 *
 * `borrowedTitle` exists because an ordinary silhouette is nearly always of a
 * relative, and drawing one is only defensible while the picture says so. A
 * witness is defensible for a different reason and so needs a different
 * sentence: it is inside the clade, not borrowed from beside it, and what
 * earns it is the *dates*. Strip those and it is an unlabelled shape again,
 * which is the failure this whole mechanism was built to fix.
 */

import { describe, expect, it } from "vitest";
import {
  witnessFor,
  TIER_INTERPOLATED,
  TIER_MEASURED,
  TIER_STRUCTURAL,
  type PathNode,
  type Witness,
} from "../api";
import { witnessTitle } from "./NodeMark";

/** The human–chimp split as the server sends it. */
function split(over: Partial<PathNode> = {}): PathNode {
  return {
    idx: 594475,
    key: "mrcaott770309ott417957",
    ott_id: null,
    name: null,
    rank: null,
    age_ma: 6.736,
    age_layout: 6.736,
    tier: TIER_INTERPOLATED,
    tip_count: 19,
    depth: 49,
    phylopic_id: "homo-uuid",
    silhouette_source_idx: 594480,
    divergence_phylopic_id: "sahel-uuid",
    divergence_source_idx: 594502,
    divergence_source_name: "Sahelanthropus",
    divergence_source_rank: "genus",
    divergence_gap_ma: 0,
    divergence_range: { fea: 7.246, fla: 5.333, lea: 7.246, lla: 5.333 },
    ...over,
  } as PathNode;
}

describe("witnessFor", () => {
  it("reads the taxon and the outer ends of its range", () => {
    const w = witnessFor(split());
    expect(w).toEqual({
      phylopicId: "sahel-uuid",
      name: "Sahelanthropus",
      rank: "genus",
      oldest: 7.246,
      youngest: 5.333,
      spans: true,
    });
  });

  it("is null on a node with no witness", () => {
    expect(witnessFor(split({ divergence_phylopic_id: null }))).toBeNull();
  });

  it("refuses a witness with no fossil range", () => {
    // The range is the whole difference between this and an unlabelled
    // silhouette, so a picture arriving without one is not drawn at all.
    expect(witnessFor(split({ divergence_range: null }))).toBeNull();
    expect(
      witnessFor(
        split({ divergence_range: { fea: null, fla: null, lea: null, lla: null } }),
      ),
    ).toBeNull();
  });

  it("survives a partial bracket", () => {
    // PBDB has no certain extent for 60.4% of taxa, so two of the four bounds
    // being absent is ordinary rather than broken.
    const w = witnessFor(
      split({ divergence_range: { fea: 56, fla: null, lea: null, lla: 33.9 } }),
    );
    expect(w?.oldest).toBe(56);
    expect(w?.youngest).toBe(33.9);
  });

  it("distinguishes spanning the split from merely nearing it", () => {
    expect(witnessFor(split())?.spans).toBe(true);
    expect(witnessFor(split({ divergence_gap_ma: 1.94 }))?.spans).toBe(false);
  });
});

describe("witnessTitle", () => {
  const sahelanthropus: Witness = {
    phylopicId: "sahel-uuid",
    name: "Sahelanthropus",
    rank: "genus",
    oldest: 7.246,
    youngest: 5.333,
    spans: true,
  };

  it("puts both dates in front of the reader", () => {
    // The claim is checkable or it is nothing: a range that contains the split
    // is visibly a range that contains the split.
    const t = witnessTitle(sahelanthropus, 6.736, TIER_INTERPOLATED);
    expect(t).toContain("Sahelanthropus");
    expect(t).toContain("7.2–5.3 Ma");
    expect(t).toContain("was around when these lineages parted");
    expect(t).toContain("≤ 6.7 Ma");
  });

  it("does not claim contemporaneity for a fossil that only comes close", () => {
    const near = { ...sahelanthropus, spans: false };
    const t = witnessTitle(near, 9.185, TIER_MEASURED);
    expect(t).toContain("the closest anyone has drawn");
    expect(t).not.toContain("so it was around when");
  });

  it("says nothing about a split nobody has dated", () => {
    // A structural node carries no age, and inventing one to compare against
    // is the exact thing the tier exists to prevent. The pipeline refuses to
    // write a witness for one; this is the belt to that brace.
    const t = witnessTitle(sahelanthropus, null, TIER_STRUCTURAL);
    expect(t).not.toContain("this split is dated");
    expect(t).toContain("7.2–5.3 Ma");
  });
});
