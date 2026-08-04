"""Typo tolerance, and the refusals that keep it honest.

Two layers, the same shape as `test_search.py`. The key and the distance are
pure functions and are tested directly; the corrector is run over a miniature
index built in memory, so the rules are proved without a 1.9 GB database. The
tests that need the real corpus are marked and skip without it.

The refusal tests matter at least as much as the recall ones. A corrector is
easy to make *more* forgiving and the pressure to do so is one-directional —
somebody will meet `hard maple` returning nothing and reach for the threshold.
`test_refuses_*` is what makes that reach fail.
"""

import sqlite3

import pytest

from concestor_build import spelling
from concestor_build.topology import DB

# --------------------------------------------------------------------------
# The key
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("aardvark", "ardvark"),
        ("betula", "betual"),
        ("rhinoceros", "rinoceros"),
        ("dolphin", "dolfin"),
        ("gorilla", "gorila"),
        ("cheetah", "cheeta"),
        ("penguin", "pengiun"),
        ("tyrannosaurus", "tyranosaurus"),
        ("mosquito", "mosquitto"),
    ],
)
def test_key_collapses_a_misspelling_onto_its_word(a, b):
    assert spelling.spelling_key(a) == spelling.spelling_key(b)


def test_key_keeps_hard_maple_away_from_sugar_maple():
    """The single most important assertion in this file.

    `hard maple` is a genuine common name for *Acer saccharum* that phase 6
    does not carry. It is not a typo and nothing here may pretend it is: the
    keys differ in their first word, so the query produces no candidates at all
    and the distance code is never even reached.
    """
    assert [spelling.spelling_key(w) for w in spelling.words("hard maple")] != [
        spelling.spelling_key(w) for w in spelling.words("sugar maple")
    ]


def test_key_does_not_fold_the_benchmark_string_into_anything():
    """`zzzqqq` is one of this project's own benchmark strings and is in the
    query log. Folding `z` to `s` and `q` to `k` — the obvious next English
    sound rules — puts it in a bucket with 69 real candidates. It has its own
    key here, which is why those rules are not in `spelling_key`."""
    assert spelling.spelling_key("zzzqqq") == "zq"


def test_non_ascii_words_are_refused_whole():
    """Never split around the accent: `aapaj` and `rvensis` are not words, and
    a corrector let loose on them would correct them to other things."""
    assert spelling.words("aapajärvensis") == []
    assert spelling.words("Betula pendula") == ["betula", "pendula"]


def test_words_splits_on_punctuation():
    assert spelling.words("Abbott's Sea-eagle") == ["abbott", "s", "sea", "eagle"]


# --------------------------------------------------------------------------
# The distance
# --------------------------------------------------------------------------


def test_transposition_is_one_edit():
    """The reason this is Damerau and not Levenshtein. Under plain Levenshtein
    `betual` is two edits from `betula` *and* two from `betel`, and the shorter
    string wins the tie — so the reader who typed a birch got a different
    plant."""
    assert spelling.damerau("betual", "betula", 2) == 1
    assert spelling.damerau("betual", "betel", 2) == 2


def test_distance_abandons_past_the_cap():
    """The cap is an argument rather than a filter on the answer, so a long
    pair costs a band of the matrix instead of all of it."""
    assert spelling.damerau("zzzqqq", "zaqiqah", 1) > 1


def test_cap_is_relative_to_length():
    assert spelling.distance_cap("betual") == 1
    assert spelling.distance_cap("triceratopps") == 2


# --------------------------------------------------------------------------
# The corrector, over a miniature index
# --------------------------------------------------------------------------


@pytest.fixture
def tiny():
    """A hand-built index holding just enough to exercise every rule."""
    con = sqlite3.connect(":memory:")
    con.executescript(spelling.SCHEMA)
    words = {
        "aardvark": 3,
        "betula": 9,
        "pendula": 40,
        "sugar": 30,
        "maple": 12,
        "hard": 5,
        "dolphin": 8,
        "sag": 60,
        "saga": 25,
        "abut": 4,
        # A real taxon name that happens to be a common misspelling of another
        # word. The corpus holds it, so it is not a typo.
        "racoon": 1,
    }
    con.executemany(
        "INSERT INTO spelling VALUES (?,?,?)",
        ((spelling.spelling_key(w), w, n) for w, n in words.items()),
    )
    con.executescript(spelling.INDEXES)
    return con


