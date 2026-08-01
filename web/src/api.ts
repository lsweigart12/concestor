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
export type Tier = 0 | 1 | 2;

export interface PathNode {
  idx: number;
  key: string;
  ott_id: number | null;
  name: string | null;
  rank: string | null;
  /** NULL wherever no numeric age may be shown. Structural is always null. */
  age_ma: number | null;
  /** Finite everywhere, monotone root-to-tip. x-position only — never a label. */
  age_layout: number;
  tier: Tier;
  tip_count: number;
  depth: number;
  phylopic_id: string | null;
  /** The node the silhouette is actually of — often an ancestor clade. */
  silhouette_source_idx: number | null;
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
  /** The node the image is actually of — often an ancestor clade. */
  silhouette_source_idx?: number | null;
  /** That ancestor's subtree size, which is what decides whether to draw it. */
  silhouette_source_tips?: number | null;
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
    /** The uploader. Differs from the creator 31% of the time. */
    contributor: string | null;
    source_idx: number;
    source_name: string | null;
  } | null;
}

/**
 * When may a node draw an image it did not earn?
 *
 * Resolution climbs to the nearest ancestor that has an image, which gives
 * near-total coverage — and at the top of the climb that means a species can
 * inherit the picture attached to "cellular organisms". Architecture §7 is
 * blunt about why that can be worse than nothing: rendering a mole for
 * "Mammalia" misinforms, where an empty space merely withholds.
 *
 * The two knobs below are that argument's dial. `maxSourceTips` is how large a
 * clade may be and still lend its picture; `allowRootSource` is whether the
 * root — whose subject is literally everything — may lend one at all.
 */
export interface SilhouettePolicy {
  maxSourceTips: number;
  allowRootSource: boolean;
}

/**
 * **Dialled to maximum**: every node with a resolved image draws it, however
 * far up the climb it came from.
 *
 * This is deliberately the permissive end of the dial and it is an experiment,
 * not a settled answer. It trades architecture §7's caution for coverage, and
 * it only holds together because the borrow is *labelled* everywhere it
 * appears — `NodeMark` captions what the picture actually depicts and the
 * detail card names the source clade. If that labelling ever weakens, this
 * setting becomes the misinformation §7 describes.
 *
 * The previous setting, and the one to return to, was
 * `{ maxSourceTips: 250_000, allowRootSource: false }`.
 */
export const SILHOUETTE_POLICY: SilhouettePolicy = {
  maxSourceTips: Number.POSITIVE_INFINITY,
  allowRootSource: true,
};

export function silhouetteIsInformative(
  node: Pick<PathNode, "idx" | "phylopic_id" | "silhouette_source_idx">,
  sourceTipCount: number | undefined,
  policy: SilhouettePolicy = SILHOUETTE_POLICY,
): boolean {
  if (!node.phylopic_id) return false;
  const src = node.silhouette_source_idx;
  if (src === null || src === undefined || src === node.idx) return true;
  if (src === 0) return policy.allowRootSource;
  if (sourceTipCount === undefined) return true;
  return sourceTipCount <= policy.maxSourceTips;
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
    {
      idx: hit.idx,
      phylopic_id: hit.phylopic_id ?? null,
      silhouette_source_idx: hit.silhouette_source_idx ?? null,
    },
    hit.silhouette_source_tips ?? undefined,
    policy,
  );
  return ok ? (hit.phylopic_id ?? null) : null;
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
};

function normTier(v: unknown): Tier {
  if (typeof v === "number" && v >= 0 && v <= 2) return v as Tier;
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
      tier === TIER_STRUCTURAL || typeof age !== "number" || !Number.isFinite(age)
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
    get<{
      intermediates: PathNode[];
      fossils: unknown[];
      fossils_available: boolean;
    }>(`/v1/segment/${upper}/${lower}`),

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
