"""The palette's front door.

The load-bearing assertion is behavioural: typing `dog`, `T. rex`, `shark`,
`human` or `Homo sapiens` must put the taxon a person means at the top.

Two layers. `test_ranking_*` runs the real `query()` over a miniature in-memory
index; the rest run against the built artifact and skip without it.
"""

import math
import sqlite3

import pytest

from concestor_build.search import (
    INDEXES,
    KIND_ABBR,
    KIND_BROKEN,
    KIND_PBDB,
    KIND_SCI,
    KIND_SYN,
    KIND_VERN,
    SCHEMA,
    W_VERNACULAR,
    abbreviate,
    build_fossil_index,
    fossil_index_miskeyed,
    fossil_index_recall,
    match_expression,
    query,
)
from concestor_build.topology import DB

# --------------------------------------------------------------------------
# Abbreviated binomials
# --------------------------------------------------------------------------


def test_abbreviate_binomial():
    assert abbreviate("Tyrannosaurus rex") == "T. rex"
    assert abbreviate("Homo sapiens") == "H. sapiens"


def test_abbreviate_trinomial_abbreviates_every_leading_token():
    assert abbreviate("Canis lupus familiaris") == "C. l. familiaris"


def test_abbreviate_declines_anything_not_linnean():
    assert abbreviate("Mammalia") is None  # uninomial
    assert abbreviate("T. rex") is None  # already abbreviated
    assert abbreviate("a b c d e f") is None  # not a name


def test_abbreviate_never_returns_the_input():
    for name in ("Homo sapiens", "Canis lupus familiaris", "Mammalia"):
        assert abbreviate(name) != name


# --------------------------------------------------------------------------
# Query construction
# --------------------------------------------------------------------------


def test_match_expression_is_a_prefixed_phrase():
    assert match_expression("Homo sap") == '"homo sap"*'


def test_match_expression_strips_the_punctuation_fts5_would_drop_anyway():
    # This is the whole reason abbreviations are indexed as generated rows:
    # `T.` cannot become a prefix term, because FTS5 allows `*` only on a
    # phrase's final token.
    assert match_expression("T. rex") == '"t rex"*'
    assert match_expression("  T-Rex  ") == '"t rex"*'


def test_match_expression_survives_empty_input():
    assert match_expression("   ") == '""'


# --------------------------------------------------------------------------
# Ranking, on a miniature index
# --------------------------------------------------------------------------

# (idx, name, rank, tip_count)
MINI_NODES = (
    (1, "Mammalia", "class", 9328),
    (2, "Homo sapiens", "species", 2),
    (3, "Tyrannosaurus rex", "no rank", 1),
    (4, "Tachyoryctes rex", "species", 1),
    (5, "Canis lupus familiaris", "subspecies", 1),
    (6, "Selachii", "no rank", 723),
    (7, "Sharpiella", "genus", 3),
    (8, "Homo", "genus", 4),
    (9, None, None, 40),  # an unnamed mrca* node, the E. coli substitute
    (10, "Escherichia albertii", "species", 5),
)
# (idx, kind, name)
MINI_NAMES = (
    (2, KIND_VERN, "human"),
    (5, KIND_VERN, "dog"),
    (6, KIND_VERN, "shark"),
    (3, KIND_VERN, "T. rex"),
    (1, KIND_VERN, "mammal"),
    (5, KIND_SYN, "Canis familiaris"),
    # Not a node: rejected from synthesis, pointed at its substituted MRCA.
    (9, KIND_BROKEN, "Escherichia coli"),
)


