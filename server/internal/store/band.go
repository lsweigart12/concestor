package store

import "strings"

// How closely a query sits inside a name. This refines architecture §4's
// "exact match, then tip_count" with the two distinctions that actually
// separate the taxon a person means from the one with the larger subtree:
//
//	"dog" in "dog family"     is a whole word          -> bandToken
//	"dog" in "dogbane family" is a prefix of a word    -> bandPrefix
//
// Both are legitimate matches, and without the first distinction they fall
// through to tip_count, where a 7,050-tip plant family beats the dogs.
//
// The second distinction is **head position**, and it is the one that answers
// "oak". An English compound noun is named by its last word: "oak moss" is a
// moss, "sessile oak" is an oak. Without it, "oak" ranked Usnea (a lichen,
// 1,569 tips) and Enaphalodes (a beetle) above every actual oak, because
// nothing separated a name the word *modifies* from a name it *is*. Measured
// over 77 everyday words it also takes "frog" off the froghoppers, "lizard"
// off the booklice, "deer" off the deer flies and "tiger" off the tiger
// beetles — the whole class of compound names where the query word qualifies
// something unrelated.
//
// All of this is orthogonal to search_name.kind, which says *which sort of
// name* matched rather than *how well*.
const (
	bandExact  = 0 // the name is the query
	bandHead   = 1 // whole words, ending at the last word of the name
	bandToken  = 2 // a run of whole words further up the name
	bandPrefix = 3 // the last query word is a prefix of a word in the name
	bandNone   = 4 // matched some other way (a synonym, an FTS stem, …)
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
// Kept to "s", "es" and consonant-y → -ies on purpose. Real English plurals
// this misses — mouse, genus, larva — are all cases where nothing regular
// relates the two strings, so they need a stemmer rather than a longer list of
// suffixes. The -ies case is here because it is the one irregularity the
// corpus leans on: "swallowtail butterflies" and "Milkweed Butterflies" are
// the names Papilionidae and Danaini are headlined by, and neither matched
// "butterfly" at all until it landed. What matters is that none of these
// *invent* a match: every one is a pair a reader would call the same word.
func samePlural(a, b string) bool {
	if len(a) < len(b) {
		a, b = b, a
	}
	// Three characters before the suffix, so "do"/"does" and "go"/"goes" are
	// not declared the same word. Nothing shorter is a taxon's common name.
	if len(b) < 3 {
		return false
	}
	if strings.HasPrefix(a, b) {
		switch a[len(b):] {
		case "s", "es":
			return true
		}
		return false
	}
	// butterfly → butterflies. The singular is not a prefix of the plural, so
	// this cannot ride on the branch above.
	return strings.HasSuffix(b, "y") && a == b[:len(b)-1]+"ies"
}

// rankWords are the words a common name ends with when it is naming a *rank*
// rather than a thing: "dog family", "owl order", "sea eagle genus". 577 of
// the 162,466 vernaculars end in one. They have to be stepped over before the
// head is read, or Canidae's "dog family" is headed by "family" and falls
// behind every one-species taxon called something-dog.
var rankWords = map[string]bool{
	"family": true, "families": true, "order": true, "orders": true,
	"genus": true, "genera": true, "class": true, "classes": true,
	"phylum": true, "phyla": true, "kingdom": true, "division": true,
	"tribe": true, "subfamily": true, "superfamily": true, "suborder": true,
	"infraorder": true, "subgenus": true, "subclass": true, "superorder": true,
	"section": true, "series": true, "group": true, "groups": true,
	"clade": true, "complex": true, "species": true, "subspecies": true,
	"taxon": true, "taxa": true,
}

// headIndex is the position of the word the name is *about*: the last one that
// is not a rank word. A name made entirely of rank words keeps its last token,
// since there is nothing else it could be about.
func headIndex(nt []string) int {
	i := len(nt) - 1
	for i > 0 && rankWords[nt[i]] {
		i--
	}
	return i
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
	head := headIndex(nt)
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
		if !exact {
			best = min(best, bandPrefix)
			continue
		}
		// The run is whole words. Where it *ends* is what says whether the
		// name is about the query or merely qualified by it.
		if i+len(qt)-1 == head {
			return bandHead
		}
		best = min(best, bandToken)
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
