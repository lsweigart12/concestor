"""Phase 6's contents, and the two things that would silently corrupt them.

The first is ColDP's compound synonym id (`txn:{accepted}#{name}`), which maps
a synonym onto the accepted taxon's number and produced an 11% error rate in
phase-3 testing. The second is a Wikidata item claiming an OTT id that belongs
to a different taxon — 770315 is claimed by both *Homo sapiens* and *Homo
floresiensis* — which without a filter makes the palette answer confidently
and wrongly.

Neither shows up in a row count.
"""

import sqlite3

import pytest

from concestor_build.topology import DB
from concestor_build.vernaculars import (
    EXPECT_PBDB_AMBIGUOUS,
    EXPECT_PBDB_ROWS,
    EXPECT_PBDB_UNMATCHED,
    ISO3_TO_BCP47,
    LANGS,
    PBDB_ZIP,
    SPOT_CHECKS,
    read_pbdb,
)

# --------------------------------------------------------------------------
# The offline source
# --------------------------------------------------------------------------

pbdb = pytest.mark.skipif(
    not PBDB_ZIP.exists(), reason="run `concestor-build snapshot` first"
)


@pytest.fixture(scope="module")
def pbdb_rows():
    return read_pbdb(log=lambda _: None)


@pbdb
def test_pbdb_vernaculars_are_all_there(pbdb_rows):
    assert len(pbdb_rows) == EXPECT_PBDB_ROWS


@pbdb
def test_pbdb_taxon_ids_are_never_coldp_compound_ids(pbdb_rows):
    """`read_pbdb` raises rather than silently mapping a synonym onto a taxon."""
    assert all("#" not in r.source_id for r in pbdb_rows if r.source_id)


@pbdb
def test_pbdb_rows_carry_the_scientific_name_they_will_be_joined_on(pbdb_rows):
    assert all(r.sci_name for r in pbdb_rows)


@pbdb
def test_pbdb_language_is_normalised_to_bcp47(pbdb_rows):
    """ColDP says `eng`; every consumer downstream expects `en`."""
    assert {r.lang for r in pbdb_rows} == {"en"}
    assert ISO3_TO_BCP47["eng"] == "en"


@pbdb
def test_pbdb_keeps_the_upstream_id_for_phase_three(pbdb_rows):
    assert all(r.source_id and r.source_id.startswith("txn:") for r in pbdb_rows)


# --------------------------------------------------------------------------
# The built table
# --------------------------------------------------------------------------


def _has_table() -> bool:
    if not DB.exists():
        return False
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return (
            con.execute(
                "SELECT count(*) FROM sqlite_master WHERE name = 'vernacular'"
            ).fetchone()[0]
            > 0
        )
    finally:
        con.close()


built = pytest.mark.skipif(
    not _has_table(), reason="run `concestor-build vernaculars` first"
)


@pytest.fixture(scope="module")
def con():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    yield c
    c.close()


@built
def test_every_row_carries_a_name_and_a_language(con):
    assert (
        con.execute(
            "SELECT count(*) FROM vernacular "
            "WHERE name IS NULL OR trim(name) = '' OR lang IS NULL OR lang = ''"
        ).fetchone()[0]
        == 0
    )
    assert {r[0] for r in con.execute("SELECT DISTINCT lang FROM vernacular")} <= set(
        LANGS
    )


@built
def test_resolved_rows_point_at_a_real_node(con):
    assert (
        con.execute(
            "SELECT count(*) FROM vernacular v LEFT JOIN node n ON n.idx = v.idx "
            "WHERE v.idx IS NOT NULL AND n.idx IS NULL"
        ).fetchone()[0]
        == 0
    )


@built
def test_unresolved_rows_are_recorded_rather_than_guessed_at(con):
    """Ambiguity is data, not an error. Phase 3 needs the taxon_no to fix it."""
    amb = con.execute(
        "SELECT count(*) FROM vernacular WHERE idx IS NULL AND source = 'pbdb_coldp'"
    ).fetchone()[0]
    assert amb == EXPECT_PBDB_AMBIGUOUS + EXPECT_PBDB_UNMATCHED
    assert (
        con.execute(
            "SELECT count(*) FROM vernacular WHERE idx IS NULL AND source_id IS NULL"
        ).fetchone()[0]
        == 0
    )


@built
def test_no_vernacular_merely_repeats_its_own_scientific_name(con):
    """Otherwise an exact binomial could be tied by a 'vernacular' of itself."""
    assert (
        con.execute(
            "SELECT count(*) FROM vernacular v JOIN node n ON n.idx = v.idx "
            "WHERE lower(n.name) = lower(v.name)"
        ).fetchone()[0]
        == 0
    )


@built
def test_no_wikidata_name_shadows_another_taxons_scientific_name(con):
    assert (
        con.execute(
            "SELECT count(*) FROM vernacular v WHERE v.source = 'wikidata' "
            "AND EXISTS (SELECT 1 FROM node n WHERE n.name = v.name "
            "AND (v.idx IS NULL OR n.idx <> v.idx))"
        ).fetchone()[0]
        == 0
    )


@built
def test_exactly_one_headline_name_per_node_and_language(con):
    assert (
        con.execute(
            "SELECT count(*) FROM (SELECT idx, lang FROM vernacular "
            "WHERE is_primary = 1 GROUP BY idx, lang HAVING count(*) > 1)"
        ).fetchone()[0]
        == 0
    )


@built
@pytest.mark.parametrize(("common", "expected"), SPOT_CHECKS)
def test_the_words_a_person_actually_types(con, common, expected):
    """Reachability only. Which of them ranks first is `test_search.py`'s job."""
    got = [
        r[0]
        for r in con.execute(
            "SELECT n.name FROM vernacular v JOIN node n ON n.idx = v.idx "
            "WHERE lower(v.name) = ? AND v.lang = 'en'",
            (common,),
        )
    ]
    assert got, f"{common!r} resolves to nothing"
    assert set(got) & set(expected), got
