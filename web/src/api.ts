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

export interface SearchHit {
  kind: "node" | "broken";
  key: string;
  idx: number;
  ott_id: number | null;
  name: string | null;
  vernacular: string | null;
  rank: string | null;
  tip_count: number;
  has_age: boolean;
  has_image: boolean;
  matched_on: string;
}

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
 * Is an inherited silhouette informative enough to draw?
 *
 * Resolution climbs to the nearest ancestor that has an image, which gives
 * near-total coverage — and at the top of the climb that means a species can
 * inherit the picture attached to "cellular organisms". Architecture §7 is
 * blunt about why that is worse than nothing: rendering a mole for "Mammalia"
 * misinforms, where an empty space merely withholds. A silhouette earns its
 * place by representing a clade the viewer would recognise as related, so an
 * image borrowed from a kingdom-sized ancestor is suppressed.
 */
export const SILHOUETTE_MAX_SOURCE_TIPS = 250_000;

export function silhouetteIsInformative(
  node: Pick<PathNode, "idx" | "phylopic_id" | "silhouette_source_idx">,
  sourceTipCount: number | undefined,
): boolean {
  if (!node.phylopic_id) return false;
  const src = node.silhouette_source_idx;
  if (src === null || src === undefined || src === node.idx) return true;
  if (src === 0) return false; // the root's image describes nothing
  if (sourceTipCount === undefined) return true;
  return sourceTipCount <= SILHOUETTE_MAX_SOURCE_TIPS;
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
    b.synonyms = b.synonyms ?? [];
    b.vernaculars = b.vernaculars ?? [];
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
    get<{ query: string; results: SearchHit[] }>(
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
