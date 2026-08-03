package store

import (
	"strings"
	"testing"
)

// The prefilter in loadPBDBRanks and rankedByTaxonomy have to pick out exactly
// the same strings, and only one of them can be read by the compiler. So the
// test enumerates every distinct rank in the corpus — 39 of them — and asks the
// database and Go the same question about each. A predicate is a pure function
// of the string, so covering the distinct values covers all 2.7M rows.
func TestUnrankedPredicateAgreesWithSQL(t *testing.T) {
	st := open(t)
	rows, err := st.DB.QueryContext(t.Context(),
		`SELECT DISTINCT n.rank, `+sqlUnranked+` FROM node n`)
	if err != nil {
		t.Fatalf("distinct ranks: %v", err)
	}
	defer rows.Close() //nolint:errcheck

	seen := 0
	for rows.Next() {
		var rank *string
		var sqlSaysUnranked bool
		if err := rows.Scan(&rank, &sqlSaysUnranked); err != nil {
			t.Fatal(err)
		}
		seen++
		if goSaysRanked := rankedByTaxonomy(rank); goSaysRanked == sqlSaysUnranked {
			shown := "NULL"
			if rank != nil {
				shown = *rank
			}
			t.Errorf("rank %q: SQL unranked=%v, Go ranked=%v — the prefilter and "+
				"the predicate disagree, so loadPBDBRanks is either missing rows "+
				"or filling ones it must not",
				shown, sqlSaysUnranked, goSaysRanked)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if seen < 20 {
		t.Fatalf("only %d distinct ranks; the corpus has 39 and this test proves nothing", seen)
	}
}

func TestRankedPredicates(t *testing.T) {
	ranked := func(s string) *string { return &s }
	for _, c := range []struct {
		rank *string
		want bool
	}{
		{nil, false},
		{ranked(""), false},
		{ranked("  "), false},
		{ranked("no rank"), false},
		{ranked("no rank - terminal"), false},
		{ranked("species"), true},
		{ranked("genus"), true},
	} {
		if got := rankedByTaxonomy(c.rank); got != c.want {
			t.Errorf("rankedByTaxonomy(%v) = %v, want %v", c.rank, got, c.want)
		}
	}
	// PBDB spells the same idea two other ways, and both would print as a rank.
	for r, want := range map[string]bool{
		"species": true, "genus": true, "unranked clade": false,
		"informal": false, "": false,
	} {
		if got := rankedByPBDB(r); got != want {
			t.Errorf("rankedByPBDB(%q) = %v, want %v", r, got, want)
		}
	}
}

// The case that started this: the Open Tree taxonomy files the most famous
// fossil in the product as `no rank`, so its label carried no rank row and its
// name rendered roman while every neighbouring species was italic.
func TestTyrannosaurusRexGetsARank(t *testing.T) {
	st := open(t)
	if st.Schema.Fossil == nil || st.Schema.Fossil.Rank == "" {
		t.Skip("no fossil table with a rank column in this build")
	}
	var idx int
	var rank *string
	err := st.DB.QueryRowContext(t.Context(),
		`SELECT idx, rank FROM node WHERE name = 'Tyrannosaurus rex'`).Scan(&idx, &rank)
	if err != nil {
		t.Fatalf("no Tyrannosaurus rex node: %v", err)
	}
	if rankedByTaxonomy(rank) {
		t.Skip("the taxonomy now ranks it itself; nothing left to fill")
	}

	metas, err := st.Metas(t.Context(), []int{idx})
	if err != nil {
		t.Fatal(err)
	}
	got := metas[idx].Rank
	if got == nil || !strings.EqualFold(*got, "species") {
		t.Fatalf("Metas rank = %v, want species (PBDB taxon 54833 ranks it one)", got)
	}
}

// Whatever else changes, the taxonomy wins where it has an answer. Filling a
// gap is the whole feature; overwriting is a different and much worse one.
func TestPBDBNeverOverridesTheTaxonomy(t *testing.T) {
	st := open(t)
	if len(st.pbdbRank) == 0 {
		t.Skip("no PBDB ranks loaded")
	}
	idxs := make([]int, 0, len(st.pbdbRank))
	for idx := range st.pbdbRank {
		idxs = append(idxs, idx)
		if len(idxs) == 400 {
			break
		}
	}
	rows, err := st.DB.QueryContext(t.Context(),
		`SELECT idx, rank FROM node WHERE idx IN (`+placeholders(len(idxs))+`)`,
		anySlice(idxs)...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var idx int
		var rank *string
		if err := rows.Scan(&idx, &rank); err != nil {
			t.Fatal(err)
		}
		if rankedByTaxonomy(rank) {
			t.Errorf("node %d is ranked %q by the taxonomy and still has a PBDB "+
				"rank loaded for it", idx, *rank)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}

func anySlice(v []int) []any {
	out := make([]any, len(v))
	for i, x := range v {
		out[i] = x
	}
	return out
}
