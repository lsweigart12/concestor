"""Phase 5a — the silhouette propagation sweep, and the index parsing feeding it.

The sweep is the only part of this phase with real logic in it. Everything else
is HTTP and SQL, so this tests the sweep against a small hand-built tree whose
right answer is written out by hand, plus a randomised comparison against the
naive definition it is a vectorisation of.

The tree, in preorder (`parent[i] < i`, exactly as phase 1 emits):

        0 root
        ├── 1 A            <- seeded, image 10
        │   ├── 2 A1
        │   │   └── 3 A1x
        │   └── 4 A2       <- seeded, image 11
        └── 5 B
            ├── 6 B1
            └── 7 B2       <- seeded, image 12

`root` and the whole B spine above B2 have no seeded ancestor, so they are
where the descendant fallback either fires or does not.
"""

import hashlib
import json
import sqlite3

import numpy as np
import pytest

from concestor_build import images
from concestor_build.images import (
    M_ANCESTOR,
    M_DESCENDANT,
    M_EXACT,
    M_NONE,
    M_RELATIVE,
    NO_IMAGE,
    ImageRecord,
    name_candidates,
    ott_ids_from_node,
    pick_per_ott,
    propagate,
    record_from_item,
    seed_nodes,
    svg_rel_path,
    taxonomy_index,
)
from concestor_build.newick import NO_OTT, NO_PARENT, derive

PARENT = np.array([NO_PARENT, 0, 1, 2, 1, 0, 5, 5], dtype=np.uint32)


@pytest.fixture
def topo():
    return derive(PARENT)


def make_seed(pairs):
    seed = np.full(PARENT.size, NO_IMAGE, dtype=np.int64)
    for idx, img in pairs:
        seed[idx] = img
    return seed


# tip_count for PARENT: tips are 3, 4, 6, 7; A(1) and B(5) hold two each.
TIP_COUNT = np.array([4, 2, 1, 1, 1, 2, 1, 1], dtype=np.uint32)


def naive(parent, depth, tip_count, seed):
    """The definition the sweep vectorises, written the slow obvious way.

    For each node: climb until an ancestor-or-self has *any* seed beneath it,
    then take the most inclusive seed under that clade. Cousins included —
    that is the whole difference from the rule this replaced.
    """
    n = parent.size

    def subtree(v) -> list[int]:
        out, stack = [], [v]
        while stack:
            u = stack.pop()
            out.append(u)
            stack.extend(int(i) for i in range(n) if i and int(parent[i]) == u)
        return out

    result = []
    for i in range(n):
        cur = i
        while True:
            below = [v for v in subtree(cur) if seed[v] != NO_IMAGE]
            if below:
                if seed[i] != NO_IMAGE:
                    src = i  # exactness wins over inclusiveness
                else:
                    src = min(
                        below, key=lambda v: (-int(tip_count[v]), int(depth[v]), v)
                    )
                result.append(
                    (int(seed[src]), src, cur, int(depth[i]) - int(depth[cur]))
                )
                break
            if cur == 0:
                result.append((NO_IMAGE, NO_IMAGE, NO_IMAGE, 0))
                break
            cur = int(parent[cur])
    return result


def test_propagation_matches_the_hand_worked_answer(topo):
    seed = make_seed([(1, 10), (4, 11), (7, 12)])
    a = propagate(PARENT, topo.depth, topo.subtree_out, seed, TIP_COUNT)

    # A is the most inclusive seed (2 tips), so it is the exemplar for the
    # root and for everything under A that has no image of its own.
    assert a.image.tolist() == [10, 10, 10, 10, 11, 12, 12, 12]
    assert a.source.tolist() == [1, 1, 1, 1, 4, 7, 7, 7]
    # The clade each picture speaks for — the honest size of the claim.
    assert a.clade.tolist() == [0, 1, 1, 1, 4, 5, 5, 7]
    # Hops up to that clade, not to the drawing.
    assert a.climb.tolist() == [0, 0, 1, 2, 0, 0, 1, 0]
    assert a.method.tolist() == [
        M_DESCENDANT,  # root borrows A, which is inside it
        M_EXACT,  # A
        M_ANCESTOR,  # A1 -> A
        M_ANCESTOR,  # A1x -> A, two hops
        M_EXACT,  # A2 has its own image, so it does NOT inherit A's
        M_DESCENDANT,  # B borrows B2
        M_RELATIVE,  # B1 -> B2, its sibling. The rule that made this M_NONE
        M_EXACT,  # B2                        is the one this change removed.
    ]


def test_a_cousin_beats_a_remote_ancestor(topo):
    """The riffle beetle, in miniature.

    B1 has no image and no seeded ancestor short of the root. The old rule
    gave it the root's picture — a drawing standing for all four tips. The
    clade it shares with B2 holds two, so that is what it gets.
    """
    a = propagate(
        PARENT, topo.depth, topo.subtree_out, make_seed([(0, 99), (7, 12)]), TIP_COUNT
    )
    assert a.source[6] == 7
    assert a.clade[6] == 5
    assert a.method[6] == M_RELATIVE
    assert TIP_COUNT[a.clade[6]] < TIP_COUNT[0]


def test_a_seeded_node_keeps_its_own_image(topo):
    """A2 is inside A's clade and both are seeded; the specific one wins.

    Exactness beating inclusiveness is what keeps architecture §7 intact:
    Mammalia draws Mammalia, never one mole from inside it.
    """
    a = propagate(
        PARENT, topo.depth, topo.subtree_out, make_seed([(1, 10), (4, 11)]), TIP_COUNT
    )
    assert a.image[4] == 11
    assert a.source[4] == 4
    assert a.climb[4] == 0
    assert a.method[4] == M_EXACT


