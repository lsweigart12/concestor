package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// Forgiving a typo, without pretending that also fixes a missing name.
//
// A typo (`ardvark`, `betual`) is one or two edits from a real string; a missing
// name (`hard maple`, not in the corpus) is 3–4 edits from anything, and a
// matcher loose enough to reach it would be wrong more often than right. This
// fixes the first; `pipeline/.../spelling.py` is the design and measurements.
//
// Nothing here is on the hot path: `/v1/search` answers as it did, and only when
// its answer is Answer.Weak does Store.Suggest run and the unchanged search run
// again on the corrected string. The reader who pays for the second pass is the
// one who was getting nothing usable anyway.
//
// `spellingKey` is a second implementation of the pipeline's `spelling_key`
// (like `abbreviateBinomial`): the pipeline keys the corpus, this keys the
// query, and a disagreement returns nothing silently, so `spelling_test.go`
// samples the built table and requires this to reproduce the stored key. That
// risk is why the key is fifteen lines rather than Double Metaphone.

// SpellingSchema is the built typo index: one row per distinct word across
// every name the search can match, keyed phonetically.
//
// Absent on any build predating the index, in which case a query that returns
// nothing simply returns nothing — the same answer as before, which is why
// nothing downstream needs a fallback.
type SpellingSchema struct {
	Table string `json:"table"`
	Key   string `json:"key"`
	Word  string `json:"word"`
	// How many distinct names carry the word. The tiebreak between two
	// candidates at equal distance, and the only ordering signal a bare word
	// has. Optional: without it ties fall to length then lexicographic, which
	// is still deterministic.
	N string `json:"n,omitempty"`
}

func (s *Schema) resolveSpelling() {
	t := s.firstTable("spelling")
	if t == "" {
		return
	}
	key, word := s.col(t, "key"), s.col(t, "word")
	if key == "" || word == "" {
		s.Skipped[t] = "no key/word column pair could be resolved"
		return
	}
	s.Spelling = &SpellingSchema{Table: t, Key: key, Word: word, N: s.col(t, "n")}
}

const (
	// A word shorter than this is never corrected: every measured false
	// correction was a short word one edit from another, and this floor takes the
	// false-correction rate on junk from 25.3% to 0.5% while costing nothing
	// (every real misspelling is six characters or longer).
	minCorrectedWord = 6

	// The edit budget, relative to length: one edit is meaningless on twenty
	// characters, two on six is the `hard maple` mistake with a smaller number.
	longWord         = 10
	maxDistanceShort = 1
	maxDistanceLong  = 2

	// A guard on the bucket scan; buckets are tiny, but an unbounded loop over an
	// index this code did not build is a promise nobody checked.
	spellingBucketCap = 4096
)

func distanceCap(word string) int {
	if len(word) < longWord {
		return maxDistanceShort
	}
	return maxDistanceLong
}

// spellingWords splits a query into the words the index holds. Returns nothing
// for any non-ASCII string rather than splitting around it (`aapajärvensis` must
// not become `aapaj` + `rvensis`); the pipeline applies the same test, which
// lets both sides agree without a Unicode normaliser.
func spellingWords(text string) []string {
	for i := range len(text) {
		if text[i] >= 0x80 {
			return nil
		}
	}
	var out []string
	start := -1
	for i := range len(text) + 1 {
		var c byte
		if i < len(text) {
			c = lowerASCII(text[i])
		}
		if i < len(text) && (c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			if start < 0 {
				start = i
			}
			continue
		}
		if start >= 0 {
			out = append(out, strings.ToLower(text[start:i]))
			start = -1
		}
	}
	return out
}

func lowerASCII(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + ('a' - 'A')
	}
	return c
}

func isSpellingVowel(c byte) bool {
	switch c {
	case 'a', 'e', 'i', 'o', 'u', 'y':
		return true
	}
	return false
}

// foldPH folds `ph`→`f` for both the key and the distance. It must be in both:
// folding it into the key alone puts `elefant` in `elephant`'s bucket, then the
// distance charges two edits over a cap of one. Not a wider cap — one
// substitution just stops being counted twice.
func foldPH(word string) string { return strings.ReplaceAll(word, "ph", "f") }

