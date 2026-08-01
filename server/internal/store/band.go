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
			case got == want:
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
