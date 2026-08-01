package store

import (
	"context"
	"sort"
	"strings"
)

// The command palette fires a query per keystroke, and the first keystroke is
// the worst case: "a" matches 268,281 names. Reading them all out of SQLite to
// rank them costs ~50 ms even index-only, because it is half a million driver
// round trips.
//
// But a short prefix is only ever answered with big clades — the ranking is
// tip_count descending — so the answer for those queries lives entirely inside
// the globally largest subtrees. Those are held in memory, folded and sorted,
// and searched with a binary search. When the hot set alone fills a page, no
// node outside it can outrank what it returned, so the database is not touched
// at all.
//
// This is ~4 MB and one pass over the tip_count array at startup. It exists
// only until node_fts lands, at which point FTS5 becomes the candidate
// generator (architecture §4) and this can go.

// hotNameCount is how many of the largest subtrees are held in memory.
const hotNameCount = 50_000

type hotName struct {
	fold string // lower-cased name
	idx  int
}

func (s *Store) loadHotNames(ctx context.Context) {
	a := s.Arrays
	if a == nil || a.N == 0 {
		return
	}

	// The hotNameCount largest subtrees, by one pass over the mmap'd array.
	h := &tipHeap{tip: a.TipCount}
	for i := range a.N {
		h.push(i, hotNameCount)
	}
	idxs := h.item
	if len(idxs) == 0 {
		return
	}

	s.hot = make([]hotName, 0, len(idxs))
	for start := 0; start < len(idxs); start += metaChunk {
		end := min(start+metaChunk, len(idxs))
		chunk := idxs[start:end]
		q := "SELECT idx, name FROM node WHERE idx IN (" + placeholders(len(chunk)) + ") AND name IS NOT NULL"
		args := make([]any, len(chunk))
		for i, v := range chunk {
			args[i] = v
		}
		rows, err := s.DB.QueryContext(ctx, q, args...)
		if err != nil {
			s.log.Warn("hot-name cache unavailable; short queries will hit the index scan", "err", err)
			s.hot = nil
			return
		}
		for rows.Next() {
			var idx int
			var name string
			if err := rows.Scan(&idx, &name); err != nil {
				_ = rows.Close()
				s.hot = nil
				return
			}
			s.hot = append(s.hot, hotName{fold: strings.ToLower(name), idx: idx})
		}
		_ = rows.Close()
	}
	sort.Slice(s.hot, func(i, j int) bool { return s.hot[i].fold < s.hot[j].fold })

	// The smallest subtree in the hot set: below this, a match can only be
	// found by going to the database.
	if len(idxs) > 0 {
		s.hotFloor = a.TipCount[idxs[0]] // heap root is the minimum
	}
}

// hotPrefixMatches returns up to k in-memory matches for a prefix, largest
// subtree first. It returns nothing when the cache was not built.
func (s *Store) hotPrefixMatches(q string, k int) []int {
	if len(s.hot) == 0 || q == "" {
		return nil
	}
	fold := strings.ToLower(q)
	lo := sort.Search(len(s.hot), func(i int) bool { return s.hot[i].fold >= fold })

	h := &tipHeap{tip: s.Arrays.TipCount}
	for i := lo; i < len(s.hot); i++ {
		if !strings.HasPrefix(s.hot[i].fold, fold) {
			break
		}
		h.push(s.hot[i].idx, k)
	}
	return h.sorted()
}