// spellingKey is the phonetic key of one lowercased ASCII word: `ph`→`f`,
// drop non-initial `h`, keep the first letter, drop vowels and repeated letters
// (aardvark/ardvark -> ardvrk). Mirrored exactly by `spelling_key` in the
// pipeline; `spelling_test.go` holds the two together.
func spellingKey(word string) string {
	folded := foldPH(word)
	if folded == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(folded))
	last := folded[0]
	b.WriteByte(last)
	for i := 1; i < len(folded); i++ {
		c := folded[i]
		// Silent `h`, and only after the first letter — `Homo` keeps its own.
		if c == 'h' || isSpellingVowel(c) || c == last {
			continue
		}
		b.WriteByte(c)
		last = c
	}
	return b.String()
}

// damerau is optimal string alignment distance, abandoning once a whole row
// exceeds the budget. Transpositions count as one edit: `betual`→`betula` is one
// swap, and under plain Levenshtein it is two, tying with `betual`→`betel` (a
// different plant) where the shorter string would win.
func damerau(a, b string, budget int) int {
	la, lb := len(a), len(b)
	if la-lb > budget || lb-la > budget {
		return budget + 1
	}
	prev2 := make([]int, lb+1)
	prev := make([]int, lb+1)
	cur := make([]int, lb+1)
	for j := 0; j <= lb; j++ {
		prev[j] = j
	}
	for i := 1; i <= la; i++ {
		cur[0] = i
		best := cur[0]
		for j := 1; j <= lb; j++ {
			sub := prev[j-1]
			if a[i-1] != b[j-1] {
				sub++
			}
			v := min(prev[j]+1, cur[j-1]+1, sub)
			if i > 1 && j > 1 && a[i-1] == b[j-2] && a[i-2] == b[j-1] {
				v = min(v, prev2[j-2]+1)
			}
			cur[j] = v
			best = min(best, v)
		}
		if best > budget {
			return budget + 1
		}
		prev2, prev, cur = prev, cur, prev2
	}
	return prev[lb]
}

// Suggest returns a better spelling of q, or "" when there is nothing to fix.
//
// Word by word, since with typeahead the misspelling that matters is in the
// leading token (`betual` kills the query before `pendula` is typed), which
// whole-name matching cannot correct. A suggestion, not an answer: the caller
// re-runs the search and reports it only if it produced results.
func (s *Store) Suggest(ctx context.Context, q string) (string, error) {
	sp := s.Schema.Spelling
	if sp == nil {
		return "", nil
	}
	words := spellingWords(q)
	if len(words) == 0 {
		return "", nil
	}
	out := make([]string, len(words))
	changed := false
	for i, w := range words {
		fixed, err := s.suggestWord(ctx, w)
		if err != nil {
			return "", err
		}
		if fixed != "" {
			out[i], changed = fixed, true
		} else {
			out[i] = w
		}
	}
	if !changed {
		return "", nil
	}
	return strings.Join(out, " "), nil
}

// suggestWord is the whole of the ranking: one indexed lookup, then Damerau
// over the handful of words that share the key.
func (s *Store) suggestWord(ctx context.Context, word string) (string, error) {
	if len(word) < minCorrectedWord {
		return "", nil
	}
	sp := s.Schema.Spelling
	n := "0"
	if sp.N != "" {
		n = fmt.Sprintf("%q", sp.N)
	}
	rows, err := s.DB.QueryContext(ctx, fmt.Sprintf(
		`SELECT %q, %s FROM %q WHERE %q = ? LIMIT ?`,
		sp.Word, n, sp.Table, sp.Key), spellingKey(word), spellingBucketCap)
	if err != nil {
		return "", err
	}
	defer rows.Close() //nolint:errcheck

	budget := distanceCap(word)
	// Both sides folded, since the bucket was built on the folded form. See foldPH.
	folded := foldPH(word)
	bestWord := ""
	bestDist, bestUse := budget+1, int64(-1)
	for rows.Next() {
		var cand string
		var use sql.NullInt64
		if err := rows.Scan(&cand, &use); err != nil {
			return "", err
		}
		// A word the corpus holds is registered, not a typo, so never correct it.
		if cand == word {
			return "", nil
		}
		d := damerau(folded, foldPH(cand), budget)
		if d > budget {
			continue
		}
		// Distance, then more widely used, then shorter, then lexicographic — so
		// the answer never depends on SQLite's row order.
		if bestWord == "" || betterSuggestion(d, use.Int64, cand, bestDist, bestUse, bestWord) {
			bestWord, bestDist, bestUse = cand, d, use.Int64
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return bestWord, nil
}

func betterSuggestion(d int, use int64, word string, bd int, bu int64, bw string) bool {
	if d != bd {
		return d < bd
	}
	if use != bu {
		return use > bu
	}
	if len(word) != len(bw) {
		return len(word) < len(bw)
	}
	return word < bw
}