@pytest.fixture
def mini():
    con = sqlite3.connect(":memory:")
    con.executescript(
        "CREATE TABLE node (idx INTEGER PRIMARY KEY, ott_id INTEGER, name TEXT, "
        "rank TEXT, tip_count INTEGER NOT NULL);"
    )
    con.executemany(
        "INSERT INTO node (idx, name, rank, tip_count) VALUES (?,?,?,?)", MINI_NODES
    )
    con.executescript(SCHEMA)

    rows = [(idx, KIND_SCI, name) for idx, name, _, _ in MINI_NODES if name]
    for idx, name, _, _ in MINI_NODES:
        short = abbreviate(name) if name else None
        if short is not None:
            rows.append((idx, KIND_ABBR, short))
    rows.extend(MINI_NAMES)

    # The real build computes the score in numpy; the formula is what matters.
    n_vern: dict[int, int] = {}
    for idx, kind, _ in rows:
        if kind == KIND_VERN:
            n_vern[idx] = n_vern.get(idx, 0) + 1
    score = {
        idx: math.log1p(tip_count)
        + W_VERNACULAR * min(math.log1p(n_vern.get(idx, 0)) / math.log1p(10.0), 1.0)
        for idx, _, _, tip_count in MINI_NODES
    }
    con.executemany(
        "INSERT INTO search_rank VALUES (?,?,?,?,?,?)",
        [
            (idx, tip_count, 0, 0, n_vern.get(idx, 0), score[idx])
            for idx, _, _, tip_count in MINI_NODES
        ],
    )

    # `id` encodes rank, exactly as `renumber_by_rank` does it — including
    # sending every name that is not a node to the very end.
    rows.sort(key=lambda r: (r[1] == KIND_BROKEN, -score[r[0]], r[1], len(r[2]), r[2]))
    con.executemany(
        "INSERT INTO search_name (id, idx, kind, name) VALUES (?,?,?,?)",
        [(i, idx, kind, name) for i, (idx, kind, name) in enumerate(rows, 1)],
    )
    con.execute(
        f"""
        INSERT INTO node_fts(rowid, sci, abbr, syn, vern, broken)
        SELECT id,
               CASE WHEN kind = {KIND_SCI}    THEN name END,
               CASE WHEN kind = {KIND_ABBR}   THEN name END,
               CASE WHEN kind = {KIND_SYN}    THEN name END,
               CASE WHEN kind = {KIND_VERN}   THEN name END,
               CASE WHEN kind = {KIND_BROKEN} THEN name END
          FROM search_name
        """
    )
    con.executescript(INDEXES)
    yield con
    con.close()


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("dog", "Canis lupus familiaris"),
        ("human", "Homo sapiens"),
        ("shark", "Selachii"),
        ("T. rex", "Tyrannosaurus rex"),
        ("Homo sapiens", "Homo sapiens"),
    ],
)
def test_ranking_puts_the_meant_taxon_first(mini, text, expected):
    hits = query(mini, text, limit=5)
    assert hits, f"{text!r} returned nothing at all"
    assert hits[0]["name"] == expected, [h["name"] for h in hits]


def test_ranking_prefers_an_exact_binomial_over_a_vernacular(mini):
    # `Homo sapiens` is exact in the scientific column; nothing may displace it.
    top = query(mini, "Homo sapiens", limit=3)[0]
    assert top["kind"] == "sci"
    assert top["exact"]


def test_ranking_breaks_an_abbreviation_tie_with_notability(mini):
    # Two taxa spell `T. rex`. Both are tips with tip_count 1, so the only
    # thing separating them is that one of them has a common name.
    hits = query(mini, "T. rex", limit=5)
    names = [h["name"] for h in hits]
    assert names[0] == "Tyrannosaurus rex"
    assert "Tachyoryctes rex" in names, "the loser must still be reachable"


def test_ranking_prefers_a_big_clade_over_a_small_prefix_collision(mini):
    # "shar" mid-type: Selachii (723 tips, common name) must beat the genus
    # Sharpiella (3 tips). This is architecture §4's "Canidae before Cania".
    assert query(mini, "shar", limit=5)[0]["name"] == "Selachii"


def test_ranking_surfaces_a_broken_taxon_instead_of_nothing(mini):
    """*Escherichia coli* is not a node. Returning nothing would be a lie."""
    top = query(mini, "Escherichia coli", limit=3)[0]
    assert top["kind"] == "broken"
    assert top["name"] == "Escherichia coli"


def test_ranking_never_lets_a_broken_name_outrank_a_real_one(mini):
    """The substitute MRCA has 40 tips; the rejected taxon has no size at all.

    Inheriting the substitute's score is how typing "can" came back three taxa
    that are not in the tree, ahead of every one that is.
    """
    top = query(mini, "Escherichia", limit=5)[0]
    assert top["name"] == "Escherichia albertii"
    assert top["kind"] == "sci"


def test_ranking_returns_one_row_per_taxon(mini):
    hits = query(mini, "Canis", limit=10)
    assert len({h["idx"] for h in hits}) == len(hits)


# --------------------------------------------------------------------------
# The built artifact
# --------------------------------------------------------------------------


def _index_state() -> tuple[bool, bool]:
    """`(index built, vernaculars in it)`.

    The two are separate because a build that has run `search` but not
    `vernaculars` is a legitimate intermediate state, not a failure — it is
    just one whose palette cannot answer "dog", which is the whole point of
    phase 6 and is asserted separately.
    """
    if not DB.exists():
        return False, False
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        if not con.execute(
            "SELECT count(*) FROM sqlite_master WHERE name = 'node_fts'"
        ).fetchone()[0]:
            return False, False
        n_vern = con.execute(
            f"SELECT count(*) FROM search_name WHERE kind = {KIND_VERN} LIMIT 1"
        ).fetchone()[0]
        return True, n_vern > 0
    finally:
        con.close()


