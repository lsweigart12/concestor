/**
 * Typed client for the read API (the Go binary in ../server).
 *
 * Everything the API serves is immutable within a build, so a response is cached
 * in-process once fetched — which is what lets the MRCA, reflow and drill-down
 * fire in the same frame as the click (architecture §2). How long it is kept is
 * a question about the URL; see {@link get}.
 */

import { displayCommonName, displayCommonNameOrNull } from "./vernacular";

/** Age provenance, architecture §3.5. The numbers match `age_tier.npy`. */
export const TIER_MEASURED = 0;
export const TIER_INTERPOLATED = 1;
export const TIER_STRUCTURAL = 2;
/**
 * Extinct, and the rock has something to say (written by phase 4). Not a fourth
 * grade of divergence estimate but a weaker question in the same units — when
 * the taxon is observed in the rock — so it carries no `age_ma`, like
 * structural, and everything guarding structural must guard it too.
 */
export const TIER_OCCURRENCE = 3;
export type Tier = 0 | 1 | 2 | 3;

/** The tiers that may show a number. The other two mean "nobody estimated one". */
export function tierHasAge(t: Tier): boolean {
  return t === TIER_MEASURED || t === TIER_INTERPOLATED;
}

export interface PathNode {
  idx: number;
  key: string;
  ott_id: number | null;
  name: string | null;
  rank: string | null;
  /**
   * The name this taxon goes by when the canvas draws common names: the name
   * ranked first by use, served only for genus and species (both in
   * `api.Entry.Vernacular`). Usually absent — most of a deep tree falls back to
   * the scientific name, and italics tell the reader which they see (`markName`).
   */
  vernacular?: string | null;
  /**
   * NULL wherever no numeric age may be shown. Structural and occurrence are
   * both always null: neither means "we are unsure", they mean nobody
   * estimated one.
   */
  age_ma: number | null;
  /**
   * The fossil range, present only on the `occurrence` tier. Not an age — an
   * observed stratigraphic extent, which is a weaker and differently-shaped
   * claim. It renders as a range and never as a point, and no midpoint may be
   * computed from it: a midpoint is a fabricated estimate wearing an
   * observation's clothes.
   */
  occurrence?: {
    fea: number | null;
    fla: number | null;
    lea: number | null;
    lla: number | null;
  } | null;
  /** Finite everywhere, monotone root-to-tip. x-position only — never a label. */
  age_layout: number;
  tier: Tier;
  tip_count: number;
  depth: number;
  phylopic_id: string | null;
  /** The node the silhouette is actually a drawing of. Often a relative. */
  silhouette_source_idx: number | null;
  /**
   * The smallest clade holding both this node and that drawing — the whole claim
   * the picture makes. Its `tip_count` is how big a claim, and what the caption
   * carries. Null on an older build.
   */
  silhouette_clade_idx?: number | null;
  silhouette_clade_tips?: number | null;
  silhouette_clade_name?: string | null;
  /**
   * The divergence witness: a second silhouette, of a fossil taxon from
   * somewhere below this fork whose stratigraphic bracket puts it at the split.
   * `phylopic_id` prefers the most inclusive drawing, so at a split it is a crown
   * group that postdates the parting; this is a taxon that existed at it
   * (*Acanthostega*, *Eohippus*, *Pakicetus*). The claim is weaker — *belongs
   * somewhere below this node* (architecture §3.4), `divergence_attach_walk` says
   * how loose. Which to draw is the client's call. Absent where the fork carries
   * its own drawing.
   */
  divergence_phylopic_id?: string | null;
  /** A `fossil.pbdb_taxon_no`. **Not** a node index — nothing may address the tree with it. */
  divergence_pbdb_taxon_no?: number | null;
  divergence_source_name?: string | null;
  divergence_source_rank?: string | null;
  /** The deepest node the fossil is known to sit below. */
  divergence_attach_idx?: number | null;
  /**
   * PBDB `parent_no` hops to that node, i.e. how loose the placement is. Zero
   * means the taxon is itself in the tree; large means the claim is about a
   * family rather than a lineage.
   */
  divergence_attach_walk?: number | null;
  /** Ma from the split to that taxon's range. 0 means the range spans it. */
  divergence_gap_ma?: number | null;
  /**
   * The witness taxon's own fossil bracket — what makes the picture legible. A
   * range, never a point, like `occurrence`. Only `fea` and `lla` arrive.
   */
  divergence_range?: {
    fea: number | null;
    fla: number | null;
    lea: number | null;
    lla: number | null;
  } | null;
}