def test_the_exemplar_is_the_most_inclusive_seed_not_the_nearest(topo):
    """A boa for Serpentes, not the blind snake that happened to sort first."""
    # Both 3 and 4 are seeded; 4 is the more inclusive by tip_count.
    tips = np.array([4, 2, 1, 1, 3, 2, 1, 1], dtype=np.uint32)
    a = propagate(
        PARENT, topo.depth, topo.subtree_out, make_seed([(3, 10), (4, 11)]), tips
    )
    assert a.source[1] == 4
    assert a.image[1] == 11


def test_climb_zero_does_not_mean_a_portrait(topo):
    """An unseeded genus holding a drawn species sits at climb 0.

    The gate that used to read `climb == 0 iff exact` was true only while
    climb counted hops to the drawing. It counts hops to the clade now.
    """
    a = propagate(PARENT, topo.depth, topo.subtree_out, make_seed([(3, 10)]), TIP_COUNT)
    assert a.climb[2] == 0
    assert a.method[2] == M_DESCENDANT
    assert a.source[2] == 3


def test_a_seeded_root_resolves_every_node(topo):
    a = propagate(PARENT, topo.depth, topo.subtree_out, make_seed([(0, 99)]), TIP_COUNT)
    assert (a.image == 99).all()
    assert (a.source == 0).all()
    assert a.climb.tolist() == topo.depth.tolist()
    assert a.method[0] == M_EXACT
    assert (a.method[1:] == M_ANCESTOR).all()


def test_nothing_seeded_resolves_nothing(topo):
    a = propagate(PARENT, topo.depth, topo.subtree_out, make_seed([]), TIP_COUNT)
    assert (a.method == M_NONE).all()
    assert (a.source == NO_IMAGE).all()
    assert (a.clade == NO_IMAGE).all()


def test_the_clade_contains_both_the_node_and_the_drawing(topo):
    """The exact check the content gate makes, on a tree small enough to read.

    This is the invariant the card asserts out loud, so it is the one worth
    pinning. Note it is *not* "the source is an ancestor" — a cousin fails
    that while being the better answer.
    """
    a = propagate(
        PARENT,
        topo.depth,
        topo.subtree_out,
        make_seed([(1, 10), (4, 11), (7, 12)]),
        TIP_COUNT,
    )
    for i in range(PARENT.size):
        if a.method[i] == M_NONE:
            continue
        c, src = int(a.clade[i]), int(a.source[i])
        assert c <= i < topo.subtree_out[c]
        assert c <= src < topo.subtree_out[c]


def test_matches_the_naive_walk_on_random_trees():
    """The vectorised sweep and the slow obvious definition must agree."""
    rng = np.random.default_rng(7)
    for _ in range(40):
        n = int(rng.integers(2, 120))
        parent = np.zeros(n, dtype=np.uint32)
        parent[0] = NO_PARENT
        for i in range(1, n):
            parent[i] = rng.integers(0, i)  # preserves parent[i] < i
        topo = derive(parent)
        tip_count = topo.tip_count
        seed = np.where(
            rng.random(n) < rng.choice([0.02, 0.2, 0.8]),
            rng.integers(0, 50, size=n),
            NO_IMAGE,
        ).astype(np.int64)

        a = propagate(parent, topo.depth, topo.subtree_out, seed, tip_count)
        expected = naive(parent, topo.depth, tip_count, seed)
        assert [
            (int(a.image[i]), int(a.source[i]), int(a.clade[i]), int(a.climb[i]))
            for i in range(n)
        ] == expected


def test_every_node_resolves_when_anything_is_seeded():
    """The property that makes coverage a useless gate, stated as a test.

    Coverage was 100% before this change and is 100% after it. That is why
    the blocking gate is now the size of the clade, not the share of nodes.
    """
    rng = np.random.default_rng(11)
    for _ in range(20):
        n = int(rng.integers(2, 200))
        parent = np.zeros(n, dtype=np.uint32)
        parent[0] = NO_PARENT
        for i in range(1, n):
            parent[i] = rng.integers(0, i)
        topo = derive(parent)
        seed = np.full(n, NO_IMAGE, dtype=np.int64)
        seed[int(rng.integers(0, n))] = 3
        a = propagate(parent, topo.depth, topo.subtree_out, seed, topo.tip_count)
        assert (a.method != M_NONE).all()


def test_deep_chain_needs_more_than_one_doubling_round():
    """A 200-deep unary chain: a single hop would answer wrong for most of it."""
    n = 200
    parent = np.arange(-1, n - 1, dtype=np.int64)
    parent[0] = NO_PARENT
    parent = parent.astype(np.uint32)
    topo = derive(parent)
    seed = np.full(n, NO_IMAGE, dtype=np.int64)
    seed[0] = 5
    a = propagate(parent, topo.depth, topo.subtree_out, seed, topo.tip_count)
    assert (a.source == 0).all()
    assert a.climb.tolist() == list(range(n))


def test_propagate_rejects_mismatched_arrays(topo):
    with pytest.raises(ValueError, match="lengths disagree"):
        propagate(
            PARENT, topo.depth, topo.subtree_out, np.zeros(3, dtype=np.int64), TIP_COUNT
        )


# --------------------------------------------------------------------------
# The divergence witness
# --------------------------------------------------------------------------
#
# Same tree. Only nodes 0, 1 and 5 can carry a witness: 2 and 3 are a unary
# chain down to one tip and the rest are tips, and a tip is not a divergence.


def ages(**kw: float):
    a = np.full(PARENT.size, np.nan, dtype=np.float32)
    for k, v in kw.items():
        a[int(k[1:])] = v
    return a


