"""Unit tests for phase 4's attachment walk, plus guards on what it wrote.

The walk is the whole phase: everything else is a column copy. Its failure mode
is silent — a broken `xref` does not error, it just parks every fossil at the
root — so the interesting tests are the ones about *where* a taxon lands and how
far the walk had to go to put it there.
"""

import sqlite3

import numpy as np
import pytest

from concestor_build import fossils
from concestor_build.fossils import ATTACH_METHOD_CODE, Attacher
from concestor_build.newick import NO_PARENT
from concestor_build.resolve import DB, PbdbTaxon

CHAIN = ATTACH_METHOD_CODE["gbif_pbdb_chain"]
NAME = ATTACH_METHOD_CODE["name_exact"]
ROOT = fossils.ATTACH_ROOT


def taxon(
    taxon_no: int,
    parent_no: int = 0,
    accepted_no: int | None = None,
    rank: str = "genus",
    name: str = "",
    accepted_rank: str = "genus",
    accepted_name: str = "",
    difference: str = "",
    n_occs: int = 1,
    is_extant: int | None = 0,
    fea: float | None = 10.0,
    fla: float | None = 9.0,
    lea: float | None = 8.0,
    lla: float | None = 7.0,
    flags: str = "",
) -> PbdbTaxon:
    return PbdbTaxon(
        taxon_no=taxon_no,
        orig_no=taxon_no,
        rank=rank,
        name=name or f"T{taxon_no}",
        accepted_no=taxon_no if accepted_no is None else accepted_no,
        accepted_rank=accepted_rank,
        accepted_name=accepted_name or f"T{taxon_no}",
        parent_no=parent_no,
        n_occs=n_occs,
        is_extant=is_extant,
        difference=difference,
        fea=fea,
        fla=fla,
        lea=lea,
        lla=lla,
        flags=flags,
    )


# --- the walk -----------------------------------------------------------------


def test_a_taxon_that_resolves_attaches_to_itself_at_walk_zero():
    a = Attacher({5: (500, CHAIN)}, {5: 4})
    got = a.attach(taxon(5, parent_no=4))
    assert got == fossils.Attachment(idx=500, method=CHAIN, walk=0, via=5)


def test_the_walk_climbs_parent_no_until_something_resolves():
    #  1 <- 2 <- 3 <- 4, only 1 is in xref
    parents = {4: 3, 3: 2, 2: 1, 1: 0}
    a = Attacher({1: (11, CHAIN)}, parents)
    got = a.attach(taxon(4, parent_no=3))
    assert got.idx == 11
    assert got.walk == 3, "three parent_no hops"
    assert got.via == 1


def test_the_walk_records_the_method_that_resolved_the_ancestor():
    a = Attacher({2: (22, NAME)}, {3: 2, 2: 0})
    assert a.attach(taxon(3, parent_no=2)).method == NAME


def test_a_synonym_resolves_through_its_accepted_taxon_at_walk_zero():
    """`accepted_no` is the key; reaching it is not a walk, it is the same taxon."""
    a = Attacher({38606: (99, CHAIN)}, {38606: 0})
    aublysodon = taxon(38614, parent_no=38606, accepted_no=38606)
    got = a.attach(aublysodon)
    assert got == fossils.Attachment(idx=99, method=CHAIN, walk=0, via=38606)


def test_the_record_s_own_id_wins_over_its_accepted_taxon():
    a = Attacher({38614: (1, CHAIN), 38606: (2, CHAIN)}, {38614: 38606})
    assert a.attach(taxon(38614, parent_no=38606, accepted_no=38606)).idx == 1


def test_everything_attaches_somewhere_and_the_root_is_the_fallback():
    a = Attacher({}, {3: 2, 2: 1, 1: 0})
    got = a.attach(taxon(3, parent_no=2))
    assert got.idx == fossils.ROOT_IDX
    assert got.method == ROOT
    assert got.via is None


def test_a_cycle_in_parent_no_terminates():
    a = Attacher({}, {1: 2, 2: 1})
    got = a.attach(taxon(1, parent_no=2))
    assert got.idx == fossils.ROOT_IDX
    assert got.walk == 2


