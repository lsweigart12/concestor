package store

import (
	"context"
	"fmt"
	"strings"
)

// The pools a random pick is drawn from — and the draw itself is not here,
// because it is not the server's to make.
//
// The empty canvas is a command list, and every command on it so far assumes
// you have already thought of something. 2.4 million species is not a thing a
// person browses, and the palette cannot help until a word is typed. So the
// product needs one action that answers "show me *something*" — and the only
// interesting question here is which something.
//
// **Uniform over the whole corpus is the wrong answer, twice over.** A uniform
// node draw returns an undescribed mite or, more often, one of the 1.6 million
// `mrcaott…` clades that have no name at all; a uniform PBDB draw returns a
// single-occurrence brachiopod with no stratigraphic bracket, which cannot even
// be placed on the axis. Neither is a nudge, and a "surprise me" that mostly
// surprises you with nothing to look at trains a reader to stop pressing it.
//
// So both pools are narrowed to what can actually be *drawn*, and the narrowing
// is the same in both cases: **the taxon has a silhouette of its own.** That is
// not a decoration filter. A drawing is the strongest notability signal either
// corpus carries — somebody chose to illustrate this thing — and it is also
// exactly what makes a random row legible to an audience of curious people
// rather than systematists, who will not recognise the name.
//
// # Why this file no longer draws
//
// There was a `/v1/random` that ran both queries behind `ORDER BY random()`
// and returned a handful of decorated rows. It was the one endpoint in the API
// that could not be cached — a random answer an ETag froze for a year is not a
// random answer — and it carried a `no-store` exception through five files to
// say so.
//
// It was also, measured against production, **the most expensive endpoint in
// the app by an order of magnitude**: 1.19–1.51 s for `kind=species` and up to
// 2.45 s for `kind=fossil`, against 49 ms for a search and 39 ms for a path.
// The 167 ms in `docs/deployment.md` §1 is the same figure taken on the machine
// the pipeline runs on, and `standard-1` is half a vCPU — the identical trap
// that hid an unindexed scan inside `/v1/search` for as long as it did.
//
// The cost was never the draw. It was that **both queries are full scans and
// both were run per press**, to produce a list that is a pure function of the
// build. So the scan now runs at most once per process, the resolved pools go
// to the client, and the client draws. That is not only cheaper, it is more
// correct: which taxa are already on the canvas is a fact about the reader's
// canvas that this process has never had, which is why the old endpoint
// over-asked twelve candidates and threw eleven away. Filtering happens where
// the knowledge is.
//
// **What ships is the resolved list and never the rule.** The two node filters
// below and the five fossil ones are policy with real arguments behind them; a
// client that recomputed them would be a second copy to keep in step. This is
// the same line `Interleave` draws when it stamps `order` on a row so the
// client reads a rank rather than computing one.

// Pool is what a client needs to make its own pick: two lists of identifiers,
// ascending, and nothing else.
//
// Bare identifiers rather than decorated rows, and the ratio is the argument.
// Both lists together are **114,193 bytes of JSON, 39.8 KB gzipped and 21.3 KB
// brotli** — measured on the response, not estimated — where the same rows
// carrying names, ranks and ages would be several hundred KB, to spend one of
// them. A pick is followed by a lookup for the one taxon drawn — `/v1/node/
// idx:N` and `/v1/fossil/{id}`, both immutable, both edge-cached, both free on
// a repeat — so the decoration is fetched exactly where it is used.
//
// It compresses that well because the lists are ascending runs of integers, so
// **the `ORDER BY` below is paying for itself twice**: once as the determinism
// the ETag needs, and once as 5.4x off the wire. Delta-encoding would take
// another few KB and was refused — it buys less than the sort already did and
// costs a decoder on the other side of the wire.
//
// Ascending order is load-bearing rather than tidy. It is what the ETag and the
// year-long `Cache-Control` on this response claim: the same build must produce
// the same bytes, and SQLite's scan order is not a promise.
type Pool struct {
	Nodes   []int32 `json:"nodes"`
	Fossils []int64 `json:"fossils"`
}

