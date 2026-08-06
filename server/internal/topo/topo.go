// Package topo holds the memory-mapped topology arrays and the one primitive
// everything else is built from: path(node) -> [root, ..., node]. Every
// interaction is a set operation over ancestor paths, so a path lookup is a walk
// up a mmap'd u32 array with one allocation for the result slice.
package topo

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"

	"github.com/lsweigart12/concestor/server/internal/npy"
)

const (
	// NoParent is the sentinel numpy wrote at the root (uint32 max).
	NoParent = uint32(math.MaxUint32)
	// NoOtt marks a node whose synthesized label carries no OTT id, i.e. an
	// `mrcaott…` divergence point. This is why idx, not ott_id, is the key.
	NoOtt = int64(-1)
)

// Tier values as baked into age_tier.npy.
const (
	TierMeasured     = uint8(0)
	TierInterpolated = uint8(1)
	TierStructural   = uint8(2)
	// TierOccurrence is written by phase 4, not a fourth grade of divergence
	// estimate: it answers when the taxon is observed in the rock, never carries
	// an age_ma, and keeps its range in the occurrence table.
	TierOccurrence = uint8(3)
)

// TierName maps a tier byte to the string the API emits.
func TierName(t uint8) string {
	switch t {
	case TierMeasured:
		return "measured"
	case TierInterpolated:
		return "interpolated"
	case TierStructural:
		return "structural"
	case TierOccurrence:
		return "occurrence"
	default:
		return "unknown"
	}
}

// Arrays is the mmap'd hot path. Optional arrays are nil when the pipeline has
// not emitted them yet; every consumer must feature-detect rather than assume.
type Arrays struct {
	N          int
	Parent     []uint32
	Depth      []uint8
	SubtreeOut []uint32
	TipCount   []uint32
	OttID      []int64
	ChildCount []uint32

	// ott_id -> idx, as a sorted key array plus a matching value array.
	OttSorted []int64
	OttToIdx  []uint32

	// Optional, phase 2 output.
	AgeMa     []float32 // NaN where no number may be shown
	AgeLayout []float32 // always finite where present: the x position
	AgeTier   []uint8

	// Derived at load.
	Tips     int
	Internal int

	closers []func() error
}

type arraySpec struct {
	file     string
	required bool
	bind     func(a *Arrays, arr *npy.Array) error
}

func bindU32(dst *[]uint32) func(*Arrays, *npy.Array) error {
	return func(_ *Arrays, arr *npy.Array) error {
		v, err := arr.U32()
		*dst = v
		return err
	}
}

// Load memory-maps every array in dir. Missing optional arrays are reported in
// `missing` rather than failing the load, so the binary starts and serves
// correctly against a partially-built dataset.
func Load(dir string) (arrays *Arrays, missing []string, err error) {
	a := &Arrays{}
	defer func() {
		if err != nil {
			_ = a.Close()
		}
	}()

	specs := []arraySpec{
		{"parent.npy", true, bindU32(&a.Parent)},
		{"depth.npy", true, func(a *Arrays, arr *npy.Array) (e error) { a.Depth, e = arr.U8(); return }},
		{"subtree_out.npy", true, bindU32(&a.SubtreeOut)},
		{"tip_count.npy", true, bindU32(&a.TipCount)},
		{"ott_id.npy", true, func(a *Arrays, arr *npy.Array) (e error) { a.OttID, e = arr.I64(); return }},
		{"child_count.npy", true, bindU32(&a.ChildCount)},
		{"ott_sorted.npy", true, func(a *Arrays, arr *npy.Array) (e error) { a.OttSorted, e = arr.I64(); return }},
		{"ott_to_idx.npy", true, bindU32(&a.OttToIdx)},
		{"age_ma.npy", false, func(a *Arrays, arr *npy.Array) (e error) { a.AgeMa, e = arr.F32(); return }},
		{"age_layout.npy", false, func(a *Arrays, arr *npy.Array) (e error) { a.AgeLayout, e = arr.F32(); return }},
		{"age_tier.npy", false, func(a *Arrays, arr *npy.Array) (e error) { a.AgeTier, e = arr.U8(); return }},
	}

	for _, s := range specs {
		p := filepath.Join(dir, s.file)
		if _, statErr := os.Stat(p); statErr != nil {
			if s.required {
				return nil, nil, fmt.Errorf("topology: %s is required: %w", s.file, statErr)
			}
			missing = append(missing, s.file)
			continue
		}
		arr, openErr := npy.Open(p)
		if openErr != nil {
			return nil, nil, openErr
		}
		a.closers = append(a.closers, arr.Close)
		if err = s.bind(a, arr); err != nil {
			return nil, nil, err
		}
	}

	a.N = len(a.Parent)
	if err = a.validate(); err != nil {
		return nil, nil, err
	}
	for _, c := range a.ChildCount {
		if c == 0 {
			a.Tips++
		}
	}
	a.Internal = a.N - a.Tips
	return a, missing, nil
}