/** A witness, resolved into the shape the canvas and the card both render. */
export interface Witness {
  phylopicId: string;
  /** The taxon drawn. Null only on a build that predates the name lookup. */
  name: string | null;
  rank: string | null;
  /** Widest and youngest ends of its observed range, or null if it has none. */
  oldest: number | null;
  youngest: number | null;
  /** True when that range contains the split rather than merely nearing it. */
  spans: boolean;
  /**
   * Ma from the split to the nearer end of the range, 0 when it spans. Carried
   * because rounding can make two right figures ("56 Ma", "56–51 Ma") look
   * contradictory when the range does not quite reach the split.
   */
  gapMa: number | null;
  /**
   * PBDB `parent_no` hops from the taxon to the deepest node it is known to sit
   * below. Zero means the taxon is itself in the synthesis tree, so the fossil
   * hangs exactly where the picture says; higher means the placement is
   * progressively vaguer, and eight is a statement about a family. Null on a
   * build that predates the move onto attachment points, where the witness was
   * a node and the question did not arise.
   */
  attachWalk: number | null;
  /**
   * The PBDB taxon, which is what the card links to.
   *
   * **A witness opens a fossil card, never a node card**, and this field is what
   * enforces it. The tempting alternative is to link the witness's *attachment
   * point* instead, since that is a node and nodes are what the canvas draws —
   * but the attachment point is a clade the fossil sits somewhere below, often
   * tens of thousands of species wide, and sending a reader who clicked
   * *Pakicetus* to Artiodactyla answers a question they did not ask. Null on a
   * build predating the field.
   */
  pbdbTaxonNo: number | null;
  /** The deepest node it is known to sit below — offered *beside* the taxon. */
  attachIdx: number | null;
}

/**
 * The witness for a node, or null.
 *
 * Refuses a witness with no fossil range even though the server should never
 * send one, because the range is the entire difference between this and an
 * unlabelled silhouette. A picture captioned "Sahelanthropus, 7.2–5.3 Ma"
 * beside a split dated 6.7 Ma is a claim the reader can check; the same
 * picture with no dates is the unexplained shape this replaced.
 */
export function witnessFor(node: PathNode): Witness | null {
  const id = node.divergence_phylopic_id;
  if (!id) return null;
  const r = node.divergence_range;
  const bounds = [r?.fea, r?.fla, r?.lea, r?.lla].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (bounds.length === 0) return null;
  return {
    phylopicId: id,
    name: node.divergence_source_name ?? null,
    rank: node.divergence_source_rank ?? null,
    oldest: Math.max(...bounds),
    youngest: Math.min(...bounds),
    spans: node.divergence_gap_ma === 0,
    gapMa: node.divergence_gap_ma ?? null,
    attachWalk: node.divergence_attach_walk ?? null,
    pbdbTaxonNo: node.divergence_pbdb_taxon_no ?? null,
    attachIdx: node.divergence_attach_idx ?? null,
  };
}

export interface PathResponse {
  key: string;
  idx: number;
  forwarded_from: number | null;
  path: PathNode[];
  broken?: undefined;
}

/**
 * A non-monophyletic taxon. There are 9,839 of them and they are *rejected*
 * from synthesis, so they are not nodes at all. The live Open Tree API
 * silently answers about the substituted MRCA instead; we explain.
 */
interface BrokenResponse {
  broken: true;
  ott_id: number;
  name: string | null;
  mrca_node_key: string;
  mrca_idx: number | null;
  n_attachment_points: number;
  attachment_points: unknown;
  intruding_taxa: unknown;
  path?: undefined;
}

export type Resolved = PathResponse | BrokenResponse;