def test_corrects_a_real_logged_typo(tiny):
    assert spelling.correct(tiny, "ardvark") == "aardvark"


def test_corrects_only_the_misspelled_word(tiny):
    """With typeahead the misspelling that matters is in the *leading* token: a
    trailing one still has the prefix's results on screen, while `betual` kills
    the query before `pendula` is ever typed."""
    assert spelling.correct(tiny, "betual pendula") == "betula pendula"


def test_refuses_a_name_the_corpus_does_not_have(tiny):
    """`hard maple` is the issue's whole subject. Both its words are real, so
    there is nothing to correct, and it must stay a coverage gap rather than
    become a bad suggestion."""
    assert spelling.correct(tiny, "hard maple") is None


def test_refuses_a_short_word(tiny):
    """`suag` is one legal edit from `sag`, which is where every measured false
    correction came from. The floor is the only thing refusing it, and without
    it the false-correction rate on random four-letter strings is 25%."""
    assert spelling.damerau("suag", "sag", 1) == 1
    assert spelling.correct(tiny, "suag") is None


def test_refuses_a_word_the_corpus_already_holds(tiny):
    """Somebody registered a taxon called `racoon`. The search answers it, so
    this never runs — and if it did run it would take the reader off a real
    name and onto a guess."""
    assert spelling.correct(tiny, "racoon") is None


def test_refuses_when_nothing_is_within_the_cap(tiny):
    assert spelling.correct(tiny, "zzzqqq") is None


def test_ties_break_on_use_rather_than_row_order():
    """Two candidates can be equally close, and then nothing about the strings
    separates them. The more widely used spelling wins, so the answer does not
    depend on the order SQLite happens to return rows in — which is how
    `betual` came back `betel` rather than `Betula`, for being one character
    shorter."""
    con = sqlite3.connect(":memory:")
    con.executescript(spelling.SCHEMA)
    # Same key, same length, both exactly one edit from `bandicot`.
    for word, n in (("bandicit", 2), ("bandicat", 90)):
        con.execute(
            "INSERT INTO spelling VALUES (?,?,?)",
            (spelling.spelling_key(word), word, n),
        )
    con.executescript(spelling.INDEXES)
    assert spelling.damerau("bandicot", "bandicit", 1) == 1
    assert spelling.damerau("bandicot", "bandicat", 1) == 1
    assert spelling.correct_word(con, "bandicot") == "bandicat"


# --------------------------------------------------------------------------
# Against the built corpus
# --------------------------------------------------------------------------


def _built() -> bool:
    if not DB.exists():
        return False
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return bool(
            con.execute(
                "SELECT count(*) FROM sqlite_master WHERE name = 'spelling'"
            ).fetchone()[0]
        )
    finally:
        con.close()


built = pytest.mark.skipif(not _built(), reason="run `concestor-build search` first")


@pytest.fixture(scope="module")
def con():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    yield c
    c.close()


@built
@pytest.mark.parametrize(("typo", "want"), spelling.CORRECTIONS)
def test_real_corpus_corrects(con, typo, want):
    assert spelling.correct(con, typo) == want


@built
@pytest.mark.parametrize("query", spelling.REFUSALS)
def test_real_corpus_refuses(con, query):
    assert spelling.correct(con, query) is None


@built
def test_every_indexed_word_recomputes_to_its_key(con):
    """The key is a stored column, so it can be stale in a way nothing else
    notices — the same trap `fossil_index_miskeyed` exists for. Sampled from
    both ends of the keyspace, because a key computed by an older version of
    this function agrees across a whole region and diverges outside it."""
    rows = []
    for direction in ("ASC", "DESC"):
        rows += con.execute(
            f"SELECT key, word FROM spelling ORDER BY word {direction} LIMIT 500"
        ).fetchall()
    assert [w for k, w in rows if spelling.spelling_key(w) != k] == []