_BUILT, _WITH_VERNACULARS = _index_state()

built = pytest.mark.skipif(not _BUILT, reason="run `concestor-build search` first")
built_with_vernaculars = pytest.mark.skipif(
    not _WITH_VERNACULARS,
    reason="run `concestor-build vernaculars` then `concestor-build search`",
)


@pytest.fixture(scope="module")
def con():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    yield c
    c.close()


@built
def test_built_index_answers_an_exact_binomial(con):
    assert query(con, "Homo sapiens", limit=5)[0]["name"] == "Homo sapiens"


@built
def test_built_index_answers_a_broken_taxon(con):
    """*E. coli* is rejected from synthesis; nothing else in the index has it."""
    hits = query(con, "Escherichia coli", limit=3)
    assert hits, "the most famous bacterium there is returned nothing"
    assert hits[0]["name"] == "Escherichia coli"
    assert hits[0]["kind"] == "broken"


@built
def test_built_index_reaches_tyrannosaurus_rex_by_abbreviation(con):
    """True with no vernaculars at all — this is what generating them is for."""
    assert "Tyrannosaurus rex" in [h["name"] for h in query(con, "T. rex", limit=40)]


@built_with_vernaculars
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("dog", ("Canis lupus familiaris", "Canis familiaris", "Canis lupus")),
        ("human", ("Homo sapiens", "Homo")),
        ("shark", ("Selachii", "Selachimorpha", "Elasmobranchii", "Chondrichthyes")),
        ("T. rex", ("Tyrannosaurus rex",)),
        ("Homo sapiens", ("Homo sapiens",)),
        ("animal", ("Metazoa",)),
    ],
)
def test_built_index_answers_the_palette(con, text, expected):
    hits = query(con, text, limit=5)
    assert hits, f"{text!r} returned nothing at all"
    assert hits[0]["name"] in expected, [h["name"] for h in hits]


@built
def test_every_indexed_name_carries_text(con):
    """The bug this repo already shipped once was a silently emptied column."""
    assert (
        con.execute(
            "SELECT count(*) FROM search_name WHERE name IS NULL OR trim(name) = ''"
        ).fetchone()[0]
        == 0
    )


@built
def test_all_four_corpora_are_populated(con):
    kinds = dict(con.execute("SELECT kind, count(*) FROM search_name GROUP BY kind"))
    assert kinds.get(KIND_SCI) == 2_599_664
    assert kinds.get(KIND_ABBR, 0) > 1_000_000
    assert kinds.get(KIND_SYN, 0) > 1_000_000


# --------------------------------------------------------------------------
# The fossil record's name for a taxon the tree holds
# --------------------------------------------------------------------------


@built
def test_a_taxon_the_tree_holds_is_findable_under_the_fossil_records_name(con):
    """`notInTree` refuses these rows, so this corpus is all that answers.

    *Opisthobranchiata* is PBDB's name for the taxon OTT calls *Opisthobranchia*,
    and OTT carries no synonym for it — so with the row refused and this corpus
    absent, the name reached nothing that is the taxon.
    """
    hits = query(con, "Opisthobranchiata", limit=5)
    assert hits, "a name the fossil record uses returned nothing"
    assert hits[0]["name"] == "Opisthobranchia"
    assert hits[0]["kind"] == "pbdb"


@built
def test_no_taxon_the_tree_holds_is_left_without_a_name_that_finds_it(con):
    """The whole statement, over the corpus rather than one example."""
    assert (
        con.execute(
            "SELECT count(*) FROM (SELECT DISTINCT attach_idx, name FROM fossil "
            " WHERE attach_walk = 0 AND name IS NOT NULL AND trim(name) <> '') f "
            "WHERE NOT EXISTS (SELECT 1 FROM search_name sn "
            "  WHERE sn.idx = f.attach_idx AND lower(sn.name) = lower(f.name))"
        ).fetchone()[0]
        == 0
    )


@built
def test_a_fossil_record_name_never_displaces_the_taxons_own(con):
    """It is a way in, not a rename: the row still prints the tree's name."""
    hits = query(con, "Homo sapiens", limit=3)
    assert hits[0]["name"] == "Homo sapiens"
    assert hits[0]["kind"] == "sci"


@built
def test_the_fossil_record_corpus_never_duplicates_a_name_a_node_already_has(con):
    """A duplicate row would compete with the scientific name for one taxon."""
    assert (
        con.execute(
            f"SELECT count(*) FROM search_name p JOIN search_name o "
            f"  ON o.idx = p.idx AND lower(o.name) = lower(p.name) AND o.kind <> p.kind "
            f"WHERE p.kind = {KIND_PBDB} AND o.kind <> {KIND_VERN}"
        ).fetchone()[0]
        == 0
    )