def test_memoisation_gives_each_ancestor_its_own_walk_length():
    """The chain above a genus is shared; caching it must not flatten `walk`."""
    parents = {4: 3, 3: 2, 2: 1, 1: 0}
    a = Attacher({1: (11, CHAIN)}, parents)
    assert a.attach(taxon(4, parent_no=3)).walk == 3
    assert a.attach(taxon(3, parent_no=2)).walk == 2
    assert a.attach(taxon(2, parent_no=1)).walk == 1
    assert a.attach(taxon(1, parent_no=0)).walk == 0


# --- the taxon the tree already holds, filed under a second taxon_no ----------
#
# PBDB enters a recombination under its own `taxon_no` and leaves the accepted
# record under the original combination. Phase 3 matches `taxon_name`, so only
# the recombination reaches the node — and the accepted record, the row
# `is_primary` picks and search serves, walked to the genus. `attach_walk` then
# said 1 for a taxon the tree holds exactly, `notInTree` did not refuse it, and
# the same animal arrived twice.


def homo_erectus() -> list[PbdbTaxon]:
    """PBDB's three rows for *Homo erectus*, verbatim from the pinned snapshot."""
    return [
        taxon(
            40901,
            parent_no=91486,
            name="Homo",
            accepted_name="Homo",
            rank="genus",
        ),
        # The accepted record — entered under the original combination.
        taxon(
            83084,
            parent_no=40901,
            name="Pithecanthropus erectus",
            accepted_name="Homo erectus",
            rank="species",
            difference="recombined as",
        ),
        # The current combination, on a taxon_no of its own.
        taxon(
            376854,
            parent_no=40901,
            accepted_no=83084,
            name="Homo erectus",
            accepted_name="Homo erectus",
            rank="species",
        ),
        # A junior synonym of the same accepted taxon.
        taxon(
            83083,
            parent_no=40901,
            accepted_no=83084,
            name="Homo ergaster",
            accepted_name="Homo erectus",
            rank="species",
            difference="subjective synonym of",
        ),
    ]


def test_the_accepted_record_reaches_the_node_its_recombination_resolved_to():
    taxa = homo_erectus()
    # Only "Homo erectus" matches a node by name; the genus resolves by chain.
    resolved = {376854: (594490, NAME), 40901: (594480, CHAIN)}
    parents = {t.taxon_no: t.parent_no for t in taxa}

    walked = Attacher(resolved, parents).attach(taxa[1])
    assert (walked.idx, walked.walk) == (594480, 1), (
        "the bug: the accepted record climbs to the genus"
    )

    a = Attacher(resolved, parents, fossils.under_accepted_name(taxa, resolved))
    got = a.attach(taxa[1])
    assert got == fossils.Attachment(idx=594490, method=NAME, walk=0, via=376854)


def test_every_row_of_the_taxon_lands_on_the_node_so_none_is_offered_twice():
    """`notInTree` refuses `attach_walk = 0`; a row left walking arrives twice."""
    taxa = homo_erectus()
    resolved = {376854: (594490, NAME), 40901: (594480, CHAIN)}
    a = Attacher(
        resolved,
        {t.taxon_no: t.parent_no for t in taxa},
        fossils.under_accepted_name(taxa, resolved),
    )
    for t in taxa[1:]:
        got = a.attach(t)
        assert (got.idx, got.walk) == (594490, 0), t.name


def test_a_synonym_does_not_hand_its_node_to_a_broader_accepted_taxon():
    """Name equality is the whole claim — grouping on `accepted_no` is not enough.

    PBDB files the radiolarian genus *Cenellipsis* under accepted name
    *Radiolaria*. OTT has a *Cenellipsis*, so taking any resolved row of the
    accepted group would attach a whole class inside one of its own genera.
    """
    radiolaria = taxon(4, name="Radiolaria", accepted_name="Radiolaria", parent_no=1)
    cenellipsis = taxon(
        60,
        parent_no=4,
        accepted_no=4,
        name="Cenellipsis",
        accepted_name="Radiolaria",
        difference="subjective synonym of",
    )
    taxa = [radiolaria, cenellipsis]
    resolved = {60: (700, NAME), 1: (1, NAME)}

    assert fossils.under_accepted_name(taxa, resolved) == {}
    a = Attacher(
        resolved, {4: 1, 60: 4, 1: 0}, fossils.under_accepted_name(taxa, resolved)
    )
    assert a.attach(radiolaria).idx == 1, "walks past its own synonym's node"


