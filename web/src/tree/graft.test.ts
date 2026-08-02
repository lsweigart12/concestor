import { describe, expect, it } from "vitest";
import { TIER_OCCURRENCE, type FossilTaxon, type PathNode } from "../api";
import { induced } from "./induced";
import {
  buildGrafts,
  fossilSpan,
  graftIdx,
  graftKey,
  isGraftIdx,
  locateAttachment,
  makeGraft,
  parseGraftKey,
} from "./graft";
import { fracToAgeIn, layout, PAD_X, PLOT_W, ROW_H } from "./layout";

/**
 * A hominin-shaped fixture, because it is the case the feature was built for
 * and the one whose numbers are checkable by hand.
 *
 *   1 root
 *   └ 2 Homininae
 *     ├ 3 Homo (genus, suppressed between the MRCA and H. sapiens)
 *     │ └ 4 Homo sapiens
 *     └ 5 Pan troglodytes
 *
 * *Homo georgicus* attaches to 3 with `attach_walk` 1, which is exactly what
 * the real build says: PBDB's own taxon is not in the synthesis tree, so the
 * resolution walked one `parent_no` hop up to the genus.
 */
const PATHS: Record<number, number[]> = {
  4: [1, 2, 3, 4],
  5: [1, 2, 5],
};

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

const NODES = new Map<number, PathNode>([
  [1, node(1, "root", 100, 4)],
  [2, node(2, "Homininae", 6.7, 3)],
  [3, node(3, "Homo", 3.37, 2)],
  [4, node(4, "Homo sapiens", 0)],
  [5, node(5, "Pan troglodytes", 0)],
]);

const IND = induced([4, 5], (i) => PATHS[i]);

function fossil(over: Partial<FossilTaxon> = {}): FossilTaxon {
  return {
    name: "Homo georgicus",
    pbdb_taxon_no: 108454,
    rank: "species",
    attach_idx: 3,
    attach_walk: 1,
    n_occs: 1,
    is_extant: false,
    phylopic_id: "defe2111-c10d-4012-babd-4604caabe12a",
    fea: 2.58,
    fla: 0.774,
    lea: 2.58,
    lla: 0.774,
    ...over,
  };
}

describe("a graft index can never be mistaken for a node", () => {
  it("is negative, so every array lookup with one fails loudly", () => {
    expect(graftIdx(108454)).toBe(-108454);
    expect(isGraftIdx(graftIdx(108454))).toBe(true);
    expect(isGraftIdx(0)).toBe(false);
    expect(isGraftIdx(594480)).toBe(false);
  });

  it("round-trips through the key the URL carries", () => {
    expect(graftKey(108454)).toBe("pbdb108454");
    expect(parseGraftKey("pbdb108454")).toBe(108454);
    // A node key must not parse as a fossil, or a graft and a node could
    // collide in the one place they are both strings.
    expect(parseGraftKey("ott770315")).toBeNull();
    expect(parseGraftKey("mrcaott320ott10907")).toBeNull();
  });
});

describe("fossilSpan reduces the two brackets without collapsing them", () => {
  it("takes the extremes and computes no midpoint", () => {
    expect(fossilSpan(fossil())).toEqual({ oldest: 2.58, youngest: 0.774 });
  });

  it("is null when PBDB records no interval — 21.4% of the corpus", () => {
    expect(fossilSpan({ fea: null, fla: null, lea: null, lla: null })).toBeNull();
  });

  it("survives a partially recorded bracket", () => {
    expect(fossilSpan({ fea: 66, fla: null, lea: null, lla: 61 })).toEqual({
      oldest: 66,
      youngest: 61,
    });
  });
});

