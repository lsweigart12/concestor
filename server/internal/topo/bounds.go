package topo

import "math"

// LayoutBound identifies one of the two dated nodes an undated node's x is
// spread between, or records that there is nothing on that side.
type LayoutBound struct {
	// Idx of the dated node, or -1 when the side has no dated node at all.
	Idx int
	// AgeMa of that node. Meaningless when Idx is -1.
	AgeMa float64
}

// LayoutSpread is what `layout_ages` used to place one undated node, recovered
// from the arrays rather than stored.
//
// **Why this is recomputed and not baked.** The pipeline builds both bounds in
// two linear sweeps and then throws them away, keeping only the resulting
// position. Storing them would be two more `u32` arrays over 2.7M nodes for a
// fact 186,317 of them can use — and the answer is derivable here in a
// contiguous scan, because preorder numbering makes a subtree the interval
// `[idx, SubtreeOut[idx])` (architecture §3.1). Measured on the shipped build,
// a structural node's subtree is **1 node at the median and 38 at the 99th
// percentile**; only 7 exceed 100k, and the largest is 287,735. That is a
// `max` over at most 1.1 MB of mmap'd float32 and it is not worth an array.
//
// **`Below` is empty far more often than reads as plausible, and that is the
// finding this type exists to carry.** Every age in the artifact set comes from
// a chronogram of *extant* species, so a dated descendant is very often a tip
// sitting at the present. Measured over the 186,317 structural nodes: only
// **5,168 (2.8%)** have a descendant whose age is greater than zero. For the
// other **181,149 (97.2%)** the lower bound is the present, and prose that says
// the node is spread "between its nearest dated ancestor and descendant" is
// describing the 2.8% case to a reader almost certainly looking at the other
// one. Callers must render the two cases differently.
//
// `Above` is never empty on a structural node — measured, zero of the 186,317
// lack a dated ancestor — but it is still returned as a bound that can be
// absent, because the root of a partially-dated build could be one and a
// caller that assumed otherwise would print a name for idx -1.
type LayoutSpread struct {
	Above LayoutBound
	Below LayoutBound
}

// LayoutSpreadFor returns the dated nodes idx's x position was spread between.
//
// It answers only for a node with no age of its own; a dated node's position
// *is* its age and there is nothing to explain. The second return is false when
// the question does not apply or the arrays are not loaded.
//
// **This describes phase 2's rule and phase 4 may have moved the node since.**
// Where a fossil's last appearance propagated onto an undated node, phase 4
// pushes it back to that bound instead — 337 of the 186,317 structural nodes,
// 0.2%. A caller wanting to be exact about those must compare `age_layout`
// against the spread this implies; nothing here can see the fossil table.
func (a *Arrays) LayoutSpreadFor(idx int) (LayoutSpread, bool) {
	if !a.Valid(idx) || a.AgeMa == nil || a.SubtreeOut == nil || a.Parent == nil {
		return LayoutSpread{}, false
	}
	if isFinite(a.AgeMa[idx]) {
		return LayoutSpread{}, false
	}

	s := LayoutSpread{
		Above: LayoutBound{Idx: -1},
		Below: LayoutBound{Idx: -1},
	}

	// Up: the first ancestor carrying an age. The root's parent is the
	// `NoParent` sentinel, which is what ends the walk — reading it as an
	// index would wrap to a u32 max and index out of the array.
	for v := idx; ; {
		p := a.Parent[v]
		if p == NoParent {
			break
		}
		if isFinite(a.AgeMa[p]) {
			s.Above = LayoutBound{Idx: int(p), AgeMa: float64(a.AgeMa[p])}
			break
		}
		v = int(p)
	}

	// Down: the *oldest* dated descendant, which is the bound the span is
	// measured to. Not the nearest one — that only sets how far along the span
	// this node falls, and naming it would name a node that is not an endpoint
	// of anything the reader can see.
	end := int(a.SubtreeOut[idx])
	if end > a.N {
		end = a.N
	}
	best := math.Inf(-1)
	bestIdx := -1
	for i := idx + 1; i < end; i++ {
		v := a.AgeMa[i]
		if isFinite(v) && float64(v) > best {
			best = float64(v)
			bestIdx = i
		}
	}
	// A descendant at the present is not a bound worth naming: it is where the
	// axis already ends, and 97.2% of structural nodes have nothing older.
	if bestIdx >= 0 && best > 0 {
		s.Below = LayoutBound{Idx: bestIdx, AgeMa: best}
	}
	return s, true
}

func isFinite(f float32) bool {
	return !math.IsNaN(float64(f)) && !math.IsInf(float64(f), 0)
}
