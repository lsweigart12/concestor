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
   * The divergence witness: a second silhouette, of a taxon *inside* this
   * clade whose fossil record puts it at this node's split.
   *
   * It answers a different question from `phylopic_id`, which is why both
   * exist. `phylopic_id` prefers the most inclusive drawing beneath a node, so
   * at a split it is always a crown group — the human–chimp split drew *Homo*,
   * the whale–hippo split drew a dolphin. Neither existed when the lineages
   * parted. This is what did: *Sahelanthropus*, *Basilosaurus*, *Hallucigenia*.
   *
   * Which one to draw is the client's call and depends on how the reader
   * reached the node: a species they chose wants its group's exemplar, a
   * divergence they arrived at wants the witness. Present on 66 nodes, and
   * absent wherever the split is undated or nothing drawn inside it is dated.
   */
  divergence_phylopic_id?: string | null;
  divergence_source_idx?: number | null;
  divergence_source_name?: string | null;
  divergence_source_rank?: string | null;
  /** Ma from the split to that taxon's range. 0 means the range spans it. */
  divergence_gap_ma?: number | null;
  /**
   * The witness taxon's own fossil bracket, and not optional in practice: it
   * is what makes the picture legible. A range, never a point, exactly like
   * `occurrence` — no midpoint may be computed from it.
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
  rank: string | null;
  /** The tree node it resolves to. Always on the segment we asked about. */
  attach_idx: number;
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

/** Accept either a list of strings or a list of `{name, preferred}` records. */
function toStrings(v: unknown, preferredFirst = false): string[] {
  if (!Array.isArray(v)) return [];
  const rows = v
    .map((x) =>
      typeof x === "string"
        ? { name: x, preferred: false }
        : x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string"
          ? {
              name: (x as { name: string }).name,
              preferred: Boolean((x as { preferred?: unknown }).preferred),
            }
          : null,
    )
    .filter((x): x is { name: string; preferred: boolean } => x !== null);
  if (preferredFirst) {
    rows.sort((a, b) => Number(b.preferred) - Number(a.preferred));
  }
  return [...new Set(rows.map((r) => r.name))];
}

function normalise(url: string, body: unknown): unknown {
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
    b.intermediates = (b.intermediates as Record<string, unknown>[]).map(normNode);
  }
  if (url.startsWith("/v1/node/")) {
    const n = normNode(b);
    Object.assign(b, n);
    const sil = b.silhouette as Record<string, unknown> | null | undefined;
    if (sil) {
      sil.attribution = sil.attribution ?? sil.creator ?? null;
      sil.contributor = sil.contributor ?? sil.uploader ?? null;
      sil.source_idx = sil.source_idx ?? b.silhouette_source_idx ?? b.idx;
      sil.source_name = sil.source_name ?? null;
    }
    // The witness credit is the same shape and needs the same translation. It
    // is not optional politeness: the canvas draws this image, several of them
    // are CC-BY-SA, and a credit line that silently reads an absent field says
    // "creator not recorded" about an artist the payload names.
    const wit = b.divergence_silhouette as Record<string, unknown> | null | undefined;
    if (wit) {
      wit.attribution = wit.attribution ?? wit.creator ?? null;
      wit.contributor = wit.contributor ?? wit.uploader ?? null;
      wit.source_name = wit.source_name ?? b.divergence_source_name ?? null;
    }
    b.synonyms = toStrings(b.synonyms);
    // The server sends `{name, lang, preferred}` objects, which is the more
    // useful shape and one the UI never templated for — "Also known as [object
    // Object]" shipped. Flatten at the boundary, preferring the ones marked
    // preferred, so the card reads as a list of names.
    b.vernaculars = toStrings(b.vernaculars, true);
  }
  return b;
}

const cache = new Map<string, Promise<unknown>>();

async function get<T>(url: string): Promise<T> {
  const hit = cache.get(url);
  if (hit) return hit as Promise<T>;
  const p = (async () => {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new ApiError(res.status, `${res.status} ${res.statusText} for ${url}`);
    }
    return normalise(url, await res.json());
  })();
  // A failed request must not poison the cache — the palette retries on the
  // next keystroke and a stuck rejection would look like a dead search box.
  p.catch(() => cache.delete(url));
  cache.set(url, p);
  return p as Promise<T>;
}

export const api = {
  about: () => get<About>("/v1/about"),

  search: (q: string, limit = 20) =>
    get<{ query: string; results: AnyHit[] }>(
      `/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  path: (key: string) => get<Resolved>(`/v1/path/${encodeURIComponent(key)}`),

  paths: (keys: string[]) =>
    get<{ paths: Record<string, Resolved> }>(
      `/v1/paths?keys=${keys.map(encodeURIComponent).join(",")}`,
    ),

  node: (key: string) => get<NodeDetail>(`/v1/node/${encodeURIComponent(key)}`),

  segment: (upper: number, lower: number) =>
    get<SegmentResponse>(`/v1/segment/${upper}/${lower}`),

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
