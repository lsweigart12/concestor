package topo

import (
	"path/filepath"
	"slices"
	"testing"

	"github.com/lsweigart12/concestor/server/internal/testenv"
)

// referenceSelection is render.py's DEFAULT_SELECTION: two primates, a rodent,
// a bird, one of the 1,129 extinct taxa that survive into the synthesis tree,
// a fish, a mollusc, an insect, two plants and a fungus.
var referenceSelection = []struct {
	name string
	ott  int64
}{
	{"Homo sapiens", 770315},
	{"Pan troglodytes", 417950},
	{"Mus musculus", 542509},
	{"Gallus gallus", 153563},
	{"Tyrannosaurus rex", 664349},
	{"Danio rerio", 1005914},
	{"Octopus vulgaris", 110468},
	{"Drosophila melanogaster", 505714},
	{"Arabidopsis thaliana", 309263},
	{"Sequoiadendron giganteum", 810380},
	{"Amanita muscaria", 75257},
}

// The values below were produced by running the reference implementation,
// pipeline/src/concestor_build/render.py, against build/topology. The Go port
// must reproduce them exactly; this is the strongest end-to-end check
// available, because it pins one number (2|L|-1) and the whole shape of the
// result at once.
var (
	refSelectionIdx = []int{12950, 449434, 588587, 594485, 594505, 633749, 654142, 674350, 882186, 1176207, 2328159}
	refMRCA         = 1
	refRendered     = []int{
		1, 18, 12950, 449434, 588406, 588414, 588422, 588426, 588435, 588587,
		594475, 594485, 594505, 603110, 633749, 654142, 674350, 741328, 882186,
		1176207, 2328159,
	}
	// node -> {nearest rendered ancestor (-1 at the induced root), suppressed count}
	refSegments = map[int][2]int{
		1: {-1, 0}, 18: {1, 16}, 12950: {18, 46}, 449434: {18, 13},
		588406: {1, 1}, 588414: {588406, 7}, 588422: {588414, 7},
		588426: {588422, 3}, 588435: {588426, 8}, 588587: {588435, 28},
		594475: {588435, 16}, 594485: {594475, 9}, 594505: {594475, 1},
		603110: {588426, 1}, 633749: {603110, 24}, 654142: {603110, 14},
		674350: {588422, 27}, 741328: {588414, 0}, 882186: {741328, 25},
		1176207: {741328, 52}, 2328159: {588406, 30},
	}
)