def test_the_record_s_own_resolution_still_wins():
    taxa = homo_erectus()
    resolved = {376854: (594490, NAME), 83084: (777, CHAIN)}
    a = Attacher(
        resolved,
        {t.taxon_no: t.parent_no for t in taxa},
        fossils.under_accepted_name(taxa, resolved),
    )
    got = a.attach(taxa[1])
    assert got == fossils.Attachment(idx=777, method=CHAIN, walk=0, via=83084)


def test_a_child_of_a_recombined_taxon_stops_at_it_rather_than_climbing_past():
    """The map is consulted inside the walk, not only at its start."""
    taxa = [
        *homo_erectus(),
        taxon(
            999,
            parent_no=83084,
            name="Homo erectus pekinensis",
            accepted_name="Homo erectus pekinensis",
            rank="subspecies",
        ),
    ]
    resolved = {376854: (594490, NAME), 40901: (594480, CHAIN)}
    a = Attacher(
        resolved,
        {t.taxon_no: t.parent_no for t in taxa},
        fossils.under_accepted_name(taxa, resolved),
    )
    got = a.attach(taxa[-1])
    assert got.idx == 594490, "one hop to Homo erectus, not two to the genus"
    assert got.walk == 1
    assert got.via == 376854


def test_the_strongest_method_wins_when_two_rows_spell_the_accepted_name():
    taxa = [
        taxon(1, name="A", accepted_name="A"),
        taxon(2, accepted_no=1, name="A", accepted_name="A"),
        taxon(3, accepted_no=1, name="A", accepted_name="A"),
    ]
    resolved = {2: (20, NAME), 3: (30, CHAIN)}
    assert fossils.under_accepted_name(taxa, resolved) == {1: 3}, "chain beats name"


# --- rows ---------------------------------------------------------------------


def test_rows_display_the_accepted_name_and_keep_the_record_s_own():
    """Rank does not survive resolution — *Aublysodon* is the canonical case."""
    t = taxon(
        38614,
        parent_no=38606,
        accepted_no=38606,
        rank="genus",
        name="Aublysodon",
        accepted_rank="family",
        accepted_name="Tyrannosauridae",
        difference="nomen dubium",
    )
    rows, _, _ = fossils.build_rows([t], Attacher({38606: (7, CHAIN)}, {}))
    (row,) = rows
    assert (row.name, row.rank) == ("Tyrannosauridae", "family")
    assert (row.own_name, row.own_rank) == ("Aublysodon", "genus")
    assert row.difference == "nomen dubium"
    assert row.is_primary == 0


def test_all_four_appearance_bounds_survive_uncollapsed():
    t = taxon(1, fea=83.6, fla=72.2, lea=72.2, lla=66.0)
    (row,), _, _ = fossils.build_rows([t], Attacher({}, {}))
    assert (row.fea, row.fla, row.lea, row.lla) == (83.6, 72.2, 72.2, 66.0)


def test_is_extant_stays_none_rather_than_becoming_false():
    (row,), _, _ = fossils.build_rows([taxon(1, is_extant=None)], Attacher({}, {}))
    assert row.is_extant is None


def test_build_rows_reports_walk_and_method_distributions():
    a = Attacher({1: (11, CHAIN)}, {3: 2, 2: 1, 1: 0})
    _, walks, methods = fossils.build_rows(
        [taxon(1), taxon(2, parent_no=1), taxon(3, parent_no=2), taxon(9)], a
    )
    # taxon 1 resolves itself; 2 is one hop up; 3 is two; 9 has nowhere to go and
    # falls back to the root after one hop.
    assert dict(walks) == {0: 1, 1: 2, 2: 1}
    assert methods[CHAIN] == 3
    assert methods[ROOT] == 1


