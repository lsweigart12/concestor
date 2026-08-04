package store

import "context"

// Search rows for taxa nobody searched for.
//
// The palette's species list is empty until a word is typed, and an empty list
// is the one state that cannot answer the question a reader opening it actually
// has — *what is in here?* Filling it needs rows for a set of taxa chosen ahead
// of time, which is a different question from every other one this package
// answers: not "what matches this string" but "give me these, fully dressed".
//
// **It is a primitive rather than a feature.** This file knows nothing about
// which taxa are worth suggesting and must not learn — that list is editorial,
// it changes on somebody's judgement about what a curious reader recognises,
// and it lives in `web/src/palette/starters.ts` beside the copy it serves.
// What the server owns is the half the client cannot compute: `idx`, the tip
// count, the resolved silhouette and the headline vernacular are all facts
// about the *dataset*, and a client that baked them would be shipping a
// snapshot of one build to readers on another. That failure is silent — a
// stale `idx` resolves cleanly and describes a different animal, which is the
// `node_fts.rowid` trap in a new place.
//
// So the split is: the client says *which*, the server says *what they are*.
//
// The rows come back as SearchResult for the same reason RandomNodes' do — a
// suggestion, a random pick and a search hit are one object to every caller,
// with one row component and one add path, and a shape of its own would fork
// all three.

// matchedOnKey is what a row fetched by key reports in `matched_on`.
//
// Nothing matched: no query was asked, exactly as for {@link matchedOnRandom}.
// Saying "name" would credit the reader with a match they never made, and the
// palette keys off this field to caption *why* a row is on the page — a caption
// that would then be a lie about a row the reader is most likely to trust,
// being the first thing they saw.
const matchedOnKey = "key"

// HitsForKeys dresses a caller's chosen taxa as search rows.
//
// Unknown keys are **skipped, not errored**, and that is the whole of the
// contract worth knowing. The caller's list is curated against one build and
// served to readers on another; OTT ids are retired and forwarded silently —
// 297,070 entries — and a suggestion list that 404s the entire response because
// one taxon moved is a palette that loses its empty state to a taxonomy edit.
// Resolve chases forwards transitively already, so a skip here means the taxon
// is genuinely gone, and the honest answer is the rest of the list.
//
// Broken taxa are skipped for a second reason: they are not nodes, they cannot
// be added, and every row this returns is one Enter will act on.
//
// Order is the caller's, preserved. The list is ranked by somebody's judgement
// about what a first-time reader recognises, and returning it in idx order —
// which is what the chunked IN scan hands back — would silently replace that
// ranking with the tree's own preorder.
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
