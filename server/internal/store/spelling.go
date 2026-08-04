package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// Forgiving a typo, without pretending that also fixes a missing name.
//
// Three of eighteen real queries pulled from Workers Logs returned nothing.
// `ardvark` and `betual` are typos, one and two edits from a string the corpus
// holds. `hard maple` is a correctly spelled common name for *Acer saccharum*
// that the corpus does not carry at all, and its distance to the nearest real
// name is 3–4 on a ten-character string — so a matcher loose enough to reach it
// would be matching at 30–40% divergence and would be wrong far more often than
// right. This file fixes the first kind. `pipeline/src/concestor_build/
// spelling.py` is the design, the measurements and the reason the key is what
// it is; the short version is below.
//
// # Nothing here is on the hot path
//
// `/v1/search` answers exactly as it did. Only when it has come back with
// nothing — no node and no fossil — does {@link Store.Suggest} run, and then
// the *unchanged* search runs a second time on the corrected string. Bands,
// `Interleave`, `notInTree` and the client are untouched. The reader who pays
// for the second pass is the one who was going to get an empty list anyway,
// which matters on a `standard-1` container with half a vCPU.
//
// # Two implementations of one key, and the test that holds them together
//
// `spellingKey` is a second implementation of the pipeline's `spelling_key`,
// in the same way `abbreviateBinomial` is a second implementation of
// `abbreviate`. The pipeline computes the key for 1.2M corpus words; this
// computes it for the query; and if the two ever disagree the lookup silently
// returns nothing, which looks exactly like a word nobody misspelled. So the
// agreement is not left to care: `spelling_test.go` samples rows out of the
// built table and requires this function to reproduce the stored key, over the
// real corpus rather than over invented vectors.
//
// That risk is also why the key is fifteen lines rather than Double Metaphone.
// The measurements are in the Python; the summary is that plain vowel-dropping
// scores 16/20 on ordinary misspellings, `ph`→`f` and silent `h` take it to
// 19/20, and every further English sound rule tried bought nothing and cost
// precision — folding `z` and `q` alone puts this project's own benchmark
// string `zzzqqq` in a bucket with 69 candidates.

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
	// A word shorter than this is never corrected. The floor is where all the
	// precision lives: every false correction measured came from a short word
	// one legal edit from another — `suag`→`sag`, `about`→`abut`, `abot`→`abt`
	// — and this one rule takes the false-correction rate on random junk from
	// 25.3% to 0.5%. It costs nothing real, because every misspelling in the
	// measured query corpus is six characters or longer.
	minCorrectedWord = 6

	// The edit budget, relative to length rather than absolute: one edit is
	// generous on six characters and meaningless on twenty. Two edits on six
	// characters is 33% divergence, which is the `hard maple` mistake wearing a
	// smaller number.
	longWord         = 10
	maxDistanceShort = 1
	maxDistanceLong  = 2

	// A bucket is 2.19 words on average and 571 at the worst key, so the scan
	// below is bounded by arithmetic rather than by this. It is here because an
	// unbounded loop over an index this code did not build is a promise nobody
	// checked.
	spellingBucketCap = 4096
)

func distanceCap(word string) int {
	if len(word) < longWord {
		return maxDistanceShort
	}
	return maxDistanceLong
}

// spellingWords splits a query into the words the index holds.
//
// Returns nothing at all for a string containing any non-ASCII character,
// rather than splitting around it: `aapajärvensis` must not become `aapaj` and
// `rvensis`, which are not words and would be corrected to other things. The
// pipeline applies the identical test, and it is what lets both sides agree on
// spelling without `golang.org/x/text` — 3,424 of 1,250,845 distinct words are
// affected, 0.27%, which is a cheaper price than a Unicode normaliser that has
// to match Python's NFKD exactly.
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

// spellingKey is the phonetic key of one already-lowercased ASCII word: `ph`
// becomes `f`, non-initial `h` is dropped, the first letter is kept, and then
// vowels and runs of the same letter go.
//
//	aardvark, ardvark     -> ardvrk
//	betula,   betual      -> btl
//	rhinoceros, rinoceros -> rncrs
//
// Mirrored exactly by `spelling_key` in the pipeline. Do not change one without
// the other; `spelling_test.go` is what tells you that you have.
func spellingKey(word string) string {
	folded := strings.ReplaceAll(word, "ph", "f")
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

// damerau is optimal string alignment distance, abandoning once every cell in a
// row exceeds cap.
//
// Transpositions count as one edit, and that is load-bearing rather than
// thorough. `betual`→`betula` is a single swap; under plain Levenshtein it is
// two, which puts it level with `betual`→`betel` — a different plant — and the
// shorter string then wins the tie. Counting the swap once is what makes the
// right answer the only answer inside the cap.
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
// Word by word, because with typeahead the misspelling that matters is in the
// *leading* token: a trailing one still has the prefix's results on screen,
// while `betual` kills the query before `pendula` is ever typed. Whole-name
// matching was built and measured first and is 7× the index — 362 MB against
// 50.6 MB — and cannot correct `betual pendula` at all.
//
// It is a suggestion and not an answer. The caller re-runs the search on it and
// reports it only if it produced results, so a correction that leads nowhere is
// never shown; and the reader is told the substitution happened, because a
// search that silently answers a different question is the same mistake as a
// confident date on an undated node.
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
	bestWord := ""
	bestDist, bestUse := budget+1, int64(-1)
	for rows.Next() {
		var cand string
		var use sql.NullInt64
		if err := rows.Scan(&cand, &use); err != nil {
			return "", err
		}
		// A word the corpus already holds is a word somebody registered, not a
		// typo. `racoon`, `squirel` and `tyranosaurus` are all real taxon names,
		// so the search answers them and this must not take the reader off a
		// real name and onto a guess.
		if cand == word {
			return "", nil
		}
		d := damerau(word, cand, budget)
		if d > budget {
			continue
		}
		// Distance, then the more widely used spelling, then the shorter
		// string, then lexicographic — so the answer never depends on the order
		// SQLite returns rows in.
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
