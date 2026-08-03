/**
 * Typed client for the read API (the Go binary in ../server).
 *
 * Everything the API serves is immutable within a build, so every response is
 * cached in-process for the session. That is not an optimisation detail: it is
 * what lets the signature interaction fire in the same frame as the click.
 * Architecture §2 — once a leaf's ancestor path is in memory, the MRCA, the
 * reflow and the drill-down are all set operations over data we already hold,
 * with no round trip.
 */

/** Age provenance, architecture §3.5. The numbers match `age_tier.npy`. */
export const TIER_MEASURED = 0;
export const TIER_INTERPOLATED = 1;
export const TIER_STRUCTURAL = 2;
/**
 * Extinct, and the rock has something to say. Written by phase 4, not phase 2.
 *
 * Not a fourth grade of divergence estimate. The other three all answer "when
 * did these lineages part", from a chronogram of extant species, and an
 * extinct taxon has no counterpart there — which is why 1,742 of the 1,743
 * extinct-flagged nodes are structural by construction rather than by
 * measurement. This answers a weaker question in the same units: when the
 * taxon is observed in the rock. It therefore carries **no `age_ma`**, exactly
 * like structural, and everything that guards structural must guard it too.
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
   * The name this taxon goes by, when the canvas is drawing common names.
   *
   * Server-side it is the name ranked **first** by use and it is served only
   * for genus, species and subspecies — both restrictions live in
   * `api.Entry.Vernacular`, and neither may be worked around from here. Absent
   * is the ordinary case: 110,794 nodes of 2,725,682 carry an English name at
   * all, so most of a deep tree has none and falls back to the scientific name.
   * That mixture is the design rather than a gap, and italics are what tell the
   * reader which they are looking at — see `markName`.
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
   * The smallest clade containing both this node and that drawing, which is
   * the whole of what the picture claims: *something in here looks like this*.
   * Its `tip_count` is how big a claim that is, and it is the number the
   * caption has to carry. Null on an older build that predates the field.
   */
  silhouette_clade_idx?: number | null;
  silhouette_clade_tips?: number | null;
  silhouette_clade_name?: string | null;
  /**
   * The divergence witness: a second silhouette, of a **fossil taxon from
   * somewhere below this fork** whose stratigraphic bracket puts it at the
   * split.
   *
   * It answers a different question from `phylopic_id`, which is why both
   * exist. `phylopic_id` prefers the most inclusive drawing beneath a node, so
   * at a split it is always a crown group — the human–chimp split drew *Homo*,
   * the whale–hippo split drew a dolphin. Neither existed when the lineages
   * parted. This is what did: *Acanthostega gunnari*, *Eohippus*, *Pakicetus*.
   *
   * **The claim is weaker than a silhouette's and the wording must be too.** A
   * witness used to be a node inside the clade, so the picture could say "a
   * member of this group". It is now a PBDB taxon that is not in the tree at
   * all, and the honest phrasing is architecture §3.4's: *this taxon belongs
   * somewhere below this node, and existed between these dates.* Not *this
   * taxon is the sister of that one.* `divergence_attach_walk` is how loose
   * the placement is.
   *
   * Which one to draw is the client's call and depends on how the reader
   * reached the node: a species they chose wants its group's exemplar, a
   * divergence they arrived at wants the witness. Absent wherever the fork
   * carries its own drawing, or nothing drawn, dated and extinct hangs below it.
   */
  divergence_phylopic_id?: string | null;
  /** A `fossil.pbdb_taxon_no`. **Not** a node index — nothing may address the tree with it. */
  divergence_pbdb_taxon_no?: number | null;
  divergence_source_name?: string | null;
  divergence_source_rank?: string | null;
  /** The deepest node the fossil is known to sit below. */
  divergence_attach_idx?: number | null;
  /**
   * How many PBDB `parent_no` hops it took to find that node, and therefore how
   * loose the placement is. Zero means PBDB's own taxon is in the synthesis
   * tree and the fossil sits exactly there; eleven means the claim is about a
   * family rather than a lineage. The caption has to say which.
   */
  divergence_attach_walk?: number | null;
  /** Ma from the split to that taxon's range. 0 means the range spans it. */
  divergence_gap_ma?: number | null;
  /**
   * The witness taxon's own fossil bracket, and not optional in practice: it
   * is what makes the picture legible. A range, never a point, exactly like
   * `occurrence` — no midpoint may be computed from it. Only `fea` and `lla`
   * arrive: the witness is chosen by a containment test on the outer bracket,
   * so the inner pair never entered the decision.
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
   * Ma from the split to the nearer end of the range, 0 when it spans.
   *
   * Carried rather than left implicit because rounding makes a true statement
   * read as a false one: Perissodactyla is dated 56.26 Ma and *Eohippus* tops
   * out at 56.0, so the card shows "56 Ma" and "56–51 Ma" and then says the
   * range does not reach the split. Both figures are right and the reader can
   * see only a contradiction. The gap is what resolves it.
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
export interface BrokenResponse {
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
  matched_on: string;
  /**
   * The name that actually matched, when the row does not already show it —
   * a synonym or an abbreviation.
   *
   * The one field that contains what the reader typed. Without it a synonym
   * hit is an unexplained answer, and OTT files *Homo floresiensis* as a
   * synonym of *Homo sapiens*, so the unexplained answer is about a different
   * species and reads as the search having misheard.
   */
  matched_name?: string | null;
  /**
   * Where this row sits in the one ranking that covers both corpora.
   *
   * `/v1/search` answers with two arrays because a node and a PBDB taxon are
   * different shapes, not because they are different qualities of answer, and
   * this integer is what lets the palette draw them as the single list they
   * are. Absent on a broken taxon, which renders as a note rather than a row,
   * and absent from every other endpoint — a segment listing and a random pick
   * are not answers to a query and have no position in one.
   *
   * **Sorting by it is not re-ranking.** The rule in `handoff.md` is that
   * `web/` must not re-sort `/v1/search`, and this is the server handing over
   * an order rather than the client computing one — the distinction that the
   * old client-side fuzzy score got wrong.
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
 * A hit that is a node — something that can actually go on the canvas.
 *
 * The union below is not decoration. `idx` and `tip_count` are null for a
 * broken taxon because it is *not in the tree*, and typing them as `number`
 * let `n:${hit.idx}` become the string `"n:null"` for all 9,839 of them: one
 * shared identity, so the session ranking learnt from one click applied to
 * every broken taxon at once, and one React key, so a list containing two of
 * them reconciled wrongly and left rows stranded on screen through every
 * subsequent query. Narrowing on `kind` is what makes both unrepresentable.
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
   * The Wikidata item this node *is*, on the 108,293 nodes the vernacular crawl
   * reached — which are close to exactly the ones a reader has heard of.
   *
   * An identifier, not a name, and that is the whole of its value: a link built
   * from it lands on an article about this taxon, where a link built from a
   * name lands on an article about whatever else is called that. It is absent
   * on the other 2.6M nodes and on every build predating the field, and
   * `detail/wiki.ts` falls back to a *checked* name lookup rather than an
   * unchecked one.
   */
  wikidata_qid?: string | null;
  silhouette: {
    phylopic_id: string;
    license_url: string;
    /** The original creator. Renders as the credit. */
    attribution: string | null;
    /** The uploader. Differs from the creator 50% of the time (handoff §4). */
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
export interface LayoutBound {
  idx: number;
  key: string;
  /** Null on an `mrcaott…` clade — 24.4% of the upper bounds. */
  name: string | null;
  rank: string | null;
  age_ma: number;
}

/**
 * What an undated node's position was derived from.
 *
 * **`below` is null on 97.2% of structural nodes and that is a fact, not a
 * gap.** Every age in the dataset comes from a chronogram of *extant* species,
 * so a dated descendant is nearly always a tip sitting at the present; only
 * 5,168 of 186,317 have one older than zero. Where it is null the lower end of
 * the span is the present, and the copy has to say that rather than trail off.
 *
 * `above` is never null on the shipped build (zero of 186,317 lack a dated
 * ancestor) but is typed nullable because a partially dated build could
 * produce one.
 */
export interface LayoutSpread {
  above: LayoutBound | null;
  below: LayoutBound | null;
}

/**
 * When may a node draw an image it did not earn?
 *
 * Resolution finds a node's closest drawn relative and records the smallest
 * clade containing both. That clade is the entire claim the picture makes —
 * *something in here looks like this* — so its size is the only thing worth
 * judging. A drawing shared with 987 other riffle beetles is a fact about the
 * beetle; one shared with 1.2M arthropods is a fact about nothing.
 *
 * The knob used to be `maxSourceTips`, the size of the clade the image was
 * *attached* to, and it was measuring the wrong object: under the old
 * nearest-seeded-ancestor rule the attached clade was usually a superphylum
 * even when a perfectly good cousin sat two hops away. Judging the shared
 * clade instead makes the question answerable, and the answer changed —
 * see below.
 */
export interface SilhouettePolicy {
  maxCladeTips: number;
}

/**
 * **Draw everything.** Every node with a resolved image draws it.
 *
 * Superseded in one place, and the exception is not about clade size at all: a
 * *divergence* draws its witness or nothing, never a borrow. See
 * `Graph.mayDrawExemplar`. This policy governs only the nodes still eligible
 * for a borrow — the clades a reader chose — and the threshold below is what
 * would catch a misinforming one among those.
 *
 * This was an uneasy experiment when the alternative was a `cellular
 * organisms` blob on two thirds of the tree; it is now simply what the data
 * supports. Measured on the built corpus after the resolution change: the
 * median silhouette speaks for a clade of 3,153 tips, p90 is 46,221, **no
 * node at all** borrows from a clade of over a million, and exactly one node
 * — the root — has the whole tree as its clade. There is no longer a
 * population of misinforming pictures for a threshold to catch.
 *
 * It holds together because the borrow is labelled wherever it appears: the
 * canvas tooltip and the detail card both name the drawing's subject *and*
 * the clade it speaks for. If that labelling ever weakens, this becomes the
 * misinformation architecture §7 warns about, and the knob is here to turn.
 */
export const SILHOUETTE_POLICY: SilhouettePolicy = {
  maxCladeTips: Number.POSITIVE_INFINITY,
};

/**
 * Whether to draw a node's silhouette at all.
 *
 * `cladeTips` is the size of the smallest clade containing the node and the
 * drawing. It is undefined against a build that predates the field, in which
 * case there is nothing to judge and the image is drawn — the same choice the
 * permissive policy makes anyway.
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
   * The young end of the last-appearance bracket, read for what it is worth.
   * `lla` above is PBDB's own number and is never overwritten.
   *
   * `lla_identified` is the youngest last appearance an *identified* member of
   * this taxon reaches. When it is **older** than `lla`, the taxon's own young
   * end rests on material catalogued no finer than the taxon itself — a
   * `Stegosaurus sp.` — and says nothing about where the named animal's record
   * ends. PBDB aggregates upward, so that comparison is exact rather than a
   * heuristic: a young end below every descendant's cannot come from an
   * identified one.
   *
   * `lla_drawn` is where the taxon may be **drawn**, and it is the only one of
   * the three a position may read. It equals `lla` except on the taxa whose
   * alternative is corroborated enough to act on, and phase 4 holds
   * `lla <= lla_drawn <= fea` for every row.
   *
   * All three are absent on a build predating them, which every reader here
   * falls back from rather than works around.
   */
  lla_identified?: number | null;
  young_end_occs?: number | null;
  lla_drawn?: number | null;
  /**
   * The other end of the same last-appearance bracket, moved with `lla_drawn`.
   * `[lea, lla]` is one bracket and both ends come from the same occurrences,
   * so pairing a corrected `lla_drawn` with PBDB's own `lea` would assemble a
   * bracket out of two different records — for *Stegosaurus*, a corrected
   * 143.1 against a 100.5 that is the very occurrence being refused.
   */
  lea_drawn?: number | null;
}

