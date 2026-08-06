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
// from the arrays rather than baked: the answer is a `max` over the subtree,
// which preorder makes the contiguous interval `[idx, SubtreeOut[idx])`, so it
// is not worth two more arrays over 2.7M nodes.
//
// `Below` is empty far more often than plausible: every age comes from a
// chronogram of extant species, so a dated descendant is usually a tip at the
// present and only ~2.8% of structural nodes have a dated descendant older than
// zero. Callers must render the two cases differently. `Above` is never empty on
// the shipped build but is returned absent-able, so a partially-dated build
// cannot make a caller print a name for idx -1.
type LayoutSpread struct {
	Above LayoutBound
	Below LayoutBound
}

// LayoutSpreadFor returns the dated nodes idx's x position was spread between.
// Answers only for a node with no age of its own (a dated node's position is its
// age); the second return is false otherwise. This describes phase 2's rule, and
// phase 4 may since have pushed the node back to a fossil bound — a caller
// wanting to be exact must compare `age_layout`, which this cannot see.
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