describe("locateAttachment finds the branch a fossil hangs on", () => {
  it("anchors on the node itself when that node is rendered", () => {
    expect(locateAttachment(4, IND)).toEqual({ anchor: 4, joinIdx: 4 });
  });

  it("anchors on the segment's lower end when the attach node is suppressed", () => {
    // Genus Homo is degree-2 between the MRCA and H. sapiens, so it is not
    // drawn. `orthPath` puts the segment's horizontal run at the *lower*
    // node's y, so that is the line a tick at Homo's age actually lands on.
    expect(locateAttachment(3, IND)).toEqual({ anchor: 4, joinIdx: 3 });
  });

  it("refuses an attach node that is not on any drawn branch", () => {
    // Not a fallback to the nearest ancestor: hanging a fossil off a node
    // several ranks up would make a much larger claim than the data supports.
    expect(locateAttachment(999, IND)).toBeNull();
  });
});

describe("makeGraft refuses rather than approximates", () => {
  it("refuses a fossil with no identity to be keyed on", () => {
    // A build whose fossil table predates `pbdb_taxon_no`. The field is
    // genuinely absent rather than undefined — `exactOptionalPropertyTypes`
    // makes that distinction real, and this is the shape the wire produces.
    const { pbdb_taxon_no: _omitted, ...anonymous } = fossil();
    expect(makeGraft(anonymous, IND, NODES)).toBe("no-identity");
  });

  it("refuses a fossil with no date, because there is no x for it", () => {
    const undated = fossil({ fea: null, fla: null, lea: null, lla: null });
    expect(makeGraft(undated, IND, NODES)).toBe("no-range");
  });

  it("refuses a fossil whose clade is not on screen", () => {
    expect(makeGraft(fossil({ attach_idx: 999 }), IND, NODES)).toBe("off-tree");
  });
});

describe("a graft is an occurrence-tier node carrying its own picture", () => {
  const g = makeGraft(fossil(), IND, NODES);
  if (typeof g === "string") throw new Error(`expected a graft, got ${g}`);

  it("never carries a numeric age", () => {
    // The whole reason the tier is `occurrence`: everything that guards
    // structural guards this too, and `markAge` prints the range behind the
    // fossil glyph instead of a figure.
    expect(g.node.age_ma).toBeNull();
    expect(g.node.tier).toBe(TIER_OCCURRENCE);
    expect(g.node.occurrence).toEqual({
      fea: 2.58,
      fla: 0.774,
      lea: 2.58,
      lla: 0.774,
    });
  });

  it("sits at lla, the only bracket end phase 4 trusts", () => {
    // `fea` is junk-wide — measured, the first-appearance bracket *widens*
    // with occurrence count — so the layout reads the latest end and only it.
    expect(g.node.age_layout).toBe(0.774);
  });

  it("owns its drawing, so no borrowed-image caption applies", () => {
    // `fossil_image` matches PBDB and PhyloPic on the same name and never
    // inherits: a fossil is not a node, so there is no clade to borrow from.
    expect(g.node.silhouette_source_idx).toBe(g.idx);
    expect(g.node.silhouette_clade_tips).toBeNull();
    expect(g.node.phylopic_id).toBe("defe2111-c10d-4012-babd-4604caabe12a");
  });

  it("leaves the branch at its own first appearance", () => {
    // Not the attach node's `age_layout`, which is a synthesized coordinate —
    // genus Homo has one of 3.37 and an `age_ma` of NaN. The first appearance
    // is measured, and it is the youngest the split can be: a lineage that was
    // already a distinct taxon at 2.58 Ma parted at or before 2.58 Ma.
    expect(g.joinAge).toBe(2.58);
    expect(g.joinAt).toBe("first-appearance");
    expect(g.joinIdx).toBe(3);
    expect(g.anchor).toBe(4);
  });
});

