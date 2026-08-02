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
 */
const KEY = "concestor.usage.v1";
const HALF_LIFE_DAYS = 21;

interface Usage {
  count: number;
  last: number;
}

function load(): Record<string, Usage> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Usage>;
  } catch {
    return {};
  }
}

let usage = load();

export function recordUse(id: string): void {
  const prev = usage[id];
  usage = { ...usage, [id]: { count: (prev?.count ?? 0) + 1, last: Date.now() } };
  try {
    localStorage.setItem(KEY, JSON.stringify(usage));
  } catch {
    /* private browsing; ranking degrades to corpus-only, which is fine */
  }
}

/** A bonus in the same units as {@link fuzzy}'s score. */
export function sessionBoost(id: string): number {
  const u = usage[id];
  if (!u) return 0;
  const days = (Date.now() - u.last) / 86_400_000;
  const recency = 2 ** (-days / HALF_LIFE_DAYS);
  return Math.min(u.count, 12) * 14 * recency + recency * 40;
}

export function resetUsage(): void {
  usage = {};
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
