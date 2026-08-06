"""Forgiving a typo, and refusing to forgive a missing name.

A typo (`ardvark`, `betual`) is one or two edits from a string the corpus holds.
A missing name (`hard maple` for *Acer saccharum*, not in the corpus) is 3–4
edits from anything real, and a matcher loose enough to reach it would be wrong
more often than right. This fixes the first and is designed so no tuning fixes
the second.

# The shape

Correct the query; never relax the matcher. Nothing here runs on the hot path:
`/v1/search` is unchanged, and only when it returns nothing does the server ask
this index for a spelling and re-run the same pipeline. Recall and ranking are
separate:

1. Recall is a phonetic key, an indexed column (the server is pure-Go
   `modernc.org/sqlite` and cannot load `spellfix1`/`editdist3`).
2. Ranking is Damerau-Levenshtein, in Go, over the handful the key returns.

# The key, and why it is not Double Metaphone

The key must be computed identically in Python (corpus) and Go (query), or the
lookup silently returns nothing. Double Metaphone is hundreds of order-dependent
rules — two ports, two chances to disagree invisibly — so the key is fifteen
lines instead:

    lowercase, ASCII only, split on non-alphanumerics; then per word —
    `ph` -> `f`, drop non-initial `h`, keep the first letter, drop vowels
    (including `y`) and collapse runs of the same letter.

    aardvark, ardvark  -> ardvrk    ;    dolphin, dolfin -> dlfn

Plain vowel-dropping scores 16/20 on measured misspellings; `ph`->`f` and silent
`h` take it to 19/20. Every further sound rule was refused for costing precision
(folding `z`/`q` puts the benchmark `zzzqqq` in a 69-candidate bucket).

Non-ASCII words (0.27% of the corpus) are not indexed, which avoids a Unicode
normalisation dependency in Go for a slice nobody misspells.

# Words, not whole names

The unit is the word. Whole-name matching is 7x larger and cannot correct
`betual pendula` at all, since the misspelling is in the leading token. Words are
denser, so the precision cost is short words: every measured false correction was
a single edit on four or five characters, so a word shorter than `MIN_CORRECTED`
is never corrected — taking the false-correction rate from 25.3% to 0.5% while
costing nothing (every real misspelling is six characters or longer).

Other guards: a word the corpus already holds is never a typo; a correction that
yields nothing is not reported; the edit cap is length-relative (one under ten
characters, two at ten or more).

# What this deliberately does not fix

`hard maple` produces no candidates: its key `hrd mpl` does not connect to
`sugar maple`'s `sgr mpl`. That is correct — a phase 6 coverage gap, not a
matcher failure.
"""

from __future__ import annotations

import re
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Iterable, Iterator

    from .typing_ import Log

SCHEMA = """
DROP TABLE IF EXISTS spelling;

-- One row per distinct word across every name the search can match, keyed by
-- the phonetic key above. `n` is how many distinct names carry the word, and it
-- is the tiebreak between two candidates at the same edit distance — the more
-- widely used spelling wins, which is the only ordering signal a bare word has.
CREATE TABLE spelling (
  key  TEXT NOT NULL,
  word TEXT NOT NULL,
  n    INTEGER NOT NULL
);
"""

INDEXES = """
CREATE INDEX spelling_key ON spelling(key);
"""

VOWELS = frozenset("aeiouy")
_WORD = re.compile(r"[a-z0-9]+")

# A word shorter than this is never corrected, and the floor is where all the
# measured precision lives. See the module docstring.
MIN_CORRECTED = 6

# Nothing shorter than this can be the *target* of a correction either, so there
# is no reason to index it: a query word is at least MIN_CORRECTED long and may
# move by at most MAX_DISTANCE_LONG.
MIN_INDEXED = 4

# The edit budget, relative to the length of the word being corrected. One edit
# is generous on six characters and meaningless on twenty.
LONG_WORD = 10
MAX_DISTANCE_SHORT = 1
MAX_DISTANCE_LONG = 2


def distance_cap(word: str) -> int:
    """The most edits a word of this length may move and still be the same word."""
    return MAX_DISTANCE_SHORT if len(word) < LONG_WORD else MAX_DISTANCE_LONG


def words(text: str) -> list[str]:
    """Split a name into the words this index holds.

    Returns nothing for any non-ASCII string rather than splitting around it
    (`aapajärvensis` must not become `aapaj` + `rvensis`). Go applies the same
    test.
    """
    if not text.isascii():
        return []
    return _WORD.findall(text.lower())


def fold_ph(word: str) -> str:
    """`ph`/`f` are the same sound, folded for both the key and the distance.

    Must be in both: folding it into the key alone puts `elefant` in `elephant`'s
    bucket, then the distance charges two edits over a cap of one. Not a wider
    cap — one substitution just stops being counted twice. Mirrored by `foldPH`
    in the serving binary.
    """
    return word.replace("ph", "f")


def spelling_key(word: str) -> str:
    """The phonetic key of one already-lowercased ASCII word.

    Mirrored exactly by `spellingKey` in the serving binary, and pinned to it by
    a Go test that reads sampled rows out of this table and recomputes them.
    That test is the contract; this docstring is only the reason for it.
    """
    w = fold_ph(word)
    w = w[:1] + w[1:].replace("h", "")
    if not w:
        return ""
    out = [w[0]]
    for c in w[1:]:
        if c in VOWELS or c == out[-1]:
            continue
        out.append(c)
    return "".join(out)


