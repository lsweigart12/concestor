/**
 * What the reader did, in three events.
 *
 * `docs/analytics.md` is the decision and the measurements behind it. The short
 * version is that the two questions this project actually has — *what do people
 * search for* and *what trees do they build* — cannot be answered from any
 * server-side surface, and no amount of logging changes that:
 *
 * - A query string is invisible in the edge dataset on anything below an
 *   Enterprise zone, so `/v1/search?q=whale` reads as `/v1/search`.
 * - A *tree* is a set of selections that only ever exists in one place. The
 *   server sees `/v1/path/{key}` one key at a time, with no session to group
 *   them by, and the edge cache means it does not reliably see even those.
 *
 * So the browser says what happened, once, in a shape the reader could read
 * over your shoulder. Nothing here touches `/v1` caching — this is a `POST` to
 * its own path, which is uncacheable by construction rather than by a header
 * somebody has to remember to set.
 *
 * **What is deliberately not collected**: no identity, no IP (Analytics Engine
 * stores what is written and nothing more), no cookie, no `localStorage`. The
 * session id is a random per-tab string in `sessionStorage`, on exactly the
 * reasoning that put bioluminescence there — per-tab means a shared link opened
 * tomorrow is a different session, which is what a session is. It exists to
 * group one person's adds into one tree, and it cannot follow anyone anywhere.
 */

/** The events, and there are only three. `docs/analytics.md` §2 is why. */
export type Kind = "search" | "add" | "tree";

/** What put a tree on screen — a made tree and a received one are not the same. */
export type Cause = "add" | "remove" | "open" | "link" | "back" | "clear";

export interface Event {
  kind: Kind;
  /** The query typed, or the key added. Empty for a tree. */
  subject: string;
  /** The whole selection, sorted. Empty except on `tree`. */
  tree: string;
  /** Only meaningful on `tree`. */
  cause: Cause | "";
}

/** Mirrors the worker's caps. Both sides truncate; neither trusts the other. */
export const MAX_SUBJECT = 128;
export const MAX_TREE = 1024;

/** Below this the server never searched, so there is nothing to record. */
export const MIN_QUERY = 2;

/** How long a query must sit still before it counts as a thing somebody typed. */
export const SEARCH_IDLE_MS = 1_500;

/**
 * How long a selection must sit still before it counts as a tree.
 *
 * Longer than the palette's own debounce and shorter than a thought. Adding
 * three species in quick succession is one tree, not three, and the one worth
 * recording is the one that was on screen when the reader stopped.
 */
export const TREE_IDLE_MS = 2_000;

/** Batched, because a burst of adds is one request's worth of events. */
export const FLUSH_MS = 3_000;
const MAX_BATCH = 32;

/**
 * A tree's identity is its *set*, not the order it was built in.
 *
 * Sorted and deduplicated, so that "human, whale" and "whale, human" are one
 * row in the answer rather than two. Selection order is real state — it is in
 * the URL, and `n=` round-trips it — but it is not what makes two readers'
 * trees the same tree.
 */
export function treeKey(keys: readonly string[]): string {
  return [...new Set(keys)].sort().join(",");
}

/**
 * Whether two queries are the same reach for the same word.
 *
 * One being a prefix of the other covers both typing forward and backspacing,
 * which is the whole of what happens inside a single search. `d` → `do` → `dog`
 * is one query and must be recorded once; `dog` → `cat` is two.
 */