def fossil(
    attach_idx,
    oldest,
    youngest,
    *,
    taxon_no=None,
    image=10,
    walk=0,
    n_occs=1,
    name=None,
):
    """A candidate hanging below `attach_idx`. It is not a node, deliberately."""
    no = taxon_no if taxon_no is not None else 1000 + attach_idx
    return images.FossilCandidate(
        pbdb_taxon_no=no,
        name=name or f"Taxon{no}",
        rank="genus",
        attach_idx=attach_idx,
        attach_walk=walk,
        oldest=oldest,
        youngest=youngest,
        n_occs=n_occs,
        image=image,
    )


def witness_for(seed, age, candidates, near_fraction=images.NEAR_FRACTION, layout=None):
    return images.divergence_witnesses(
        PARENT,
        TIP_COUNT,
        age,
        seed,
        candidates,
        near_fraction=near_fraction,
        age_layout=layout,
    )


def test_the_witness_is_not_the_exemplar(topo):
    """The headline case: the two rules disagree, and both answers are kept.

    A2 is the shallower tip, so `propagate` hands A its picture. That is the
    whale–hippo failure in miniature — the crown group is what gets drawn at the
    fork it did not exist at. The witness is a fossil hanging under A1x instead.
    """
    seed = make_seed([(3, 10), (4, 11)])
    w = witness_for(seed, ages(n1=10.0), [fossil(3, 12.0, 8.0, taxon_no=77)])

    assert (
        propagate(PARENT, topo.depth, topo.subtree_out, seed, TIP_COUNT).source[1] == 4
    )
    assert w.source[1] == 77, "a pbdb_taxon_no, not a node index"
    assert w.image[1] == 10
    assert w.gap[1] == 0.0  # the bracket spans the split outright
    assert w.taxa[1].attach_idx == 3


def test_a_fossil_reaches_forks_no_node_could():
    """The reason the layer moved off nodes.

    Node 3 is a tip and carries no image of its own, so under the old rule it
    could never be a candidate for anything. A fossil *attached* there witnesses
    every fork above it — which is how Tetrapoda reaches Acanthostega.
    """
    w = witness_for(make_seed([]), ages(n0=10.0, n1=10.0), [fossil(3, 12.0, 8.0)])
    assert w.source[0] != NO_IMAGE
    assert w.source[1] != NO_IMAGE
    assert w.source[5] == NO_IMAGE, "B is not above the attachment point"


def test_a_fossil_may_witness_its_own_attachment_point():
    """`attach_idx` is where the fossil hangs, so the fork it hangs from is
    exactly the one it has most to say about."""
    w = witness_for(make_seed([]), ages(n1=10.0), [fossil(1, 12.0, 8.0)])
    assert w.source[1] != NO_IMAGE


def test_a_split_nobody_has_dated_falls_back_to_where_it_is_drawn():
    """A `structural` fork has no estimated age, but it still has a position.

    Without this, Carnivora, Canidae, Primates and Rodentia have no witness at
    all — every one of them is undated, and they are exactly the forks a reader
    goes looking for. The layout age is used to *choose* and never to display;
    no number reaches the screen for these, and the card says the fork is
    undated. See the note in `divergence_witnesses`.
    """
    cands = [fossil(3, 12.0, 8.0)]
    assert witness_for(make_seed([]), ages(), cands).source[1] == NO_IMAGE
    assert witness_for(make_seed([]), ages(), cands, layout=ages(n1=10.0)).source[
        1
    ] != (NO_IMAGE)


def test_an_estimated_age_always_beats_the_drawn_position():
    """The fallback only ever reaches nodes that would have had nothing."""
    near = fossil(3, 12.0, 8.0, taxon_no=1)
    far = fossil(4, 40.0, 36.0, taxon_no=2)
    # age_ma says 10 and the layout says 38. If the layout won, A would take
    # the far fossil; the real age must decide.
    w = witness_for(make_seed([]), ages(n1=10.0), [near, far], layout=ages(n1=38.0))
    assert w.source[1] == 1


def test_a_node_with_its_own_image_keeps_it():
    """Exactness wins here as it does everywhere else in this phase."""
    w = witness_for(make_seed([(1, 99)]), ages(n1=10.0), [fossil(3, 12.0, 8.0)])
    assert w.source[1] == NO_IMAGE


def test_the_cap_is_a_fraction_of_the_split_age_not_a_fixed_span():
    """The mechanism, exercised explicitly because the shipped cap is off.

    At 0.25 a fossil 8 Ma from a 20 Ma fork is refused and the same fossil is
    admitted at 0.5. Nothing in the ranking changes when the cap moves, so
    dialling `NEAR_FRACTION` back is a one-line change with no other edits.
    """
    cands = [fossil(3, 12.0, 8.0)]
    assert witness_for(make_seed([]), ages(n1=20.0), cands, 0.25).source[1] == NO_IMAGE
    assert witness_for(make_seed([]), ages(n1=20.0), cands, 0.5).source[1] != NO_IMAGE


def test_the_shipped_rule_refuses_nothing_on_distance():
    """Uncapped by default: a fork takes the nearest fossil however far it is.

    A refused witness does not fall back to anything — the fork simply draws
    no picture — so the cap traded coverage for nothing a reader could see.
    The dates render beside the drawing either way, which is what lets the
    reader judge a poor match instead of being protected from it.
    """
    w = witness_for(make_seed([]), ages(n1=500.0), [fossil(3, 2.0, 1.0)])
    assert w.source[1] != NO_IMAGE
    assert w.gap[1] == 498.0