/**
 * The four bounds as they may be *drawn*: PBDB's first-appearance bracket
 * unchanged, and the last-appearance bracket corrected where its own young end
 * is one no identified member reaches.
 *
 * `fea`/`fla` are never touched here. They are wide for a different reason —
 * stratigraphic resolution, not misidentification — and that width is what the
 * faded envelope honestly means. *Stegosaurus* reaches 161.5 Ma because one of
 * its 86 occurrences is logged only as "Late Jurassic", an epoch whose base is
 * 161.5; no specimen is dated there.
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
 * Whether a fossil's own young end is one no identified member of it reaches.
 *
 * The card says so and the position avoids it. Both need the same test, and it
 * is a comparison rather than a flag so that a build without the columns
 * simply answers `false` instead of throwing.
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
 * A fossil with the two things a card needs beyond the row itself.
 *
 * `silhouette` is **not** optional in spirit: a graft puts that drawing on the
 * canvas and CC-BY applies to whatever is on screen, so the card is where the
 * credit has to appear. It is absent only when the taxon has no drawing at all.
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
 * Normalise the wire format at the boundary.
 *
 * The server writes `tier` as a word and the silhouette credit as
 * `creator`/`uploader`, both of which read better in a JSON payload than the
 * numeric tier and the `attribution`/`contributor` names the pipeline uses
 * internally. Rather than push either side to match the other, translate once
 * here — the numeric tier is what the rendering compares against, and having
 * exactly one place that knows both vocabularies is cheaper than having the
 * whole component tree tolerate two.
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
    // Belt and braces on the hard requirement: even if a future server build
    // sends a number alongside a structural tier, it does not reach the UI.
    age_ma:
      !tierHasAge(tier) || typeof age !== "number" || !Number.isFinite(age)
        ? null
        : age,
  };
}

/**
 * Accept either a list of strings or a list of `{name, preferred}` records,
 * and **keep the server's order**.
 *
 * This used to take a `preferredFirst` flag and sort on the boolean. That was
 * harmless only while the boolean was the entire ranking; the server now
 * orders by `usage_rank` — a taxon's names in the order people use them,
 * measured against English Wikipedia's title and redirect graph — and a
 * client-side sort on one flag would flatten every distinction below the
 * headline back into whatever order the rows happened to arrive in.
 *
 * The rule is the one `docs/handoff.md` already records for `/v1/search`, for
 * the same reason and after the same bug: ranking is the server's, the client
 * highlights. A re-sort here cannot see the evidence the rank was built from,
 * so it can only ever lose information.
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

/**
 * Exported for `api.test.ts` only. The order a name list arrives in is now
 * load-bearing and is decided three layers away, in the pipeline — so the one
 * boundary that could quietly permute it needs a test that says so.
 */
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
  if (url.startsWith("/v1/node/")) {
    const n = normNode(b);
    Object.assign(b, n);
    const sil = b.silhouette as Record<string, unknown> | null | undefined;
    if (sil) {
      creditFields(sil);
      sil.source_idx = sil.source_idx ?? b.silhouette_source_idx ?? b.idx;
      sil.source_name = sil.source_name ?? null;
    }
    // The witness credit is the same shape and needs the same translation. It
    // is not optional politeness: the canvas draws this image, several of them
    // are CC-BY-SA, and a credit line that silently reads an absent field says
    // "creator not recorded" about an artist the payload names.
    const wit = b.divergence_silhouette as
      Record<string, unknown> | null | undefined;
    if (wit) {
      creditFields(wit);
      wit.source_name = wit.source_name ?? b.divergence_source_name ?? null;
    }
    b.synonyms = toStrings(b.synonyms);
    // The server sends `{name, lang, preferred}` objects, which is the more
    // useful shape and one the UI never templated for — "Also known as [object
    // Object]" shipped. Flatten at the boundary and change nothing else: the
    // list arrives most-used first and the card reads it positionally.
    b.vernaculars = toStrings(b.vernaculars);
  }
  // A fossil card draws a PhyloPic image too, so it needs the same translation
  // — and this is the third place that has needed it, which is why it is one
  // helper now. The failure is silent by construction: reading an absent field
  // yields a credit line that says "creator not recorded" about an artist the
  // payload names by a different key.
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