interface HitBase {
  key: string;
  ott_id: number | null;
  name: string | null;
  vernacular: string | null;
  rank: string | null;
  has_age: boolean;
  has_image: boolean;
  /**
   * Which corpus the winning name came from: `name`, `abbreviation`, `synonym`,
   * `vernacular`, `fossil-name`, `fts` or `key`.
   *
   * `fossil-name` is the Paleobiology Database's name for a taxon the tree
   * holds as a node. Those rows are refused from the fossil list on purpose
   * (fossil-grafts.md §9), so this is the only way they answer at all.
   */
  matched_on: string;
  /**
   * The name that actually matched, when the row does not already show it —
   * a synonym, an abbreviation, or the fossil record's spelling.
   *
   * The one field that contains what the reader typed. Without it a synonym
   * hit is an unexplained answer, and OTT files *Homo floresiensis* as a
   * synonym of *Homo sapiens*, so the unexplained answer is about a different
   * species and reads as the search having misheard.
   */
  matched_name?: string | null;
  /**
   * Where this row sits in the one ranking covering both corpora. `/v1/search`
   * answers with two arrays (a node and a PBDB taxon are different shapes) and
   * this integer merges them into one list. The client sorts by it but must not
   * re-rank. Absent on a broken taxon and on non-query endpoints.
   */
  order?: number | null;
  /** Present when the server resolved a silhouette for this hit. */
  phylopic_id?: string | null;
  /** The node the image is actually a drawing of. Often a relative. */
  silhouette_source_idx?: number | null;
  silhouette_source_tips?: number | null;
  /** The smallest clade holding both this hit and that drawing — see PathNode. */
  silhouette_clade_tips?: number | null;
}

/**
 * A hit that is a node — something that can go on the canvas. `idx` and
 * `tip_count` are null for a broken taxon (not in the tree); narrowing on `kind`
 * keeps a `"n:null"` shared key/identity unrepresentable.
 */
export interface SearchHit extends HitBase {
  kind: "node";
  idx: number;
  tip_count: number;
}

/** A hit that is a non-monophyletic taxon — an explanation, not a candidate. */
export interface BrokenHit extends HitBase {
  kind: "broken";
  idx: null;
  tip_count: null;
  mrca_idx: number | null;
  n_attachment_points: number | null;
}

export type AnyHit = SearchHit | BrokenHit;

export interface NodeDetail extends PathNode {
  flags: string | null;
  child_count: number;
  synonyms: string[];
  vernaculars: string[];
  /**
   * The infraspecific taxa the pipeline folded into this node — subspecies,
   * varieties, forms. They are not nodes; the card mentions them so a species
   * that is deliberately a tip can still say what it contains.
   */
  folded_infraspecific: { ott_id: number; name: string; rank: string | null }[];
  /**
   * The Wikidata item this node is, where the vernacular crawl reached it. An
   * identifier, not a name, so a link from it lands on the right article; absent
   * elsewhere, where `detail/wiki.ts` falls back to a checked name lookup.
   */
  wikidata_qid?: string | null;
  silhouette: {
    phylopic_id: string;
    license_url: string;
    /** The original creator. Renders as the credit. */
    attribution: string | null;
    /** The uploader. Differs from the creator about half the time. */
    contributor: string | null;
    /** The node the drawing is of. Usually a relative, rarely this node. */
    source_idx: number;
    source_name: string | null;
    /** The smallest clade holding both — the whole of what is being claimed. */
    clade_idx?: number | null;
    clade_name?: string | null;
    clade_tip_count?: number | null;
  } | null;
  /**
   * The witness drawing's own credit. A separate artist from `silhouette`'s,
   * so a separate block: the canvas shows this image, and CC-BY applies to
   * whatever is on screen.
   */
  divergence_silhouette?: {
    phylopic_id: string;
    license_url: string;
    attribution: string | null;
    contributor: string | null;
    source_idx: number;
    source_name: string | null;
  } | null;
  /**
   * The dated taxa this node's x was spread between, on a node with no age.
   *
   * Absent on any node carrying one, and absent on an older build. It exists
   * so the card can *name* what the position was derived from rather than say
   * "its nearest dated ancestor and descendant" — a phrase that is true of
   * 2.8% of these nodes and describes nothing a reader of the other 97.2% can
   * find on screen.
   */
  layout_spread?: LayoutSpread | null;
}