describe("the join is clamped to the branch it has to land on", () => {
  it("pulls back to the branch's top when the fossil predates the whole branch", () => {
    const early = fossil({ pbdb_taxon_no: 5, fea: 60, fla: 55, lea: 20, lla: 3 });
    const g = makeGraft(early, IND, NODES);
    if (typeof g === "string") throw new Error(g);
    // The branch runs Homininae (6.7) → H. sapiens (0); 60 Ma is off its top,
    // so the split is earlier than anything drawn here.
    expect(g.joinAge).toBe(6.7);
    expect(g.joinAt).toBe("branch-top");
  });

  it("joins at the anchor when the fossil first appears below it", () => {
    // *Dimetrodon*'s real case: 299–267 Ma hanging off Amniota at 323, so the
    // split is *below* the anchor rather than earlier than it. The two clamped
    // cases point in opposite directions and a boolean put the reverse of the
    // truth on screen — this is the one that caught it.
    const inside = makeGraft(
      fossil({ pbdb_taxon_no: 9, attach_idx: 2, fea: 4, fla: 3, lea: 4, lla: 3 }),
      IND,
      NODES,
    );
    if (typeof inside === "string") throw new Error(inside);
    expect(inside.anchor).toBe(2);
    expect(inside.joinAge).toBe(6.7);
    expect(inside.joinAt).toBe("anchor");
  });

  it("does not clamp a first appearance that sits on the branch", () => {
    const g = makeGraft(fossil({ pbdb_taxon_no: 6, fea: 5, lla: 1 }), IND, NODES);
    if (typeof g === "string") throw new Error(g);
    expect(g.joinAge).toBe(5);
    expect(g.joinAt).toBe("first-appearance");
  });
});

describe("buildGrafts is deterministic and keeps its refusals", () => {
  it("orders independently of the order the fossils resolved in", () => {
    const a = fossil();
    const b = fossil({ name: "Homo floresiensis", pbdb_taxon_no: 91487, lla: 0.0117 });
    const one = buildGrafts([a, b], IND, NODES).grafts.map((g) => g.idx);
    const two = buildGrafts([b, a], IND, NODES).grafts.map((g) => g.idx);
    expect(one).toEqual(two);
    // Oldest first within an anchor, so a stack of grafts reads down the axis.
    expect(one).toEqual([graftIdx(108454), graftIdx(91487)]);
  });

  it("reports what it would not draw rather than dropping it silently", () => {
    // A fossil that vanishes is indistinguishable from a broken canvas —
    // the same reasoning `store.ts` applies to an unresolvable selection.
    const { grafts, refused } = buildGrafts(
      [fossil(), fossil({ pbdb_taxon_no: 1, attach_idx: 999 })],
      IND,
      NODES,
    );
    expect(grafts).toHaveLength(1);
    expect(refused).toEqual([
      { fossil: expect.objectContaining({ pbdb_taxon_no: 1 }), reason: "off-tree" },
    ]);
  });
});