@built
def test_rank_score_is_ordered_by_clade_size(con):
    names = [
        r[0]
        for r in con.execute(
            "SELECT n.name FROM search_rank r JOIN node n ON n.idx = r.idx "
            "WHERE n.ott_id IN (93302, 244265, 770315) ORDER BY r.rank_score DESC"
        )
    ]
    assert names == ["cellular organisms", "Mammalia", "Homo sapiens"]


# --------------------------------------------------------------------------
# The fossil name index
# --------------------------------------------------------------------------
#
# `SearchFossils` used to scan all 523,112 rows on every keystroke — 100–117 ms
# in the serving binary, ~90% of `/v1/search`, and several times worse again on
# the half-vCPU container it deploys to. These cover the index that replaced it,
# and in particular the two ways of checking it that do not work.


def _fossil_db() -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    con.execute(
        "CREATE TABLE fossil (pbdb_taxon_no INTEGER PRIMARY KEY, name TEXT NOT NULL)"
    )
    con.executemany(
        "INSERT INTO fossil VALUES (?, ?)",
        [
            (1, "Triceratops horridus"),
            (2, "Eotriceratops xerinsularis"),
            (3, "Tyrannosaurus rex"),
            (4, "Nuralagus rex"),
            (5, "Rexroadus kentuckyensis"),
            (6, "   "),  # nothing indexable, and not a build failure
        ],
    )
    con.commit()
    return con


def test_fossil_index_indexes_every_indexable_name():
    con = _fossil_db()
    assert build_fossil_index(con, log=lambda *_: None) == 5


def test_fossil_index_is_skipped_when_there_is_no_fossil_table():
    con = sqlite3.connect(":memory:")
    assert build_fossil_index(con, log=lambda *_: None) == 0


def test_fossil_index_miskeyed_passes_a_correct_index():
    con = _fossil_db()
    build_fossil_index(con, log=lambda *_: None)
    assert fossil_index_miskeyed(con) == 0


def test_fossil_index_miskeyed_catches_a_shifted_key():
    """The gate that a column comparison could not answer.

    `fossil_fts` is contentless, so `SELECT f.name FROM fossil_fts f` is NULL
    and `NULL <> t.name` is NULL rather than true — the obvious join-and-compare
    check reports 0 here as readily as on a correct index. It was written that
    way first and passed against exactly this database.
    """
    con = _fossil_db()
    con.execute(
        "CREATE VIRTUAL TABLE fossil_fts USING fts5("
        "name, content='', tokenize='unicode61 remove_diacritics 2')"
    )
    con.execute(
        "INSERT INTO fossil_fts(rowid, name) "
        "SELECT pbdb_taxon_no + 1, name FROM fossil WHERE trim(name) <> ''"
    )
    con.commit()

    vacuous = con.execute(
        "SELECT count(*) FROM fossil_fts f JOIN fossil t "
        "ON t.pbdb_taxon_no = f.rowid WHERE f.name <> t.name"
    ).fetchone()[0]
    assert vacuous == 0, "the contentless comparison is supposed to be vacuous"

    assert fossil_index_miskeyed(con) > 0


def test_fossil_index_never_invents_a_row():
    con = _fossil_db()
    build_fossil_index(con, log=lambda *_: None)
    invented, _ = fossil_index_recall(con, ("triceratops", "rex", "tyrannosaurus"))
    assert invented == 0


def test_fossil_index_drops_only_mid_word_matches():
    """What the index trades away, named rather than counted.

    A token prefix reaches *Rexroadus*; nothing but a substring reaches the
    `rex` inside *Eotriceratops*. The serving binary scores that class
    `bandNone` and ranks it behind every node, which is why the loss is
    affordable — but it is a loss, and it should show up here if it ever
    changes shape.
    """
    con = _fossil_db()
    build_fossil_index(con, log=lambda *_: None)

    found = {
        r[0]
        for r in con.execute(
            "SELECT rowid FROM fossil_fts WHERE fossil_fts MATCH ?", ('"rex"*',)
        )
    }
    # Tyrannosaurus rex, Nuralagus rex — whole token; Rexroadus — token prefix.
    assert found == {3, 4, 5}

    tri = {
        r[0]
        for r in con.execute(
            "SELECT rowid FROM fossil_fts WHERE fossil_fts MATCH ?", ('"triceratops"*',)
        )
    }
    assert tri == {1}, "Eotriceratops matches only inside a word"