def test_the_attach_method_dictionary_is_a_bijection():
    assert len(fossils.ATTACH_METHOD_NAME) == len(ATTACH_METHOD_CODE)
    assert fossils.ATTACH_METHOD_NAME[ROOT] == "root_fallback"


# --- the unwitnessed young end ------------------------------------------------
#
# The real case, reduced: a genus PBDB stops at 93.9 Ma because of one
# occurrence catalogued `Stegosaurus sp.`, whose named species all end at 143.1.


def _species(
    parent: int, first: int, n: int, lla: float, occs: int = 5, fea: float = 1e4
) -> list[PbdbTaxon]:
    """`fea` defaults absurdly old so the bracket never binds; the tests that
    care about it set one."""
    return [
        taxon(
            first + i, parent_no=parent, rank="species", fea=fea, lla=lla, n_occs=occs
        )
        for i in range(n)
    ]


def test_a_young_end_below_every_descendant_is_unwitnessed_and_moves():
    taxa = [taxon(1, fea=1e4, lla=93.9, n_occs=86), *_species(1, 10, 4, 143.1)]
    ends, stats = fossils.young_ends(taxa)

    assert stats["unwitnessed"] == 1
    assert stats["clamped"] == 1
    got = ends[1]
    assert got.identified == 143.1, "the youngest end an identified member reaches"
    assert got.occs == 20, "four species at five occurrences each"
    assert got.drawn == 143.1
    assert got.clamped


def test_pbdbs_own_number_is_never_overwritten():
    """`lla` is what PBDB says and stays that. Only the position moves."""
    taxa = [taxon(1, fea=1e4, lla=93.9, n_occs=86), *_species(1, 10, 4, 143.1)]
    ends, _ = fossils.young_ends(taxa)
    rows, _, _ = fossils.build_rows(
        taxa, Attacher({1: (7, NAME)}, {t.taxon_no: t.parent_no for t in taxa}), ends
    )
    genus = next(r for r in rows if r.pbdb_taxon_no == 1)
    assert genus.lla == 93.9, "untouched"
    assert genus.lla_drawn == 143.1
    assert genus.lla_identified == 143.1


def test_a_young_end_a_descendant_reaches_is_left_alone():
    taxa = [taxon(1, fea=1e4, lla=143.1, n_occs=86), *_species(1, 10, 4, 143.1)]
    ends, stats = fossils.young_ends(taxa)
    assert stats["unwitnessed"] == 0
    assert ends[1].drawn == 143.1
    assert not ends[1].clamped


def test_an_ichnotaxon_keeps_its_own_young_end():
    """For a trace fossil the genus-level id is the finest one that exists.

    *Gyrolithes* really does run from the Cambrian to the Recent, and the
    corroboration would happily clamp it 475 Myr in the wrong direction.
    """
    taxa = [
        taxon(1, fea=1e4, lla=2.58, n_occs=90, flags="I"),
        *_species(1, 10, 4, 477.1),
    ]
    ends, stats = fossils.young_ends(taxa)
    assert stats["unwitnessed"] == 1, "still detected — the test is exact"
    assert stats["refused_form"] == 1
    assert ends[1].drawn == 2.58, "and never acted on"
    assert not ends[1].clamped


def test_an_uncorroborated_alternative_is_refused():
    """The *Tasmanites* case: 56 occurrences, one species, one record.

    Clamping here would be a 1,595 Myr error — far worse than the young end
    it would be correcting. Refusing falls back to PBDB's own number.
    """
    taxa = [
        taxon(1, fea=1e4, lla=5.333, n_occs=56),
        *_species(1, 10, 1, 1600.0, occs=1),
    ]
    ends, stats = fossils.young_ends(taxa)
    assert stats["unwitnessed"] == 1
    assert stats["refused_sparse"] == 1
    assert ends[1].identified == 1600.0, "the alternative is still recorded"
    assert ends[1].drawn == 5.333, "it is just not used"
    assert not ends[1].clamped


