/**
 * Fossils, placed in the tree.
 *
 * A PBDB taxon is not a node. It has no position in the synthesis topology, no
 * sister group and no ancestor path — `phase3-pbdb-path.md` is the measurement,
 * and the whole of what phase 4 recovers is *this taxon belongs somewhere below
 * node X*. `attach_walk` says how loose even that is. So a fossil cannot be a
 * tip, and grafting one into the baked arrays would put a crown age on the
 * resulting MRCA and call it a divergence.
 *
 * It can still be **drawn**, and one property makes the placement fall out
 * rather than have to be invented: on this canvas **x is time**, and a fossil
 * is the one thing in the corpus that carries its own date. Every node here has
 * to be *estimated* onto the axis; a fossil is simply observed there.
 *
 * So a graft is:
 *
 *   x    its own `lla`, the latest end of the last appearance — the only end
 *        phase 4 trusts and the only one its layout clamp reads. No new
 *        judgement is made here, and none is available to make.
 *   y    a row of its own, directly beneath the lineage it hangs from, so it
 *        reads as attached rather than as a sibling of anything.
 *   join its own **first appearance**, clamped to the branch it hangs on.
 *
 * The join is the part that had to stop being arbitrary. It used to sit at the
 * attach node's `age_layout`, and `age_layout` is documented as "x-position
 * only — never a label": for genus *Homo* it is 3.37 with an `age_ma` of NaN,
 * so the connector left the lineage at a *synthesized* coordinate. The fossil's
 * own first appearance is measured instead, and it is the right measurement:
 * a lineage that was already a distinct taxon at time T parted from its
 * neighbours **at or before T**, so the first appearance is the youngest the
 * split can possibly be. Drawing the join there claims the least the data
 * allows rather than a number nobody estimated.
 *
 * It is clamped to the drawn branch because a fossil can be older than the
 * branch it hangs on — *Dimetrodon* first appears at 298.9 Ma below Amniota,
 * which is drawn at 323 — and there the honest join is the top of the branch,
 * which is exactly what the clamp gives.
 *
 * One consequence worth knowing: the connector's horizontal run then spans
 * first appearance to last, so where it is unclamped **that run is the fossil's
 * observed extent**. The vertical drop is the part nobody knows. Both are drawn
 * dashed, which understates the horizontal half rather than overstating it.
 *
 * The caption says "somewhere below", because the *one* thing we do not know is
 * where along that branch it joins. That is the paleontological figure
 * convention and it is also the literal truth of the data: a stub off a lineage
 * at a known date, with an unresolved attachment.
 *
 * **What a graft may never become is a divergence.** It is not in `Induced`, it
 * never enters an MRCA computation, and nothing may address the tree with its
 * index — which is negative for exactly that reason: `-(pbdb_taxon_no)` cannot
 * be confused with an `idx` by anything that forgets to check, because every
 * real node index is non-negative and every array lookup with a negative one
 * fails loudly instead of returning a neighbour.
 */

import {
  TIER_OCCURRENCE,
  type FossilTaxon,
  type PathNode,
} from "../api";
import type { Induced } from "./induced";

/** The synthetic key a graft carries. Parallel to a node's `node_key`. */
export function graftKey(taxonNo: number): string {
  return `pbdb${taxonNo}`;
}

