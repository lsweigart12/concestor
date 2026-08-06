/**
 * How a common name is cased on screen, in one place: the first letter is
 * capitalised and nothing else changes. Ranking (`name-ranking.md`, `band.go`)
 * decides which name a taxon goes by and does not touch the characters, so the
 * corpus's own mixed casing would otherwise reach the reader unchanged.
 *
 * The interior is left alone because the corpus cannot tell a proper noun
 * ("African", 1% lowercase) from a Title Cased common word ("Moth", 25%) by any
 * threshold: any cut that protects "African" keeps "Moth", any cut that
 * lowercases "Moth" destroys "Rocky Mountain". Capitalising the first letter
 * needs no lexicon — it is a fact about the slot, not the word.
 *
 * Up rather than down because the canvas is a mixture — a common name sits in
 * the same column as *Homo* — so "human" beside "Pan" would read as the bug in
 * the other direction. Applied at the client's two entry points (`api.ts`'s
 * `normalise`, `recent.ts`'s `loadRecent`), display-only, server untouched — the
 * ranking paths compare case-insensitively and cannot see it.
 */

/**
 * True for a character with a distinct uppercase form. A pair of round trips
 * rather than a regex, because the corpus is not ASCII ("ñame", "élaphode").
 */
function isLowercaseLetter(c: string): boolean {
  return c.toLowerCase() === c && c.toUpperCase() !== c;
}

/** True for a character that has a distinct lowercase form. */
function isUppercaseLetter(c: string): boolean {
  return c.toUpperCase() === c && c.toLowerCase() !== c;
}

/**
 * The first code point of a string, or "" — never half a surrogate pair. Some
 * names begin with an astral-plane character (`🐀`), which `[0]` would split.
 */
function firstCodePoint(s: string): string {
  const cp = s.codePointAt(0);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

/**
 * A common name as printed: first letter capitalised, the rest exactly as
 * recorded. Two refusals: a name not beginning with a lowercase letter is
 * unchanged (so "T. rex" does not become "T. Rex"), and a lowercase letter
 * followed by an uppercase one is unchanged (the Zulu "uMgugudo", not
 * "UMgugudo"). Same length as the input, differing in at most the first char.
 */
export function displayCommonName(name: string): string {
  const first = firstCodePoint(name);
  if (first === "" || !isLowercaseLetter(first)) return name;

  const rest = name.slice(first.length);
  if (isUppercaseLetter(firstCodePoint(rest))) return name;

  return first.toUpperCase() + rest;
}

/** The same rule over a value that may be absent. */
export function displayCommonNameOrNull<T extends string | null | undefined>(
  name: T,
): T {
  return (typeof name === "string" ? displayCommonName(name) : name) as T;
}
