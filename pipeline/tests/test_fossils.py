"""Unit tests for phase 4's attachment walk, plus guards on what it wrote.

The walk is the whole phase: everything else is a column copy. Its failure mode
is silent — a broken `xref` does not error, it just parks every fossil at the
root — so the interesting tests are the ones about *where* a taxon lands and how
far the walk had to go to put it there.
"""

import sqlite3

import pytest

from concestor_build import fossils
from concestor_build.fossils import ATTACH_METHOD_CODE, Attacher
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
