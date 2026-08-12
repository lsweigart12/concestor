package store

import (
	"context"
	"sort"
)

// The taxa one drill-down step below a node, for the palette's scoped empty
// state: enter a clade and the list starts full rather than blank.
//
// "One step" is a step through *named* nodes, not through the synthesis tree's
// raw edges. The synthesis resolves most groups into cascades of unnamed
// `mrcaott…` divergences — *Homo*'s direct children are two of them, not two
// species — and a row the reader cannot name is not somewhere they can go.
// So an unnamed child is replaced by its own children, repeatedly, until every
// row on the frontier carries a name. Rows are ranked by subtree size, the
// same signal that puts Canidae above *Cania* in search (architecture §4).

const (
	maxChildren     = 100
	defaultChildren = 50
	// The frontier expansion visits at most this many nodes. Named nodes are
	// dense (95.4% of the tree), so a frontier that has not closed by then is
	// pathological; the rows found are still correct, and Total honestly
	// reports only what was found.
	childScanCap = 4096
)

// Children lists the named children of the node at idx, ranked largest subtree
// first, with `Order` stamped for the client. The second return is the size of
// the whole frontier before the page was cut.
func (s *Store) Children(ctx context.Context, idx, limit int) ([]SearchResult, int, error) {
	if limit <= 0 {
		limit = defaultChildren
	}
	limit = min(limit, maxChildren)
	a := s.Arrays
	if !a.Valid(idx) {
		return []SearchResult{}, 0, nil
	}

	// Direct children fall out of the preorder: the first is idx+1, and each
	// sibling starts where the previous subtree ends.
	direct := func(n int) []int {
		out := make([]int, 0, a.ChildCount[n])
		for c := n + 1; c < int(a.SubtreeOut[n]); c = int(a.SubtreeOut[c]) {
			out = append(out, c)
		}
		return out
	}

	var named []int
	queue := direct(idx)
	visited := 0
	for len(queue) > 0 && visited < childScanCap {
		if len(queue) > childScanCap-visited {
			queue = queue[:childScanCap-visited]
		}
		visited += len(queue)
		names, err := s.namedOf(ctx, queue)
		if err != nil {
			return nil, 0, err
		}
		var next []int
		for _, c := range queue {
			if names[c] {
				named = append(named, c)
			} else {
				next = append(next, direct(c)...)
			}
		}
		queue = next
	}

	sort.SliceStable(named, func(i, j int) bool {
		return a.TipCount[named[i]] > a.TipCount[named[j]]
	})
	total := len(named)
	if len(named) > limit {
		named = named[:limit]
	}
	if len(named) == 0 {
		return []SearchResult{}, 0, nil
	}

	ptrs, err := s.resultsForIdxs(ctx, named, matchedOnKey)
	if err != nil {
		return nil, 0, err
	}
	results := make([]SearchResult, 0, len(ptrs))
	for _, r := range ptrs {
		results = append(results, *r)
	}
	// The same decoration a search hit gets, with no query behind it — the
	// banding rules are all no-ops on an empty string and only the enrichment
	// runs (see HitsForKeys, which set the precedent).
	if err := s.decorate(ctx, results, ""); err != nil {
		return nil, 0, err
	}
	// The rank the canvas and card would show, and the tip_count order the
	// list promised — resultsForIdxs answers in whatever order the IN clause
	// pleased.
	byIdx := make(map[int]SearchResult, len(results))
	for _, r := range results {
		if r.Idx != nil {
			r.Rank = s.rankFor(*r.Idx, r.Rank)
			byIdx[*r.Idx] = r
		}
	}
	out := make([]SearchResult, 0, len(named))
	for _, i := range named {
		if r, ok := byIdx[i]; ok {
			order := len(out)
			r.Order = &order
			out = append(out, r)
		}
	}
	return out, total, nil
}

// namedOf reports which of these nodes the taxonomy names. NULL-named rows are
// the `mrcaott…` divergences; a name is what makes a row somewhere to go.
func (s *Store) namedOf(ctx context.Context, idxs []int) (map[int]bool, error) {
	out := make(map[int]bool, len(idxs))
	for start := 0; start < len(idxs); start += metaChunk {
		end := min(start+metaChunk, len(idxs))
		chunk := idxs[start:end]
		q := "SELECT idx FROM node WHERE name IS NOT NULL AND idx IN (" +
			placeholders(len(chunk)) + ")"
		args := make([]any, len(chunk))
		for i, v := range chunk {
			args[i] = v
		}
		rows, err := s.DB.QueryContext(ctx, q, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var idx int
			if err := rows.Scan(&idx); err != nil {
				_ = rows.Close()
				return nil, err
			}
			out[idx] = true
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}