def test_the_correction_carries_up_the_hierarchy():
    """Otherwise the fix is defeated one rank up.

    The single genus-level occurrence that stretches *Stegosaurus* stretches
    *Stegosauridae* too, and a reader who selects the family would meet the
    same error.
    """
    taxa = [
        taxon(1, rank="family", fea=1e4, lla=93.9, n_occs=193),
        taxon(2, parent_no=1, rank="genus", fea=1e4, lla=93.9, n_occs=86),
        *_species(2, 10, 4, 143.1),
    ]
    ends, _ = fossils.young_ends(taxa)
    assert ends[2].drawn == 143.1, "the genus moves"
    assert ends[1].drawn == 143.1, "and so does the family above it"


def test_a_real_younger_member_holds_the_family_where_it_is():
    """Propagation must not overshoot. A Cretaceous stegosaurid is a real one."""
    taxa = [
        taxon(1, rank="family", fea=1e4, lla=93.9, n_occs=193),
        taxon(2, parent_no=1, rank="genus", fea=1e4, lla=93.9, n_occs=86),
        *_species(2, 10, 4, 143.1),
        # Wuerhosaurus, genuinely Early Cretaceous and identified.
        taxon(20, parent_no=1, rank="genus", fea=1e4, lla=100.5, n_occs=9),
    ]
    ends, _ = fossils.young_ends(taxa)
    assert ends[2].drawn == 143.1
    assert ends[1].drawn == 100.5, "the family stops at its youngest real member"


def test_a_child_reaching_younger_than_its_parent_is_recorded_not_acted_on():
    """PBDB's aggregate is not monotone — 440 taxa are like this."""
    taxa = [taxon(1, fea=1e4, lla=468.0, n_occs=40), *_species(1, 10, 1, 66.0, occs=35)]
    ends, stats = fossils.young_ends(taxa)
    assert stats["non_monotone"] == 1
    assert stats["unwitnessed"] == 0, "the test only fires on an *older* end"
    assert ends[1].drawn == 468.0


def test_the_last_appearance_bracket_moves_as_a_pair():
    """`[lea, lla]` is one bracket and both ends come from the same records.

    *Stegosaurus* has `lea` 100.5 and `lla` 93.9, and both are the single
    Cenomanian `Stegosaurus sp.`. Moving `lla` alone would leave the older end
    of the very occurrence being refused.
    """
    taxa = [
        taxon(1, fea=161.5, fla=149.2, lea=100.5, lla=93.9, n_occs=86),
        *[
            taxon(
                10 + i,
                parent_no=1,
                rank="species",
                fea=154.8,
                fla=149.2,
                lea=149.2,
                lla=143.1,
                n_occs=5,
            )
            for i in range(4)
        ],
    ]
    ends, _ = fossils.young_ends(taxa)
    rows, _, _ = fossils.build_rows(
        taxa, Attacher({1: (7, NAME)}, {t.taxon_no: t.parent_no for t in taxa}), ends
    )
    genus = next(r for r in rows if r.pbdb_taxon_no == 1)
    assert (genus.lea, genus.lla) == (100.5, 93.9), "PBDB's own, untouched"
    assert genus.lla_drawn == 143.1
    assert genus.lea_drawn == 149.2, "the partner end came with it"
    assert genus.lea_drawn is not None and genus.lla_drawn is not None
    assert genus.lea_drawn >= genus.lla_drawn, "still a bracket"


def test_a_row_is_never_drawn_outside_its_own_bracket():
    """PBDB files three *Paronychodon* rows with three different first
    appearances against one accepted taxon. The clamp is right for the accepted
    row and would put the narrow ones older than their own `fea`.
    """
    taxa = [
        taxon(1, fea=154.8, lla=66.0, n_occs=40),
        *_species(1, 10, 4, 89.8),
        taxon(2, accepted_no=1, fea=72.2, lla=66.0, difference="misspelling of"),
    ]
    ends, _ = fossils.young_ends(taxa)
    assert ends[1].clamped and ends[1].drawn == 89.8
    rows, _, _ = fossils.build_rows(
        taxa, Attacher({1: (7, NAME)}, {t.taxon_no: t.parent_no for t in taxa}), ends
    )
    wide = next(r for r in rows if r.pbdb_taxon_no == 1)
    narrow = next(r for r in rows if r.pbdb_taxon_no == 2)
    assert wide.lla_drawn == 89.8, "89.8 sits inside 154.8–66.0"
    assert narrow.lla_drawn == 66.0, "but not inside 72.2–66.0, so it stays put"


