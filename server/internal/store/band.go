package store

import "strings"

// How closely a query sits inside a name. This refines architecture §4's
// "exact match, then tip_count" with the distinction that actually separates
// "dog" -> Canidae from "dog" -> Apocynaceae:
//
//	"dog" in "dog family"     is a whole word          -> bandToken
//	"dog" in "dogbane family" is a prefix of a word    -> bandPrefix
//
// Both are legitimate matches, and without the distinction they fall through
// to tip_count, where a 7,050-tip plant family beats the dogs. A whole-word
// match is a much stronger signal of what the user meant, so it gets its own
// band above tip_count. It is orthogonal to search_name.kind, which says
// *which sort of name* matched rather than *how well*.
const (
	bandExact  = 0 // the name is the query
	bandToken  = 1 // the query is a run of whole words inside the name
	bandPrefix = 2 // the last query word is a prefix of a word in the name
	bandNone   = 3 // matched some other way (a synonym, an FTS stem, …)
)

// tokens lower-cases, splits on whitespace, and trims punctuation from each
// end. Hyphens and apostrophes stay *inside* a token deliberately: a hyphen
// binds a compound word. Splitting on it made "can" a whole-word match inside
// "Can-opener Smoothdream", which then outranked Cantharellales — the token
// band is supposed to capture "the user typed a real word", and "can-opener"
// is one word, not two.
func tokens(s string) []string {
	fields := strings.Fields(strings.ToLower(s))
	out := fields[:0]
	for _, f := range fields {
		f = strings.TrimFunc(f, func(r rune) bool { return !isAlnum(r) })
		if f != "" {
			out = append(out, f)
		}
	}
	return out
}

func isAlnum(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		return true
	}
	return r > 127 // keep accented letters together; the index folds diacritics
}

// samePlural reports whether two tokens are the same English word, one of them
// pluralised. Order does not matter, so it covers both "the corpus is plural
// and the user typed singular" and the reverse.
//
// This is the one piece of morphology the band needs, and it needs it because
// vernaculars are overwhelmingly stored plural — "animals", "spiders", "sharks"
// — while a person types the singular. Without it a plural is merely a *prefix*
// match, one band below a whole word, and that inverted the most basic query in
// the product: searching "animal" ranked Arthropoda first, on a Wikidata alias
// reading "arthropod animal" where "animal" happens to stand as its own word.
// Metazoa, whose English name is "animals" and which holds 1.49M tips, fell
// below five-tip bacteria and off the end of the result list entirely.
//
// Kept to "s" and "es" on purpose. Real English plurals this misses — mouse,
// genus, larva — are all cases where the singular is not a prefix of the plural
// anyway, so they were never reachable through this path and need a stemmer,
// not a longer list of suffixes. What matters is that it does not *invent*
// matches: it only ever promotes a pair the prefix rule already accepted.
func samePlural(a, b string) bool {
	if len(a) < len(b) {
		a, b = b, a
	}
	// Three characters before the suffix, so "do"/"does" and "go"/"goes" are
	// not declared the same word. Nothing shorter is a taxon's common name.
	if len(b) < 3 || !strings.HasPrefix(a, b) {
		return false
	}
	switch a[len(b):] {
	case "s", "es":
		return true
	}
	return false
}

// matchBand scores how well q sits inside name. Lower is better.
func matchBand(name, q string) int {
	if name == "" || q == "" {
		return bandNone
	}
	if strings.EqualFold(name, q) {
		return bandExact
	}
	nt, qt := tokens(name), tokens(q)
	if len(qt) == 0 || len(nt) < len(qt) {
		return bandNone
	}
	best := bandNone
	for i := 0; i+len(qt) <= len(nt); i++ {
		exact := true
		ok := true
		for j, want := range qt {
			got := nt[i+j]
			switch {
			case got == want, samePlural(got, want):
				// keep going
			case j == len(qt)-1 && strings.HasPrefix(got, want):
				// A trailing prefix is what typeahead means.
				exact = false
			default:
				ok = false
			}
			if !ok {
				break
			}
		}
		if !ok {
			continue
		}
		if exact {
			return bandToken
		}
		best = bandPrefix
	}
	return best
}

// abbreviateBinomial renders "Tyrannosaurus rex" as "T. rex", matching the form
// `search.py` generates for real nodes. Returns "" for anything not in the
// Linnean shape — uninomials, already-abbreviated names, and the long
// connective strings OTT carries for a few unplaced taxa.
//
// This is a second implementation of the pipeline's `abbreviate`, and it exists
// rather than a fifth search_name column because the row would have to be filed
// against some node's idx, and a broken taxon has none — filing it against the
// substituted MRCA is what made "Dinosauria" answer *Sauria*. Keeping it in the
// broken path means an abbreviation can only ever produce an explanation.
func abbreviateBinomial(name string) string {
	parts := strings.Fields(name)
	if len(parts) < 2 || len(parts) > 4 {
		return ""
	}
	var b strings.Builder
	for _, p := range parts[:len(parts)-1] {
		r := []rune(p)
		if !isLetter(r[0]) || strings.HasSuffix(p, ".") {
			return ""
		}
		b.WriteRune(r[0])
		b.WriteString(". ")
	}
	b.WriteString(parts[len(parts)-1])
	return b.String()
}

func isLetter(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r > 127
}
