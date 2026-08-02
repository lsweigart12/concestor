/**
 * The encyclopaedia block on a card: a description, and a way out to the
 * article.
 *
 * ## Why this is fetched at read time rather than baked
 *
 * Everything else a card shows comes out of the build, and that is the right
 * default — `docs/architecture.md` §9 is emphatic that the Open Tree API is a
 * build-time oracle and never a runtime dependency, and nothing here weakens
 * that. This is a different kind of thing and the reasoning is different too:
 *
 *   - **It is not part of the dataset.** Topology, ages, brackets and images
 *     are what the pipeline exists to make reproducible, and a build id has to
 *     mean the same tree every time. A description of a badger is prose about a
 *     badger. It is not a claim this project makes, it does not go through any
 *     gate, and freezing a 2026 revision of it into the artifact would make the
 *     app *staler* rather than more trustworthy.
 *   - **It covers the corpus the build cannot.** Nodes carry a Wikidata QID —
 *     108,293 of them — but the 523,112 PBDB fossil taxa carry none, and a
 *     crawl keyed on QIDs would leave every fossil card exactly as bare as it
 *     is now. Resolving a fossil by name is a *request-time* question because
 *     it needs an answer that can be refused (see the guard below).
 *   - **It costs nothing when it fails.** The card is complete before this
 *     resolves and complete without it. Offline, blocked, or rate-limited, the
 *     block does not appear and no other part of the app notices.
 *
 * The cost is real and worth stating plainly: opening a card sends a taxon name
 * to the Wikimedia Foundation. That is the whole of the privacy surface, it is
 * public-taxonomy data, and it happens only on a click.
 *
 * ## The guard
 *
 * A name-shaped link is how you put a Greek war god on a fossil card. PBDB's
 * *Ivesia* is an Ediacaran rangeomorph and OTT's is a rose-family plant; the
 * same trap cost this project a phase-3 fix (`refuse_disagreements`) and a
 * phase-6 one (the P225 check in `vernaculars.py`), and it is the same trap
 * here. So:
 *
 *   - **With a QID**, nothing is checked at request time, because the check has
 *     already been made by something better placed to make it. Phase 6 refuses
 *     any Wikidata item whose own `wdt:P225` names a different taxon from OTT's.
 *     Re-testing it here would fetch the same triple and learn nothing — and
 *     where that triple is absent it would learn nothing there either, which is
 *     the documented residual both ends live with.
 *   - **Without one** — every fossil, and the 2.6M nodes the crawl never
 *     reached — the item is found by its English article title and then made to
 *     prove itself: its `P225` must name the taxon we asked about, or there is
 *     no answer. Refusing is cheap here, because the fallback is a card with no
 *     description rather than a card with the wrong one.
 */

/** English only, in both places it is chosen. See `LANG_NOTE`. */
const WIKI_LANG = "en";
const WIKI_SITE = "enwiki";

/**
 * Why there is no language setting.
 *
 * Wikidata carries descriptions in ~300 languages and this asks for one. A
 * picker is a real feature and not a line of code — the vernacular names on the
 * card come from the same crawl and are also filtered to English, so doing this
 * properly means doing both together. Recorded rather than pretended away.
 */
export const LANG_NOTE = "English Wikipedia and Wikidata only.";

/** How long a card waits before deciding the encyclopaedia is not coming. */
const TIMEOUT_MS = 6000;

export interface Encyclopedia {
  /** The Wikidata item, which is always a page even when no article exists. */
  qid: string;
  wikidataUrl: string;
  /** Wikidata's one-line gloss — "species of mammal". Often the only prose. */
  gloss: string | null;
  /** Wikipedia's opening paragraph, as plain text. */
  extract: string | null;
  articleTitle: string | null;
  articleUrl: string | null;
  /**
   * Set when the entry is about a **broader** taxon than the one asked for.
   *
   * Only the genus fallback sets it, and the card has to print it. An article
   * about *Tyrannosaurus* shown silently on a card headed *Tyrannosaurus rex*
   * is the borrowed-silhouette mistake in prose: the reader has no way to tell
   * that the paragraph is about a group rather than about this taxon, and for a
   * genus with a dozen species that is a real difference.
   */
  broaderThanAsked: string | null;
}

