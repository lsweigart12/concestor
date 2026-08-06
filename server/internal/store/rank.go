package store

import (
	"context"
	"fmt"
	"strings"
)

// A rank, where the taxonomy has none.
//
// OTT files some taxa (including *Tyrannosaurus rex*) as `no rank`. PBDB has the
// field, and phase 3 already resolved the PBDB taxon to this node, so the gap is
// filled from PBDB — but only where OTT is silent, and only where the PBDB
// taxon's name matches the node's exactly (which keeps PBDB's Ediacaran *Ivesia*
// from ranking OTT's rose). Nothing is invented: it is a rank for a taxon this
// node already is.
//
// Loaded once at open rather than joined per request: `fossil` has no index on
// `name`, so a path through a large unranked clade would scan its every attached
// row. One scan at open, a map of ~2,000 entries.

// rankedByTaxonomy reports whether OTT states a real rank. OTT writes an empty
// string or a `no rank` prefix where it has none. The SQL prefilter in
// loadPBDBRanks must agree with this; TestUnrankedAgreesWithSQL holds it there.
func rankedByTaxonomy(rank *string) bool {
	if rank == nil {
		return false
	}
	r := strings.ToLower(strings.TrimSpace(*rank))
	return r != "" && !strings.HasPrefix(r, "no rank")
}

// rankedByPBDB is the same in PBDB's vocabulary: `unranked clade` and
// `informal` are not rungs and may not be printed as one.
func rankedByPBDB(rank string) bool {
	r := strings.ToLower(strings.TrimSpace(rank))
	return r != "" && r != "unranked clade" && r != "informal" &&
		!strings.HasPrefix(r, "no rank")
}

// The SQL side of rankedByTaxonomy: it selects a superset of what the predicate
// rejects (Go decides; this only keeps the scan small).
const sqlUnranked = `(n.rank IS NULL OR TRIM(n.rank) = '' OR LOWER(TRIM(n.rank)) LIKE 'no rank%')`

// loadPBDBRanks fills the map read by Metas. A build with no fossil table (or a
// fossil table predating the rank column) gets no map and the rank row stays
// empty, the same degradation every other optional table gets.
func (s *Store) loadPBDBRanks(ctx context.Context) {
	f := s.Schema.Fossil
	if f == nil || f.Rank == "" {
		return
	}
	q := fmt.Sprintf(
		`SELECT f.%q, f.%q FROM %q f JOIN node n ON n.idx = f.%q AND f.%q = n.name
		  WHERE %s AND f.%q IS NOT NULL`,
		f.AttachIdx, f.Rank, f.Table, f.AttachIdx, f.Name, sqlUnranked, f.Rank)
	rows, err := s.DB.QueryContext(ctx, q)
	if err != nil {
		s.log.Warn("pbdb ranks unavailable", "err", err)
		return
	}
	defer rows.Close() //nolint:errcheck

	out := make(map[int]string)
	// Two PBDB taxa of one name ranked differently is a disagreement, not a tie:
	// the node keeps its empty rank row rather than a coin flip.
	conflicted := make(map[int]bool)
	for rows.Next() {
		var idx int
		var rank string
		if err := rows.Scan(&idx, &rank); err != nil {
			s.log.Warn("pbdb ranks unavailable", "err", err)
			return
		}
		if !rankedByPBDB(rank) {
			continue
		}
		if prev, ok := out[idx]; ok && prev != rank {
			conflicted[idx] = true
			continue
		}
		out[idx] = rank
	}
	if err := rows.Err(); err != nil {
		s.log.Warn("pbdb ranks unavailable", "err", err)
		return
	}
	for idx := range conflicted {
		delete(out, idx)
	}
	s.pbdbRank = out
	s.log.Info("pbdb ranks loaded", "nodes", len(out), "conflicts", len(conflicted))
}

// rankFor returns the rank to serve for one node: the taxonomy's where it has
// one, PBDB's where it does not, and nil where neither does. The order is the
// whole rule — OTT is never overridden.
func (s *Store) rankFor(idx int, taxonomy *string) *string {
	if rankedByTaxonomy(taxonomy) {
		return taxonomy
	}
	if r, ok := s.pbdbRank[idx]; ok {
		v := r
		return &v
	}
	return taxonomy
}