/** One end of the span an undated node was placed within. */
interface LayoutBound {
  idx: number;
  key: string;
  /** Null on an `mrcaott…` clade — 24.4% of the upper bounds. */
  name: string | null;
  rank: string | null;
  age_ma: number;
}

/**
 * What an undated node's position was derived from. `below` is null on most
 * structural nodes — the dated descendant is a tip at the present, so the lower
 * end of the span is the present. `above` is nullable only for a partial build.
 */
export interface LayoutSpread {
  above: LayoutBound | null;
  below: LayoutBound | null;
}

/**
 * When may a node draw an image it did not earn? The size of the smallest clade
 * holding both the node and the drawing is the whole claim the picture makes, so
 * it is what the threshold would judge.
 */
export interface SilhouettePolicy {
  maxCladeTips: number;
}

/**
 * Draw everything: every node with a resolved image draws it. Measured on the
 * built corpus, no borrow reaches a clade of over a million, so there is no
 * misinforming population for a threshold to catch — and each borrow is labelled
 * in the drawing's accessible name and on the card. The knob is here in case
 * that labelling weakens.
 * (Superseded for a divergence, which draws its witness or nothing — see
 * `Graph.mayDrawExemplar`.)
 */
export const SILHOUETTE_POLICY: SilhouettePolicy = {
  maxCladeTips: Number.POSITIVE_INFINITY,
};

/**
 * Whether to draw a node's silhouette at all. `cladeTips` is the smallest clade
 * holding node and drawing; undefined on an older build, where it is drawn.
 */
export function silhouetteIsInformative(
  node: Pick<PathNode, "phylopic_id">,
  cladeTips: number | null | undefined,
  policy: SilhouettePolicy = SILHOUETTE_POLICY,
): boolean {
  if (!node.phylopic_id) return false;
  if (cladeTips === null || cladeTips === undefined) return true;
  return cladeTips <= policy.maxCladeTips;
}

/**
 * The silhouette to draw for a search hit, or null to draw none.
 *
 * A search hit carries the same borrowed-image problem as a node on the canvas
 * and is judged by the same rule — one function, so the palette and the canvas
 * cannot drift into disagreeing about whether a given picture is honest.
 */
export function hitSilhouette(
  hit: SearchHit,
  policy: SilhouettePolicy = SILHOUETTE_POLICY,
): string | null {
  const ok = silhouetteIsInformative(
    { phylopic_id: hit.phylopic_id ?? null },
    hit.silhouette_clade_tips,
    policy,
  );
  return ok ? (hit.phylopic_id ?? null) : null;
}

/**
 * A PBDB taxon attached somewhere on a segment (architecture §3.4).
 *
 * The four appearance bounds arrive uncollapsed and must stay that way — they
 * are two brackets, not a range, and `canvas/bracket.ts` is the only thing
 * allowed to turn them into marks. They are also **not ages**: an appearance
 * interval is an observed stratigraphic extent, which is a different and
 * weaker claim than a divergence time, and nothing here may reach `age_ma`.
 */