def test_a_fossil_synonym_of_a_living_genus_is_not_dragged_to_the_present():
    """The other direction, and the one the gate actually caught.

    *Crassispira* is a living genus whose `lla` is 0 and whose identified end
    is 0.0117. Its synonym *Tripia* is an Eocene row ending at 37.71, and
    inheriting 0.0117 would move a fossil 37 Myr forward into the Holocene.
    """
    taxa = [
        taxon(1, fea=1e4, lla=0.0, n_occs=90, is_extant=1),
        *_species(1, 10, 4, 0.0117),
        taxon(2, accepted_no=1, fea=48.07, lla=37.71, difference="synonym of"),
    ]
    ends, _ = fossils.young_ends(taxa)
    assert ends[1].clamped and ends[1].drawn == 0.0117
    rows, _, _ = fossils.build_rows(
        taxa, Attacher({1: (7, NAME)}, {t.taxon_no: t.parent_no for t in taxa}), ends
    )
    fossil_row = next(r for r in rows if r.pbdb_taxon_no == 2)
    assert fossil_row.lla_drawn == 37.71, "its own number, not its genus's"


def test_a_synonym_inherits_its_accepted_taxons_verdict():
    taxa = [
        taxon(1, fea=1e4, lla=93.9, n_occs=86),
        *_species(1, 10, 4, 143.1),
        taxon(2, accepted_no=1, fea=1e4, lla=93.9, difference="subjective synonym of"),
    ]
    ends, _ = fossils.young_ends(taxa)
    rows, _, _ = fossils.build_rows(
        taxa, Attacher({1: (7, NAME)}, {t.taxon_no: t.parent_no for t in taxa}), ends
    )
    syn = next(r for r in rows if r.pbdb_taxon_no == 2)
    assert syn.lla == 93.9
    assert syn.lla_drawn == 143.1, "the same animal, so the same position"


# --- reporting helpers --------------------------------------------------------


def test_median_of_a_histogram():
    from collections import Counter

    assert fossils._median(Counter({1: 1, 2: 1, 3: 1})) == 2.0
    assert fossils._median(Counter()) == 0.0


def test_histogram_renders_a_truncation_marker():
    from collections import Counter

    text = fossils._histogram(Counter(dict.fromkeys(range(20), 1)), top=3)
    assert text.endswith("…")


# --- what actually got written ------------------------------------------------


@pytest.fixture(scope="module")
def con():
    if not DB.exists():
        pytest.skip("no database")
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    has = c.execute(
        "SELECT count(*) FROM sqlite_master WHERE name IN ('fossil','xref')"
    ).fetchone()[0]
    if has != 2:
        c.close()
        pytest.skip("run `concestor-build resolve` then `fossils`")
    yield c
    c.close()


def test_every_fossil_attaches_to_a_real_node(con):
    orphaned = con.execute(
        "SELECT count(*) FROM fossil LEFT JOIN node ON node.idx = fossil.attach_idx "
        "WHERE node.idx IS NULL"
    ).fetchone()[0]
    assert orphaned == 0


def test_the_fossil_table_is_keyed_on_taxon_no_because_orig_no_is_not_unique(con):
    """architecture §3.4's `pbdb_orig_no PRIMARY KEY` cannot work on this file."""
    rows, distinct_orig = con.execute(
        "SELECT count(*), count(DISTINCT pbdb_orig_no) FROM fossil"
    ).fetchone()
    assert rows == 523_112
    assert distinct_orig < rows, "orig_no genuinely repeats; taxon_no does not"


def test_appearance_bounds_are_not_collapsed(con):
    """`fea/fla` and `lea/lla` are two brackets; a single range is a wrong claim."""
    row = con.execute(
        "SELECT fea, fla, lea, lla FROM fossil WHERE pbdb_taxon_no = 38613"
    ).fetchone()
    assert row == (83.6, 72.2, 72.2, 66.0)


def test_is_extant_is_nullable_and_actually_carries_nulls(con):
    assert (
        con.execute("SELECT count(*) FROM fossil WHERE is_extant IS NULL").fetchone()[0]
        == 9_059
    )