def test_the_narrower_bracket_wins_the_tie():
    """Sahelanthropus (7.2–5.3) over Ardipithecus (11.6–2.6), in miniature.

    Both contain the split, so the gap cannot separate them and the tie-break
    is which one claims less. Without it the wider bracket wins more often,
    because PBDB's `fea` is junk-wide and widening it can only help — which is
    also what keeps Ammonitina (249.9–56 Ma) from taking every fork it spans.
    """
    wide = fossil(3, 30.0, 2.0, taxon_no=1, n_occs=43884)
    narrow = fossil(4, 12.0, 8.0, taxon_no=2, n_occs=1)
    assert witness_for(make_seed([]), ages(n1=10.0), [wide, narrow]).source[1] == 2


def test_a_firmer_attachment_breaks_a_tie_the_bracket_cannot():
    """Zero hops is a different quality of claim from eight: PBDB's own taxon
    is in the tree, rather than something eight ranks up from it."""
    loose = fossil(3, 12.0, 8.0, taxon_no=1, walk=8)
    firm = fossil(4, 12.0, 8.0, taxon_no=2, walk=0)
    assert witness_for(make_seed([]), ages(n1=10.0), [loose, firm]).source[1] == 2


def test_spanning_the_split_beats_merely_being_near_it():
    spans = fossil(3, 19.0, 17.0, taxon_no=1)
    near = fossil(4, 24.0, 20.0, taxon_no=2)
    w = witness_for(make_seed([]), ages(n1=18.0), [spans, near])
    assert w.source[1] == 1
    assert w.gap[1] == 0.0


def test_a_witness_must_hang_below_the_fork_it_witnesses():
    """A fossil under B2 says nothing about A's split, however well it is dated."""
    w = witness_for(
        make_seed([]), ages(n0=10.0, n1=10.0, n5=10.0), [fossil(7, 12.0, 8.0)]
    )
    assert w.source[0] != NO_IMAGE
    assert w.source[5] != NO_IMAGE
    assert w.source[1] == NO_IMAGE, "A is not an ancestor of the attachment point"


def test_a_candidate_attached_outside_the_tree_is_ignored():
    """`attach_idx` comes from a table this function does not own."""
    w = witness_for(make_seed([]), ages(n1=10.0), [fossil(999, 12.0, 8.0)])
    assert w.source.tolist() == [NO_IMAGE] * PARENT.size


def test_witnesses_reject_mismatched_arrays():
    with pytest.raises(ValueError, match="lengths disagree"):
        images.divergence_witnesses(
            PARENT, TIP_COUNT, ages(), np.zeros(3, dtype=np.int64), []
        )


def _fossil_db() -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    con.executescript(
        "CREATE TABLE fossil (pbdb_taxon_no INTEGER PRIMARY KEY, accepted_no INTEGER,"
        " name TEXT, rank TEXT, attach_idx INTEGER, attach_walk INTEGER,"
        " fea REAL, lla REAL, n_occs INTEGER, is_extant INTEGER, is_primary INTEGER);"
    )
    return con


def _record(uuid: str = "u") -> ImageRecord:
    return ImageRecord(
        uuid=uuid,
        license_url="https://creativecommons.org/publicdomain/zero/1.0/",
        attribution=None,
        contributor=None,
        modified="2026-07-31",
        node_uuid=None,
        node_title="Acanthostega gunnari",
        node_primary_image=None,
    )


def test_load_fossil_candidates_without_a_fossil_table():
    """Phase 5a must run against a build where phase 4 has not."""
    got, stats = images.load_fossil_candidates(sqlite3.connect(":memory:"), [], {1: 0})
    assert got == [] and stats["rows"] == 0


def test_an_extant_taxon_is_never_a_candidate():
    """The one that would quietly undo the feature. PBDB carries Mammalia at
    239.5–0 Ma, and a range running to the present spans every split inside it,
    so the biggest forks would take the crown group with a fossil's label on.
    Unknown extancy goes too: a wrong include is a silent regression and a wrong
    exclude is one missing picture."""
    con = _fossil_db()
    con.executemany(
        "INSERT INTO fossil VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
            (1, 1, "Mammalia", "class", 5, 0, 239.5, 0.0, 900, 1, 1),
            (2, 2, "Unknown", "genus", 5, 0, 60.0, 50.0, 3, None, 1),
            (3, 3, "Acanthostega", "genus", 5, 2, 372.0, 359.0, 40, 0, 1),
        ],
    )
    got, stats = images.load_fossil_candidates(con, [_record()], {1: 0, 2: 0, 3: 0})
    assert [c.pbdb_taxon_no for c in got] == [3]
    assert stats["extant_excluded"] == 2
    assert got[0].attach_walk == 2 and got[0].oldest == 372.0


def test_a_synonym_and_an_undrawn_taxon_are_not_candidates():
    con = _fossil_db()
    con.executemany(
        "INSERT INTO fossil VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
            (1, 9, "Synonym", "genus", 5, 0, 60.0, 50.0, 3, 0, 0),
            (2, 2, "Undrawn", "genus", 5, 0, 60.0, 50.0, 3, 0, 1),
            (3, 3, "Undated", "genus", 5, 0, None, None, 3, 0, 1),
            (4, 4, "Good", "genus", 5, 0, 60.0, 50.0, 3, 0, 1),
        ],
    )
    got, stats = images.load_fossil_candidates(con, [_record()], {4: 0, 9: 0})
    assert [c.name for c in got] == ["Good"]
    assert stats["rows"] == 2, "primary, extinct and dated; drawn is counted apart"
    assert stats["drawn"] == 1


# --------------------------------------------------------------------------
# Seeding
# --------------------------------------------------------------------------


TIPS = np.array([9, 1, 1, 1], dtype=np.uint32)


