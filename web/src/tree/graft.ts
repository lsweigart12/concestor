/**
 * Fossils, placed in the tree.
 *
 * A PBDB taxon is not a node: no topology position, no ancestor path, only
 * *belongs somewhere below node X* (`attach_walk` says how loosely). It cannot
 * be a tip, and grafting one into the baked arrays would put a crown age on the
 * resulting MRCA. It can still be drawn, because on this canvas x is time and a
 * fossil is the one thing that carries its own date. A graft is:
 *
 *   x    its own `lla`, the latest end of the last appearance (the end phase 4
 *        trusts).
 *   y    a row of its own beneath the lineage it hangs from.
 *   join its own first appearance — the youngest the split can be — clamped to
 *        the branch (a fossil can be older than the branch it hangs on).
 *
 * Where the join is unclamped, the connector's horizontal run is the fossil's
 * observed extent; the vertical drop is the unknown attachment, so the caption
 * says "somewhere below". Both dashed.
 *
 * A graft may never become a divergence: it is not in `Induced`, never enters an
 * MRCA, and its index is negative (`-(pbdb_taxon_no)`) so any array lookup that
 * mistakes it for a node fails loudly rather than answering about a neighbour.
 */

import {
  drawnBounds,
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
 * A graft's canvas index: `-(pbdb_taxon_no)`, negative so any code that mistakes
 * it for a node index fails loudly on the array lookup. See the module note.
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
   * Which of three things `joinAge` is — the two clamped ends point in opposite
   * directions, so a boolean would put a false sentence on screen:
   *
   *   first-appearance  unclamped; the split is at or before the join.
   *   anchor            first appearance younger than the anchor; the split is
   *                     further down, off the drawn branch.
   *   branch-top        first appearance older than the whole branch; the split
   *                     is earlier than anything drawn.
   */
  joinAt: "first-appearance" | "anchor" | "branch-top";
}

/**
 * The oldest and youngest ends of a fossil's brackets, or null if it has none.
 * No midpoint is computed — that would be a fabricated estimate.
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
 * Where the glyph goes: `lla_drawn`, PBDB's young end corrected where it rests
 * on material identified no finer than the taxon (differs from the bracket on
 * 7,802 rows — *Stegosaurus* would otherwise draw 50 Myr after it lived).
 * Clamped against `span` for safety.
 */
export function graftYoungest(
  f: Pick<FossilTaxon, "fea" | "fla" | "lea" | "lla" | "lla_drawn">,
  span: { oldest: number; youngest: number },
): number {
  const drawn = f.lla_drawn;
  if (typeof drawn !== "number" || !Number.isFinite(drawn))
    return span.youngest;
  return Math.min(Math.max(drawn, span.youngest), span.oldest);
}

/**
 * Where a fossil's attach node sits relative to what is drawn: rendered,
 * suppressed inside one segment, or off-tree (a refusal — the nearest drawn
 * thing would be an ancestor several ranks up).
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

/** Build the graft for a fossil, or say why not. */
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
  const branchTop =
    ancIdx === null ? anchorAge : (nodes.get(ancIdx)?.age_layout ?? anchorAge);
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
      // The bounds as they may be drawn: `[lea, lla]` corrected together (they
      // share occurrences), `fea`/`fla` untouched. The card prints PBDB's own
      // numbers beside this.
      occurrence: drawnBounds(fossil),
      // The corrected young end alone, matching phase 4's clamp.
      age_layout: graftYoungest(fossil, span),
      tier: TIER_OCCURRENCE,
      tip_count: 1,
      depth: 0,
      phylopic_id: fossil.phylopic_id ?? null,
      // Its own picture, so `mayDrawExemplar` lets it through: a fossil has no
      // clade to borrow from, so the drawing is always a portrait.
      silhouette_source_idx: idx,
      silhouette_clade_idx: null,
      silhouette_clade_tips: null,
      silhouette_clade_name: null,
    },
  };
}

/**
 * Build every graft that can be placed, keeping the refusals — the reader asked
 * for each by name, so a silent failure to appear reads as a broken canvas.
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
  // Deterministic, not by insertion order, so a URL draws the same picture
  // whatever order fossils resolved in. The base order; `graftOrder` in
  // `layout.ts` settles drawn row order on top of it.
  grafts.sort(
    (a, b) =>
      a.anchor - b.anchor ||
      b.node.age_layout - a.node.age_layout ||
      a.idx - b.idx,
  );
  return { grafts, refused };
}