def test_columns_are_populated_rather_than_merely_present(con):
    """A rename once emptied a column while every gate still passed."""
    n, named, with_occs, with_interval = con.execute(
        "SELECT count(*), count(name), sum(n_occs > 0), count(fea) FROM fossil"
    ).fetchone()
    assert named == n
    assert with_occs > 400_000
    assert with_interval >= 0.78 * n


def test_attachment_is_not_universally_the_root(con):
    at_root = con.execute(
        "SELECT count(*) FROM fossil WHERE attach_idx = 0"
    ).fetchone()[0]
    total = con.execute("SELECT count(*) FROM fossil").fetchone()[0]
    assert at_root < total, "everything landing at the root means the chain is broken"


# ------------------------------------------------------------------------------
# Bounding the layout by the fossil record
# ------------------------------------------------------------------------------
#
# The defect these guard: `age_layout` fills an undated run between the nearest
# dated ancestor and the deepest dated *descendant*, and an extinct lineage has
# no dated descendant, so the fill drags it to the present. *T. rex* was drawn
# at 25.9 Ma against a last occurrence at 66.

# 0 root; 1 and 5 its children; 2 under 1; 3 under 2; 4 under 1; 6, 7 under 5.
LAYOUT_PARENT = np.array([NO_PARENT, 0, 1, 2, 1, 0, 5, 5], dtype=np.uint32)
NAN = float("nan")


def _bound_db(rows) -> sqlite3.Connection:
    """An in-memory `fossil` table carrying just what the bound pass reads.

    `is_extant` is here because the pass also counts probable cross-kingdom
    homonyms while it has the data in hand, and defaults to 0 so the existing
    cases read as three-tuples.
    """
    con = sqlite3.connect(":memory:")
    con.execute(
        "CREATE TABLE fossil (attach_idx INTEGER, attach_walk INTEGER, "
        "lla REAL, is_extant INTEGER)"
    )
    con.executemany(
        "INSERT INTO fossil VALUES (?,?,?,?)",
        [(*r, 0) if len(r) == 3 else r for r in rows],
    )
    return con


def test_the_homonym_count_is_taken_before_the_bounds_are_cleared():
    """Clearing a bound on a living lineage is what hides the defect.

    Phase 3 resolves PBDB to OTT by name and OTT carries the same genus name
    in unrelated kingdoms, so a Cambrian fossil lands on a living plant. Node 3
    is dated, so its bound is refused — and the refusal is exactly the evidence
    worth counting.
    """
    age = np.array([100.0, NAN, NAN, 0.0, NAN, NAN, NAN, NAN], dtype=np.float32)
    con = _bound_db([(3, 0, 538.8)])
    _bound, _direct, refused, ancient, homonyms = fossils.layout_bounds(
        con, LAYOUT_PARENT, age
    )
    assert (refused, ancient, homonyms) == (1, 1, 1)


def test_an_ancient_fossil_on_a_dead_lineage_is_not_a_homonym():
    age = np.array([600.0, NAN, NAN, NAN, NAN, NAN, NAN, NAN], dtype=np.float32)
    con = _bound_db([(3, 0, 538.8)])
    _bound, _direct, _refused, ancient, homonyms = fossils.layout_bounds(
        con, LAYOUT_PARENT, age
    )
    assert (ancient, homonyms) == (1, 0)


def test_a_bound_reaches_every_ancestor_of_the_fossil():
    """A lineage's origin precedes its occurrences, so ancestors inherit it."""
    age = np.array([100.0, NAN, NAN, NAN, NAN, NAN, NAN, NAN], dtype=np.float32)
    con = _bound_db([(3, 0, 66.0)])
    bound, direct, refused, _ancient, _homonyms = fossils.layout_bounds(
        con, LAYOUT_PARENT, age
    )
    assert direct == 1
    assert refused == 0
    # 3 -> 2 -> 1 -> 0 all carry 66; the other branch carries nothing.
    assert bound.tolist() == [66.0, 66.0, 66.0, 66.0, 0.0, 0.0, 0.0, 0.0]