def test_seed_nodes_chases_a_forwarded_ott_id():
    """OTT id forwarding is silent, so a direct miss is not an absent taxon."""
    ott = np.array([NO_OTT, 100, 200, NO_OTT], dtype=np.int64)
    # PhyloPic cites 999, which OTT retired in favour of 200.
    seed, stats = seed_nodes(ott, TIPS, {100: 0, 999: 1}, {999: 200})
    assert seed.tolist() == [NO_IMAGE, 0, 1, NO_IMAGE]
    assert stats["ott_ids_via_forward"] == 1
    assert stats["seeded_nodes"] == 2


def test_seed_nodes_ignores_ids_absent_from_the_tree():
    ott = np.array([NO_OTT, 100], dtype=np.int64)
    seed, stats = seed_nodes(ott, TIPS[:2], {100: 0, 555: 1}, {})
    assert seed.tolist() == [NO_IMAGE, 0]
    assert stats["ott_ids_offered"] == 2
    assert stats["ott_ids_in_tree"] == 1


def test_one_hop_lift_recovers_a_taxon_synthesis_does_not_carry():
    """The Homo sapiens case: images hang off a subspecies that is not a node."""
    ott = np.array([NO_OTT, 770315], dtype=np.int64)
    tips = np.array([9, 2], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott, tips, {5341349: 7}, {}, parents={5341349: 770315}, lift_max_tips=100
    )
    assert seed.tolist() == [NO_IMAGE, 7]
    assert stats["ott_ids_lifted_one_hop"] == 1
    assert stats["ott_ids_in_tree"] == 0


def test_one_hop_lift_refuses_a_target_that_is_too_broad():
    """A fossil family must not be lifted onto Amphibia — worse than nothing."""
    ott = np.array([NO_OTT, 500], dtype=np.int64)
    tips = np.array([10_018, 10_018], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott, tips, {999: 7}, {}, parents={999: 500}, lift_max_tips=100
    )
    assert seed.tolist() == [NO_IMAGE, NO_IMAGE]
    assert stats["ott_ids_lifted_one_hop"] == 0


def test_one_hop_lift_never_displaces_a_direct_hit():
    """An image OF the node beats an image lifted from one of its children."""
    ott = np.array([NO_OTT, 770315], dtype=np.int64)
    tips = np.array([9, 2], dtype=np.uint32)
    seed, _ = seed_nodes(
        ott, tips, {5341349: 7, 770315: 3}, {}, parents={5341349: 770315}
    )
    assert seed[1] == 3


def test_lift_only_walks_one_hop():
    """Two hops is a different claim, and the fossil cases are all multi-hop."""
    ott = np.array([NO_OTT, 100], dtype=np.int64)
    tips = np.array([9, 1], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott, tips, {300: 7}, {}, parents={300: 200, 200: 100}, lift_max_tips=100
    )
    assert seed.tolist() == [NO_IMAGE, NO_IMAGE]
    assert stats["ott_ids_lifted_one_hop"] == 0


# --------------------------------------------------------------------------
# Seeding by name — the images that carry no OTT id at all
# --------------------------------------------------------------------------


def test_name_match_reaches_an_image_with_no_ott_id():
    """1,783 images resolve only in GBIF/PBDB. Their node still has a name."""
    ott = np.array([NO_OTT, 100], dtype=np.int64)
    tips = np.array([9, 1], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott,
        tips,
        {},
        {},
        titles=["Chlamydiae"],
        name_uids={"Chlamydiae": [100]},
    )
    assert seed.tolist() == [NO_IMAGE, 0]
    assert stats["names_matched"] == 1
    assert stats["names_matched_truncated"] == 0
    # No OTT id reaches node 1, so the name pass is what put an image on it.
    assert stats["nodes_from_name"] == 1


def test_an_exact_name_match_carries_no_tip_bound():
    """The image is *of* that taxon however broad it is, so climb 0 is honest."""
    ott = np.array([NO_OTT, 100], dtype=np.int64)
    tips = np.array([90_000, 90_000], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott, tips, {}, {}, titles=["Mollusca"], name_uids={"Mollusca": [100]}
    )
    assert seed[1] == 0
    assert stats["names_matched"] == 1


def test_a_title_truncates_to_its_genus():
    """`Phoca caspica` is not in synthesis; `Phoca` is, and is narrow enough."""
    ott = np.array([NO_OTT, 100], dtype=np.int64)
    tips = np.array([9, 4], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott,
        tips,
        {},
        {},
        titles=["Phoca caspica"],
        name_uids={"Phoca": [100]},
        lift_max_tips=100,
    )
    assert seed.tolist() == [NO_IMAGE, 0]
    assert stats["names_matched_truncated"] == 1
    assert stats["nodes_from_name_truncated"] == 1


def test_truncation_prefers_the_species_over_the_genus():
    """A subspecies image belongs on the species when the species exists."""
    ott = np.array([NO_OTT, 100, 200], dtype=np.int64)
    tips = np.array([9, 2, 4], dtype=np.uint32)
    seed, _ = seed_nodes(
        ott,
        tips,
        {},
        {},
        titles=["Equus quagga chapmani"],
        name_uids={"Equus quagga": [100], "Equus": [200]},
    )
    assert seed.tolist() == [NO_IMAGE, 0, NO_IMAGE]


def test_truncation_refuses_a_genus_that_is_too_broad():
    """Same bound as the one-hop lift, for the same reason."""
    ott = np.array([NO_OTT, 100], dtype=np.int64)
    tips = np.array([10_018, 10_018], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott,
        tips,
        {},
        {},
        titles=["Ichthyostega stensioei"],
        name_uids={"Ichthyostega": [100]},
        lift_max_tips=100,
    )
    assert seed.tolist() == [NO_IMAGE, NO_IMAGE]
    assert stats["names_matched_truncated"] == 0