// RandomPool returns both pools, building them at most once per process.
//
// **Who calls this first is the serving binary's decision, not this file's**,
// and `server/main.go` warms it in a goroutine at startup. That is the third
// answer to a question whose first two were both wrong, and the reasoning is
// worth keeping because it is not about speed:
//
//   - Building on first request put two full scans on the press a reader is
//     waiting on. Measured against production, the first pool request on a
//     freshly provisioned container took **29.9 s** — most of it the container's
//     own cold start against an empty page cache and a 1.9 GB mmap, but the
//     scans were in there and the reader was holding the whole of it.
//   - Building inside `Open` fixes that by moving the cost in front of *every*
//     request the container has not answered yet — including the reader's first
//     search, which is the primary flow. On one instance and half a vCPU that
//     is a worse trade than the one it replaces.
//
// Warmed in the background it blocks nothing, and a request arriving mid-build
// waits on this mutex for the build already running rather than starting a
// second. Callers therefore need no warm/cold distinction: this is always
// correct, and by the time a human has pressed anything it is nearly always
// already in memory.
//
// A failure is not memoised. `loaded` stays false so the next caller tries
// again, because a transient error that permanently disables the surface for
// the process's lifetime is a worse outcome than repeating a slow query — and
// with a warm-up that runs once at startup, a failure nobody retried would mean
// the surface stays broken until the container next sleeps.
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
// Two filters, and the second is subtler than it looks:
//
//   - **A name.** 1.6M nodes are unnamed `mrcaott…` clades. They are perfectly
//     good tree structure and a perfectly useless thing to be handed.
//   - **`node_image.climb = 0`.** Phase 5 resolves an image for every one of
//     the 2,725,682 nodes by climbing to a relative, so "has an image" is true
//     of the whole corpus and says nothing. `climb` is hops from the node up to
//     the *clade the drawing speaks for*, so zero means that clade is the node
//     itself — the picture is of this taxon or of something inside it, never
//     borrowed from a group larger than it. That is the same claim the canvas's
//     suppression rule is built on, and it is the one that makes a picture
//     honest rather than merely present.
//
// Measured on the current build: 30,982 nodes have `climb = 0`, and 13,918 of
// those are named. That is the pool, and it is the whole of what ships.
func (s *Store) randomNodePool(ctx context.Context) ([]int32, error) {
	ni := s.Schema.NodeImage
	if ni == nil || ni.Climb == "" {
		// No way to tell an own drawing from a borrowed one, so no way to keep
		// the promise. An empty pool is the honest answer; the client reports
		// it rather than picking something worse.
		return []int32{}, nil
	}

	// A subquery rather than a join, and the difference is 9x. Written as a
	// join, SQLite drives from `node_name` — the partial index over the 1.1M
	// named nodes — and probes `node_image` once per row, 745 ms. Written as an
	// `IN`, it scans `node_image` once for the 30,982 rows that pass `climb = 0`
	// and probes `node` by rowid, 83 ms. Neither side is indexed on `climb`, so
	// the scan is unavoidable; what is avoidable is doing it from the wrong end.
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

// randomFossilPool collects PBDB taxa that can be drawn against the tree.
//
// Five filters. The first three are the graft's own refusals stated in SQL, so
// a pick can never land on something `makeGraft` would then decline to place;
// the fourth is the silhouette rule above, and the fifth is {@link notInTree}.
//
//   - **Not itself a node.** A pick that lands on *Tyrannosaurus rex* has found
//     a taxon the tree already contains, and drawing it as a graft is drawing
//     the poorer of two things the reader could have been handed. Costs 168 of
//     2,114 — every one of them still reachable, as a species.
//
//   - **`is_primary`.** PBDB carries a row per `taxon_no` and synonyms collapse
//     onto one accepted name, so without this the same animal is drawn several
//     times over and the pool is weighted by how heavily a taxon was renamed.
//
//   - **A last appearance.** 21.4% of the corpus has no interval at all, and
//     `lla` is the end phase 4 trusts and the only one the layout reads. No
//     `lla`, no x — and a fossil placed at a guessed date is the one thing
//     worse than a fossil not placed.
//
//   - **Extinct, and ended before the Holocene.** `is_extant` alone is not
//     enough and the docs are emphatic about why: PBDB flags *Thalassia
//     testudinum*, the living turtle grass, extinct at 48.07–0.0117 Ma. A range
//     running to the present is a living thing wearing a fossil's clothes, and
//     drawing one at the right-hand edge of deep time as a "random fossil" is
//     the same wrong flag arriving somewhere new.
//
//   - **A drawing**, joined through `fossil_image`. A fossil has no clade to
//     borrow a picture from — `node_image` cannot reach a thing that is not a
//     node — so this join is exact by construction, and the taxa that survive
//     all five filters are all illustrated portraits. **1,935 of them**, read off
//     build `03473db1bfce56ca` — a reading rather than a constant, like every
//     other corpus figure here: the comment said 1,946 for a build two runs
//     back and the difference is the pipeline, not a filter.
//
// The one thing this cannot filter on is whether the taxon's attachment point
// is currently drawn, because that is a fact about the reader's canvas and not
// about the fossil. The client adds the attaching clade when it is missing.
func (s *Store) randomFossilPool(ctx context.Context) ([]int64, error) {
	f := s.Schema.Fossil
	if f == nil || f.TaxonNo == "" || f.ImageTable == "" || !f.Brackets {
		return []int64{}, nil
	}

	// `lla_drawn` where the build has it, because this is the position the
	// graft will use and the filter has to be the graft's own refusal stated in
	// SQL. Reading `lla` here and drawing at `lla_drawn` would let a pick land
	// on a taxon whose two ends straddle the Holocene test.
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
		// `IS NULL` is excluded rather than admitted. 1.7% of the corpus has
		// genuinely unknown extancy, and a pick nobody can vouch for is not
		// worth the 1.7%.
		where = append(where, fmt.Sprintf("t.%q = 0", f.IsExtant))
	}

	// The same join `fossilRow` builds, and it is on `accepted_no` rather than
	// on the primary key: a synonym's drawing belongs to the taxon it collapses
	// onto. Only the id is selected — the client fetches the row it draws.
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