const cache = new Map<string, Promise<unknown>>();

/**
 * Fetch once per URL and remember the answer for the life of the tab.
 *
 * `signal` cancels a request **this call started**, and deliberately not one it
 * merely joined: a cache hit is somebody else's request, already paid for, and
 * a second caller is not entitled to cancel work the first is still waiting on.
 * In practice only the palette passes a signal and only one search is ever out
 * at a time, so the two cases do not meet — but the rule is the one that stays
 * correct if they ever do.
 *
 * Cancelling matters more than it looks. `/v1/search` is served by a *single*
 * container instance with half a vCPU, so an abandoned request is not free — it
 * is a full search's worth of the only CPU there is, taken from the keystroke
 * the reader is actually waiting on. Typing past the debounce used to leave
 * every one of those in flight to completion, with their answers thrown away.
 */
async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const hit = cache.get(url);
  if (hit) return hit as Promise<T>;
  const p = (async () => {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      // `null` rather than `undefined`: under `exactOptionalPropertyTypes` the
      // two are not interchangeable, and `RequestInit.signal` accepts the one
      // that means "no signal" explicitly.
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
  // A failed request must not poison the cache — the palette retries on the
  // next keystroke and a stuck rejection would look like a dead search box.
  // This is also what makes an abort safe to remember nothing about: the entry
  // is gone before the debounce on the next keystroke has even elapsed, so
  // backspacing to a query that was cancelled asks again rather than
  // rediscovering its cancellation.
  p.catch(() => cache.delete(url));
  cache.set(url, p);
  return p as Promise<T>;
}

/**
 * A request whose answer is *not* a function of the build, so it must never be
 * remembered — not by this cache, and not by the browser's.
 *
 * `get` memoises on the URL forever, which is exactly right for an immutable
 * API and exactly wrong for one endpoint: `/v1/random` would answer every press
 * of the command with the first press's pick, for the lifetime of the tab. The
 * server sends `no-store` for the same reason one layer down; this is the other
 * half of it.
 */
async function getFresh<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `${res.status} ${res.statusText} for ${url}`,
    );
  }
  return normalise(url, await res.json()) as T;
}