def test_a_homonym_seeds_nothing():
    """OTT carries `Prunella` twice. Nothing in the title says which was drawn."""
    ott = np.array([NO_OTT, 100, 200], dtype=np.int64)
    tips = np.array([9, 1, 1], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott, tips, {}, {}, titles=["Prunella"], name_uids={"Prunella": [100, 200]}
    )
    assert seed.tolist() == [NO_IMAGE, NO_IMAGE, NO_IMAGE]
    assert stats["names_ambiguous"] == 1
    assert stats["names_matched"] == 0


def test_a_name_never_displaces_an_ott_id():
    """Passes 1-3 are evidence about identity; a name is evidence about a label."""
    ott = np.array([NO_OTT, 100], dtype=np.int64)
    tips = np.array([9, 1], dtype=np.uint32)
    # Record 0 lands by id on node 1; record 1's title names the same node.
    seed, _ = seed_nodes(
        ott,
        tips,
        {100: 0},
        {},
        titles=["Something else", "Canis lupus"],
        name_uids={"Canis lupus": [100]},
    )
    assert seed[1] == 0


def test_a_name_match_an_ott_id_also_reaches_is_not_credited_as_a_recovery():
    """Counting matches instead of surviving seeds is the flattering-gate bug.

    Record 1's title names node 1 correctly — but record 0 already claimed it
    by OTT id, so the name pass changed nothing there and must not say it did.
    """
    ott = np.array([NO_OTT, 100], dtype=np.int64)
    tips = np.array([9, 1], dtype=np.uint32)
    _, stats = seed_nodes(
        ott,
        tips,
        {100: 0},
        {},
        titles=["Something else", "Canis lupus"],
        name_uids={"Canis lupus": [100]},
    )
    assert stats["names_matched"] == 1
    assert stats["nodes_from_name"] == 0


def test_an_image_that_already_seeded_is_not_reconsidered_by_name():
    ott = np.array([NO_OTT, 100, 200], dtype=np.int64)
    tips = np.array([9, 1, 1], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott,
        tips,
        {100: 0},
        {},
        titles=["Bos taurus"],
        name_uids={"Bos taurus": [200]},
    )
    assert seed.tolist() == [NO_IMAGE, 0, NO_IMAGE]
    assert stats["names_matched"] == 0


def test_name_match_chases_a_forward_like_the_id_passes_do():
    ott = np.array([NO_OTT, 200], dtype=np.int64)
    tips = np.array([9, 1], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott,
        tips,
        {},
        {999: 200},
        titles=["Felis bieti"],
        name_uids={"Felis bieti": [999]},
    )
    assert seed.tolist() == [NO_IMAGE, 0]
    assert stats["names_matched"] == 1


def test_seeding_by_name_is_off_without_a_name_index():
    """`taxonomy.tsv` is optional; its absence must not fail the phase."""
    ott = np.array([NO_OTT, 100], dtype=np.int64)
    seed, stats = seed_nodes(ott, TIPS[:2], {}, {}, titles=["Chlamydiae"])
    assert seed.tolist() == [NO_IMAGE, NO_IMAGE]
    assert stats["names_matched"] == 0


def test_name_candidates_collects_the_title_and_its_truncations():
    recs = [_rec_named("Equus quagga chapmani"), _rec_named("Orthocerida")]
    assert name_candidates(recs) == {
        "Equus quagga chapmani",
        "Equus quagga",
        "Equus",
        "Orthocerida",
    }