describe("the layout places a graft without disturbing the tree", () => {
  const { grafts } = buildGrafts([fossil()], IND, NODES);
  const bare = layout(IND, NODES);
  const with_ = layout(IND, NODES, { grafts });

  it("gives it a row of its own beneath the lineage it hangs from", () => {
    const g = with_.placed.get(graftIdx(108454));
    const sapiens = with_.placed.get(4);
    expect(g).toBeDefined();
    expect(sapiens).toBeDefined();
    // Directly after H. sapiens, whose row block it follows — not between
    // H. sapiens and Pan, which would separate a branch from the rest of
    // itself, and not at the bottom, which would read as a third lineage.
    expect(g!.y).toBe(sapiens!.y + ROW_H);
    expect(with_.placed.get(5)!.y).toBe(g!.y + ROW_H);
  });

  it("leaves every node's x exactly where it was", () => {
    // A graft is an annotation. It may open the tree vertically to make room;
    // it may never move anything in x, because x is time.
    for (const idx of [1, 2, 4, 5]) {
      const before = bare.placed.get(idx);
      const after = with_.placed.get(idx);
      if (!before || !after) continue;
      expect(after.x).toBeCloseTo(before.x, 9);
    }
  });

  it("spans the fossil's own range, first appearance to last", () => {
    const link = with_.graftLinks[0]!;
    const sapiens = with_.placed.get(4)!;
    const g = with_.placed.get(graftIdx(108454))!;
    // The join sits on the horizontal run of the segment leading to
    // H. sapiens. Unclamped, its x is the fossil's first appearance and the
    // mark's is its last — so the run between them is the observed extent
    // rather than a distance to somebody else's coordinate.
    expect(link.joinY).toBe(sapiens.y);
    expect(link.joinX).toBeLessThan(link.x);
    expect(link.x).toBe(g.x);
    expect(link.y).toBe(g.y);
    // Both ends read back as the bracket they came from, on the layout's own
    // scale — so the run is the range and not merely near it.
    const ageAt = (px: number) =>
      fracToAgeIn(1 - (px - PAD_X) / PLOT_W, with_.maxAge, "log");
    expect(ageAt(link.joinX)).toBeCloseTo(2.58, 6);
    expect(ageAt(link.x)).toBeCloseTo(0.774, 6);
  });

  it("stretches the axis to reach a fossil older than every node", () => {
    // Otherwise a Cambrian fossil under a shallow tree is placed against a
    // scale that does not reach it and lands off the left edge, which is the
    // one failure a time axis must not have.
    const old = fossil({ pbdb_taxon_no: 7, fea: 500, fla: 490, lea: 500, lla: 485 });
    const { grafts: deep } = buildGrafts([old], IND, NODES);
    const out = layout(IND, NODES, { grafts: deep });
    expect(out.maxAge).toBeGreaterThanOrEqual(485);
    expect(out.placed.get(graftIdx(7))!.x).toBeGreaterThan(0);
  });

  it("never enters the induced subtree", () => {
    // The load-bearing invariant. A graft on the canvas must not be a node in
    // the topology, or it would start contributing to an MRCA.
    expect(IND.rendered).not.toContain(graftIdx(108454));
    expect(IND.leaves).not.toContain(graftIdx(108454));
    expect(IND.segments.has(graftIdx(108454))).toBe(false);
  });
});

/**
 * Several fossils on one branch, which is the ordinary case and not the exotic
 * one: PBDB resolves most hominins to the same node, so asking for three at
 * once puts three connectors on the same point.
 *
 *   1 root (100)
 *   └ 2 Homininae (6.7)
 *     ├ 3 the H. sapiens / H. erectus divergence (2.2)
 *     │ ├ 4 Homo sapiens
 *     │ └ 6 Homo erectus
 *     └ 5 Pan
 *
 * The numbers are the real ones. *H. floresiensis* and *H. neanderthalensis*
 * first appear at 0.129 and 0.774 Ma — *younger* than the divergence they hang
 * from — so both connectors clamp to node 3 and leave the lineage at the same
 * x. *H. georgicus* first appears at 2.58, older than the fork, so its
 * connector leaves further up the branch and has further to travel right.
 */
const STACK_PATHS: Record<number, number[]> = {
  4: [1, 2, 3, 4],
  6: [1, 2, 3, 6],
  5: [1, 2, 5],
};

const STACK_NODES = new Map<number, PathNode>([
  [1, node(1, "root", 100, 5)],
  [2, node(2, "Homininae", 6.7, 4)],
  [3, node(3, "Homo sapiens / H. erectus", 2.2, 3)],
  [4, node(4, "Homo sapiens", 0)],
  [5, node(5, "Pan", 0)],
  [6, node(6, "Homo erectus", 0)],
]);

const STACK_IND = induced([4, 5, 6], (i) => STACK_PATHS[i]);

const GEORGICUS = fossil({ attach_idx: 3 });
const FLORESIENSIS = fossil({
  name: "Homo floresiensis",
  pbdb_taxon_no: 91487,
  attach_idx: 3,
  fea: 0.129,
  fla: 0.0117,
  lea: 0.129,
  lla: 0.0117,
});
const NEANDERTHALENSIS = fossil({
  name: "Homo neanderthalensis",
  pbdb_taxon_no: 83087,
  attach_idx: 3,
  fea: 0.774,
  fla: 0.129,
  lea: 0.129,
  lla: 0.0117,
});

