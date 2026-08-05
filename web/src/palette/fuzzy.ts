/**
 * Fuzzy matching with highlighted ranges, and session ranking.
 *
 * design-reference.md asks for fuzzy search with highlighted match ranges and
 * results ranked on recency and frequency rather than alphabetically. That is
 * the Raycast model, and it composes with — rather than replaces — the corpus
 * ranking baked at build time (architecture §4: exact match, then `tip_count`
 * descending, then has-silhouette, then has-measured-age, which is what makes
 * "can" surface Canidae before *Cania*). Neither signal alone is right: the
 * corpus knows what is important in general, the session knows what is
 * important to you.
 */

export interface Match {
  score: number;
  /** [start, end) index pairs into the haystack, for highlighting. */
  ranges: [number, number][];
}

/**
 * Subsequence match, scored so that word-boundary and prefix hits win.
 *
 * Returns null when the needle is not a subsequence at all, which is the
 * common case and wants to be cheap.
 */
export function fuzzy(needle: string, haystack: string): Match | null {
  if (!needle) return { score: 0, ranges: [] };
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();

  // Whole-substring hits are qualitatively better than scattered ones and are
  // worth finding first: a prefix match on a species name should never lose to
  // a needle smeared across a long one.
  const direct = h.indexOf(n);
  if (direct >= 0) {
    const boundary = direct === 0 || /[\s._-]/.test(h[direct - 1] ?? " ");
    return {
      score: 1000 - direct + (boundary ? 300 : 0) + (direct === 0 ? 400 : 0),
      ranges: [[direct, direct + n.length]],
    };
  }

  const ranges: [number, number][] = [];
  let hi = 0;
  let score = 0;
  let streak = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni]!;
    const found = h.indexOf(c, hi);
    if (found < 0) return null;
    const boundary = found === 0 || /[\s._-]/.test(h[found - 1] ?? " ");
    if (found === hi && ni > 0) {
      streak += 1;
      score += 12 + streak * 4;
    } else {
      streak = 0;
      score += boundary ? 10 : 2;
      score -= Math.min(found - hi, 12);
    }
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) last[1] = found + 1;
    else ranges.push([found, found + 1]);
    hi = found + 1;
  }
  // Shorter haystacks are better matches for the same needle.
  return { score: score - Math.floor(h.length / 12), ranges };
}

/**
 * Ranges to *highlight*, which is not the same question as ranges that matched.
 *
 * {@link fuzzy} accepts scattered subsequences, and it should — that is what
 * makes typeahead forgiving. But highlighting a scattered subsequence is
 * actively misleading: searching "shark" against *Chiloscyllium* lights up
 * c…y…ll and tells the reader that is why the row is here, when in fact it
 * matched on the vernacular "Bamboo sharks". A highlight is an explanation, so
 * it only earns its place when it is a contiguous run the reader would
 * recognise as what they typed.
 *
 * Returns [] when there is no such run, which renders as plain text.
 *
 * A regular plural of a typed word counts as that word. Vernaculars are stored
 * plural and people type singular, so without this the top result for
 * "butterfly" — Papilionidae, "swallowtail butterflies" — was the only row on
 * the page with nothing lit, which reads as *this one does not match* directly
 * above three that do.
 */
export function litRanges(needle: string, haystack: string): [number, number][] {
  const n = needle.trim().toLowerCase();
  if (!n) return [];
  const h = haystack.toLowerCase();
  const out: [number, number][] = [];
  // Each whitespace-separated word of the query, wherever it appears whole.
  for (const word of n.split(/\s+/).filter(Boolean)) {
    for (const form of surfaceForms(word)) {
      let from = 0;
      for (;;) {
        const at = h.indexOf(form, from);
        if (at < 0) break;
        out.push([at, at + form.length]);
        from = at + form.length;
      }
    }
  }
  if (out.length === 0) return [];
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [out[0]!];
  for (const r of out.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }
  return merged;
}

