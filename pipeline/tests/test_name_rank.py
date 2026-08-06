"""The name ordering, pinned against the cases it was built from.

Two halves. The first needs no database and no network: it is the scoring
itself, fed the evidence the live APIs actually returned on 2026-08-02, so a
change to the bands or the tiebreaks fails here rather than in a build. The
second reads the built table and is skipped without one.

Every fixture in the first half is a real row. `TRex`, `Ferae`, `man` and
`moth` are all names phase 6 harvested and the old election either elected or
left unordered.
"""

import sqlite3

import pytest

from concestor_build import name_rank
from concestor_build.name_rank import (
    EV_ELSEWHERE,
    EV_NONE,
    EV_REDIRECT,
    EV_TITLE,
    Candidate,
    Resolution,
    band,
    evidence,
    mangled_abbreviation,
    rank,
    shape_penalty,
    shares_stem,
)
from concestor_build.topology import DB


def c(name, kind="a", n_sources=1, wiki=None, rowid=0):
    return Candidate(rowid=rowid, name=name, kind=kind, n_sources=n_sources, wiki=wiki)


def names(ordered):
    return [x.name for x in ordered]


# --------------------------------------------------------------------------
# Evidence
# --------------------------------------------------------------------------


def test_a_taxon_with_no_article_gets_no_evidence():
    """NULL means the question could not be asked, and is not 'no page'.

    Conflating the two is how a half-finished crawl would silently demote
    every name it had not reached yet — the same shape as phase 6 keeping a
    Wikidata item that carries no P225 rather than refusing it.
    """
    res = {"dog": Resolution(normalized="Dog", target="Dog")}
    assert evidence("dog", None, res) is None
    assert evidence("never asked", "Dog", res) is None


def test_the_taxon_title_is_compared_after_its_own_redirect():
    """Wikidata gives *Homo sapiens* the sitelink `Homo sapiens`, which is a
    redirect to `Human`. Compared unresolved, every good vernacular for the
    species points 'elsewhere' and the ordering inverts."""
    res = {
        "human": Resolution(normalized="Human", target="Human"),
        "humans": Resolution(normalized="Humans", target="Human"),
        "man": Resolution(normalized="Man", target="Man"),
    }
    assert evidence("human", "Human", res) == EV_TITLE
    assert evidence("humans", "Human", res) == EV_REDIRECT
    assert evidence("man", "Human", res) == EV_ELSEWHERE


def test_a_name_that_is_no_page_at_all():
    res = {"TRex": Resolution(normalized="TRex", target=None)}
    assert evidence("TRex", "Tyrannosaurus", res) == EV_NONE


# --------------------------------------------------------------------------
# Bands
# --------------------------------------------------------------------------


def test_elsewhere_is_demoted_one_band_and_never_removed():
    """`elsewhere` is demoted one band, never removed: `man` is a name humans go
    by even though the article `Man` is about something narrower."""
    plain = c("man", kind="a")
    elsewhere = c("man", kind="a", wiki=EV_ELSEWHERE)
    assert band(elsewhere) == band(plain) + 1
    assert band(elsewhere) <= name_rank.BAND_WORST


def test_wiki_evidence_outranks_kind():
    """An alias Wikipedia files the taxon under beats a declared name it does
    not. `carnivorans` is an altLabel; `Ferae` is P1843."""
    got = names(
        rank(
            [
                c("Ferae", kind="v", wiki=EV_ELSEWHERE),
                c("carnivorans", kind="a", wiki=EV_REDIRECT),
            ],
            "Carnivora",
        )
    )
    assert got == ["carnivorans", "Ferae"]


def test_the_headline_is_the_article_title():
    got = names(
        rank(
            [
                c("humans", kind="a", wiki=EV_REDIRECT),
                c("man", kind="a", wiki=EV_ELSEWHERE),
                c("human", kind="v", wiki=EV_TITLE),
                c("human being", kind="a", wiki=EV_REDIRECT),
                c("men", kind="a", wiki=EV_ELSEWHERE),
            ],
            "Homo sapiens",
        )
    )
    assert got[0] == "human"
    assert set(got[1:3]) == {"humans", "human being"}
    assert set(got[3:]) == {"man", "men"}


