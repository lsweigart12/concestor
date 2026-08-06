package store

import (
	"context"
	"fmt"
	"strings"
)

// The pools a random pick is drawn from; the draw itself is the client's.
//
// The empty canvas needs one action that answers "show me something". Uniform
// over the corpus is wrong twice: a uniform node draw returns an unnamed
// `mrcaott…` clade, a uniform PBDB draw returns a taxon with no bracket to place
// on the axis. So both pools are narrowed to what can be drawn — the taxon has a
// silhouette of its own, which is also the strongest notability signal either
// corpus carries.
//
// The draw is not here. `/v1/random` ran both queries per press behind
// `ORDER BY random()`, which made it uncacheable and the most expensive endpoint
// in the app (both queries are full scans producing a pure function of the
// build). Now the scan runs at most once per process, the pools go to the
// client, and the client draws — which is also more correct, since the exclusion
// (what is already on the canvas) is knowledge only the client has. What ships
// is the resolved list, never the rule.

// Pool is what a client needs to make its own pick: two ascending lists of
// identifiers, nothing else. Bare identifiers, not decorated rows: the pick is
// followed by an immutable, edge-cached lookup for the one taxon drawn, so
// decoration is fetched where it is used. Ascending order is what the ETag and
// year-long Cache-Control claim (same build, same bytes; SQLite's scan order is
// not a promise) and compresses ~5x off the wire.
type Pool struct {
	Nodes   []int32 `json:"nodes"`
	Fossils []int64 `json:"fossils"`
}

// RandomPool returns both pools, building them at most once per process.
//
// `server/main.go` warms it in a goroutine at startup. Building on first request
// would put two full scans on the press a reader is waiting on; building inside
// `Open` would delay every request including the first search. Warmed in the
// background it blocks nothing, and a request arriving mid-build waits on this
// mutex rather than starting a second build.
//
// A failure is not memoised (`loaded` stays false), so a transient error does
// not disable the surface for the life of the process.
func (s *Store) RandomPool(ctx context.Context) (*Pool, error) {
	s.poolMu.Lock()
	defer s.poolMu.Unlock()
	if s.poolLoaded {
		return s.pool, nil
	}
	nodes, err := s.randomNodePool(ctx)
	if err != nil {
		return nil, err
	}
	fossils, err := s.randomFossilPool(ctx)
	if err != nil {
		return nil, err
	}
	s.pool = &Pool{Nodes: nodes, Fossils: fossils}
	s.poolLoaded = true
	return s.pool, nil
}

// randomNodePool collects named nodes that carry their own drawing.
//
//   - A name: 1.6M nodes are unnamed `mrcaott…` clades, useless to be handed.
//   - `node_image.climb = 0`: every node has an image (phase 5 climbs to a
//     relative), so "has an image" says nothing. `climb = 0` means the drawing
//     speaks for this node itself, not a larger group — the canvas's suppression
//     rule, and what makes a picture honest rather than merely present.
func (s *Store) randomNodePool(ctx context.Context) ([]int32, error) {
	ni := s.Schema.NodeImage
	if ni == nil || ni.Climb == "" {
		// No way to tell an own drawing from a borrowed one, so no way to keep
		// the promise. An empty pool is the honest answer; the client reports
		// it rather than picking something worse.
		return []int32{}, nil
	}

	// A subquery, not a join (9x): the `IN` scans `node_image` once for the
	// `climb = 0` rows and probes `node` by rowid, rather than probing
	// `node_image` per named node. Neither side is indexed on `climb`.
	q := fmt.Sprintf(
		`SELECT n.idx FROM node n
		 WHERE n.name IS NOT NULL AND trim(n.name) <> ''
		   AND n.idx IN (SELECT %q FROM %q WHERE %q = 0)
		 ORDER BY n.idx`,
		ni.Idx, ni.Table, ni.Climb)
	rows, err := s.DB.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close() //nolint:errcheck
	out := []int32{}
	for rows.Next() {
		var idx int32
		if err := rows.Scan(&idx); err != nil {
			return nil, err
		}
		out = append(out, idx)
	}
	return out, rows.Err()
}

// randomFossilPool collects PBDB taxa that can be drawn against the tree. Five
// filters, the first three being the graft's own refusals stated in SQL so a
// pick can never land on something makeGraft would decline:
//
//   - Not itself a node (notInTree): a pick on *T. rex* found a taxon the tree
//     already contains, still reachable as a species.
//   - `is_primary`: else a synonym-heavy taxon is drawn several times over.
//   - A last appearance: no `lla`, no x, and a guessed date is worse than none.
//   - Extinct AND ended before the Holocene: `is_extant` alone flags living
//     turtle grass extinct, and a range to the present would draw at x ≈ 0.
//   - A drawing (via `fossil_image`): a fossil has no clade to borrow one from.
//
// It cannot filter on whether the attachment point is currently drawn (a fact
// about the reader's canvas); the client adds the attaching clade when missing.
func (s *Store) randomFossilPool(ctx context.Context) ([]int64, error) {
	f := s.Schema.Fossil
	if f == nil || f.TaxonNo == "" || f.ImageTable == "" || !f.Brackets {
		return []int64{}, nil
	}

	// `lla_drawn` where the build has it, since that is the position the graft
	// uses; reading `lla` here would let a pick straddle the Holocene test.
	young := `t."lla"`
	if f.YoungEnd {
		young = `coalesce(t."lla_drawn", t."lla")`
	}
	where := []string{
		young + " IS NOT NULL",
		// Holocene base, 0.0117 Ma. Anything whose last appearance is at or
		// after it has not demonstrably ended.
		young + " > 0.0117",
		"img." + quote(f.ImageID) + " IS NOT NULL",
	}
	if f.IsPrimary != "" {
		where = append(where, fmt.Sprintf("t.%q = 1", f.IsPrimary))
	}
	if nit := notInTree(f); nit != "" {
		where = append(where, nit)
	}
	if f.IsExtant != "" {
		// `IS NULL` (unknown extancy) is excluded: a pick nobody can vouch for.
		where = append(where, fmt.Sprintf("t.%q = 0", f.IsExtant))
	}

	// Joined on `accepted_no` (a synonym's drawing belongs to its accepted
	// taxon). Only the id is selected; the client fetches the row it draws.
	q := fmt.Sprintf(
		`SELECT t.%q FROM %q t LEFT JOIN %q img ON img.%q = t.%q WHERE %s ORDER BY t.%q`,
		f.TaxonNo, f.Table, f.ImageTable, f.ImageKey, f.AcceptedNo,
		strings.Join(where, " AND "), f.TaxonNo)

	rows, err := s.DB.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close() //nolint:errcheck
	out := []int64{}
	for rows.Next() {
		var no int64
		if err := rows.Scan(&no); err != nil {
			return nil, err
		}
		out = append(out, no)
	}
	return out, rows.Err()
}
