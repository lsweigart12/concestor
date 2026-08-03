package store

import (
	"context"
	"fmt"
	"strings"
)

// A rank, where the taxonomy has none.
//
// The Open Tree taxonomy files *Tyrannosaurus rex* as `no rank`. Not "species",
// not blank — the string "no rank", which is what OTT writes for a row whose
// source gave it no Linnaean rung. So the canvas printed no rank row above the
// most famous fossil in the product, and `isScientificItalic` set the name
// roman while *Homo sapiens* two rows above it was italic. Both of those are
// one missing field.
//
// The Paleobiology Database has the field. It ranks taxon 54833,
// *Tyrannosaurus rex*, as a species, and phase 3 already resolved that taxon to
// this node. **2,039 nodes** are in the same position — unranked in OTT, ranked
// by a PBDB taxon of the same name attached at the node — and across all of
// them the PBDB rows never disagree with each other about the rank. So the gap
// is filled from PBDB and only ever where OTT is silent; nothing here can
// overwrite a rank the taxonomy states.
//
// # Why this is not the gap-filling the docs refuse
//
// `handoff.md` §3 records that the detail card **names** the gaps in a
// classification rather than filling them — *Homo sapiens* has no ranked order
// and Hominidae is not a node at all, and inventing rungs to make the ladder
// look complete would be a lie about the tree's shape. That is a different
// operation. Nothing is invented here and no rung is added: a second catalogue
// records a rank for a taxon *this same node already is*, and the resolution
// carrying that identity is one phase 3 made and phase 3's `refuse_disagreements`
// vetted. Requiring the names to match exactly is the last guard on top of that,
// and it is what keeps PBDB's Ediacaran *Ivesia* from ranking OTT's rose.
//
// # Why it is loaded once rather than joined per request
//
// The join is name equality, and `fossil` has no index on `name` — only
// `fossil(attach_idx, n_occs DESC)`. A path through *Sauropsida* would pay for
// 10,818 attached rows to answer a question about one, and *Sauropsida* is
// itself unranked so it would pay on every dinosaur in the product. Loaded at
// open it is one 150 ms scan and a map of ~2,000 entries.

// unrankedTaxonomy is what the Open Tree taxonomy writes when a row carries no
// rank at all: an empty string, `no rank`, or `no rank - terminal`. The whole
// vocabulary is 39 strings and these are the three that say nothing; the
// prefilter in loadPBDBRanks must agree with this, and `TestUnrankedAgreesWithSQL`
// holds it to that over every distinct rank in the corpus.
func rankedByTaxonomy(rank *string) bool {
	if rank == nil {
		return false
	}
	r := strings.ToLower(strings.TrimSpace(*rank))
	return r != "" && !strings.HasPrefix(r, "no rank")
}

// unrankedPBDB is the same idea in PBDB's vocabulary, which spells it
// differently: `unranked clade` for a real clade nobody has ranked, and
// `informal` for a name that is not a taxon claim at all. Neither is a rung and
// neither may be printed as one.
func rankedByPBDB(rank string) bool {
	r := strings.ToLower(strings.TrimSpace(rank))
	return r != "" && r != "unranked clade" && r != "informal" &&
		!strings.HasPrefix(r, "no rank")
}

// The SQL side of rankedByTaxonomy. It must select a **superset** of the rows
// that predicate rejects — Go decides, this only keeps the scan small — and the
// test named above proves the two pick out exactly the same strings.
const sqlUnranked = `(n.rank IS NULL OR TRIM(n.rank) = '' OR LOWER(TRIM(n.rank)) LIKE 'no rank%')`

// loadPBDBRanks fills the map read by Metas. A build with no fossil table, or
// one whose fossil table predates the rank column, simply gets no map: the rank
// row stays empty exactly as it did before, which is the same degradation every
// other optional table gets.
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
	// Two PBDB taxa of one name, ranked differently, is a disagreement about what
	// the name *is* and not a tie to break. Measured: it happens zero times in
	// the current corpus. If it ever does the node keeps its empty rank row,
	// because a coin flip between "genus" and "family" is worse than silence.
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