export interface WikiQuery {
  /** The Wikidata item, when the build knows it. Trusted; see the header. */
  qid?: string | null;
  /**
   * The scientific name. Used to find an item when there is no QID, and then
   * to check the one that comes back.
   */
  name?: string | null;
}

/**
 * One cache for the session, holding promises rather than values so two cards
 * opened on the same taxon make one request.
 *
 * A transport failure is evicted. The distinction matters: "Wikipedia has
 * nothing about this" is an answer and is worth remembering, while "the network
 * was down when you clicked" is not, and caching the second as the first would
 * leave every card in the session blank until a reload.
 */
const cache = new Map<string, Promise<Encyclopedia | null>>();

/** Exposed for tests, which must not inherit each other's answers. */
export function resetWikiCache(): void {
  cache.clear();
}

export function lookup(q: WikiQuery): Promise<Encyclopedia | null> {
  const qid = q.qid?.trim() || null;
  const name = q.name?.trim() || null;
  if (!qid && !name) return Promise.resolve(null);
  const key = qid ? `q:${qid}` : `n:${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = resolve(qid, name).catch(() => {
    cache.delete(key);
    return null;
  });
  cache.set(key, p);
  return p;
}

async function resolve(qid: string | null, name: string | null): Promise<Encyclopedia | null> {
  let broader: string | null = null;
  let item = qid ? await itemById(qid) : await itemByName(name!);
  // A binomial that resolves to nothing, tried again as its genus.
  //
  // Wikipedia files most extinct species under the genus — *Tyrannosaurus rex*
  // is a redirect to *Tyrannosaurus* — and a sitelink lookup does not follow
  // redirects, so the species asks and gets silence while an article about it
  // sits one word away. The genus is a true and weaker answer, and the field
  // above is what keeps it from being read as a stronger one.
  if (!item && !qid && name) {
    const genus = genusOf(name);
    if (genus) {
      item = await itemByName(genus);
      if (item) broader = genus;
    }
  }
  if (!item) return null;
  const article = item.title
    ? `https://${WIKI_LANG}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`
    : null;
  // The gloss is enough to render with. The extract is a second request and the
  // richer half of the block, but a failure there must not take the whole block
  // down — a card reading "species of mammal" with a link is still an answer.
  const extract = item.title ? await summary(item.title).catch(() => null) : null;
  return {
    qid: item.qid,
    wikidataUrl: `https://www.wikidata.org/wiki/${item.qid}`,
    gloss: item.gloss,
    extract,
    articleTitle: item.title,
    articleUrl: article,
    broaderThanAsked: broader,
  };
}

/**
 * The genus of a binomial, or null if this is not one.
 *
 * Deliberately narrow. Two words, the first capitalised, the second not — which
 * is what a species name looks like and what a vernacular, a subspecies
 * trinomial and an informal PBDB string do not. Anything else falls through to
 * no answer rather than to a guess about which word is the group.
 */
function genusOf(name: string): string | null {
  const parts = name.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [g, s] = parts as [string, string];
  if (!/^[A-Z][a-z-]+$/.test(g) || !/^[a-z-]+$/.test(s)) return null;
  return g;
}

interface Item {
  qid: string;
  gloss: string | null;
  /** The English article's title, or null when the item has no English article. */
  title: string | null;
}

const WD = "https://www.wikidata.org/w/api.php";

/** The trusted path: the build already vouched for this identifier. */
async function itemById(qid: string): Promise<Item | null> {
  const url =
    `${WD}?action=wbgetentities&ids=${encodeURIComponent(qid)}` +
    `&props=descriptions%7Csitelinks&sitefilter=${WIKI_SITE}&languages=${WIKI_LANG}` +
    `&format=json&origin=*`;
  const body = await getJSON(url);
  const ent = entity(body, qid);
  return ent ? readItem(qid, ent) : null;
}

/**
 * The checked path: find the item behind an article of this name, then make it
 * prove it is about this taxon.
 *
 * `claims` is asked for here and nowhere else, because `P225` is the proof. It
 * is the expensive property to request — a well-worked item is a large
 * document — and the taxa that reach this path are the ones the crawl never
 * found, whose items are correspondingly thin.
 */