def damerau(a: str, b: str, cap: int) -> int:
    """Optimal string alignment distance, abandoning once it exceeds `cap`.

    Transpositions count as one edit: `betual` -> `betula` is one swap, and
    under plain Levenshtein it is two, tying with `betual` -> `betel` (a
    different plant) where the shorter string would win.
    """
    la, lb = len(a), len(b)
    if abs(la - lb) > cap:
        return cap + 1
    prev2: list[int] = []
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        for j in range(1, lb + 1):
            cur[j] = min(
                prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1])
            )
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        if min(cur) > cap:
            return cap + 1
        prev2, prev = prev, cur
    return prev[lb]


# --------------------------------------------------------------------------
# Building
# --------------------------------------------------------------------------


def _table_exists(con: sqlite3.Connection, name: str) -> bool:
    return (
        con.execute(
            "SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') "
            "AND name = ?",
            (name,),
        ).fetchone()[0]
        > 0
    )


def corpus_names(con: sqlite3.Connection) -> Iterator[str]:
    """Every distinct string `/v1/search` can match, from both catalogues.

    Both `search_name` and `fossil`, so `triceratopps` can reach *Triceratops*
    (a PBDB taxon, not a node).
    """
    seen: set[str] = set()
    sources = ["SELECT DISTINCT name FROM search_name"]
    if _table_exists(con, "fossil"):
        sources.append("SELECT DISTINCT name FROM fossil WHERE trim(name) <> ''")
    for sql in sources:
        for (name,) in con.execute(sql):
            if not name or name in seen:
                continue
            seen.add(name)
            yield name


def word_counts(names: Iterable[str]) -> dict[str, int]:
    """Distinct-name frequency per indexable word."""
    counts: dict[str, int] = {}
    for name in names:
        for w in set(words(name)):
            if len(w) >= MIN_INDEXED:
                counts[w] = counts.get(w, 0) + 1
    return counts


def build(con: sqlite3.Connection, log: Log = print) -> dict[str, int]:
    t0 = time.monotonic()
    con.executescript(SCHEMA)
    counts = word_counts(corpus_names(con))
    con.executemany(
        "INSERT INTO spelling VALUES (?,?,?)",
        ((spelling_key(w), w, n) for w, n in counts.items()),
    )
    con.commit()
    con.executescript(INDEXES)
    con.commit()
    log(f"  spelling: {len(counts):,} words in {time.monotonic() - t0:,.1f}s")
    return counts


# --------------------------------------------------------------------------
# Querying — the reference implementation of what the serving binary does
# --------------------------------------------------------------------------


def correct_word(con: sqlite3.Connection, word: str) -> str | None:
    """The best spelling of one word, or None to leave it exactly as typed."""
    if len(word) < MIN_CORRECTED:
        return None
    cap = distance_cap(word)
    rows = con.execute(
        "SELECT word, n FROM spelling WHERE key = ?", (spelling_key(word),)
    ).fetchall()
    # Both sides folded, since the bucket was built on the folded form.
    folded = fold_ph(word)
    best: tuple[int, int, int, str] | None = None
    for candidate, n in rows:
        # A word the corpus holds is registered, not a typo.
        if candidate == word:
            return None
        d = damerau(folded, fold_ph(candidate), cap)
        if d > cap:
            continue
        # Distance, then more widely used, then shorter, then lexicographic —
        # so the answer never depends on row order.
        scored = (d, -n, len(candidate), candidate)
        if best is None or scored < best:
            best = scored
    return best[3] if best is not None else None


def correct(con: sqlite3.Connection, text: str) -> str | None:
    """A better spelling of the whole query, or None if nothing was misspelled.

    Word by word, since with typeahead the misspelling that matters is in the
    leading token (`betual` kills the query before `pendula` is typed).
    """
    parts = words(text)
    if not parts:
        return None
    out = [correct_word(con, w) or w for w in parts]
    return " ".join(out) if out != parts else None


# --------------------------------------------------------------------------
# Gates
# --------------------------------------------------------------------------

# Real misspellings, and what they must reach. The first two were typed at
# concestor.com and pulled from Workers Logs; the rest are the ordinary English
# misspellings of animals a curious reader is most likely to make.
CORRECTIONS: tuple[tuple[str, str], ...] = (
    ("ardvark", "aardvark"),
    # The `ph`/`f` pair the key was built for, and which nothing reached until
    # the distance folded it too. See fold_ph.
    ("elefant", "elephant"),
    ("dolfin", "dolphin"),
    ("betual", "betula"),
    ("betual pendula", "betula pendula"),
    ("rinoceros", "rhinoceros"),
    ("gorila", "gorilla"),
    ("cheeta", "cheetah"),
    ("mosquitto", "mosquito"),
    ("aligator", "alligator"),
    ("pengiun", "penguin"),
    ("triceratopps", "triceratops"),
)

# Strings that must come back **uncorrected**, and each is a different way the
# feature could go wrong rather than ten of the same test.
#
#   hard maple  a real common name the corpus lacks — the whole point of the
#               issue, and no threshold here may reach it
#   hard oak    the same shape, typed by the same reader minutes later
#   zzzqqq      this project's own benchmark string, which is in the log corpus
#   suag, abot  short-word false positives, refused by MIN_CORRECTED
#   about       a *command*, not a taxon; the palette answers it client-side
#   pleasy      a six-letter non-word with 75 candidates in its bucket, all of
#               them further than one edit away — the cap doing its job
#   dog, whale  ordinary queries that already work and must not be touched
REFUSALS: tuple[str, ...] = (
    "hard maple",
    "hard oak",
    "zzzqqq",
    "suag",
    "abot",
    "about",
    "pleasy",
    "amt",
    "dog",
    "whale",
)
