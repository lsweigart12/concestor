package store

import (
	"slices"
	"testing"
)

// The two pools exist to keep one promise — *whatever the client draws can be
// drawn* — so what these tests pin is the promise, not the draw. A pick that
// arrives nameless, undrawn, or without a date on the axis is the failure, and
// none of them would make the endpoint error.
//
// **The contract inverted when the draw moved to the client**, and these tests
// inverted with it. There used to be one here called `TestRandomPicksDiffer`,
// guarding the `ORDER BY random()` that a well-meaning "add an index" refactor
// would have removed. The pool must now do the exact opposite: it is served
// under an ETag and a year-long `Cache-Control`, so two reads of the same build
// have to be byte-identical, and `TestThePoolIsDeterministic` is that test
// wearing the other sign. If both had been left in place they would contradict
// each other, which is worth noticing — the shuffle did not move, it was
// deleted, and the thing it used to protect is now a thing to forbid.

// How many pool entries the property tests resolve in full. The pools are
// thousands deep and each check is a row lookup, so this samples rather than
// sweeps; the sample is taken from both ends and the middle, because a filter
// that composes wrongly usually fails at one end of the keyspace.
const randomSample = 25

// sampleOf takes up to n entries spread across a pool rather than the first n.
// The first n of an ascending list is the lowest-numbered corner of the corpus,
// which is exactly where the oldest and least representative rows live.
func sampleOf[T any](pool []T, n int) []T {
	if len(pool) <= n {
		return pool
	}
	out := make([]T, 0, n)
	step := len(pool) / n
	for i := 0; i < len(pool) && len(out) < n; i += step {
		out = append(out, pool[i])
	}
	return out
}

func TestPooledNodesAlwaysHaveANameAndTheirOwnDrawing(t *testing.T) {
	st := open(t)
	if st.Schema.NodeImage == nil || st.Schema.NodeImage.Climb == "" {
		t.Skip("this build has no node_image.climb to distinguish an own drawing from a borrow")
	}

	pool, err := st.RandomPool(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(pool.Nodes) < 1000 {
		t.Fatalf("the node pool is %d deep; it should be thousands — measured at "+
			"13,918 on the build this was written against", len(pool.Nodes))
	}

	idxs := make([]int, 0, randomSample)
	for _, idx := range sampleOf(pool.Nodes, randomSample) {
		idxs = append(idxs, int(idx))
	}
	ptrs, err := st.resultsForIdxs(t.Context(), idxs, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(ptrs) != len(idxs) {
		t.Fatalf("resolved %d of %d pooled indices — a pool entry that is not a "+
			"node cannot be added to the canvas", len(ptrs), len(idxs))
	}
	results := make([]SearchResult, 0, len(ptrs))
	for _, r := range ptrs {
		results = append(results, *r)
	}
	if err := st.decorate(t.Context(), results, ""); err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
		switch {
		case r.Idx == nil:
			t.Errorf("%+v: a pick with no idx cannot be added to the canvas", r)
		case r.Name == nil || *r.Name == "":
			t.Errorf("idx %d: pooled a node with no name", *r.Idx)
		case r.PhylopicID == nil || *r.PhylopicID == "":
			t.Errorf("%s: pooled a node with no drawing", *r.Name)
		}
	}
}

// The drawing has to be of the taxon or of something inside it. `node_image`
// resolves an image for all 2,725,682 nodes by climbing to a relative, so "has
// an image" is true of the whole corpus; `climb = 0` is what makes it a claim.
// A borrow from a clade larger than the node is the failure mode, and it shows
// up as a `silhouette_clade_tips` bigger than the node's own tip count.
func TestAPooledNodesDrawingNeverSpeaksForMoreThanTheNode(t *testing.T) {
	st := open(t)
	if st.Schema.NodeImage == nil || st.Schema.NodeImage.Climb == "" {
		t.Skip("no node_image.climb in this build")
	}
	pool, err := st.RandomPool(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	idxs := make([]int, 0, randomSample)
	for _, idx := range sampleOf(pool.Nodes, randomSample) {
		idxs = append(idxs, int(idx))
	}
	ptrs, err := st.resultsForIdxs(t.Context(), idxs, "")
	if err != nil {
		t.Fatal(err)
	}
	results := make([]SearchResult, 0, len(ptrs))
	for _, r := range ptrs {
		results = append(results, *r)
	}
	if err := st.decorate(t.Context(), results, ""); err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
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
func TestPooledFossilsAreAlwaysGraftable(t *testing.T) {
	st := open(t)
	f := st.Schema.Fossil
	if f == nil || f.ImageTable == "" || !f.Brackets {
		t.Skip("this build has no fossil table with brackets and images")
	}

	pool, err := st.RandomPool(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(pool.Fossils) == 0 {
		t.Fatal("the pool is ~1,935 taxa deep; an empty one means the filters " +
			"stopped composing")
	}
	for _, no := range sampleOf(pool.Fossils, randomSample) {
		fo, err := st.FossilByTaxonNo(t.Context(), no)
		if err != nil {
			t.Fatal(err)
		}
		if fo == nil {
			t.Errorf("taxon %d is in the pool and not in the table", no)
			continue
		}
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
func TestPooledFossilsHaveEndedBeforeTheHolocene(t *testing.T) {
	st := open(t)
	f := st.Schema.Fossil
	if f == nil || f.ImageTable == "" || !f.Brackets {
		t.Skip("no fossil table with brackets and images")
	}
	pool, err := st.RandomPool(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, no := range sampleOf(pool.Fossils, randomSample) {
		fo, err := st.FossilByTaxonNo(t.Context(), no)
		if err != nil {
			t.Fatal(err)
		}
		if fo == nil {
			continue
		}
		if fo.IsExtant != nil && *fo.IsExtant {
			t.Errorf("%s: pooled a taxon PBDB calls extant", fo.Name)
		}
		if fo.LLA != nil && *fo.LLA <= 0.0117 {
			t.Errorf("%s: last appearance %v Ma is at or after the Holocene base",
				fo.Name, *fo.LLA)
		}
	}
}

// The response carries an ETag and a year of `Cache-Control`, and both are
// claims about these bytes. SQLite's scan order is not a promise, so the query
// says `ORDER BY` and this says why: without it the same build could serve two
// different orderings, the second of which is a cache entry contradicting a
// validator that still matches.
func TestThePoolIsDeterministic(t *testing.T) {
	st := open(t)
	if st.Schema.NodeImage == nil || st.Schema.NodeImage.Climb == "" {
		t.Skip("no node_image.climb in this build")
	}
	// Around the cache, not through it — the second call would otherwise be
	// testing that a pointer equals itself.
	a, err := st.randomNodePool(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.randomNodePool(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(a, b) {
		t.Fatal("two reads of the same build returned different pools; the ETag on " +
			"this response is a lie the moment that is true")
	}
	if !slices.IsSorted(a) {
		t.Error("the pool is not ascending, so the bytes depend on scan order")
	}

	fa, err := st.randomFossilPool(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	fb, err := st.randomFossilPool(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(fa, fb) {
		t.Fatal("two reads returned different fossil pools")
	}
	if !slices.IsSorted(fa) {
		t.Error("the fossil pool is not ascending")
	}
}

// The pool is built once and reused. Not a performance note: the queries are
// two full scans measured at 1.2 s through the deployed container, which is
// what made the old per-press endpoint the most expensive thing in the app.
func TestThePoolIsBuiltOnce(t *testing.T) {
	st := open(t)
	a, err := st.RandomPool(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.RandomPool(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Error("a second call rebuilt the pool; the scan is meant to run once per process")
	}
}