async function itemByName(name: string): Promise<Item | null> {
  const url =
    `${WD}?action=wbgetentities&sites=${WIKI_SITE}&titles=${encodeURIComponent(name)}` +
    `&props=descriptions%7Csitelinks%7Cclaims&sitefilter=${WIKI_SITE}&languages=${WIKI_LANG}` +
    `&format=json&origin=*`;
  const body = await getJSON(url);
  const ents = (body?.entities ?? {}) as Record<string, unknown>;
  for (const [qid, raw] of Object.entries(ents)) {
    // A title with no item comes back keyed `-1` with `missing` set.
    if (!qid.startsWith("Q")) continue;
    const ent = raw as Record<string, unknown>;
    if (!taxonNameMatches(ent, name)) continue;
    return readItem(qid, ent);
  }
  return null;
}

/**
 * Whether the item's own `wdt:P225` is the taxon we asked about.
 *
 * An item with **no** P225 is refused on this path, which is the opposite of
 * what phase 6 does with the same absence and is right for the opposite reason.
 * There, a QID had already been tied to a node by an explicit identifier and a
 * missing triple was merely no evidence against it. Here the only thing linking
 * the item to the taxon *is* the string, and an article titled with a genus
 * name that is not filed as a taxon is exactly the collision to refuse —
 * *Ares*, *Iris*, *Aurora*, *Nike* are all PBDB genera.
 */
function taxonNameMatches(ent: Record<string, unknown>, want: string): boolean {
  const claims = ent.claims as Record<string, unknown> | undefined;
  const p225 = claims?.P225 as unknown[] | undefined;
  if (!Array.isArray(p225) || p225.length === 0) return false;
  const target = want.trim().toLowerCase();
  for (const c of p225) {
    const v = (c as { mainsnak?: { datavalue?: { value?: unknown } } })?.mainsnak?.datavalue
      ?.value;
    if (typeof v === "string" && v.trim().toLowerCase() === target) return true;
  }
  return false;
}

function entity(body: JsonObject | null, qid: string): Record<string, unknown> | null {
  const ents = body?.entities as Record<string, unknown> | undefined;
  const e = ents?.[qid] as Record<string, unknown> | undefined;
  if (!e || "missing" in e) return null;
  return e;
}

function readItem(qid: string, ent: Record<string, unknown>): Item {
  const desc = ent.descriptions as Record<string, { value?: unknown }> | undefined;
  const gloss = desc?.[WIKI_LANG]?.value;
  const links = ent.sitelinks as Record<string, { title?: unknown }> | undefined;
  const title = links?.[WIKI_SITE]?.title;
  return {
    qid,
    gloss: typeof gloss === "string" && gloss !== "" ? gloss : null,
    title: typeof title === "string" && title !== "" ? title : null,
  };
}

/**
 * The article's opening paragraph.
 *
 * The REST summary carries a thumbnail alongside the text and it is deliberately
 * not read. A photograph on this card would be the one warm, high-detail object
 * on an instrument whose whole visual argument is a dark field and flat
 * silhouettes — and it would arrive with a Commons attribution obligation that
 * the credit block, which is about PhyloPic, is not built to carry.
 * `docs/phase5c-decision.md` is the standing record of what Wikimedia imagery
 * would cost here; nothing about a card changes that answer.
 */
async function summary(title: string): Promise<string | null> {
  const url =
    `https://${WIKI_LANG}.wikipedia.org/api/rest_v1/page/summary/` +
    `${encodeURIComponent(title.replace(/ /g, "_"))}?redirect=true`;
  const body = await getJSON(url);
  const e = body?.extract;
  return typeof e === "string" && e.trim() !== "" ? e.trim() : null;
}

type JsonObject = Record<string, unknown>;

/**
 * One request, with a deadline and no retry.
 *
 * A retry would double the load on a donated public API for a block the card
 * does not need, and it would double the time a reader spends looking at a
 * pending row before it gives up.
 */
async function getJSON(url: string): Promise<JsonObject | null> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  return body && typeof body === "object" ? (body as JsonObject) : null;
}
