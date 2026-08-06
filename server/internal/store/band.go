package store

import "strings"

// How closely a query sits inside a name. Refines "exact, then tip_count" with
// the two distinctions that separate the taxon a person means from the one with
// the larger subtree:
//
//	"dog" in "dog family"     is a whole word       -> bandToken
//	"dog" in "dogbane family" is a prefix of a word -> bandPrefix
//
// and head position, which answers "oak": an English compound is named by its
// last word ("oak moss" is a moss, "sessile oak" is an oak), so without it "oak"
// ranks a lichen and a beetle above every actual oak. Orthogonal to
// search_name.kind, which says which sort of name matched, not how well.
const (
	bandExact  = 0 // the name is the query
	bandHead   = 1 // whole words, ending at the last word of the name
	bandToken  = 2 // a run of whole words further up the name
	bandPrefix = 3 // the last query word is a prefix of a word in the name
	bandNone   = 4 // matched some other way (a synonym, an FTS stem, …)
)

// tokens lower-cases, splits on whitespace, and trims punctuation from each end.
// Hyphens and apostrophes stay inside a token: "can-opener" is one word, so "can"
// must not match it as a whole word.
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

// samePlural reports whether two tokens are the same English word, one
// pluralised (either order). Needed because vernaculars are stored plural
// ("animals", "sharks") while a person types the singular; without it "animal"
// is a mere prefix match and Metazoa falls off the result list.
//
// Kept to "s", "es" and consonant-y → -ies: the plurals it misses (mouse, genus)
// need a stemmer, not a longer suffix list, and none of these invent a match.
func samePlural(a, b string) bool {
	if len(a) < len(b) {
		a, b = b, a
	}
	// Three chars before the suffix, so "do"/"does" are not the same word.
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
	// butterfly → butterflies (singular is not a prefix of the plural).
	return strings.HasSuffix(b, "y") && a == b[:len(b)-1]+"ies"
}

// rankWords are the words a common name ends with when naming a rank rather than
// a thing ("dog family", "owl order"). Stepped over before the head is read, or
// Canidae's "dog family" is headed by "family".
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

// abbreviateBinomial renders "Tyrannosaurus rex" as "T. rex", matching search.py.
// Returns "" for anything not in the Linnean shape. A second implementation of
// the pipeline's `abbreviate`, kept in the broken path rather than a search_name
// column because a broken taxon has no idx to file the row against.
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