// Close unmaps every array.
func (a *Arrays) Close() error {
	var first error
	for _, c := range a.closers {
		if e := c(); e != nil && first == nil {
			first = e
		}
	}
	a.closers = nil
	return first
}

// validate refuses to serve against arrays that violate the invariants the
// rest of the system assumes. Preorder numbering guaranteeing parent[i] < i is
// what makes the ancestor walk terminate and what makes subtree containment an
// interval test; if it does not hold, nothing downstream is trustworthy.
func (a *Arrays) validate() error {
	if a.N == 0 {
		return fmt.Errorf("topology: parent.npy is empty")
	}
	lens := map[string]int{
		"depth": len(a.Depth), "subtree_out": len(a.SubtreeOut),
		"tip_count": len(a.TipCount), "ott_id": len(a.OttID),
		"child_count": len(a.ChildCount),
	}
	if a.AgeMa != nil {
		lens["age_ma"] = len(a.AgeMa)
	}
	if a.AgeLayout != nil {
		lens["age_layout"] = len(a.AgeLayout)
	}
	if a.AgeTier != nil {
		lens["age_tier"] = len(a.AgeTier)
	}
	for name, n := range lens {
		if n != a.N {
			return fmt.Errorf("topology: %s has %d entries, parent has %d", name, n, a.N)
		}
	}
	if len(a.OttSorted) != len(a.OttToIdx) {
		return fmt.Errorf("topology: ott_sorted has %d entries, ott_to_idx has %d",
			len(a.OttSorted), len(a.OttToIdx))
	}

	if a.Parent[0] != NoParent {
		return fmt.Errorf("topology: parent[0] = %d, want the no-parent sentinel", a.Parent[0])
	}
	for i := 1; i < a.N; i++ {
		if a.Parent[i] >= uint32(i) {
			return fmt.Errorf("topology: preorder invariant violated at idx %d: parent = %d", i, a.Parent[i])
		}
	}
	for i := range a.N {
		if int(a.SubtreeOut[i]) <= i {
			return fmt.Errorf("topology: subtree_out[%d] = %d is not a valid interval", i, a.SubtreeOut[i])
		}
	}
	for i := 1; i < len(a.OttSorted); i++ {
		if a.OttSorted[i] < a.OttSorted[i-1] {
			return fmt.Errorf("topology: ott_sorted is not ascending at %d", i)
		}
	}
	for i, v := range a.OttToIdx {
		if int(v) >= a.N {
			return fmt.Errorf("topology: ott_to_idx[%d] = %d is out of range", i, v)
		}
	}
	return nil
}

// IdxForOtt resolves an OTT id to a node index by binary search.
func (a *Arrays) IdxForOtt(ott int64) (int, bool) {
	i := sort.Search(len(a.OttSorted), func(k int) bool { return a.OttSorted[k] >= ott })
	if i < len(a.OttSorted) && a.OttSorted[i] == ott {
		return int(a.OttToIdx[i]), true
	}
	return 0, false
}

// Valid reports whether idx names a node.
func (a *Arrays) Valid(idx int) bool { return idx >= 0 && idx < a.N }