/**
 * The forms of a typed word a reader would recognise as the same word: itself
 * and its regular plural. Three characters minimum, so "go" does not claim
 * "goes" — the same guard, and for the same reason, as `samePlural` in the
 * server's band rule. This is deliberately not a stemmer: three fixed suffixes,
 * each of which a reader reading the row would agree is the word they typed.
 */
function surfaceForms(word: string): string[] {
  if (word.length < 3) return [word];
  const forms = [word, `${word}s`, `${word}es`];
  if (word.endsWith("y")) forms.push(`${word.slice(0, -1)}ies`);
  return forms;
}

/** Split a string into alternating plain / highlighted chunks for rendering. */
export function highlight(
  text: string,
  ranges: [number, number][],
): { text: string; hit: boolean }[] {
  if (!ranges.length) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/**
 * Recency and frequency, persisted so the palette gets better with use.
 *
 * The decay is deliberately slow: this is a tool for exploring, and something
 * you looked at last week is still evidence about what you care about.
 *
 * ## What comes back out of storage is not this app's word
 *
 * `localStorage` is a string that a truncated write, another version of this
 * app, a browser extension or the reader themselves could have last touched, so
 * every entry has to prove its shape on the way in. Same posture as
 * `recent.ts`, for a sharper reason: a bad *recent* row draws wrong and the
 * reader can see it, whereas a bad usage entry is invisible.
 *
 * `{"count": 3}` with no `last` made `days` NaN, so `recency` NaN and
 * {@link sessionBoost} NaN — and NaN in Palette.tsx's `b.score - a.score`
 * compares as **equal** rather than throwing. That does not merely misplace the
 * corrupt row: a comparator answering "equal" to everything *partitions* the
 * list at that element, so the rows around it stop ordering too. Measured on
 * three rows worth 100, NaN and 50, the 100 sorted **last**. The symptom is
 * search results in subtly the wrong order with nothing in any log, which is
 * about the least diagnosable failure this palette could have. A stored `null`
 * is quieter still in the other direction — it parses fine and then every read
 * throws on property access, so the palette does not rank wrongly, it does not
 * render.
 *
 * Entries are discarded one at a time rather than the blob whole: one row this
 * app did not write is not a reason to forget everything the browser has
 * learned about its reader.
 *
 * ## The store is capped, because the decay never removed a key
 *
 * The half-life decays the *score*; it has never decayed the *key*. So the
 * record grew monotonically for the life of a browser profile, and every write
 * paid a full object copy and a full `JSON.stringify` of the whole history, on
 * the interaction path.
 *
 * A count cap rather than a decay floor, and the two are not close. A floor
 * only ever fires for a reader who *stopped* — the reader generating the most
 * writes is the one whose entries are all recent, so every one of them clears
 * any floor and the store still grows without limit. A cap is the only one of
 * the two that bounds anything. It also subsumes the floor's intent for free,
 * because eviction is by {@link boostOf} itself: what goes first is exactly
 * what a decay rule would have dropped, and it needs no magic threshold to say
 * so. Note what that rules out — a plain oldest-first eviction would throw away
 * the taxon a reader has returned to a dozen times in favour of one they
 * glanced at yesterday, and the boost is the definition of which of those is
 * worth keeping.
 *
 * With the cap in place the write is O(1) rather than O(history), which is what
 * settles the third question: the write stays **synchronous**. At the cap the
 * blob is 8.6 KB and stringifying it measures 17 µs, against 864 KB and 2.5 ms
 * for the 20,000 entries the unbounded version would reach — and the spread
 * that used to sit in front of it, which more than doubled that at every size,
 * is gone. It also happens once per deliberate pick rather than once per
 * keystroke, which is the other half of the answer. Deferring it
 * to an idle callback would buy those microseconds and cost a `pagehide` flush
 * that, the one time it is missed, loses precisely the pick the reader just
 * made. The cap is also what keeps this clear of the ~5 MB quota, past which
 * `setItem` throws into the catch below and the table silently stops persisting
 * at all.
 */
const KEY = "concestor.usage.v1";
const HALF_LIFE_DAYS = 21;

/**
 * How many ids this browser remembers having used.
 *
 * Generous on purpose — the boost is worth at most 208 points against a server
 * rank step of 10, and it is meant to accumulate over months. 200 entries is
 * roughly 9 KB, so the bound is here to stop unbounded growth rather than to
 * save space, and it should never be the reason a returning reader loses
 * something they use.
 */
export const MAX_USAGE_ENTRIES = 200;

interface Usage {
  count: number;
  last: number;
}

/**
 * Whether a stored value is an entry this module could have written.
 *
 * `Number.isFinite` rather than `typeof === "number"` alone, because `NaN` and
 * `Infinity` are numbers and both are exactly the poison being kept out —
 * neither survives `JSON.stringify` as itself, but a hand-edited or
 * foreign-written blob is under no obligation to have come through it.
 */
function isUsage(v: unknown): v is Usage {
  if (typeof v !== "object" || v === null) return false;
  const u = v as Partial<Usage>;
  return (
    typeof u.count === "number" &&
    Number.isFinite(u.count) &&
    u.count > 0 &&
    typeof u.last === "number" &&
    Number.isFinite(u.last)
  );
}

/**
 * The decayed worth of one entry, in {@link fuzzy}'s score units.
 *
 * Shared by {@link sessionBoost} and by the eviction in {@link prune}, and that
 * sharing is the point: "drop what is worth least" is only true if the two
 * agree on what a thing is worth.
 *
 * `days` is clamped at zero because a `last` in the future is a fact about the
 * reader's clock and not about their reading. It passes every shape check there
 * is — it is a perfectly finite number — so validation cannot catch it and this
 * has to. Unclamped, a timestamp one year ahead is worth 29 million points
 * against a real entry's 208, which pins one row to the top of every search
 * until the date passes; far enough ahead, `2 ** big` is `Infinity` and
 * `Infinity - Infinity` is NaN, which lands back in the sorting bug above.
 */
function boostOf(u: Usage, now: number): number {
  const days = Math.max(0, (now - u.last) / 86_400_000);
  const recency = 2 ** (-days / HALF_LIFE_DAYS);
  return Math.min(u.count, 12) * 14 * recency + recency * 40;
}

/** Keep the {@link MAX_USAGE_ENTRIES} entries worth most, and drop the rest. */
function prune(store: Record<string, Usage>): Record<string, Usage> {
  const ids = Object.keys(store);
  if (ids.length <= MAX_USAGE_ENTRIES) return store;
  const now = Date.now();
  ids.sort((a, b) => boostOf(store[b]!, now) - boostOf(store[a]!, now));
  const out: Record<string, Usage> = {};
  for (const id of ids.slice(0, MAX_USAGE_ENTRIES)) out[id] = store[id]!;
  return out;
}

function load(): Record<string, Usage> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    // An array passes `typeof === "object"` and would then be spread into an
    // object by the first write, which is a shape nothing here can read back.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, Usage> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isUsage(v)) out[id] = { count: v.count, last: v.last };
    }
    // Capped on read as well as on write, on `recent.ts`'s precedent: the cap
    // is a policy and may fall, and a blob written under a larger one — or by a
    // build that had none — would otherwise only shrink when the reader
    // happened to pick something.
    return prune(out);
  } catch {
    return {};
  }
}

let usage = load();

export function recordUse(id: string): void {
  const prev = usage[id];
  // Mutated rather than copied. Nothing holds a reference to this object and no
  // render is keyed on its identity, so the spread was a full copy of the whole
  // history bought nothing.
  usage[id] = { count: (prev?.count ?? 0) + 1, last: Date.now() };
  usage = prune(usage);
  try {
    localStorage.setItem(KEY, JSON.stringify(usage));
  } catch {
    /* private browsing, or the quota; ranking degrades to corpus-only, which is fine */
  }
}

/** A bonus in the same units as {@link fuzzy}'s score. */
export function sessionBoost(id: string): number {
  const u = usage[id];
  return u ? boostOf(u, Date.now()) : 0;
}

export function resetUsage(): void {
  usage = {};
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
