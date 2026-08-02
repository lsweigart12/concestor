package store

import (
	"testing"
)

// The two random pools exist to keep one promise — *whatever comes back can be
// drawn* — so what these tests pin is the promise, not the shuffle. A pick that
// arrives nameless, undrawn, or without a date on the axis is the failure, and
// none of them would make the endpoint error.

const randomSample = 25

func TestRandomNodesAlwaysHaveANameAndTheirOwnDrawing(t *testing.T) {
	st := open(t)
	if st.Schema.NodeImage == nil || st.Schema.NodeImage.Climb == "" {
		t.Skip("this build has no node_image.climb to distinguish an own drawing from a borrow")
	}

	got, err := st.RandomNodes(t.Context(), randomSample)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != randomSample {
		t.Fatalf("asked for %d picks, got %d — the pool should be thousands deep",
			randomSample, len(got))
	}
	for _, r := range got {
		switch {
		case r.Idx == nil:
			t.Errorf("%+v: a pick with no idx cannot be added to the canvas", r)
		case r.Name == nil || *r.Name == "":
			t.Errorf("idx %d: picked a node with no name", *r.Idx)
		case r.PhylopicID == nil || *r.PhylopicID == "":
			t.Errorf("%s: picked a node with no drawing", *r.Name)
		case r.MatchedOn != matchedOnRandom:
			// Nothing matched. Reporting "name" here would caption the row with
			// a match the reader never made.
			t.Errorf("%s: matched_on = %q, want %q", *r.Name, r.MatchedOn, matchedOnRandom)
		}
	}
}

// The drawing has to be of the taxon or of something inside it. `node_image`
// resolves an image for all 2,725,682 nodes by climbing to a relative, so "has
// an image" is true of the whole corpus; `climb = 0` is what makes it a claim.
// A borrow from a clade larger than the node is the failure mode, and it shows
// up as a `silhouette_clade_tips` bigger than the node's own tip count.
func TestARandomNodesDrawingNeverSpeaksForMoreThanTheNode(t *testing.T) {
	st := open(t)
	if st.Schema.NodeImage == nil || st.Schema.NodeImage.Climb == "" {
		t.Skip("no node_image.climb in this build")
	}
	got, err := st.RandomNodes(t.Context(), randomSample)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range got {
		if r.SilhouetteCladeTips == nil || r.TipCount == nil {
			continue
		}
		if *r.SilhouetteCladeTips > *r.TipCount {
			t.Errorf("%s: drawing speaks for %d tips but the node has %d — that is a borrow",
				*r.Name, *r.SilhouetteCladeTips, *r.TipCount)
		}
	}
}

// Every refusal `makeGraft` can make, stated as a property of the pool. If one
// of these ever fails, the command draws a fossil the canvas will then decline
// to place, and the reader gets a refusal toast for something they did not
// choose.
func TestRandomFossilsAreAlwaysGraftable(t *testing.T) {
	st := open(t)
	f := st.Schema.Fossil
	if f == nil || f.ImageTable == "" || !f.Brackets {
		t.Skip("this build has no fossil table with brackets and images")
	}

	got, err := st.RandomFossils(t.Context(), randomSample)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != randomSample {
		t.Fatalf("asked for %d picks, got %d", randomSample, len(got))
	}
	for _, fo := range got {
		switch {
		case fo.TaxonNo <= 0:
			// `no-identity`: a graft is keyed on this and could not survive a URL.
			t.Errorf("%s: no pbdb_taxon_no", fo.Name)
		case fo.LLA == nil:
			// `no-range`: there is no x for it on a time axis.
			t.Errorf("%s: no last appearance, so nowhere in time to draw it", fo.Name)
		case fo.PhylopicID == nil || *fo.PhylopicID == "":
			t.Errorf("%s: no drawing", fo.Name)
		case !st.Arrays.Valid(fo.AttachIdx):
			t.Errorf("%s: attach_idx %d is not a node", fo.Name, fo.AttachIdx)
		}
	}
}

// PBDB flags *Thalassia testudinum* — the living turtle grass — extinct, with a
// range running to 0.0117 Ma. `is_extant` alone therefore admits living things
// wearing a fossil's clothes, and a "random fossil" that lands on one draws it
// at the right-hand edge of deep time. The pool refuses anything that has not
// demonstrably ended.
func TestRandomFossilsHaveEndedBeforeTheHolocene(t *testing.T) {
	st := open(t)
	f := st.Schema.Fossil
	if f == nil || f.ImageTable == "" || !f.Brackets {
		t.Skip("no fossil table with brackets and images")
	}
	got, err := st.RandomFossils(t.Context(), randomSample)
	if err != nil {
		t.Fatal(err)
	}
	for _, fo := range got {
		if fo.IsExtant != nil && *fo.IsExtant {
			t.Errorf("%s: picked a taxon PBDB calls extant", fo.Name)
		}
		if fo.LLA != nil && *fo.LLA <= 0.0117 {
			t.Errorf("%s: last appearance %v Ma is at or after the Holocene base",
				fo.Name, *fo.LLA)
		}
	}
}

// A limit of one is the ordinary case and must not be a special one, and the
// cap has to hold or a caller can ask for the whole pool in one response.
func TestRandomLimitsAreClamped(t *testing.T) {
	st := open(t)
	if st.Schema.NodeImage == nil || st.Schema.NodeImage.Climb == "" {
		t.Skip("no node_image.climb in this build")
	}
	for _, c := range []struct{ ask, want int }{
		{0, defaultRandomLimit},
		{-4, defaultRandomLimit},
		{1, 1},
		{1000, maxRandomLimit},
	} {
		got, err := st.RandomNodes(t.Context(), c.ask)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != c.want {
			t.Errorf("RandomNodes(limit=%d) returned %d, want %d", c.ask, len(got), c.want)
		}
	}
}

// It has to actually shuffle. Two draws of 20 from a 13,918-deep pool that come
// back identical mean the query lost its `random()` — which is exactly what a
// well-meaning "add an index and an ORDER BY" refactor would do, and it would
// pass every other test in this file.
func TestRandomPicksDiffer(t *testing.T) {
	st := open(t)
	if st.Schema.NodeImage == nil || st.Schema.NodeImage.Climb == "" {
		t.Skip("no node_image.climb in this build")
	}
	a, err := st.RandomNodes(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.RandomNodes(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	same := 0
	for i := range a {
		if i < len(b) && a[i].Key == b[i].Key {
			same++
		}
	}
	if same == len(a) {
		t.Fatalf("two draws of %d from a pool of thousands were identical", len(a))
	}
}