def test_taxonomy_index_reads_names_and_parents_in_one_pass(tmp_path, monkeypatch):
    tsv = tmp_path / "taxonomy.tsv"
    tsv.write_text(
        "uid\t|\tparent_uid\t|\tname\t|\trank\t|\n"
        "100\t|\t50\t|\tPhoca\t|\tgenus\t|\n"
        "200\t|\t100\t|\tPhoca caspica\t|\tspecies\t|\n"
        "300\t|\t60\t|\tPrunella\t|\tgenus\t|\n"
        "400\t|\t70\t|\tPrunella\t|\tgenus\t|\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(images, "TAXONOMY", tsv)
    parents, names = taxonomy_index({"Phoca", "Prunella"})
    assert parents == {100: 50, 200: 100, 300: 60, 400: 70}
    # Filtered to what was asked for, and homonyms kept as a list so the
    # caller can see there are two.
    assert names == {"Phoca": [100], "Prunella": [300, 400]}


def test_taxonomy_index_without_an_extracted_taxonomy(tmp_path, monkeypatch):
    monkeypatch.setattr(images, "TAXONOMY", tmp_path / "absent.tsv")
    assert taxonomy_index({"Phoca"}) == ({}, {})


def _rec_named(title) -> ImageRecord:
    return ImageRecord(
        uuid="u",
        license_url="https://creativecommons.org/publicdomain/zero/1.0/",
        attribution="A",
        contributor="A",
        modified="2020-01-01",
        node_uuid="n",
        node_title=title,
        node_primary_image=None,
    )


def _rec(uuid, ott_ids, primary=None, modified="2020-01-01") -> ImageRecord:
    return ImageRecord(
        uuid=uuid,
        license_url="https://creativecommons.org/publicdomain/zero/1.0/",
        attribution="A",
        contributor="A",
        modified=modified,
        node_uuid="n",
        node_title="t",
        node_primary_image=primary,
        ott_ids=list(ott_ids),
    )


def test_pick_per_ott_prefers_the_nodes_own_primary_image():
    older = _rec("aaa", [7], primary="bbb", modified="2026-01-01")
    primary = _rec("bbb", [7], primary="bbb", modified="2001-01-01")
    assert pick_per_ott([older, primary])[7] == 1


def test_pick_per_ott_falls_back_to_most_recently_modified():
    a = _rec("aaa", [7], primary="zzz", modified="2001-01-01")
    b = _rec("bbb", [7], primary="zzz", modified="2026-01-01")
    assert pick_per_ott([a, b])[7] == 1


def test_pick_per_ott_skips_images_with_no_licence():
    r = _rec("aaa", [7])
    r.license_url = ""
    assert pick_per_ott([r]) == {}


# --------------------------------------------------------------------------
# Index payload parsing
# --------------------------------------------------------------------------

# Shape verified against the live API on 2026-07-31, build 545.
ITEM = {
    "uuid": "87782103-d7e2-4574-a932-ef445dd112fa",
    "attribution": "Amy Beauvois",
    "modified": "2026-07-22T06:40:10.428Z",
    "_links": {
        "license": {"href": "https://creativecommons.org/publicdomain/zero/1.0/"},
        "contributor": {
            "href": "/contributors/x?build=545",
            "title": "T. Michael Keesey",
        },
        "vectorFile": {
            "href": "https://images.phylopic.org/images/87782103/vector.svg"
        },
    },
    "_embedded": {
        "specificNode": {
            "uuid": "5009dab6-2315-4192-8a41-e7ecd7919e63",
            "_links": {
                "self": {
                    "href": "/nodes/5009dab6?build=545",
                    "title": "Diabloceratops",
                },
                "primaryImage": {"href": "/images/aaaa-bbbb?build=545"},
                "external": [
                    {"href": "/resolve/gbif.org/species/8559524?build=545"},
                    {"href": "/resolve/opentreeoflife.org/taxonomy/6150271?build=545"},
                    {"href": "/resolve/paleobiodb.org/txn/170568?build=545"},
                ],
            },
        }
    },
}


def test_record_from_item_keeps_creator_and_uploader_apart():
    """Conflating them credits the wrong person; they differ 31% of the time."""
    r = record_from_item(ITEM)
    assert r.attribution == "Amy Beauvois"
    assert r.contributor == "T. Michael Keesey"
    assert r.license_url.endswith("/zero/1.0/")
    assert r.ott_ids == [6150271]
    assert r.node_primary_image == "aaaa-bbbb"


def test_record_survives_an_image_with_no_specific_node():
    bare = {"uuid": "u", "_links": {"license": {"href": "x"}}}
    r = record_from_item(bare)
    assert r.ott_ids == []
    assert r.node_uuid is None


def test_ott_ids_reads_every_declared_id_not_just_the_first():
    node = {
        "_links": {
            "external": [
                {"href": "/resolve/opentreeoflife.org/taxonomy/1?build=545"},
                {"href": "/resolve/opentreeoflife.org/taxonomy/2"},
                {"href": "/resolve/gbif.org/species/3"},
                {"href": "/resolve/opentreeoflife.org/taxonomy/notanumber"},
            ]
        }
    }
    assert ott_ids_from_node(node) == [1, 2]


def test_ott_ids_on_a_node_with_no_external_block():
    assert ott_ids_from_node({"_links": {"external": None}}) == []
    assert ott_ids_from_node({}) == []


def test_index_round_trips_through_jsonl(tmp_path, monkeypatch):
    monkeypatch.setattr(images, "MIRROR", tmp_path)
    monkeypatch.setattr(images, "INDEX", tmp_path / "index.jsonl")
    monkeypatch.setattr(images, "INDEX_META", tmp_path / "index_meta.json")
    recs = [record_from_item(ITEM), _rec("z", [1, 2])]
    images.save_index(recs, 545, total_items=2)
    back, meta = images.load_index()
    assert meta == {"build": 545, "images": 2, "total_items": 2}
    assert [r.to_json() for r in back] == [r.to_json() for r in recs]


def test_load_index_with_nothing_cached(tmp_path, monkeypatch):
    monkeypatch.setattr(images, "INDEX", tmp_path / "nope.jsonl")
    monkeypatch.setattr(images, "INDEX_META", tmp_path / "nope.json")
    assert images.load_index() == ([], {})


# --------------------------------------------------------------------------
# Attribution and mirror layout
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "required"),
    [
        ("https://creativecommons.org/licenses/by/4.0/", True),
        ("https://creativecommons.org/licenses/by-sa/3.0/", True),
        ("https://creativecommons.org/licenses/by-nc-sa/3.0/", True),
        ("https://creativecommons.org/publicdomain/zero/1.0/", False),
        ("https://creativecommons.org/publicdomain/mark/1.0/", False),
    ],
)
def test_attribution_requirement_follows_the_licence(url, required):
    r = _rec("u", [])
    r.license_url = url
    assert r.needs_attribution is required


def test_svg_paths_are_sharded():
    p = svg_rel_path("87782103-d7e2-4574-a932-ef445dd112fa")
    assert p == "svg/87/87782103-d7e2-4574-a932-ef445dd112fa.svg"


def test_resume_keeps_good_files_and_refetches_ruined_ones(tmp_path, monkeypatch):
    """Resumability is by content, not by presence.

    An interrupted run leaves a half-written or empty file behind. Skipping it
    because the path exists would bake a broken silhouette into the mirror and
    then record a checksum for it, so nothing downstream would ever notice.
    """
    monkeypatch.setattr(images, "MIRROR", tmp_path)
    good, empty, junk = _rec("a" * 8, []), _rec("b" * 8, []), _rec("c" * 8, [])
    body = b"<svg><path d='M0 0'/></svg>"
    for rec, content in ((good, body), (empty, b""), (junk, b"<!doctype html>oops")):
        p = tmp_path / svg_rel_path(rec.uuid)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content)

    have = images.existing_mirror(
        [good, empty, junk, _rec("d" * 8, [])], lambda _m: None
    )
    assert set(have) == {good.uuid, junk.uuid}  # junk still parses as markup
    assert have[good.uuid].bytes == len(body)
    assert have[good.uuid].sha256 == hashlib.sha256(body).hexdigest()
    assert have[good.uuid].rel_path == svg_rel_path(good.uuid)