export interface FossilTaxon {
  name: string;
  /**
   * PBDB's own primary key, and the only identity this taxon has — it is not a
   * node, so it has no `node_key` and no OTT id. It is what a graft is keyed on
   * and therefore what goes in the URL. Absent on a build whose fossil table
   * predates the column, which `makeGraft` refuses rather than works around.
   *
   * **Nothing may address the tree with it.** See `divergence_pbdb_taxon_no`.
   */
  pbdb_taxon_no?: number;
  rank: string | null;
  /**
   * Where this row sits in the one ranking that covers both corpora, on a
   * `/v1/search` response and nowhere else. See {@link HitBase.order}.
   */
  order?: number | null;
  /** The tree node it resolves to. Always on the segment we asked about. */
  attach_idx: number;
  /**
   * PBDB `parent_no` hops taken to reach `attach_idx`, and so how loose the
   * placement is. Zero means the taxon is itself in the synthesis tree; eight
   * is a statement about a family. `placementNote` turns it into words.
   */
  attach_walk?: number | null;
  n_occs: number;
  is_extant: boolean | null;
  /**
   * A drawing of *this taxon*, when PhyloPic has one under the same name.
   * Never inherited: a fossil is not a node, so it has no clade to borrow a
   * picture from, and somebody else's portrait beside it would say nothing.
   * Present on 4,656 of the 275,082 dated PBDB taxa.
   */
  phylopic_id?: string | null;
  fea: number | null;
  fla: number | null;
  lea: number | null;
  lla: number | null;
  /**
   * The last-appearance bracket read for what it is worth; `lla` above is PBDB's
   * own and never overwritten. `lla_identified` is the youngest last appearance
   * an *identified* member reaches — older than `lla` means the young end rests
   * on `Stegosaurus sp.`-grade material (exact, since PBDB aggregates upward).
   * `lla_drawn` is the only one a position may read; phase 4 holds
   * `lla <= lla_drawn <= fea`. All absent on an older build.
   */
  lla_identified?: number | null;
  young_end_occs?: number | null;
  lla_drawn?: number | null;
  /**
   * The other end of the same bracket, moved with `lla_drawn`: pairing a
   * corrected `lla_drawn` with PBDB's own `lea` would assemble a bracket from two
   * different records.
   */
  lea_drawn?: number | null;
}

/**
 * The four bounds as they may be drawn: `fea`/`fla` unchanged, the
 * last-appearance bracket corrected where its young end is one no identified
 * member reaches. `fea`/`fla` are wide for a different reason (stratigraphic
 * resolution), which the faded envelope honestly means.
 */
export function drawnBounds(f: FossilTaxon): {
  fea: number | null;
  fla: number | null;
  lea: number | null;
  lla: number | null;
} {
  const moved =
    typeof f.lla_drawn === "number" &&
    Number.isFinite(f.lla_drawn) &&
    f.lla_drawn !== f.lla;
  if (!moved) return { fea: f.fea, fla: f.fla, lea: f.lea, lla: f.lla };
  return {
    fea: f.fea,
    fla: f.fla,
    lea: typeof f.lea_drawn === "number" ? f.lea_drawn : f.lea,
    lla: f.lla_drawn as number,
  };
}

/**
 * Whether a fossil's young end is one no identified member reaches. A comparison
 * rather than a flag, so a build without the columns answers `false`.
 */
export function youngEndIsIndeterminate(
  f: Pick<FossilTaxon, "lla" | "lla_identified">,
): boolean {
  return (
    typeof f.lla === "number" &&
    typeof f.lla_identified === "number" &&
    f.lla_identified > f.lla
  );
}

/**
 * A fossil with the two things a card needs beyond the row. `silhouette` is
 * absent only when the taxon has no drawing; where present it carries the credit
 * for the image a graft puts on the canvas.
 */
export interface FossilDetail extends FossilTaxon {
  silhouette?: {
    phylopic_id: string;
    license_url: string;
    attribution: string | null;
    contributor: string | null;
  } | null;
  /** The node it hangs below, resolved — so the card can name it cold. */
  attach?: PathNode | null;
}

export interface SegmentResponse {
  upper_idx: number;
  lower_idx: number;
  /** The suppressed degree-2 nodes, root-first. Same shape as a path node. */
  intermediates: PathNode[];
  fossils: FossilTaxon[];
  /**
   * False when the fossil table was never built. An empty list with no flag
   * reads as "nothing lived along here", which is a different claim.
   */
  fossils_available: boolean;
  /** Distinct taxa on the segment before the server's cap, for "N of M". */
  fossils_total: number;
}

export interface About {
  /**
   * The running binary's version — a release tag, or "dev". Not `build_id`,
   * which identifies the *dataset* it has mmap'd. The two move on completely
   * different cadences: a release ships code, a pipeline run ships data, and
   * either can change without the other.
   */
  release?: string;
  commit?: string;
  build_id: string;
  generated_at?: string;
  counts: Record<string, number>;
  phases?: Record<string, unknown>;
  age?: {
    source_tree: string;
    phase2_accepted: boolean;
    nodes_with_age: number;
    tiers: Record<string, number>;
    headline?: string;
  };
}

