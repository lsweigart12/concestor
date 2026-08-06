package store

import "context"

// Search rows for taxa nobody searched for, to fill the palette's empty state.
//
// A primitive, not a feature: which taxa to suggest is editorial and lives in
// `web/src/palette/starters.ts`; the server owns only what the client cannot
// bake without shipping one build's data to another build's readers (idx, tip
// count, silhouette, headline name). The client says which, the server says what
// they are. Rows come back as SearchResult so a suggestion, a random pick and a
// search hit share one row component and add path.

// matchedOnKey is what a row fetched by key reports in `matched_on`: nothing
// matched, no query was asked. Saying "name" would caption a match never made.
const matchedOnKey = "key"

// HitsForKeys dresses a caller's chosen taxa as search rows.
//
// Unknown keys are skipped, not errored: the list is curated against one build
// and served to readers on another, and one forwarded OTT id must not 404 the
// whole empty state. Broken taxa are skipped too (not nodes, cannot be added).
// Order is the caller's, preserved, since it is an editorial ranking that idx
// order would silently replace.
func (s *Store) HitsForKeys(ctx context.Context, keys []string) ([]SearchResult, error) {
	idxs := make([]int, 0, len(keys))
	// Keys that resolve, in the caller's order, so the reorder below has
	// something to sort against that is not the request itself.
	order := make([]int, 0, len(keys))
	seen := make(map[int]bool, len(keys))
	for _, k := range keys {
		res, err := s.Resolve(ctx, k)
		if err != nil {
			// ErrUnknownKey is the expected case and is not worth a log line;
			// anything else is a real lookup failure and would be, but the
			// caller has already lost this row either way and the rest of the
			// list is still correct. Skip and continue.
			continue
		}
		if res.Broken != nil || res.Idx < 0 || seen[res.Idx] {
			continue
		}
		seen[res.Idx] = true
		idxs = append(idxs, res.Idx)
		order = append(order, res.Idx)
	}
	if len(idxs) == 0 {
		return []SearchResult{}, nil
	}

	ptrs, err := s.resultsForIdxs(ctx, idxs, matchedOnKey)
	if err != nil {
		return nil, err
	}
	results := make([]SearchResult, 0, len(ptrs))
	for _, r := range ptrs {
		results = append(results, *r)
	}
	// The same decoration a search hit gets: age, silhouette, clade size,
	// vernacular. The empty query is not a degenerate case — `matchBand`
	// returns `bandNone` for it, so every banding rule is a no-op and only the
	// enrichment runs, which is all a row with no query behind it can want.
	if err := s.decorate(ctx, results, ""); err != nil {
		return nil, err
	}

	byIdx := make(map[int]SearchResult, len(results))
	for _, r := range results {
		if r.Idx != nil {
			byIdx[*r.Idx] = r
		}
	}
	out := make([]SearchResult, 0, len(order))
	for _, idx := range order {
		if r, ok := byIdx[idx]; ok {
			out = append(out, r)
		}
	}
	return out, nil
}