// PathToRoot is the load-bearing primitive: the root-first ancestor chain.
// It is a direct port of render.py's path_to_root.
func (a *Arrays) PathToRoot(idx int) []int {
	if !a.Valid(idx) {
		return nil
	}
	out := make([]int, 0, int(a.Depth[idx])+2)
	cur := idx
	for {
		out = append(out, cur)
		p := a.Parent[cur]
		if p == NoParent {
			break
		}
		cur = int(p)
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// IsAncestor reports whether u is an ancestor-or-self of v, using the preorder
// interval test rather than a walk (architecture §3.1).
func (a *Arrays) IsAncestor(u, v int) bool {
	if !a.Valid(u) || !a.Valid(v) {
		return false
	}
	return u <= v && v < int(a.SubtreeOut[u])
}

// Segment records a rendered node's nearest rendered ancestor and the degree-2
// nodes suppressed between them. Those intermediates are interaction 3's
// content (architecture §2).
type Segment struct {
	Ancestor   int // -1 at the induced root
	Suppressed []int
}

// Induced is the result of the suppression rule.
type Induced struct {
	MRCA     int
	Rendered []int // ascending, i.e. preorder
	Segments map[int]Segment
	Paths    map[int][]int // per selected leaf, trimmed to start at the MRCA
}

// InducedSubtree computes the marked set, the rendered set and the segments,
// per architecture §2. It is a direct port of render.py's induced_subtree and
// must stay in exact agreement with it; TestInducedSubtreeMatchesReference
// pins that against the reference selection.
func (a *Arrays) InducedSubtree(selection []int) *Induced {
	if len(selection) == 0 {
		return &Induced{MRCA: -1, Segments: map[int]Segment{}, Paths: map[int][]int{}}
	}

	order := make([]int, 0, len(selection))
	paths := make(map[int][]int, len(selection))
	for _, leaf := range selection {
		if !a.Valid(leaf) {
			continue
		}
		if _, seen := paths[leaf]; seen {
			continue
		}
		paths[leaf] = a.PathToRoot(leaf)
		order = append(order, leaf)
	}
	if len(order) == 0 {
		return &Induced{MRCA: -1, Segments: map[int]Segment{}, Paths: map[int][]int{}}
	}

	// The MRCA is the last common element of the paths — interaction 1 falls
	// out of the same primitive, with no separate endpoint.
	first := paths[order[0]]
	mrcaDepth := len(first)
	for _, p := range paths {
		if len(p) < mrcaDepth {
			mrcaDepth = len(p)
		}
	}
	for mrcaDepth > 0 {
		cand := first[mrcaDepth-1]
		agree := true
		for _, p := range paths {
			if len(p) < mrcaDepth || p[mrcaDepth-1] != cand {
				agree = false
				break
			}
		}
		if agree {
			break
		}
		mrcaDepth--
	}
	mrca := first[mrcaDepth-1]

	// Everything above the MRCA is outside the induced subtree; including it
	// would break the 2|L|-1 bound with a chain of unary ancestors.
	for leaf, p := range paths {
		paths[leaf] = p[mrcaDepth-1:]
	}

	marked := make(map[int]struct{})
	childrenInMarked := make(map[int]map[int]struct{})
	for _, leaf := range order {
		p := paths[leaf]
		for i, v := range p {
			marked[v] = struct{}{}
			if i > 0 {
				up := p[i-1]
				if childrenInMarked[up] == nil {
					childrenInMarked[up] = make(map[int]struct{}, 2)
				}
				childrenInMarked[up][v] = struct{}{}
			}
		}
	}

	chosen := make(map[int]struct{}, len(order))
	for _, leaf := range order {
		chosen[leaf] = struct{}{}
	}

	rendered := make(map[int]struct{})
	for v := range marked {
		if _, ok := chosen[v]; ok {
			rendered[v] = struct{}{}
			continue
		}
		if len(childrenInMarked[v]) >= 2 {
			rendered[v] = struct{}{}
		}
	}
	rendered[mrca] = struct{}{}

	// position[v] is v's offset within any path containing it; a node's
	// ancestor chain is unique, so which path we read it from does not matter.
	position := make(map[int][]int, len(rendered))
	for _, leaf := range order {
		p := paths[leaf]
		for i, v := range p {
			if _, ok := rendered[v]; !ok {
				continue
			}
			if _, seen := position[v]; !seen {
				position[v] = p[:i]
			}
		}
	}

	segments := make(map[int]Segment, len(rendered))
	for v := range rendered {
		chain := position[v]
		anc := -1
		var suppressed []int
		for i := len(chain) - 1; i >= 0; i-- {
			u := chain[i]
			if _, ok := rendered[u]; ok {
				anc = u
				break
			}
			suppressed = append(suppressed, u)
		}
		for i, j := 0, len(suppressed)-1; i < j; i, j = i+1, j-1 {
			suppressed[i], suppressed[j] = suppressed[j], suppressed[i]
		}
		if suppressed == nil {
			suppressed = []int{}
		}
		segments[v] = Segment{Ancestor: anc, Suppressed: suppressed}
	}

	out := make([]int, 0, len(rendered))
	for v := range rendered {
		out = append(out, v)
	}
	sort.Ints(out)

	return &Induced{MRCA: mrca, Rendered: out, Segments: segments, Paths: paths}
}