export interface TimescaleInterval {
  id: string;
  name: string;
  rank: string;
  parent: string | null;
  begin_ma: number;
  end_ma: number;
  /** The instrument colour: official hue, dimmed and desaturated. */
  color: string;
  /** The exact CGMW hex, kept so the derivation stays checkable. */
  color_official?: string;
  order?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Normalise the wire format at the boundary: the server writes `tier` as a word
 * and the credit as `creator`/`uploader`, translated once here to the numeric
 * tier and `attribution`/`contributor` the components use.
 */
const TIER_BY_NAME: Record<string, Tier> = {
  measured: TIER_MEASURED,
  interpolated: TIER_INTERPOLATED,
  structural: TIER_STRUCTURAL,
  occurrence: TIER_OCCURRENCE,
};

function normTier(v: unknown): Tier {
  if (typeof v === "number" && v >= 0 && v <= 3) return v as Tier;
  if (typeof v === "string" && v in TIER_BY_NAME) return TIER_BY_NAME[v]!;
  // Unknown provenance is not an excuse to show a confident number.
  return TIER_STRUCTURAL;
}

function normNode(raw: Record<string, unknown>): PathNode {
  const tier = normTier(raw.tier);
  const age = raw.age_ma;
  return {
    ...(raw as unknown as PathNode),
    tier,
    // Common-name casing is the client's decision (`vernacular.ts`), applied
    // once here. `?? null` because `exactOptionalPropertyTypes` forbids assigning
    // undefined to an optional property.
    vernacular:
      displayCommonNameOrNull(raw.vernacular as string | null | undefined) ??
      null,
    // Belt and braces: a number alongside a non-age tier must not reach the UI.
    age_ma:
      !tierHasAge(tier) || typeof age !== "number" || !Number.isFinite(age)
        ? null
        : age,
  };
}

/**
 * Accept a list of strings or of `{name, preferred}` records, keeping the
 * server's order. The server ranks by `usage_rank`; the client must not re-sort,
 * since it cannot see the evidence the rank was built from.
 */
function toStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const names = v
    .map((x) =>
      typeof x === "string"
        ? x
        : x &&
            typeof x === "object" &&
            typeof (x as { name?: unknown }).name === "string"
          ? (x as { name: string }).name
          : null,
    )
    .filter((x): x is string => x !== null);
  return [...new Set(names)];
}

/** Exported for `api.test.ts` only: name-list order is load-bearing here. */
export function normalise(url: string, body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const b = body as Record<string, unknown>;

  if (Array.isArray(b.path)) {
    b.path = (b.path as Record<string, unknown>[]).map(normNode);
  }
  if (b.paths && typeof b.paths === "object") {
    for (const v of Object.values(b.paths as Record<string, unknown>)) {
      normalise(url, v);
    }
  }
  if (Array.isArray(b.intermediates)) {
    b.intermediates = (b.intermediates as Record<string, unknown>[]).map(
      normNode,
    );
  }
  // Case the vernacular here so `litRanges` highlights the printed string; the
  // rule only changes a character, never moves one, so the ranges are unaffected.
  if (Array.isArray(b.results)) {
    for (const r of b.results as Record<string, unknown>[]) {
      if (r && typeof r === "object") {
        r.vernacular = displayCommonNameOrNull(
          r.vernacular as string | null | undefined,
        );
      }
    }
  }
  if (url.startsWith("/v1/node/")) {
    const n = normNode(b);
    Object.assign(b, n);
    const sil = b.silhouette as Record<string, unknown> | null | undefined;
    if (sil) {
      creditFields(sil);
      sil.source_idx = sil.source_idx ?? b.silhouette_source_idx ?? b.idx;
      sil.source_name = sil.source_name ?? null;
    }
    // The witness credit is the same shape and needs the same translation:
    // several of these images are CC-BY-SA and their artist must be credited.
    const wit = b.divergence_silhouette as
      Record<string, unknown> | null | undefined;
    if (wit) {
      creditFields(wit);
      wit.source_name = wit.source_name ?? b.divergence_source_name ?? null;
    }
    b.synonyms = toStrings(b.synonyms);
    // Cased, then deduped *after* casing (which can newly collide two rows). The
    // server's order is kept — the card reads this list positionally.
    b.vernaculars = [
      ...new Set(toStrings(b.vernaculars).map(displayCommonName)),
    ];
  }
  // A fossil card draws a PhyloPic image too, so it needs the same credit rename.
  if (url.startsWith("/v1/fossil/")) {
    creditFields(b.silhouette as Record<string, unknown> | null | undefined);
  }
  return b;
}

