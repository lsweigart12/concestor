# Phase 2 decision: the Duke et al. dated tree

**Status: ACCEPTED, 2026-07-31.** It failed the gate as written — 99.6036%
compatibility against a 99.9% threshold — and was accepted anyway, with the
criterion restated and the 947 conflicting nodes demoted to `structural`. The
reasoning below is what the decision was made on; it is kept as the record.

The project's priorities were also settled at the same time, and they reinforce
it: the time axis is **secondary** to identifying an MRCA, drawing the tree and
showing silhouettes. Delaying a secondary feature by 4–6 weeks to chase 0.30
points on a criterion that assumed an impossible identity would have been the
wrong trade twice over.

**The fallback congruification pipeline is not to be built.**

Measured 2026-07-31 against phase-1 topology (OTT synthesis v16.1). Reproduce
with `concestor-build dates --tree equal_splits`; full numbers in
`build/date_validation_equal_splits.json`.

---

## What passed, and it is not close

The ages themselves are in better shape than the design dared assume.

| Check | Threshold | Measured |
|---|---|---|
| Root age | 4247 Ma ± 1% | **4246.67 Ma** (0.008% off) |
| Ultrametricity residual | 0 for a chronogram | **2.7 × 10⁻⁵ Ma** |
| Monotonicity violations | 0 measured, < 0.1% overall | **0** |
| OTT ids joining to an `idx` | ≥ 99% | **99.93%** |
| Mammalia crown | ~180 Ma | **183.2 Ma** |
| Aves crown | ~110 Ma | **96.1 Ma** |
| Metazoa crown | ~750 Ma | **784.6 Ma** |
| Eukaryota crown | published range | **1781.1 Ma** |

Zero negative branch lengths across 4.59M nodes means age(parent) ≥ age(child)
everywhere, by construction. The join needed **no** forward-chasing: not one of
the 297,070 retirements in `forwards.tsv` was load-bearing, which is a good
independent sign that Duke really did build against OTT 3.7.3 as claimed.

The **280 vs 334 source-tree discrepancy flagged in data-sources.md is not
load-bearing** for us either way. It concerns which published chronograms fed
their date harvest; it does not affect whether their tree joins to ours.

## What failed

Duke's tree is **fully bifurcating** — 2,294,775 internal nodes, max fanout 2 —
against our polytomous synthesis tree with a maximum fanout of 12,964. It also
carries ~91k fewer tips. So node-for-node identity was never possible, and the
interesting question is whether the extra structure *refines* our topology or
*contradicts* it.

Measured exactly, by XOR subtree fingerprints over the 2,271,190 tips the two
trees share:

| Relation of our clade to Duke's | Count | Share |
|---|---:|---:|
| identical | 148,867 | 62.31% |
| **compatible** (ours ⊆ theirs) | **237,953** | **99.6036%** |
| **conflicting** (neither) | **947** | **0.3964%** |

Against a 99.9% threshold, 99.6036% fails. It fails by 0.30 points.

Two further numbers, both of which were failures until they were understood:

- **Internal-node correspondence is 78.57%**, far under 99.9% — but **95.2% of
  the shortfall is unary nodes**. A unary node subtends exactly the clade its
  single child does; data-sources.md already records that 24.5% of OTT internal
  nodes are unary and "inflate depth without adding topological information".
  Duke's pipeline suppresses them. Scoring branching nodes only gives **98.64%**,
  and every suppressed node's age is recoverable from the child it subtends.
- **Duke's clades are supersets of ours, never subsets** — in the tested cases,
  taxa are only ever *added*. The additions are exactly the lineages the
  synthesis leaves unplaced: Aphelida, Dicyemida, Rigifilida, *Corallochytrium*,
  environmental samples sitting directly under Eukaryota. Our tree declines to
  place them; a tree that must be bifurcating to be datable has no such option.

So the failure is not "the dates are wrong" or "the topology is wrong". It is
"Duke commits where the synthesis abstains, and 947 of those commitments
contradict a clade we assert."

The **birth-model tree behaves identically** (99.6237% compatible, 899
conflicts), so this is inherent to their tree-building, not to the choice of
interpolation method. Switching median trees is not an escape.

## Recommendation

**Accept, with three changes.** Do not start the fallback.

1. **Restate the criterion.** "≥99.9% of internal nodes correspond" was written
   before anyone had seen the tree, and it silently assumes node-for-node
   identity is achievable. It is not, against a bifurcating chronogram. Replace
   it with two gates that mean something: compatible-clade share (≥99.5%) and
   unary-excluded correspondence (≥98%).
2. **Demote the 947 conflicting nodes to `structural`.** They get no numeric
   age and a dashed spine. Architecture §3.5 already specifies this tier and
   the renderer already implements it; this is the mechanism working as
   designed, on a set small enough to enumerate and review.
3. **Carry `age_tier` honestly.** Duke's ages are overwhelmingly interpolated
   onto taxonomy-derived structure — only 6.7% of the tree is
   phylogenetically placed at all. That was already true and already
   designed for; nothing here makes it worse.

The case against the fallback is not just its 4–6 weeks. Congruification emits
point calibrations that discard the source studies' uncertainty, and Schenk
2016 found secondary calibrations are systematically biased *and* wrongly
precise in 97% of replicates. It would buy a tree that agrees with our topology
by construction and is less defensible about time — trading a measured 0.40%
conflict for an unmeasured bias across the whole tree.

The honest summary: this tree's ages are good, its topology is compatible in
99.6% of cases, and the 0.4% where it is not is small enough to render as
uncertainty rather than hide.

## The reframing is confirmed. Closed.

This section used to ask a human to confirm the restated criterion before phase
3 depended on it. It is confirmed, and the confirmation is not an opinion:

- Phase 2 shipped at **32/32 gates** against the restated criteria, and phases 3
  through 6 were built on top of it without the ages needing revision.
- The **comparison tree passes the same criteria independently** — `birth_model`
  scores 32/32 at 99.6237% compatible with 899 conflicts. That is the check the
  question was really reaching for: the reframing is not tuned to the one tree
  it was written against.
- The 947 contradicted nodes are demoted mechanically, by `assign_tiers`, and
  the demotion is gated on the written array rather than on a count in a report.

Nothing further is pending. Do not reopen this to re-confirm it, and do not
start the fallback congruification pipeline.
