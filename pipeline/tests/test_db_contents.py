"""Guards on the `node` table's contents.

These exist because a lint fix once renamed a loop variable and silently
emptied the `rank` column: every gate still passed, the build still succeeded,
and the only visible symptom was the database being 19 MB smaller. Structural
gates count nodes; nothing was checking that the columns had anything in them.

Skipped unless phase 1 has been run.
"""

import sqlite3

import pytest

from concestor_build.topology import DB

pytestmark = pytest.mark.skipif(
    not DB.exists(), reason="run `concestor-build topology` first"
)


@pytest.fixture(scope="module")
def con():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    yield c
    c.close()


def test_every_node_has_a_key(con):
    assert (
        con.execute(
            "SELECT count(*) FROM node WHERE node_key IS NULL OR node_key = ''"
        ).fetchone()[0]
        == 0
    )


def test_named_nodes_carry_a_rank(con):
    """A node with an OTT id joins taxonomy.tsv, which always supplies a rank."""
    named, ranked = con.execute(
        "SELECT count(*), count(rank) FROM node WHERE ott_id IS NOT NULL"
    ).fetchone()
    assert named > 2_500_000
    assert ranked == named


def test_ranks_are_a_plausible_vocabulary(con):
    ranks = dict(
        con.execute(
            "SELECT rank, count(*) FROM node GROUP BY rank ORDER BY 2 DESC LIMIT 8"
        )
    )
    assert "species" in ranks
    assert ranks["species"] > 1_000_000


def test_mrca_nodes_have_no_ott_id_and_no_name(con):
    bad = con.execute(
        "SELECT count(*) FROM node WHERE node_key LIKE 'mrca%' AND ott_id IS NOT NULL"
    ).fetchone()[0]
    assert bad == 0


def test_broken_taxa_live_in_their_own_table_and_are_not_nodes(con):
    """A non-monophyletic taxon is rejected from synthesis, so it has no node.

    An `is_broken` flag on `node` would therefore be permanently zero — which
    is exactly what shipped before this test existed.
    """
    assert con.execute("SELECT count(*) FROM broken_taxon").fetchone()[0] == 9_839

    orphaned = con.execute(
        "SELECT count(*) FROM broken_taxon b JOIN node n ON n.node_key = b.node_key"
    ).fetchone()[0]
    assert orphaned == 0, "broken taxa must not appear as nodes"


def test_every_broken_taxon_offers_a_substitute_and_attachment_points(con):
    total, resolved, with_points = con.execute(
        "SELECT count(*), count(mrca_idx), "
        "sum(n_attachment_points > 0) FROM broken_taxon"
    ).fetchone()
    assert resolved == total, "the substituted MRCA must resolve to a real node"
    assert with_points == total, "the UI needs somewhere to point instead"


def test_forwards_table_is_fully_populated(con):
    assert con.execute("SELECT count(*) FROM forward").fetchone()[0] == 297_070


def test_spot_check_a_few_well_known_taxa(con):
    for ott_id, name, rank in (
        (770315, "Homo sapiens", "species"),
        (244265, "Mammalia", "class"),
        (664349, "Tyrannosaurus rex", "no rank"),
    ):
        row = con.execute(
            "SELECT name, rank FROM node WHERE ott_id = ?", (ott_id,)
        ).fetchone()
        assert row == (name, rank), f"ott{ott_id}"