def test_trex_loses_to_t_rex_on_evidence_not_on_length():
    """The old election's whole failure: `length(name)` picked `TRex` (4) over
    `T. rex` (6). `TRex` is not a page on English Wikipedia in any form."""
    got = names(
        rank(
            [
                c("TRex", kind="l", wiki=EV_NONE),
                c("T. rex", kind="a", wiki=EV_REDIRECT),
                c("T-Rex", kind="a", wiki=EV_REDIRECT),
                c("tyrant lizard king", kind="v", wiki=EV_NONE),
            ],
            "Tyrannosaurus rex",
        )
    )
    assert got[0] in {"T. rex", "T-Rex"}
    assert got.index("TRex") > 1


def test_bug_does_not_lead_insecta():
    got = names(
        rank(
            [
                c("bug", kind="a", wiki=EV_ELSEWHERE),
                c("bugs", kind="a", wiki=EV_ELSEWHERE),
                c("insects", kind="v", wiki=EV_REDIRECT),
                c("insect", kind="l", wiki=EV_TITLE),
            ],
            "Insecta",
        )
    )
    assert got[0] == "insect"
    assert got[-2:] == ["bug", "bugs"] or set(got[-2:]) == {"bug", "bugs"}


def test_length_still_breaks_a_genuine_dead_heat():
    """Kept deliberately. It is a fine way to choose between two names nothing
    else distinguishes, and a catastrophic way to choose a headline."""
    got = names(rank([c("domesticated dog"), c("dog")], "Canis lupus familiaris"))
    assert got == ["dog", "domesticated dog"]


def test_corroboration_beats_shape_inside_a_band():
    got = names(rank([c("blue whale", n_sources=2), c("Sulphur-bottom Whale")], None))
    assert got[0] == "blue whale"


# --------------------------------------------------------------------------
# Shape, which only ever decides ties inside a band
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "worse_than"),
    [
        ("Sibbold's Rorqual,", "Sibbold's Rorqual"),
        ("spider (arachnid)", "spider"),
        ("the lion", "lion"),
        ("Ferae", "carnivorans"),
        ("Zanthoxylum diversifolium Warb. (1891), non Lesq. (1878)", "prickly ash"),
    ],
)
def test_shape_penalises_the_forms_found_in_the_table(name, worse_than):
    assert shape_penalty(name) > shape_penalty(worse_than)


def test_a_plain_name_carries_no_penalty():
    for n in ("dog", "blue whale", "ray-finned fishes", "T. rex"):
        assert shape_penalty(n) == 0


def test_stem_derived_names_are_only_demoted_when_there_is_an_alternative():
    """`arthropod`, `tetrapod`, `mollusc` and `primate` are all the scientific
    name with an English ending, and all of them are the ordinary word. There
    is nothing else to call an arthropod, so the rule has to be relative."""
    assert shares_stem("lepidopteran", "Lepidoptera")
    assert shares_stem("arthropod", "Arthropoda")
    # Nothing else on offer: the stem-derived name still leads.
    only = names(
        rank([c("arthropod", kind="v"), c("arthropods", kind="a")], "Arthropoda")
    )
    assert only[0] == "arthropod"
    # An alternative exists in the same band, so it goes first.
    both = names(
        rank(
            [c("lepidopteran", kind="v"), c("butterflies and moths", kind="v")],
            "Lepidoptera",
        )
    )
    assert both[0] == "butterflies and moths"


def test_the_canonical_abbreviation_beats_its_manglings():
    """`T. rex`, `T rex` and `T-Rex` are all redirects to *Tyrannosaurus*, so
    Wikipedia does not separate them and the generic tiebreaks picked the
    shortest — headlining the app's most famous fossil as **T-Rex**.

    `X. epithet` is the standard abbreviated binomial, which is the same form
    this project's search already indexes as an abbreviation kind.
    """
    got = names(
        rank(
            [
                c("T-Rex", kind="a", wiki=EV_REDIRECT),
                c("T rex", kind="a", wiki=EV_REDIRECT),
                c("T. rex", kind="a", wiki=EV_REDIRECT),
                c("TRex", kind="l", wiki=EV_NONE),
            ],
            "Tyrannosaurus rex",
        )
    )
    assert got[0] == "T. rex"
    assert got[-1] == "TRex"