func load(t *testing.T) *Arrays {
	t.Helper()
	build := testenv.RequireBuild(t)
	a, _, err := Load(filepath.Join(build, "topology"))
	if err != nil {
		t.Fatalf("loading topology: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return a
}

func TestLoadAssertsInvariants(t *testing.T) {
	a := load(t)
	// Load() refuses to return arrays that violate parent[i] < i, so reaching
	// here already proves the preorder invariant over all 2,725,682 nodes.
	if a.N != 2725682 {
		t.Errorf("N = %d, want 2725682", a.N)
	}
	if a.Tips != 2385875 {
		t.Errorf("tips = %d, want 2385875", a.Tips)
	}
	if a.Internal != 339807 {
		t.Errorf("internal = %d, want 339807", a.Internal)
	}
	if a.Parent[0] != NoParent {
		t.Errorf("root has a parent")
	}
}

func TestIdxForOtt(t *testing.T) {
	a := load(t)
	idx, ok := a.IdxForOtt(770315)
	if !ok {
		t.Fatal("Homo sapiens (ott770315) not found")
	}
	if a.OttID[idx] != 770315 {
		t.Fatalf("ott_id[%d] = %d, want 770315", idx, a.OttID[idx])
	}
	if _, ok := a.IdxForOtt(-1); ok {
		t.Error("the no-ott sentinel must not resolve")
	}
	if _, ok := a.IdxForOtt(999999999999); ok {
		t.Error("a nonexistent ott id must not resolve")
	}
}

func TestPathToRoot(t *testing.T) {
	a := load(t)
	idx, _ := a.IdxForOtt(770315)
	p := a.PathToRoot(idx)
	if len(p) == 0 {
		t.Fatal("empty path")
	}
	if p[0] != 0 {
		t.Errorf("path is not root-first: starts at %d", p[0])
	}
	if p[len(p)-1] != idx {
		t.Errorf("path does not end at the node: %d != %d", p[len(p)-1], idx)
	}
	if len(p) != 60 {
		t.Errorf("Homo sapiens path length = %d, want 60 (measured from render.py)", len(p))
	}
	for i := 1; i < len(p); i++ {
		if int(a.Parent[p[i]]) != p[i-1] {
			t.Fatalf("path is not a parent chain at %d", i)
		}
		if p[i] <= p[i-1] {
			t.Fatalf("path is not ascending in preorder at %d", i)
		}
	}
	// depth is the number of edges from the root.
	if int(a.Depth[idx]) != len(p)-1 {
		t.Errorf("depth = %d, path implies %d", a.Depth[idx], len(p)-1)
	}
}

func TestPathToRootInvalid(t *testing.T) {
	a := load(t)
	if p := a.PathToRoot(-1); p != nil {
		t.Error("negative idx should yield no path")
	}
	if p := a.PathToRoot(a.N); p != nil {
		t.Error("out-of-range idx should yield no path")
	}
	if p := a.PathToRoot(0); len(p) != 1 || p[0] != 0 {
		t.Errorf("root path = %v, want [0]", p)
	}
}

// TestInducedSubtreeMatchesReference is the port's correctness proof: it
// reproduces render.py's induced_subtree for DEFAULT_SELECTION and asserts the
// 2|L|-1 bound holds exactly.
func TestInducedSubtreeMatchesReference(t *testing.T) {
	a := load(t)

	var sel []int
	for _, s := range referenceSelection {
		idx, ok := a.IdxForOtt(s.ott)
		if !ok {
			t.Fatalf("%s (ott%d) is not in the tree", s.name, s.ott)
		}
		sel = append(sel, idx)
	}
	slices.Sort(sel) // preorder order == canonical vertical order (§3.1)
	if !slices.Equal(sel, refSelectionIdx) {
		t.Fatalf("selection resolved to %v, want %v", sel, refSelectionIdx)
	}

	ind := a.InducedSubtree(sel)

	if ind.MRCA != refMRCA {
		t.Errorf("MRCA = %d, want %d", ind.MRCA, refMRCA)
	}
	if got, want := len(ind.Rendered), 2*len(sel)-1; got != want {
		t.Errorf("rendered %d nodes, the 2|L|-1 bound is %d", got, want)
	}
	if !slices.Equal(ind.Rendered, refRendered) {
		t.Errorf("rendered set\n got %v\nwant %v", ind.Rendered, refRendered)
	}
	if len(ind.Segments) != len(refSegments) {
		t.Fatalf("%d segments, want %d", len(ind.Segments), len(refSegments))
	}
	for v, want := range refSegments {
		got, ok := ind.Segments[v]
		if !ok {
			t.Errorf("no segment for rendered node %d", v)
			continue
		}
		if got.Ancestor != want[0] {
			t.Errorf("segment %d: ancestor = %d, want %d", v, got.Ancestor, want[0])
		}
		if len(got.Suppressed) != want[1] {
			t.Errorf("segment %d: %d suppressed, want %d", v, len(got.Suppressed), want[1])
		}
		// The suppressed chain must be a contiguous parent walk from the
		// ancestor down to v: those are interaction 3's intermediates.
		chain := append(append([]int{}, got.Suppressed...), v)
		prev := got.Ancestor
		if prev == -1 {
			continue
		}
		for _, u := range chain {
			if int(a.Parent[u]) != prev {
				t.Fatalf("segment %d is not a parent chain at %d", v, u)
			}
			prev = u
		}
	}
}

func TestInducedSubtreeTwoLeavesGivesMRCA(t *testing.T) {
	a := load(t)
	human, _ := a.IdxForOtt(770315)
	chimp, _ := a.IdxForOtt(417950)

	ind := a.InducedSubtree([]int{human, chimp})
	if len(ind.Rendered) != 3 {
		t.Errorf("two leaves rendered %d nodes, want 3", len(ind.Rendered))
	}
	// The MRCA is the last common element of the two ancestor paths.
	ph, pc := a.PathToRoot(human), a.PathToRoot(chimp)
	last := -1
	for i := 0; i < len(ph) && i < len(pc); i++ {
		if ph[i] != pc[i] {
			break
		}
		last = ph[i]
	}
	if ind.MRCA != last {
		t.Errorf("MRCA = %d, last common path element = %d", ind.MRCA, last)
	}
	if !a.IsAncestor(ind.MRCA, human) || !a.IsAncestor(ind.MRCA, chimp) {
		t.Error("MRCA is not an ancestor of both leaves")
	}
}

func TestInducedSubtreeEdgeCases(t *testing.T) {
	a := load(t)
	if ind := a.InducedSubtree(nil); ind.MRCA != -1 || len(ind.Rendered) != 0 {
		t.Error("empty selection should produce an empty result")
	}
	human, _ := a.IdxForOtt(770315)
	ind := a.InducedSubtree([]int{human})
	if ind.MRCA != human || len(ind.Rendered) != 1 {
		t.Errorf("single selection: mrca=%d rendered=%v", ind.MRCA, ind.Rendered)
	}
	// Duplicates must not change the answer or break the bound.
	dup := a.InducedSubtree([]int{human, human})
	if len(dup.Rendered) != 1 {
		t.Errorf("duplicate selection rendered %d nodes, want 1", len(dup.Rendered))
	}
	if bad := a.InducedSubtree([]int{-5, a.N + 1}); len(bad.Rendered) != 0 {
		t.Error("out-of-range selection should produce an empty result")
	}
}

func TestIsAncestor(t *testing.T) {
	a := load(t)
	human, _ := a.IdxForOtt(770315)
	p := a.PathToRoot(human)
	for _, anc := range p {
		if !a.IsAncestor(anc, human) {
			t.Fatalf("%d should be an ancestor of %d", anc, human)
		}
	}
	if a.IsAncestor(human, p[0]) && human != p[0] {
		t.Error("a leaf is not an ancestor of the root")
	}
	if !a.IsAncestor(human, human) {
		t.Error("IsAncestor should be reflexive (ancestor-or-self)")
	}
}

func TestTierName(t *testing.T) {
	for tier, want := range map[uint8]string{0: "measured", 1: "interpolated", 2: "structural", 3: "occurrence", 9: "unknown"} {
		if got := TierName(tier); got != want {
			t.Errorf("TierName(%d) = %q, want %q", tier, got, want)
		}
	}
}

func BenchmarkPathToRoot(b *testing.B) {
	build := testenv.BuildDir(b)
	if build == "" {
		b.Skip("no build")
	}
	a, _, err := Load(filepath.Join(build, "topology"))
	if err != nil {
		b.Fatal(err)
	}
	defer a.Close() //nolint:errcheck
	idx, _ := a.IdxForOtt(770315)
	b.ResetTimer()
	for b.Loop() {
		_ = a.PathToRoot(idx)
	}
}

func BenchmarkInducedSubtree(b *testing.B) {
	build := testenv.BuildDir(b)
	if build == "" {
		b.Skip("no build")
	}
	a, _, err := Load(filepath.Join(build, "topology"))
	if err != nil {
		b.Fatal(err)
	}
	defer a.Close() //nolint:errcheck
	b.ResetTimer()
	for b.Loop() {
		_ = a.InducedSubtree(refSelectionIdx)
	}
}