def test_only_exact_attachments_count():
    """A bracket attached at a parent belongs to some taxon below it and names
    no child, so it constrains none of them."""
    age = np.full(8, NAN, dtype=np.float32)
    con = _bound_db([(3, 1, 66.0)])
    bound, direct, *_ = fossils.layout_bounds(con, LAYOUT_PARENT, age)
    assert direct == 0
    assert not bound.any()


def test_a_bound_is_refused_where_the_lineage_is_still_alive():
    """A last appearance is evidence about a lineage that *ended*.

    PBDB's *Ivesia* is an Ediacaran rangeomorph and OTT's is a rose-family
    plant, so phase 3's name-based `xref` put a 538.8 Ma bound on a living
    genus. Node 3 here is dated — something under it survives — so the bound
    says nothing about where to draw it.
    """
    age = np.array([100.0, NAN, NAN, 0.0, NAN, NAN, NAN, NAN], dtype=np.float32)
    con = _bound_db([(3, 0, 538.8)])
    bound, direct, refused, _ancient, _homonyms = fossils.layout_bounds(
        con, LAYOUT_PARENT, age
    )
    assert (direct, refused) == (0, 1)
    assert not bound.any()


def test_the_tyrannosaurus_case_end_to_end():
    """25.9 Ma against a last occurrence at 66, which is the whole bug."""
    age = np.array([250.0, NAN, NAN, NAN, NAN, NAN, NAN, NAN], dtype=np.float32)
    layout = np.array([250.0, 100.0, 60.0, 25.9, 0, 0, 0, 0], dtype=np.float32)
    bound, *_ = fossils.layout_bounds(_bound_db([(3, 0, 66.0)]), LAYOUT_PARENT, age)
    after, moved, _ = fossils.bound_layout(layout, age, LAYOUT_PARENT, bound)
    assert after[3] == pytest.approx(66.0)
    assert moved >= 1
    # And its ancestors made room rather than the tree inverting.
    assert after[2] >= after[3]
    assert after[1] >= after[2]


def test_no_node_gains_a_number():
    """The point of three separate arrays. `age_ma` is not an input here and
    not an output; the pass returns positions only."""
    age = np.full(8, NAN, dtype=np.float32)
    age[0] = 250.0
    layout = np.array([250.0, 100.0, 60.0, 25.9, 0, 0, 0, 0], dtype=np.float32)
    bound, *_ = fossils.layout_bounds(_bound_db([(3, 0, 66.0)]), LAYOUT_PARENT, age)
    after, _, _ = fossils.bound_layout(layout, age, LAYOUT_PARENT, bound)
    assert np.isnan(age[3])
    assert after.dtype == np.float32


def test_a_dated_node_never_moves():
    """Its layout position is the figure printed on its card. Moving it would
    make the number and the picture disagree — a different, worse failure."""
    age = np.array([250.0, 90.0, NAN, NAN, NAN, NAN, NAN, NAN], dtype=np.float32)
    layout = np.array([250.0, 90.0, 60.0, 25.9, 0, 0, 0, 0], dtype=np.float32)
    bound, *_ = fossils.layout_bounds(_bound_db([(3, 0, 200.0)]), LAYOUT_PARENT, age)
    after, _, conflicts = fossils.bound_layout(layout, age, LAYOUT_PARENT, bound)
    assert after[1] == pytest.approx(90.0)
    # The descendant is pulled back to it rather than inverting the tree, and
    # the disagreement is counted rather than silently absorbed.
    assert after[3] <= after[1]
    assert conflicts >= 1


def test_the_result_is_monotone_root_to_tip():
    age = np.full(8, NAN, dtype=np.float32)
    age[0] = 250.0
    layout = np.array(
        [250.0, 100.0, 60.0, 25.9, 10.0, 80.0, 5.0, 3.0], dtype=np.float32
    )
    bound, *_ = fossils.layout_bounds(
        _bound_db([(3, 0, 66.0), (7, 0, 40.0)]), LAYOUT_PARENT, age
    )
    after, _, _ = fossils.bound_layout(layout, age, LAYOUT_PARENT, bound)
    for i in range(1, 8):
        assert after[i] <= after[LAYOUT_PARENT[i]] + 1e-3
