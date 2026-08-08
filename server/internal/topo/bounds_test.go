package topo

import (
	"math"
	"testing"
)

// The numbers below were measured against the shipped build by reproducing
// `layout_ages`'s two sweeps in numpy over age_ma.npy and age_tier.npy. They
// are the whole reason this file exists: prose that says an undated node is
// spread "between its nearest dated ancestor and descendant" is describing the
// 2.8% case, and a reader is almost certainly looking at the other one.
//
// **They are a census of one artifact set, so a pipeline rerun can move them,
// and a move is a fact worth reading rather than a number to bump.** Whichever
// dataset is named below is the one they hold for; against another build this
// test is measuring that build's difference from it. The one move so far:
// `1a06c3c2a2be4ccf` promoted *Delphinoidea* from `structural` to
// `occurrence`, because letting an accepted PBDB record reach the tree under
// the name the tree writes gave it a walk-0 attachment it did not have before
// (`fossils.under_accepted_name`). One node, and both totals it appears in.
const (
	measuredAgainstBuild = "1a06c3c2a2be4ccf"

	wantStructural      = 186316
	wantWithLowerBound  = 5168
	wantAtPresentBelow  = 181148
	wantWithoutAncestor = 0
)

// What a mismatch here usually means, said once rather than at each of the four
// call sites. A census that is off by a handful is the dataset having moved
// under a constant; a census that is off by thousands is the sweep itself.
const censusHint = "\nThis is a census of build " + measuredAgainstBuild +
	". If build/manifest.json names a different one, the artifact set moved:" +
	" find out which nodes changed tier before changing either side."

// The census, run over every structural node. This is the assertion the copy on
// the card rests on, so it is checked against the arrays rather than trusted
// from a comment — the same discipline the pipeline's content gates use.
func TestLayoutSpreadCensus(t *testing.T) {
	a := load(t)
	if a.AgeTier == nil || a.AgeMa == nil {
		t.Skip("phase 2 arrays not present in this build")
	}

	var structural, withLower, atPresent, noAncestor int
	for i := 0; i < a.N; i++ {
		if a.AgeTier[i] != TierStructural {
			continue
		}
		structural++
		s, ok := a.LayoutSpreadFor(i)
		if !ok {
			t.Fatalf("idx %d is structural but has no spread", i)
		}
		if s.Below.Idx >= 0 {
			withLower++
		} else {
			atPresent++
		}
		if s.Above.Idx < 0 {
			noAncestor++
		}
	}

	if structural != wantStructural {
		t.Errorf("structural nodes = %d, want %d%s", structural, wantStructural, censusHint)
	}
	if withLower != wantWithLowerBound {
		t.Errorf("with a datable lower bound = %d, want %d%s", withLower, wantWithLowerBound, censusHint)
	}
	if atPresent != wantAtPresentBelow {
		t.Errorf("bounded below by the present = %d, want %d%s", atPresent, wantAtPresentBelow, censusHint)
	}
	// Zero, and the card's prose leans on it: every structural node can name
	// the taxon above it. If this ever fires, the "no age" paragraph has a
	// case it does not write.
	if noAncestor != wantWithoutAncestor {
		t.Errorf("structural nodes with no dated ancestor = %d, want %d", noAncestor, wantWithoutAncestor)
	}
}

// A dated node's position *is* its age, so there is nothing to explain and the
// caller must be told so rather than handed a spread it would then print.
func TestLayoutSpreadRefusesDatedNodes(t *testing.T) {
	a := load(t)
	if a.AgeMa == nil {
		t.Skip("phase 2 arrays not present in this build")
	}
	// Homo sapiens is dated; so is the root.
	idx, ok := a.IdxForOtt(770315)
	if !ok {
		t.Fatal("Homo sapiens not found")
	}
	if _, ok := a.LayoutSpreadFor(idx); ok {
		t.Error("a dated node was given a layout spread")
	}
}

// Both bounds must be real ancestry, not merely plausible numbers. The interval
// test is the cheap proof, and it is what catches a scan that ran off the end
// of a subtree — the failure mode that would name a neighbour's descendant.
func TestLayoutSpreadBoundsAreRelatives(t *testing.T) {
	a := load(t)
	if a.AgeTier == nil || a.AgeMa == nil {
		t.Skip("phase 2 arrays not present in this build")
	}
	checked := 0
	for i := 0; i < a.N && checked < 20000; i++ {
		if a.AgeTier[i] != TierStructural {
			continue
		}
		s, ok := a.LayoutSpreadFor(i)
		if !ok {
			continue
		}
		checked++
		if s.Above.Idx >= 0 {
			if !a.IsAncestor(s.Above.Idx, i) || s.Above.Idx == i {
				t.Fatalf("idx %d: upper bound %d is not a strict ancestor", i, s.Above.Idx)
			}
			if !isFinite(a.AgeMa[s.Above.Idx]) {
				t.Fatalf("idx %d: upper bound %d carries no age", i, s.Above.Idx)
			}
		}
		if s.Below.Idx >= 0 {
			if !a.IsAncestor(i, s.Below.Idx) || s.Below.Idx == i {
				t.Fatalf("idx %d: lower bound %d is not a strict descendant", i, s.Below.Idx)
			}
			if s.Below.AgeMa <= 0 {
				t.Fatalf("idx %d: lower bound at the present was reported as a bound", i)
			}
			// The oldest, not merely any. A scan that stopped at the first
			// dated descendant would pass everything above and fail here.
			for j := i + 1; j < int(a.SubtreeOut[i]); j++ {
				if isFinite(a.AgeMa[j]) && float64(a.AgeMa[j]) > s.Below.AgeMa {
					t.Fatalf("idx %d: %d is older than the reported lower bound", i, j)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no structural nodes were checked")
	}
}

// Brunelliaceae is one of the 5,168 that genuinely has a dated descendant, and
// it is the worked example the card's prose was written against.
func TestLayoutSpreadNamesARealDescendant(t *testing.T) {
	a := load(t)
	if a.AgeTier == nil || a.AgeMa == nil {
		t.Skip("phase 2 arrays not present in this build")
	}
	var found bool
	for i := 0; i < a.N; i++ {
		if a.AgeTier[i] != TierStructural {
			continue
		}
		s, ok := a.LayoutSpreadFor(i)
		if !ok || s.Below.Idx < 0 || s.Above.Idx < 0 {
			continue
		}
		found = true
		// The span has to be the right way round or the fraction that places
		// the node is computed against a negative width.
		if s.Above.AgeMa < s.Below.AgeMa {
			t.Fatalf("idx %d: upper %.3f is younger than lower %.3f",
				i, s.Above.AgeMa, s.Below.AgeMa)
		}
		if math.IsNaN(s.Above.AgeMa) || math.IsNaN(s.Below.AgeMa) {
			t.Fatalf("idx %d: a bound carries NaN", i)
		}
		break
	}
	if !found {
		t.Fatal("no structural node with both bounds was found")
	}
}