/**
 * Do two graft connectors cross?
 *
 * Each is the L that `orthPath` draws: a vertical at `joinX` from the anchor's
 * row down to the fossil's, then a horizontal along the fossil's row out to the
 * mark. Written as the segments themselves rather than as a rule about ordering,
 * so the test measures the picture and not the implementation of the picture.
 */
function crosses(
  a: { joinX: number; joinY: number; x: number; y: number },
  b: { joinX: number; joinY: number; x: number; y: number },
): boolean {
  const spans = (lo: number, hi: number, v: number) =>
    v > Math.min(lo, hi) && v < Math.max(lo, hi);
  // b's vertical through a's horizontal, and the mirror.
  return (
    (spans(a.joinX, a.x, b.joinX) && spans(b.joinY, b.y, a.y)) ||
    (spans(b.joinX, b.x, a.joinX) && spans(a.joinY, a.y, b.y))
  );
}

describe("connectors on one branch do not cross each other", () => {
  const { grafts } = buildGrafts(
    [GEORGICUS, FLORESIENSIS, NEANDERTHALENSIS],
    STACK_IND,
    STACK_NODES,
  );
  const out = layout(STACK_IND, STACK_NODES, { grafts });

  it("draws the deepest join lowest", () => {
    // georgicus joins at 2.58 Ma, above the fork; the other two clamp to the
    // fork itself. Ordered by last appearance instead, georgicus came first
    // and its run cut through the vertical carrying the other two down.
    const ys = new Map(out.graftLinks.map((l) => [l.graft.fossil.name, l.y]));
    expect(ys.get("Homo georgicus")).toBeGreaterThan(ys.get("Homo floresiensis")!);
    expect(ys.get("Homo georgicus")).toBeGreaterThan(
      ys.get("Homo neanderthalensis")!,
    );
  });

  it("puts them below the whole clade they hang from, not inside it", () => {
    // The existing rule, still holding: the fossils follow node 3's block
    // rather than splitting H. sapiens from H. erectus.
    for (const l of out.graftLinks) {
      expect(l.y).toBeGreaterThan(out.placed.get(4)!.y);
      expect(l.y).toBeGreaterThan(out.placed.get(6)!.y);
    }
  });

  it("has no pair of connectors intersecting", () => {
    expect(out.graftLinks).toHaveLength(3);
    for (const a of out.graftLinks) {
      for (const b of out.graftLinks) {
        if (a === b) continue;
        expect([a.graft.fossil.name, b.graft.fossil.name, crosses(a, b)]).toEqual([
          a.graft.fossil.name,
          b.graft.fossil.name,
          false,
        ]);
      }
    }
  });

  it("puts each fossil's name beside its own mark", () => {
    // A graft is terminal: its connector arrives from the left and stops, so
    // the margin to its right is clear and the label belongs in it. Typed as a
    // divergence — which it was, because `isLeaf` means *chosen* — it went down
    // a candidate list that does not offer `dy: 0` until its ninth entry, and
    // every fossil's name and silhouette sat a half-row above the ammonite it
    // named. With three of them stacked, the reader has to guess the pairing.
    for (const l of out.graftLinks) {
      const box = out.labels.get(l.idx);
      expect([l.graft.fossil.name, box?.side, box?.dy]).toEqual([
        l.graft.fossil.name,
        "right",
        0,
      ]);
    }
  });

  it("still draws the same picture whatever order the fossils resolved in", () => {
    const other = buildGrafts(
      [NEANDERTHALENSIS, GEORGICUS, FLORESIENSIS],
      STACK_IND,
      STACK_NODES,
    ).grafts;
    const flipped = layout(STACK_IND, STACK_NODES, { grafts: other });
    expect(flipped.graftLinks.map((l) => [l.idx, l.y])).toEqual(
      out.graftLinks.map((l) => [l.idx, l.y]),
    );
  });
});
