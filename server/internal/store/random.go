package store

import (
	"context"
	"fmt"
	"strings"
)

// Random picks: the way in for a reader who does not yet know what to ask for.
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
// Neither query is cheap-because-indexed and neither needs to be: both are a
// full scan behind `ORDER BY random()`, which is measured at a few tens of
// milliseconds on this database — the same order as `SearchFossils`, which the
// palette already runs on a keystroke. The picks are made per request and the
// endpoint is `no-store`, because a random answer that an ETag froze for a year
// is not a random answer.

// randomLimit bounds a pick request. A caller asks for a handful rather than
// one so it can skip picks already on the canvas without a second round trip;
// nothing needs more than that, and the cap keeps the response small enough to
// stay uncacheable without mattering.
const (
	defaultRandomLimit = 1
	maxRandomLimit     = 25
)

// matchedOnRandom is what a random pick reports in `matched_on`. Nothing
// matched — no query was asked — and saying "name" would credit a match the
// reader never made. A client that keys off `matched_on` to caption *why* a row
// is on the page must therefore say nothing for these, which is correct.
const matchedOnRandom = "random"

// RandomNodes picks named nodes that carry their own drawing.
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
// those are named. That is the pool.
//
// The rows come back as `SearchResult` deliberately: a random pick and a search
// hit are the same object to every caller — the same palette row, the same add
// path — and giving them a shape of their own would fork both.
func (s *Store) RandomNodes(ctx context.Context, limit int) ([]SearchResult, error) {
	ni := s.Schema.NodeImage
	if ni == nil || ni.Climb == "" {
		// No way to tell an own drawing from a borrowed one, so no way to keep
		// the promise. An empty list is the honest answer; the caller reports
		// it rather than picking something worse.
		return []SearchResult{}, nil
	}
	limit = clampRandomLimit(limit)

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
		 ORDER BY random() LIMIT %d`,
		ni.Idx, ni.Table, ni.Climb, limit)
	rows, err := s.DB.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close() //nolint:errcheck
	var idxs []int
	for rows.Next() {
		var idx int
		if err := rows.Scan(&idx); err != nil {
			return nil, err
		}
		idxs = append(idxs, idx)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(idxs) == 0 {
		return []SearchResult{}, nil
	}

	ptrs, err := s.resultsForIdxs(ctx, idxs, matchedOnRandom)
	if err != nil {
		return nil, err
	}
	results := make([]SearchResult, 0, len(ptrs))
	for _, r := range ptrs {
		results = append(results, *r)
	}
	// The same decoration a search hit gets: age, silhouette, clade size,
	// vernacular. The empty query is not a degenerate case here — `matchBand`
	// returns `bandNone` for it, so every banding rule is a no-op and only the
	// enrichment runs, which is all a pick with no query behind it can want.
	if err := s.decorate(ctx, results, ""); err != nil {
		return nil, err
	}
	// `resultsForIdxs` returns rows in whatever order the chunked IN scan hands
	// them back, which for SQLite is idx order — a stable, *non*-random order
	// that would make a multi-pick request read as sorted. Put them back in the
	// order random() drew them.
	byIdx := make(map[int]SearchResult, len(results))
	for _, r := range results {
		if r.Idx != nil {
			byIdx[*r.Idx] = r
		}
	}
	out := make([]SearchResult, 0, len(idxs))
	for _, idx := range idxs {
		if r, ok := byIdx[idx]; ok {
			out = append(out, r)
		}
	}
	return out, nil
}

// RandomFossils picks PBDB taxa that can be drawn against the tree.
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
//     node — so this join is exact by construction, and the 1,946 taxa that
//     survive all five filters are all illustrated portraits.
//
// The one thing this cannot filter on is whether the taxon's attachment point
// is currently drawn, because that is a fact about the reader's canvas and not
// about the fossil. The caller adds the attaching clade when it is missing.
func (s *Store) RandomFossils(ctx context.Context, limit int) ([]Fossil, error) {
	f := s.Schema.Fossil
	if f == nil || f.TaxonNo == "" || f.ImageTable == "" || !f.Brackets {
		return []Fossil{}, nil
	}
	limit = clampRandomLimit(limit)

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

	sel, join := fossilRow(f)
	if join == "" {
		return []Fossil{}, nil
	}
	q := fmt.Sprintf("SELECT %s FROM %q t%s WHERE %s ORDER BY random() LIMIT %d",
		sel, f.Table, join, strings.Join(where, " AND "), limit)

	rows, err := s.DB.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close() //nolint:errcheck
	list := []Fossil{}
	for rows.Next() {
		fo, err := scanFossil(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, fo)
	}
	return list, rows.Err()
}

func clampRandomLimit(limit int) int {
	if limit <= 0 {
		return defaultRandomLimit
	}
	return min(limit, maxRandomLimit)
}
