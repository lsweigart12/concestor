"""Age tiers and ordinal layout positions — phase 2's accept, on small trees.

The gates in `dates.run` check these against 2.7M real nodes, which proves the
invariants hold on the data we ship but says nothing about *why*. These tests
build trees small enough to reason about, so a change in the tiering rules
fails somewhere the failure is legible.

The rule that matters most is negative: a `structural` node must never carry a
numeric age. Every other guarantee here is in service of that one.
"""

from __future__ import annotations

import numpy as np

from concestor_build.dates import (
    TIER_INTERPOLATED,
    TIER_MEASURED,
    TIER_STRUCTURAL,
    Congruence,
    assign_tiers,
    layout_ages,
)

EMPTY = np.array([], dtype=np.int64)


def cong(**kw: list[int]) -> Congruence:
    """A Congruence with only the fields the tiering reads."""
    base = {
        "report": {},
        "shared_tip_our": EMPTY,
        "identical_our": EMPTY,
        "subset_our": EMPTY,
        "conflict_our": EMPTY,
    }
    base.update({k: np.array(v, dtype=np.int64) for k, v in kw.items()})
    return Congruence(**base)


def test_identical_clade_is_measured():
    duke = np.array([100.0, 50.0])
    dk_to_ours = np.array([0, 1], dtype=np.int64)
    age, tier = assign_tiers(duke, dk_to_ours, 2, cong(identical_our=[0, 1]))
    assert list(tier) == [TIER_MEASURED, TIER_MEASURED]
    assert list(age) == [100.0, 50.0]


def test_subset_clade_is_interpolated_and_keeps_its_upper_bound():
    # Our clade is a strict subset of Duke's, so their age is an upper bound on
    # ours. The number survives; how it is written changes.
    duke = np.array([96.0])
    age, tier = assign_tiers(
        duke, np.array([0], dtype=np.int64), 1, cong(subset_our=[0])
    )
    assert tier[0] == TIER_INTERPOLATED
    assert age[0] == 96.0


def test_unmatched_nodes_are_structural_with_no_number():
    duke = np.array([100.0])
    # Node 1 has no Duke counterpart at all.
    dk_to_ours = np.array([0], dtype=np.int64)
    age, tier = assign_tiers(duke, dk_to_ours, 2, cong(identical_our=[0]))
    assert tier[1] == TIER_STRUCTURAL
    assert np.isnan(age[1])


def test_contradicted_nodes_are_demoted_and_lose_their_age():
    """The phase-2 accept's second condition, in isolation.

    The node matched an identifier and Duke has an age for it, but Duke's clade
    contradicts ours — so that age is about a different set of species and must
    not be shown against this node.
    """
    duke = np.array([100.0, 50.0, 25.0])
    dk_to_ours = np.array([0, 1, 2], dtype=np.int64)
    age, tier = assign_tiers(
        duke, dk_to_ours, 3, cong(identical_our=[0, 1, 2], conflict_our=[1])
    )
    assert tier[1] == TIER_STRUCTURAL
    assert np.isnan(age[1])
    # ...and its neighbours are untouched.
    assert tier[0] == TIER_MEASURED and age[0] == 100.0
    assert tier[2] == TIER_MEASURED and age[2] == 25.0


def test_conflict_wins_over_every_other_rule():
    """Order matters: a contradicted node that is also a shared tip is still
    demoted. Applying the rules in the other order would leave a number on a
    node whose clade we know is wrong."""
    duke = np.array([0.0])
    _age, tier = assign_tiers(
        duke,
        np.array([0], dtype=np.int64),
        1,
        cong(shared_tip_our=[0], identical_our=[0], conflict_our=[0]),
    )
    assert tier[0] == TIER_STRUCTURAL


def test_no_structural_node_anywhere_carries_a_number():
    """The invariant the whole design is organised around, over a random tree."""
    rng = np.random.default_rng(7)
    n = 400
    duke = rng.uniform(0, 1000, size=n)
    dk_to_ours = np.arange(n, dtype=np.int64)
    dk_to_ours[rng.random(n) < 0.3] = -1  # some nodes have no counterpart
    matched = np.flatnonzero(dk_to_ours >= 0)
    age, tier = assign_tiers(
        duke,
        dk_to_ours,
        n,
        cong(
            identical_our=matched[::3].tolist(),
            subset_our=matched[1::3].tolist(),
            conflict_our=matched[2::5].tolist(),
        ),
    )
    assert not np.isfinite(age[tier == TIER_STRUCTURAL]).any()
    assert np.isfinite(age[tier != TIER_STRUCTURAL]).all()


# --------------------------------------------------------------- layout ----


def test_layout_fills_an_undated_run_evenly_between_its_bounds():
    # A chain root(100) -> a(?) -> b(?) -> c(20). The two undated nodes should
    # land between 100 and 20, in order, without touching either bound.
    parent = np.array([2**32 - 1, 0, 1, 2], dtype=np.uint32)
    age = np.array([100.0, np.nan, np.nan, 20.0], dtype=np.float32)
    lay, violations = layout_ages(parent, age, 100.0, log=lambda _s: None)
    assert violations == 0
    assert lay[0] == 100.0 and lay[3] == 20.0
    assert 20.0 < lay[2] < lay[1] < 100.0


def test_layout_is_finite_and_monotone_on_a_random_tree():
    rng = np.random.default_rng(11)
    n = 2000
    parent = np.empty(n, dtype=np.uint32)
    parent[0] = 2**32 - 1
    for i in range(1, n):
        parent[i] = rng.integers(0, i)
    # Ages that decrease with depth, with most of them missing.
    depth = np.zeros(n, dtype=np.int64)
    for i in range(1, n):
        depth[i] = depth[parent[i]] + 1
    age = (4000.0 / (1.0 + depth)).astype(np.float32)
    age[rng.random(n) < 0.75] = np.nan
    age[0] = 4000.0

    lay, _ = layout_ages(parent, age, 4000.0, log=lambda _s: None)
    assert np.isfinite(lay).all()
    # The axis must never run backwards along a lineage.
    assert (lay[1:] <= lay[parent[1:].astype(np.int64)] + 1e-6).all()


def test_layout_clamps_and_counts_a_dated_child_older_than_its_parent():
    parent = np.array([2**32 - 1, 0], dtype=np.uint32)
    age = np.array([50.0, 90.0], dtype=np.float32)  # child older than parent
    lay, violations = layout_ages(parent, age, 50.0, log=lambda _s: None)
    assert violations == 1
    assert lay[1] <= lay[0]


def test_layout_supplies_a_root_age_when_the_root_is_undated():
    parent = np.array([2**32 - 1, 0], dtype=np.uint32)
    age = np.array([np.nan, np.nan], dtype=np.float32)
    lay, _ = layout_ages(parent, age, 4247.0, log=lambda _s: None)
    assert lay[0] == 4247.0
    assert np.isfinite(lay).all()


def test_layout_never_invents_a_displayable_age():
    """layout positions are a separate array precisely so they cannot leak.

    This is the guard against someone collapsing the two arrays back into one
    to save 10 MB, which would put a confident number on every dashed node.
    """
    parent = np.array([2**32 - 1, 0, 1], dtype=np.uint32)
    age = np.array([100.0, np.nan, 10.0], dtype=np.float32)
    lay, _ = layout_ages(parent, age, 100.0, log=lambda _s: None)
    assert np.isfinite(lay[1])
    assert np.isnan(age[1])  # the displayable array is untouched