def test_the_abbreviation_rule_cannot_reach_an_ordinary_name():
    """It fires only on strings that abbreviate *this* taxon's own binomial."""
    assert mangled_abbreviation("T-Rex", "Tyrannosaurus rex")
    assert not mangled_abbreviation("T. rex", "Tyrannosaurus rex")
    assert not mangled_abbreviation("blue whale", "Balaenoptera musculus")
    assert not mangled_abbreviation("dog", "Canis lupus familiaris")
    # A clade name is not a binomial, so there is nothing to abbreviate.
    assert not mangled_abbreviation("Ferae", "Carnivora")
    got = names(
        rank(
            [
                c("B. musculus", kind="a", wiki=EV_REDIRECT),
                c("blue whale", kind="v", wiki=EV_REDIRECT),
            ],
            "Balaenoptera musculus",
        )
    )
    assert got[0] == "blue whale"


def test_stem_matching_ignores_case_and_accents():
    assert shares_stem("Dipterous", "Diptera")
    assert not shares_stem("dog", "Canis lupus familiaris")


def test_ranking_is_total_and_deterministic():
    """A repeated rank is a tie the key failed to break, and the gate on
    contiguous 1..n ranks would fail the build on it."""
    cands = [c(f"name {i}", kind="a") for i in range(20)]
    assert names(rank(cands)) == names(rank(list(reversed(cands))))


# --------------------------------------------------------------------------
# Against the built table
# --------------------------------------------------------------------------

needs_db = pytest.mark.skipif(
    not DB.exists(), reason="run `concestor-build vernaculars` and `names` first"
)


@pytest.fixture(scope="module")
def con():
    c_ = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    yield c_
    c_.close()


def _has_ranks(con: sqlite3.Connection) -> bool:
    cols = {r[1] for r in con.execute("PRAGMA table_info(vernacular)")}
    if "usage_rank" not in cols:
        return False
    return (
        con.execute(
            "SELECT count(*) FROM vernacular WHERE usage_rank IS NOT NULL"
        ).fetchone()[0]
        > 0
    )


@needs_db
def test_every_resolved_name_is_ranked(con):
    if not _has_ranks(con):
        pytest.skip("run `concestor-build names`")
    assert (
        con.execute(
            "SELECT count(*) FROM vernacular "
            "WHERE idx IS NOT NULL AND usage_rank IS NULL"
        ).fetchone()[0]
        == 0
    )


@needs_db
def test_is_primary_cannot_disagree_with_usage_rank(con):
    if not _has_ranks(con):
        pytest.skip("run `concestor-build names`")
    assert (
        con.execute(
            "SELECT count(*) FROM vernacular "
            "WHERE is_primary <> (usage_rank = 1 AND usage_rank IS NOT NULL)"
        ).fetchone()[0]
        == 0
    )


@needs_db
def test_ranks_are_contiguous_within_a_node_and_language(con):
    if not _has_ranks(con):
        pytest.skip("run `concestor-build names`")
    assert (
        con.execute(
            "SELECT count(*) FROM (SELECT idx, lang FROM vernacular "
            "WHERE idx IS NOT NULL GROUP BY idx, lang "
            "HAVING count(DISTINCT usage_rank) <> count(*) "
            "    OR min(usage_rank) <> 1 OR max(usage_rank) <> count(*))"
        ).fetchone()[0]
        == 0
    )


@needs_db
@pytest.mark.parametrize(
    ("sci", "expect"),
    [
        ("Homo sapiens", ("human", "humans")),
        ("Canis lupus familiaris", ("dog", "dogs", "domestic dog")),
        ("Insecta", ("insect", "insects")),
        ("Carnivora", ("carnivorans", "carnivores", "carnivoran")),
        ("Tyrannosaurus rex", ("t. rex", "tyrannosaurus rex", "t rex", "t-rex")),
    ],
)
def test_the_headline_is_a_name_people_use(con, sci, expect):
    if not _has_ranks(con):
        pytest.skip("run `concestor-build names`")
    row = con.execute(
        "SELECT v.name FROM vernacular v JOIN node n ON n.idx = v.idx "
        "WHERE n.name = ? AND v.lang = 'en' AND v.usage_rank = 1 "
        "ORDER BY n.tip_count DESC LIMIT 1",
        (sci,),
    ).fetchone()
    assert row is not None, f"{sci} carries no ranked English name"
    assert row[0].lower() in expect
