/**
 * What the reader did, in three events (`docs/analytics.md` has the decision).
 * The two questions this project has — what people search for, what trees they
 * build — cannot be answered server-side: query strings are invisible below an
 * Enterprise zone, and a tree is a set of selections the server only ever sees
 * one cached key at a time. So the browser says what happened, once, as a `POST`
 * to its own path (uncacheable, and untouching `/v1`).
 *
 * Deliberately not collected: no identity, no IP, no cookie, no `localStorage`.
 * The session id is a random per-tab string in `sessionStorage`, to group one
 * person's adds into one tree; it cannot follow anyone.
 */

/** The events, and there are only three (`docs/analytics.md` §2). */
type Kind = "search" | "add" | "tree";

/**
 * What put a tree on screen — a made tree and a received one differ. `open` is
 * an opening pressed, kept apart from `add` to see whether a canned comparison
 * converts to trees of the reader's own: an opening's taxa were chosen by us.
 * Every string fits the Worker's 16-char `blob4` cap.
 */
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

/** How long a selection must sit still before it counts as a tree. */
export const TREE_IDLE_MS = 2_000;

/** Batched, because a burst of adds is one request's worth of events. */
export const FLUSH_MS = 3_000;
const MAX_BATCH = 32;

/** A tree's identity is its set: sorted and deduplicated, so order does not matter. */
export function treeKey(keys: readonly string[]): string {
  return [...new Set(keys)].sort().join(",");
}

/**
 * Whether two queries are the same reach for one word. A prefix relation covers
 * both typing forward and backspacing (`d`→`do`→`dog` is one query).
 */
export function supersedes(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/** Which of a superseding pair to keep: the longer — the fullest thing typed. */
export function longer(a: string, b: string): string {
  return b.length > a.length ? b : a;
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * The queue and the two debounces. A class, not module state, so tests can
 * drive a real one with their own transport.
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
   * The palette closed, or a row was taken. Without it a reader who types a
   * query and presses Enter inside the idle window records no search.
   */
  endSearch(): void {
    this.emitQuery();
  }

  /** A taxon the reader chose. Interactive adds only (`docs/analytics.md` §2). */
  add(key: string): void {
    this.record({
      kind: "add",
      subject: cap(key, MAX_SUBJECT),
      tree: "",
      cause: "",
    });
  }

  /** The selection changed. Recorded once it settles, and never as a duplicate. */
  tree(keys: readonly string[], cause: Cause): void {
    // A tree of one has no divergence and its add is already recorded.
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
    this.record({
      kind: "search",
      subject: cap(q, MAX_SUBJECT),
      tree: "",
      cause: "",
    });
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

/** A random per-tab id in `sessionStorage`, falling back if storage throws. */
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
    // `sendBeacon` first: the only transport promised to finish after the page
    // is gone, which is when a session's last tree is emitted.
    if (
      navigator.sendBeacon?.(
        BEACON_PATH,
        new Blob([body], { type: "application/json" }),
      )
    ) {
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