def test_budget_caps_one_run_and_takes_the_highest_priority_first(monkeypatch):
    """A budgeted run must fetch the *front* of the priority order, not any N."""
    monkeypatch.setattr(images, "MIRROR_WORKERS", 1)
    recs = [_rec(f"u{i}", []) for i in range(5)]
    fetched: list[str] = []

    def fake(_client, rec) -> images.MirrorRow:
        fetched.append(rec.uuid)
        return images.MirrorRow(rec.uuid, svg_rel_path(rec.uuid), "x" * 64, 10)

    monkeypatch.setattr(images, "fetch_svg", fake)
    have, failures = images.mirror_svgs(recs, [3, 1, 4, 0, 2], {}, 2, lambda _m: None)
    assert fetched == ["u3", "u1"]
    assert set(have) == {"u3", "u1"}
    assert failures == []


def test_a_single_bad_image_does_not_stop_the_mirror(monkeypatch):
    monkeypatch.setattr(images, "MIRROR_WORKERS", 1)
    recs = [_rec("ok1", []), _rec("bad", []), _rec("ok2", [])]

    def fake(_client, rec) -> images.MirrorRow:
        if rec.uuid == "bad":
            raise images.PhylopicError("not SVG")
        return images.MirrorRow(rec.uuid, svg_rel_path(rec.uuid), "x" * 64, 10)

    monkeypatch.setattr(images, "fetch_svg", fake)
    have, failures = images.mirror_svgs(recs, [0, 1, 2], {}, 0, lambda _m: None)
    assert set(have) == {"ok1", "ok2"}
    assert len(failures) == 1
    assert "bad" in failures[0]


# --------------------------------------------------------------------------
# Output tables, on a throwaway database
# --------------------------------------------------------------------------


def test_tables_carry_data_and_not_just_rows(tmp_path, monkeypatch):
    """`silhouette.svg_path` stays NULL until fetched, and must fill when it is.

    CLAUDE.md records a column that was permanently NULL while every gate
    passed. Counting rows is not checking them.
    """
    db = tmp_path / "t.db"
    monkeypatch.setattr(images, "DB", db)
    monkeypatch.setattr(images, "OUT", tmp_path / "out")

    recs = [_rec("img-a", [1]), _rec("img-b", [2])]
    mirrored = {"img-a": images.MirrorRow("img-a", "svg/im/img-a.svg", "d" * 64, 1234)}
    topo = derive(PARENT)
    assign = propagate(
        PARENT,
        topo.depth,
        topo.subtree_out,
        make_seed([(1, 0), (7, 1)]),
        TIP_COUNT,
    )

    con = images.connect_rw()
    images.write_silhouette(con, recs, mirrored)
    n_rows = images.write_node_image(con, recs, assign)
    con.close()

    con = sqlite3.connect(db)
    fetched, missing = con.execute(
        "SELECT count(svg_path), count(*) - count(svg_path) FROM silhouette"
    ).fetchone()
    assert (fetched, missing) == (1, 1)
    assert con.execute(
        "SELECT sha256, bytes FROM silhouette WHERE phylopic_id='img-a'"
    ).fetchone() == ("d" * 64, 1234)
    assert (
        con.execute("SELECT count(*) FROM silhouette WHERE license_url=''").fetchone()[
            0
        ]
        == 0
    )

    # Only resolved nodes get a row, and every row names a real silhouette.
    assert n_rows == int((assign.method != M_NONE).sum())
    assert (
        con.execute(
            "SELECT count(*) FROM node_image "
            "WHERE phylopic_id NOT IN (SELECT phylopic_id FROM silhouette)"
        ).fetchone()[0]
        == 0
    )
    assert con.execute(
        "SELECT phylopic_id, source_idx, clade_idx, climb, method FROM node_image "
        "WHERE idx=3"
    ).fetchone() == ("img-a", 1, 1, 2, "ancestor")
    assert {m for (m,) in con.execute("SELECT DISTINCT method FROM node_image")} <= {
        "exact",
        "ancestor",
        "descendant",
        "relative",
    }
    con.close()

    images.write_arrays(recs, assign)
    assert json.loads((tmp_path / "out" / "silhouette_ids.json").read_text()) == [
        "img-a",
        "img-b",
    ]
    assert (
        np.load(tmp_path / "out" / "node_image_climb.npy").tolist()
        == assign.climb.tolist()
    )


def test_mirror_order_puts_the_biggest_clades_first():
    """An interrupted crawl should already have Mammalia, not a monotypic genus."""
    tip_count = np.array([8, 3, 1, 1, 1, 3, 1, 1], dtype=np.uint32)
    topo = derive(PARENT)
    # image 0 resolves the A clade (3 tips), image 1 resolves only B2 (1 tip).
    assign = propagate(
        PARENT, topo.depth, topo.subtree_out, make_seed([(1, 0), (7, 1)]), tip_count
    )
    recs = [_rec("small-clade", [1]), _rec("big-clade", [2]), _rec("unused", [3])]
    order = images.mirror_order(recs, tip_count, assign)
    assert order[0] == 0  # weight 3, the A clade
    assert order[1] == 1  # weight 1, B2 alone
    assert order[2] == 2  # weight 0, resolves nothing


def test_mirror_order_without_a_resolution_is_index_order():
    recs = [_rec("a", []), _rec("b", [])]
    assert images.mirror_order(recs, np.ones(8, dtype=np.uint32), None) == [0, 1]