/** Which corpus a random pick is drawn from. Never both — see `/v1/random`. */
export type RandomKind = "species" | "fossil";

export interface RandomResponse {
  kind: RandomKind;
  results: SearchHit[];
  fossils: FossilTaxon[];
  /** False when this build cannot make the pick at all, rather than "no luck". */
  available: boolean;
}

export const api = {
  about: () => get<About>("/v1/about"),

  /**
   * Draw taxa that carry their own drawing, from one corpus or the other.
   *
   * `limit` is over-asked on purpose. A pick already on the canvas is a no-op
   * that would still be confirmed by a toast, so the caller takes the first
   * candidate it is not already showing rather than making a second request to
   * find one.
   */
  random: (kind: RandomKind, limit = 1) =>
    getFresh<RandomResponse>(`/v1/random?kind=${kind}&limit=${limit}`),

  search: (q: string, limit = 20, signal?: AbortSignal) =>
    get<{
      query: string;
      results: AnyHit[];
      /** PBDB taxa matching the same query. Ranked separately, never merged. */
      fossils?: FossilTaxon[];
      fossils_available?: boolean;
    }>(`/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`, signal),

  path: (key: string) => get<Resolved>(`/v1/path/${encodeURIComponent(key)}`),

  paths: (keys: string[]) =>
    get<{ paths: Record<string, Resolved> }>(
      `/v1/paths?keys=${keys.map(encodeURIComponent).join(",")}`,
    ),

  node: (key: string) => get<NodeDetail>(`/v1/node/${encodeURIComponent(key)}`),

  segment: (upper: number, lower: number) =>
    get<SegmentResponse>(`/v1/segment/${upper}/${lower}`),

  /**
   * One PBDB taxon by its own key.
   *
   * The segment listing is how a reader normally meets a fossil, and it is
   * keyed on the branch. A graft is view state, so it survives in the URL, so a
   * cold load arrives holding an id and no lane to have found it in.
   */
  fossil: (taxonNo: number) => get<FossilDetail>(`/v1/fossil/${taxonNo}`),

  timescale: () => get<{ intervals: TimescaleInterval[] }>("/v1/timescale"),

  silhouetteUrl: (phylopicId: string) => `/v1/silhouette/${phylopicId}.svg`,
};

/** Reachability probe used by the boot sequence to give an honest error. */
export async function ping(): Promise<boolean> {
  try {
    const res = await fetch("/healthz");
    return res.ok;
  } catch {
    return false;
  }
}