/**
 * Translate a credit block's field names in place.
 *
 * The server calls them `creator` and `uploader`; every card in this app calls
 * them `attribution` and `contributor`. One boundary, one rename.
 */
function creditFields(sil: Record<string, unknown> | null | undefined): void {
  if (!sil) return;
  sil.attribution = sil.attribution ?? sil.creator ?? null;
  sil.contributor = sil.contributor ?? sil.uploader ?? null;
}

/**
 * A set of remembered answers. `limit` 0 never evicts; above it is an LRU bound,
 * with `Map` insertion order as the recency (a read re-inserts).
 */
interface Memo {
  entries: Map<string, Promise<unknown>>;
  limit: number;
}

/**
 * The memo for every URL the dataset bounds — `/v1/node`, `/v1/path`,
 * `/v1/paths`, `/v1/hits`, `/v1/segment`, `/v1/fossil`, `/v1/timescale`,
 * `/v1/about`, the random pool. Each is a build-assigned key with an immutable
 * response, so all are kept for the tab's life (architecture §2).
 */
const forever: Memo = { entries: new Map(), limit: 0 };

/**
 * How many `/v1/search` answers are kept. It is the one URL built from typed
 * text, so with typeahead every prefix is a key and "keep forever" would be a
 * log of every search. Bounded instead; 64 covers several whole queries and
 * every backspace inside them. Exported because `api.test.ts` asserts the bound.
 */
export const SEARCH_MEMO_LIMIT = 64;

/** @see SEARCH_MEMO_LIMIT */
const searches: Memo = { entries: new Map(), limit: SEARCH_MEMO_LIMIT };

/** Which of the two a URL belongs to. The endpoint decides, nothing else. */
function memoFor(url: string): Memo {
  return url.startsWith("/v1/search?") ? searches : forever;
}

function memoGet(m: Memo, url: string): Promise<unknown> | undefined {
  const hit = m.entries.get(url);
  // Touch, so that "least recently used" means used rather than fetched.
  // Skipped where nothing reads recency, because re-inserting into a memo with
  // no eviction rule is work that buys nothing.
  if (hit && m.limit) {
    m.entries.delete(url);
    m.entries.set(url, hit);
  }
  return hit;
}

function memoSet(m: Memo, url: string, p: Promise<unknown>): void {
  m.entries.set(url, p);
  while (m.limit && m.entries.size > m.limit) {
    const oldest = m.entries.keys().next().value;
    if (oldest === undefined) break;
    m.entries.delete(oldest);
  }
}

/**
 * Fetch once per URL and remember the answer — for the tab's life where the
 * dataset bounds the URL, for the last {@link SEARCH_MEMO_LIMIT} where typing
 * does.
 *
 * `signal` cancels the request, and a joiner inherits that cancellation: a
 * second caller for the same URL is handed the first's promise. That is safe
 * only because `Palette` is the sole signal-passing caller and no two of its
 * queries share a URL; `api.test.ts` pins the behaviour. Cancelling matters
 * because `/v1/search` is one half-vCPU container, so an abandoned request is a
 * full search taken from the keystroke the reader is waiting on.
 */
async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const memo = memoFor(url);
  const hit = memoGet(memo, url);
  if (hit) return hit as Promise<T>;
  const p = (async () => {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      // `null`, not `undefined`, under `exactOptionalPropertyTypes`.
      signal: signal ?? null,
    });
    if (!res.ok) {
      throw new ApiError(
        res.status,
        `${res.status} ${res.statusText} for ${url}`,
      );
    }
    return normalise(url, await res.json());
  })();
  // A failed or aborted request must not poison the memo. Deletes *this* promise
  // and not merely this URL, or an evicted-then-re-fetched entry's late
  // rejection would delete the newer one.
  p.catch(() => {
    if (memo.entries.get(url) === p) memo.entries.delete(url);
  });
  memoSet(memo, url, p);
  return p as Promise<T>;
}

