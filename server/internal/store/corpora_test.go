package store

import (
	"strings"
	"testing"
)

// What separates the two corpora, and what it costs to get it wrong.
//
// A reader types a name. Two catalogues can answer: the synthesis tree, whose
// nodes join a tree and induce ancestors, and PBDB, whose taxa are pinned to a
// branch at the date the rock gives them. The catalogues **overlap** — 32,386
// accepted PBDB taxa are themselves nodes — and for those the same animal was
// arriving twice with two different futures and nothing saying why.
//
// These tests hold the line that resolves it: a fossil row is a taxon the tree
// does not contain, and both lists are ranked into one order by one function.

// A taxon the tree contains is never offered as a fossil, however famous. This
// is the test that makes "fossil" mean something a reader can hold.
func TestSearchNeverOffersATaxonTheTreeAlreadyHas(t *testing.T) {
	st := open(t)
	if st.Schema.Fossil == nil {
		t.Skip("no fossil table in this build")
	}
	if st.Schema.Fossil.AttachWalk == "" {
		t.Skip("this build's fossil table predates attach_walk")
	}
	// Every one of these is both a PBDB taxon and a node, and the first two are
	// the most-searched fossils in the product.
	for _, q := range []string{"Tyrannosaurus rex", "Tyrannosaurus", "Stegosaurus", "Velociraptor"} {
		fos, err := st.SearchFossils(t.Context(), q, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range fos {
			if strings.EqualFold(f.Name, q) {
				t.Errorf("%q came back as a fossil row, but it is a node — "+
					"the reader is being offered the same animal twice", f.Name)
			}
			if f.AttachWalk != nil && *f.AttachWalk == 0 {
				t.Errorf("%q: attach_walk 0 means this taxon *is* a node", f.Name)
			}
		}
	}
}

// The same refusal on the random pool, for the same reason: a "surprise me"
// that lands on T. rex has found something the tree holds, and drawing it as a
// graft hands the reader the poorer of the two things it could have.
func TestRandomFossilsAreNeverTaxaTheTreeAlreadyHas(t *testing.T) {
	st := open(t)
	f := st.Schema.Fossil
	if f == nil || f.ImageTable == "" || !f.Brackets {
		t.Skip("no fossil table with images and brackets in this build")
	}
	if f.AttachWalk == "" {
		t.Skip("this build's fossil table predates attach_walk")
	}
	got, err := st.RandomFossils(t.Context(), randomSample)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 {
		t.Fatal("the pool is ~1,946 taxa deep; an empty draw means the filters " +
			"stopped composing")
	}
	for _, fo := range got {
		if fo.AttachWalk == nil {
			t.Errorf("%s: no attach_walk, so nothing proved it is not a node", fo.Name)
		} else if *fo.AttachWalk == 0 {
			t.Errorf("%s: picked a taxon that is itself a node", fo.Name)
		}
	}
}

// Searching a name only PBDB has still answers. The exclusion above removes the
// duplicates and must not remove the corpus — *Triceratops* is nine parent_no
// hops from the nearest node and is the reason the fossil layer exists.
func TestFossilOnlyTaxaAreStillFound(t *testing.T) {
	st := open(t)
	if st.Schema.Fossil == nil {
		t.Skip("no fossil table in this build")
	}
	for _, q := range []string{"Triceratops", "Dimetrodon", "Anomalocaris"} {
		fos, err := st.SearchFossils(t.Context(), q, 0)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, f := range fos {
			if strings.EqualFold(f.Name, q) {
				found = true
			}
		}
		if !found {
			t.Errorf("%q is in PBDB and not in the tree, so it has to be findable "+
				"as a fossil; got %d rows and none of them it", q, len(fos))
		}
	}
}

// The band decides the merge, so a fossil whose name *is* the query has to lead
// the whole page — over every node that merely contains the word.
func TestAFossilCanLeadTheMergedOrder(t *testing.T) {
	st := open(t)
	if st.Schema.Fossil == nil {
		t.Skip("no fossil table in this build")
	}
	const q = "Triceratops"
	nodes, err := st.Search(t.Context(), q, 20)
	if err != nil {
		t.Fatal(err)
	}
	fos, err := st.SearchFossils(t.Context(), q, 20)
	if err != nil {
		t.Fatal(err)
	}
	Interleave(nodes, fos, q)

	lead := ""
	best := -1
	for _, r := range nodes {
		if r.Order != nil && (best < 0 || *r.Order < best) {
			best, lead = *r.Order, deref(r.Name)
		}
	}
	for _, f := range fos {
		if f.Order != nil && (best < 0 || *f.Order < best) {
			best, lead = *f.Order, f.Name
		}
	}
	if !strings.EqualFold(lead, q) {
		t.Errorf("%q led the merged order with %q; the fossil is the exact name "+
			"and nothing in the tree is", q, lead)
	}
}

// Every pickable row gets a position, no two rows share one, and the positions
// are the contiguous run 0..n-1. The client walks them; a gap or a collision is
// a row drawn twice or not at all.
func TestInterleaveStampsOneContiguousOrder(t *testing.T) {
	st := open(t)
	if st.Schema.Fossil == nil {
		t.Skip("no fossil table in this build")
	}
	for _, q := range []string{"dog", "Homo", "oak", "Triceratops", "shark"} {
		nodes, err := st.Search(t.Context(), q, 20)
		if err != nil {
			t.Fatal(err)
		}
		fos, err := st.SearchFossils(t.Context(), q, 20)
		if err != nil {
			t.Fatal(err)
		}
		Interleave(nodes, fos, q)

		seen := map[int]bool{}
		want := 0
		for _, r := range nodes {
			if r.Kind == "broken" {
				// Not a row. A note cannot be picked and has no place in a list
				// of pickable things.
				if r.Order != nil {
					t.Errorf("%q: a broken taxon was stamped with order %d", q, *r.Order)
				}
				continue
			}
			if r.Order == nil {
				t.Fatalf("%q: node %q got no order", q, deref(r.Name))
			}
			seen[*r.Order] = true
			want++
		}
		for _, f := range fos {
			if f.Order == nil {
				t.Fatalf("%q: fossil %q got no order", q, f.Name)
			}
			seen[*f.Order] = true
			want++
		}
		if len(seen) != want {
			t.Errorf("%q: %d rows share %d distinct positions", q, want, len(seen))
		}
		for i := range want {
			if !seen[i] {
				t.Errorf("%q: position %d is empty in a run of %d", q, i, want)
			}
		}
	}
}

// A node beats a fossil only as the *last* tiebreak. Where the two are equally
// good matches at equal standing in their own list, the thing that can join the
// tree wins — and nowhere else, or this is the pinned tail again wearing a
// different name.
func TestANodeOnlyBeatsAFossilOnAnOtherwiseExactTie(t *testing.T) {
	name := "Sample"
	band := 0
	nodes := []SearchResult{{Kind: "node", Name: &name, band: band}}
	fossils := []Fossil{{Name: name}}
	Interleave(nodes, fossils, name)
	if *nodes[0].Order != 0 || *fossils[0].Order != 1 {
		t.Errorf("on a dead tie the node should lead; got node %d, fossil %d",
			*nodes[0].Order, *fossils[0].Order)
	}

	// Now give the node a worse band. The fossil has to lead — the tiebreak is
	// a tiebreak, not a corpus preference.
	other := "Sampled thing"
	nodes = []SearchResult{{Kind: "node", Name: &other, band: bandPrefix}}
	fossils = []Fossil{{Name: name}}
	Interleave(nodes, fossils, name)
	if *fossils[0].Order != 0 {
		t.Errorf("the fossil matched the query exactly and the node did not, "+
			"but the fossil landed at %d", *fossils[0].Order)
	}
}
