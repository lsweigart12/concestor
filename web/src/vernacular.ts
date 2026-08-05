/**
 * How a common name is *cased* on screen, in one place.
 *
 * `docs/name-ranking.md` decides **which** name a taxon goes by and stops
 * there, deliberately: `usage_rank` is an ordering and `band.go` is a ranking,
 * and neither has any business touching the characters. So nothing owned the
 * presentation, and the corpus's own casing reached the reader unchanged —
 * 122,310 of 162,466 English vernaculars start uppercase and 39,821 start
 * lowercase, which is one search returning "Aardvark", "aardvark" and
 * "Aardvark" as three rows, and the opening panda tree drawing "Raccoon" and
 * "Giant panda" in a column beside "lesser panda" and "polar bear".
 *
 * This file capitalises the first letter and **changes nothing else**. That
 * restraint is the whole design, so the argument for it is worth keeping.
 *
 * ## Why the interior is left alone
 *
 * Sentence case is the obvious target and half of it is unreachable. 57,168 of
 * the 147,152 multi-word names are Title Cased throughout — "Beet Webworm
 * Moth", "Pedunculate Oak", "Glassy-Winged Tiger" — and lowercasing their
 * interior would be right. But 62,747 names carry an interior capital and a
 * great many of those are proper nouns that must survive: "Puerto Rican
 * calisto", "Rocky Mountain arctic", "Florida Keys blackbead", "Western
 * Australian golden wattle", "Japanese glorybower". A naive `toLowerCase` puts
 * "african elephant" on the canvas.
 *
 * **The corpus was asked whether it could tell the two apart, and it cannot.**
 * Counting, over every interior word, how often it appears lowercase against
 * capitalised gives a lower-share that does not separate the classes:
 *
 * | word | lowercase | capitalised | lower-share |
 * |---|---:|---:|---:|
 * | `african` | 3 | 259 | 0.01 |
 * | `island` | 14 | 387 | 0.03 |
 * | `hawaiian` | 1 | 5 | 0.17 |
 * | `mountain` | 125 | 518 | 0.19 |
 * | `webworm` | 6 | 24 | 0.20 |
 * | `moth` | 314 | 925 | 0.25 |
 * | `rocky` | 3 | 1 | 0.75 |
 *
 * Any threshold low enough to protect "African" (0.01) also protects
 * "Mountain", "Webworm" and "Moth", leaving most of the Title Cased corpus
 * exactly as it was; any threshold high enough to lowercase "Moth" (0.25) also
 * lowercases "Rocky" (0.75) and destroys "Rocky Mountain". There is no cut. A
 * curated list would only move the guessing somewhere a test cannot see it, so
 * the interior is refused on the evidence rather than deferred.
 *
 * What is left is the half that needs no knowledge of the word at all: **a
 * label's first letter is capitalised whatever the word is.** That is a fact
 * about the slot, not about the name, which is why it can be applied to
 * 162,466 strings without a lexicon and without a judgement call.
 *
 * ## Why up rather than down
 *
 * Strict biological style lowercases a common name, and this app is the wrong
 * place for it. The canvas is a **mixture** by construction — 110,794 nodes of
 * 2.7M carry an English name — so a common name sits in the same column as
 * *Homo*, *Pan* and *Cetacea*, and "human" beside "Pan" reads as the same bug
 * in the other direction. The card's subtitle sits under an `<h2>` and the
 * palette's under an italic binomial. Every one of these slots is a label
 * rather than running prose. Capitalising also moves the minority: 24.5% of the
 * corpus changes, and 75.5% already reads the way this rule leaves it.
 *
 * ## Where it is applied
 *
 * At the client's two entry points — `api.ts`'s `normalise`, which every
 * response carrying a vernacular passes through, and `recent.ts`'s
 * `loadRecent`, which is the one path that restores rows without a response.
 * Not at the render sites: there are six of them, they are in four directories,
 * and a seventh costs one line to write.
 *
 * It is **display-only and the server is untouched**, which is the same line
 * this project draws for a spelling correction and for `age_tier`. The stored
 * string is what the source recorded, `/v1` stays a faithful mirror of it, and
 * the ranking paths that read these same strings — `band.go`, `litRanges`,
 * `commonName`'s identity check — all compare case-insensitively and cannot
 * see this.
 */

/**
 * True for a character that has a distinct uppercase form.
 *
 * Written as a pair of round trips rather than a regex because the corpus is
 * not ASCII: "árbol de baquetas", "ñame" and "élaphode" are real rows and all
 * three should capitalise. A character with no case — a digit, a quote, an
 * emoji — fails both halves and is left alone.
 */
function isLowercaseLetter(c: string): boolean {
  return c.toLowerCase() === c && c.toUpperCase() !== c;
}

/** True for a character that has a distinct lowercase form. */
function isUppercaseLetter(c: string): boolean {
  return c.toUpperCase() === c && c.toLowerCase() !== c;
}

/**
 * The first code point of a string, or "" — never half a surrogate pair.
 *
 * Three names in the corpus begin with an astral-plane character (`🐀`, `🦏`,
 * `🦉`). Indexing with `[0]` would hand back a lone surrogate, and while that
 * happens to be case-less and so survives this rule untouched, a slice built
 * from its length would cut the pair in half.
 */
function firstCodePoint(s: string): string {
  const cp = s.codePointAt(0);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

/**
 * A common name as it should be printed: first letter capitalised, everything
 * after it exactly as the source recorded it.
 *
 * Two refusals, both measured against the corpus:
 *
 * - **A name that does not begin with a lowercase letter is returned
 *   unchanged.** That covers the 75.5% already capitalised, the 251 rows
 *   starting with a digit, a quote or an emoji ("88 Butterfly",
 *   `'Hyposmochoma'`), and abbreviated binomials carried as vernaculars —
 *   "T. rex" and "S. oriastra" must not become "T. Rex", and they do not,
 *   because nothing here touches a character it did not capitalise.
 * - **A lowercase letter followed by an uppercase one is returned unchanged.**
 *   The corpus holds exactly one such name, the Zulu "uMgugudo", where the
 *   lowercase initial is the word rather than an accident of transcription.
 *   One row in 162,466 does not justify a rule on its own; it costs a line, it
 *   cannot fire on anything else this corpus contains, and the alternative is
 *   printing "UMgugudo".
 *
 * The result always has the same length as the input, and differs from it in at
 * most its first character. `vernacular.test.ts` sweeps a real sample and
 * asserts exactly that.
 */
export function displayCommonName(name: string): string {
  const first = firstCodePoint(name);
  if (first === "" || !isLowercaseLetter(first)) return name;

  const rest = name.slice(first.length);
  if (isUppercaseLetter(firstCodePoint(rest))) return name;

  return first.toUpperCase() + rest;
}

/**
 * The same rule over a value that may be absent.
 *
 * Every field this is applied to is `string | null | undefined` on the wire,
 * and the boundary should not have to restate that three times.
 */
export function displayCommonNameOrNull<T extends string | null | undefined>(
  name: T,
): T {
  return (typeof name === "string" ? displayCommonName(name) : name) as T;
}