/** `pbdb123` → 123, and null for anything else. The URL's half of the mapping. */
export function parseGraftKey(key: string): number | null {
  const m = /^pbdb(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/**
 * A graft's canvas index: negative, derived, and never an array subscript.
 *
 * See the module note. The negation is a type-level trick done in the value
 * domain, and it is worth the ugliness: `nodeMap.get(graft.idx)` misses,
 * `Arrays.parent[graft.idx]` is undefined, and `IsAncestor(graft.idx, …)`
 * refuses — so the failure of any code path that mistakes one for a node is
 * immediate rather than a silently wrong answer about a neighbouring taxon.
 */
export function graftIdx(taxonNo: number): number {
  return -taxonNo;
}

/** True for a canvas index that belongs to a fossil rather than to a node. */
export function isGraftIdx(idx: number): boolean {
  return idx < 0;
}

/**
 * Why a fossil could not be drawn, when it could not.
 *
 * Each of these is refused rather than approximated, and the refusals are the
 * interesting part of the design:
 *
 *   no-identity  the build's fossil table predates `pbdb_taxon_no`, so the
 *                graft has nothing to be keyed on and could not survive a URL
 *   no-range     PBDB records no appearance interval at all — 21.4% of the
 *                corpus. There is no x. A fossil placed at a guessed date is
 *                the one thing worse than a fossil not placed
 *   off-tree     the attach node is not on any branch currently drawn, so
 *                there is no lineage to hang it from. The remedy is to add
 *                that clade, which is a thing the reader can do
 */
export type GraftRefusal = "no-identity" | "no-range" | "off-tree";

export interface Graft {
  /** Negative. See {@link graftIdx}. */
  idx: number;
  key: string;
  fossil: FossilTaxon;
  /** What the canvas draws: an occurrence-tier node carrying its own picture. */
  node: PathNode;
  /**
   * The rendered node whose row block this graft follows, and whose row the
   * connector's horizontal run sits on.
   *
   * For an attach node that is itself rendered this is that node. For one
   * suppressed inside a segment it is the segment's *lower* endpoint, because
   * `orthPath` puts the segment's horizontal run at the lower node's y — so
   * that is the line a tick at the attach node's age actually lands on.
   */
  anchor: number;
  /** The attach node: the deepest node anyone can put this taxon below. */
  joinIdx: number;
  /**
   * Where along the branch the connector leaves, in Ma.
   *
   * The fossil's own first appearance, clamped to the span the anchor's branch
   * actually covers. **Not** the attach node's age — see the module note; that
   * was a layout coordinate rather than a measurement.
   */
  joinAge: number;
  /**
   * Which of three things `joinAge` actually is.
   *
   * A boolean was wrong here, and wrong in a way that put a false sentence on
   * screen. The clamp has two ends and they mean opposite things:
   *
   *   first-appearance  unclamped. The join is the fossil's own datum and the
   *                     horizontal run is its observed extent. The split is at
   *                     or before this point.
   *   anchor            the first appearance is *younger* than the anchor, so
   *                     the taxon sits below it and the split is not on the
   *                     drawn branch at all — it is somewhere further down.
   *                     *Dimetrodon* at 299–267 Ma below Amniota at 323.
   *   branch-top        the first appearance is *older* than the whole branch,
   *                     so the split is earlier than anything drawn here.
   *
   * `anchor` and `branch-top` both mean "clamped" and point in opposite
   * directions. Saying "parted somewhere earlier" for the first of them —
   * which is what a single boolean bought — is the exact reverse of the truth.
   */
  joinAt: "first-appearance" | "anchor" | "branch-top";
}

/**
 * The oldest and youngest ends of a fossil's brackets, or null if it has none.
 *
 * Both brackets, uncollapsed, reduced only to their extremes — the same
 * treatment `witnessFor` gives a witness. No midpoint is computed here or
 * anywhere: a midpoint is a fabricated estimate wearing an observation's
 * clothes.
 */
export function fossilSpan(
  f: Pick<FossilTaxon, "fea" | "fla" | "lea" | "lla">,
): { oldest: number; youngest: number } | null {
  const bounds = [f.fea, f.fla, f.lea, f.lla].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (bounds.length === 0) return null;
  return { oldest: Math.max(...bounds), youngest: Math.min(...bounds) };
}

/**
 * Where a fossil's attach node sits relative to what is currently drawn.
 *
 * Three cases and no fourth. A node is either rendered, or suppressed inside
 * exactly one segment, or not in the induced subtree at all — and the last is
 * a refusal rather than a fallback, because the nearest *drawn* thing to an
 * off-tree attach node is an ancestor several ranks up, and hanging a fossil
 * there would make a much larger claim than the data supports.
 */
export function locateAttachment(
  attachIdx: number,
  ind: Induced,
): { anchor: number; joinIdx: number } | null {
  if (ind.segments.has(attachIdx)) {
    return { anchor: attachIdx, joinIdx: attachIdx };
  }
  for (const [lower, seg] of ind.segments) {
    if (seg.suppressed.includes(attachIdx)) {
      return { anchor: lower, joinIdx: attachIdx };
    }
  }
  return null;
}

/**
 * Build the graft for a fossil, or say why not.
 *
 * `nodes` supplies the attach node's `age_layout`, which is where the connector
 * leaves the branch. Suppressed nodes arrive with every path, so the map holds
 * it whenever the attachment resolved at all.
 */
export function makeGraft(
  fossil: FossilTaxon,
  ind: Induced,
  nodes: ReadonlyMap<number, PathNode>,
): Graft | GraftRefusal {
  const taxonNo = fossil.pbdb_taxon_no;
  if (!taxonNo || taxonNo <= 0) return "no-identity";

  const span = fossilSpan(fossil);
  if (!span) return "no-range";

  const at = locateAttachment(fossil.attach_idx, ind);
  if (!at) return "off-tree";

  // The span of the branch the connector has to land on. `orthPath` draws the
  // anchor's incoming edge as a vertical at the ancestor's x and a horizontal
  // at the anchor's y, so the run available to us is between the two ages. At
  // the induced root there is no incoming edge at all and the only point on
  // offer is the node itself.
  const anchorAge = nodes.get(at.anchor)?.age_layout ?? 0;
  const ancIdx = ind.segments.get(at.anchor)?.anc ?? null;
  const branchTop = ancIdx === null ? anchorAge : (nodes.get(ancIdx)?.age_layout ?? anchorAge);
  const joinAge = Math.min(Math.max(span.oldest, anchorAge), branchTop);
  const joinAt =
    joinAge === span.oldest
      ? "first-appearance"
      : span.oldest < anchorAge
        ? "anchor"
        : "branch-top";

  const idx = graftIdx(taxonNo);
  const key = graftKey(taxonNo);

  return {
    idx,
    key,
    fossil,
    anchor: at.anchor,
    joinIdx: at.joinIdx,
    joinAge,
    joinAt,
    node: {
      idx,
      key,
      ott_id: null,
      name: fossil.name,
      rank: fossil.rank,
      // Never a number. The tier is `occurrence` precisely so that everything
      // guarding structural guards this too, and `markAge` prints the range
      // behind the fossil glyph rather than an age.
      age_ma: null,
      occurrence: {
        fea: fossil.fea,
        fla: fossil.fla,
        lea: fossil.lea,
        lla: fossil.lla,
      },
      // `lla` alone, matching phase 4's clamp. `fea` is junk-wide — measured,
      // the first-appearance bracket *widens* with occurrence count — and the
      // latest end is the one that holds throughout.
      age_layout: span.youngest,
      tier: TIER_OCCURRENCE,
      tip_count: 1,
      depth: 0,
      phylopic_id: fossil.phylopic_id ?? null,
      // Its own picture, so `mayDrawExemplar` lets it through. A fossil has no
      // clade to borrow from — `node_image` cannot reach a thing that is not a
      // node — so this is the one case where the drawing is always a portrait
      // and the borrowed-image caption would be a lie in the other direction.
      silhouette_source_idx: idx,
      silhouette_clade_idx: null,
      silhouette_clade_tips: null,
      silhouette_clade_name: null,
    },
  };
}

/**
 * Build every graft that can be placed, keeping the refusals.
 *
 * Refusals are returned rather than dropped because the reader asked for each
 * of these by name. A fossil that silently fails to appear is indistinguishable
 * from a broken canvas, which is the same reasoning `store.ts` applies to a
 * selection key that resolves to nothing.
 */
export interface GraftSet {
  grafts: Graft[];
  refused: { fossil: FossilTaxon; reason: GraftRefusal }[];
}

export function buildGrafts(
  fossils: readonly FossilTaxon[],
  ind: Induced,
  nodes: ReadonlyMap<number, PathNode>,
): GraftSet {
  const grafts: Graft[] = [];
  const refused: GraftSet["refused"] = [];
  for (const f of fossils) {
    const g = makeGraft(f, ind, nodes);
    if (typeof g === "string") refused.push({ fossil: f, reason: g });
    else grafts.push(g);
  }
  // Deterministic, and not by insertion order: the same URL must draw the same
  // picture whichever order the fossils happened to resolve in. Oldest first
  // within an anchor, so a stack of grafts on one branch reads down the axis.
  //
  // This is the *base* order, not the drawn one. Row order within a slot is a
  // layout question — it is what decides whether two connectors cross — and
  // `graftOrder` in `layout.ts` settles it, stably, on top of this.
  grafts.sort(
    (a, b) => a.anchor - b.anchor || b.node.age_layout - a.node.age_layout || a.idx - b.idx,
  );
  return { grafts, refused };
}