/** Which corpus a random pick is drawn from. Never both. */
export type RandomKind = "species" | "fossil";

/**
 * The taxa a random pick may draw from, as bare identifiers rather than rows:
 * the draw is followed by an immutable, memoised lookup for the one taxon chosen,
 * so the decoration is fetched where it is used. Empty `nodes` means the build
 * has no pool at all (it cannot tell an own drawing from a borrowed one).
 */
export interface RandomPool {
  build_id: string;
  nodes: number[];
  fossils: number[];
}

export const api = {
  /**
   * What is running: the release, the commit and the dataset's build id.
   * `refresh` drops the memoised answer, for the one caller that must re-read it
   * after a deploy lands mid-session (when `randomPool` 404s on a stale build id).
   */
  about: (refresh = false) => {
    if (refresh) forever.entries.delete("/v1/about");
    return get<About>("/v1/about");
  },

  /**
   * The pools a random pick is drawn from, for one build. The build id is in the
   * path because a node index means nothing across builds and this is held a year
   * at the edge; a stale id 404s and the caller re-reads `/v1/about`.
   */
  randomPool: (buildId: string) =>
    get<RandomPool>(`/v1/random-pool/${encodeURIComponent(buildId)}`),

  /**
   * The one endpoint whose URL the reader writes, so its answers live in the
   * bounded memo ({@link SEARCH_MEMO_LIMIT}). `signal` is the palette's.
   */
  search: (q: string, limit = 20, signal?: AbortSignal) =>
    get<{
      /** Always the string that was asked for, corrected or not. */
      query: string;
      results: AnyHit[];
      /** PBDB taxa matching the same query. Ranked separately, never merged. */
      fossils?: FossilTaxon[];
      fossils_available?: boolean;
      /**
       * The spelling these results are actually for: present only when the typed
       * string returned nothing and a corrected one returned something. The
       * palette must render it — a search that silently answers a different
       * question is the mistake this project does not make.
       */
      corrected?: string | null;
      /**
       * A spelling that answers better than the typed one, whose rows are still
       * the typed one's. The counterpart to `corrected`, never sent with it, for
       * when the typed string had a row or two of accidental matches. The palette
       * offers it but must not perform it — the reader keeps what they asked for.
       */
      suggested?: string | null;
    }>(`/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`, signal),

  /**
   * Palette rows for taxa curated in `palette/starters.ts`. The keys are fixed,
   * so the URL is fixed and a session pays once; prefetched on boot in `App.tsx`.
   * Unknown keys come back missing rather than erroring the response.
   */
  hits: (keys: string[]) =>
    get<{ results: SearchHit[] }>(
      `/v1/hits?keys=${keys.map(encodeURIComponent).join(",")}`,
    ),

  path: (key: string) => get<Resolved>(`/v1/path/${encodeURIComponent(key)}`),

  paths: (keys: string[]) =>
    get<{ paths: Record<string, Resolved> }>(
      `/v1/paths?keys=${keys.map(encodeURIComponent).join(",")}`,
    ),

  node: (key: string) => get<NodeDetail>(`/v1/node/${encodeURIComponent(key)}`),

  segment: (upper: number, lower: number) =>
    get<SegmentResponse>(`/v1/segment/${upper}/${lower}`),

  /** One PBDB taxon by its own key, for a graft that survives in the URL. */
  fossil: (taxonNo: number) => get<FossilDetail>(`/v1/fossil/${taxonNo}`),

  timescale: () => get<{ intervals: TimescaleInterval[] }>("/v1/timescale"),

  silhouetteUrl: (phylopicId: string) => `/v1/silhouette/${phylopicId}.svg`,
};

/**
 * There is no reachability probe here: `about()` is it. A former `ping()` on
 * `/healthz` read the SPA fallback's HTML shell and reported healthy whether or
 * not the API was up. `about()` is on `/v1`, so it reaches the container by the
 * real route, and being non-immutable it also wakes a sleeping one.
 */