export function supersedes(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Which of a superseding pair to keep: the longer.
 *
 * The reader's intent is the fullest thing they typed, so backspacing out of
 * `dog` still records `dog`. Keeping the *last* instead would record `do`, and
 * keeping the first would record `d`.
 */
export function longer(a: string, b: string): string {
  return b.length > a.length ? b : a;
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * The queue, the two debounces, and nothing else.
 *
 * A class rather than module state so that the tests drive a real one with a
 * transport of their own, instead of the module growing a test-only hatch that
 * production code can reach.
 */
export class Beacon {
  private queue: Event[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private pendingQuery: string | null = null;
  private queryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastQuery = "";

  private pendingTree: { tree: string; cause: Cause } | null = null;
  private treeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTree = "";

  constructor(private readonly post: (events: readonly Event[]) => void) {}

  /** A query the palette actually ran. Recorded once it settles. */
  search(raw: string): void {
    const q = raw.trim();
    if (q.length < MIN_QUERY) return;
    if (this.pendingQuery === null) {
      this.pendingQuery = q;
    } else if (supersedes(this.pendingQuery, q)) {
      this.pendingQuery = longer(this.pendingQuery, q);
    } else {
      // A different word. The one before it is finished, whatever the timer
      // thinks.
      this.emitQuery();
      this.pendingQuery = q;
    }
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = setTimeout(() => this.emitQuery(), SEARCH_IDLE_MS);
  }

  /**
   * The palette closed, or a row was taken.
   *
   * Without this a reader who types `axolotl` and presses Enter inside the idle
   * window is recorded as having searched for nothing — which is precisely the
   * search that worked.
   */
  endSearch(): void {
    this.emitQuery();
  }

  /** A taxon the reader chose. Interactive adds only — see `docs/analytics.md` §2. */
  add(key: string): void {
    this.record({ kind: "add", subject: cap(key, MAX_SUBJECT), tree: "", cause: "" });
  }

  /** The selection changed. Recorded once it settles, and never as a duplicate. */
  tree(keys: readonly string[], cause: Cause): void {
    // A tree of one has no divergence in it, and the add that made it is
    // already recorded. Recording it as well would double every canvas anyone
    // opens and answer the question "what trees" with a list of species.
    if (keys.length < 2) return;
    this.pendingTree = { tree: cap(treeKey(keys), MAX_TREE), cause };
    if (this.treeTimer) clearTimeout(this.treeTimer);
    this.treeTimer = setTimeout(() => this.emitTree(), TREE_IDLE_MS);
  }

  /** Send whatever is held, now. The page is going away. */
  flush(): void {
    this.emitQuery();
    this.emitTree();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    this.post(events);
  }

  private emitQuery(): void {
    if (this.queryTimer) {
      clearTimeout(this.queryTimer);
      this.queryTimer = null;
    }
    const q = this.pendingQuery;
    this.pendingQuery = null;
    if (q === null || q === this.lastQuery) return;
    this.lastQuery = q;
    this.record({ kind: "search", subject: cap(q, MAX_SUBJECT), tree: "", cause: "" });
  }

  private emitTree(): void {
    if (this.treeTimer) {
      clearTimeout(this.treeTimer);
      this.treeTimer = null;
    }
    const t = this.pendingTree;
    this.pendingTree = null;
    if (t === null || t.tree === this.lastTree) return;
    this.lastTree = t.tree;
    this.record({ kind: "tree", subject: "", tree: t.tree, cause: t.cause });
  }

  private record(e: Event): void {
    this.queue.push(e);
    if (this.queue.length >= MAX_BATCH) {
      this.flush();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    }
  }
}

/** Where the events go. Same origin, its own path, never `/v1`'s cached surface. */
export const BEACON_PATH = "/v1/e";

const SESSION_KEY = "concestor.session";

let memo: string | null = null;

/**
 * A random per-tab id.
 *
 * `sessionStorage`, for the reason spelled out in the module header, and with
 * the same fallback as {@link import("../state/store").loadBiolum}: private
 * browsing throws on access, and losing the grouping is a better answer than
 * losing the app.
 */
export function session(): string {
  if (memo !== null) return memo;
  const fresh = crypto.randomUUID().slice(0, 8);
  try {
    const held = sessionStorage.getItem(SESSION_KEY);
    if (held) return (memo = held);
    sessionStorage.setItem(SESSION_KEY, fresh);
  } catch {
    /* private browsing: the id lives as long as the page does, which is enough */
  }
  return (memo = fresh);
}

function post(events: readonly Event[]): void {
  const body = JSON.stringify({ session: session(), events });
  try {
    // `sendBeacon` first because it is the only transport the browser promises
    // to finish after the page is gone, which is exactly when the last tree of
    // a session is emitted.
    if (navigator.sendBeacon?.(BEACON_PATH, new Blob([body], { type: "application/json" }))) {
      return;
    }
    void fetch(BEACON_PATH, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* analytics must never be able to break the page it is measuring */
  }
}

/** The one the app uses. */
export const beacon = new Beacon(post);

if (typeof document !== "undefined") {
  // `visibilitychange` rather than `unload`, which does not fire on mobile
  // Safari at all and is why so much analytics undercounts phones.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") beacon.flush();
  });
}
