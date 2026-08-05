"""Forgiving a typo, and refusing to forgive a missing name.

Three of eighteen real queries pulled from Workers Logs returned nothing, and
they were two different problems. `ardvark` and `betual` are **typos** — one and
two edits from a string the corpus holds. `hard maple` is a correctly spelled
common name for *Acer saccharum* that the corpus simply **does not have**; its
distance to the nearest real name is 3–4 on a ten-character string, so a matcher
loose enough to reach it would be matching at 30–40% divergence and would be
wrong far more often than right. This module fixes the first kind and is
designed so that no amount of tuning can make it pretend to fix the second.

# The shape

**Correct the query; never relax the matcher.** Nothing here runs on the hot
path. `/v1/search` answers exactly as it did, and only when it has come back
with nothing at all does the serving binary ask this index for a better
spelling and run the *unchanged* pipeline again. Bands, `Interleave`,
`notInTree` and the client are untouched, and a query that was going to cost the
reader nothing but disappointment is the only one that pays for the second pass.

Recall and ranking are separate, because neither works alone:

1. **Recall is a phonetic key**, computed here and stored as an indexed column.
   `spellfix1` and `editdist3` are not available — the server is
   `modernc.org/sqlite`, pure Go, and cannot load SQLite's C extensions — so the
   textbook answer is off the table and this is the cheap half of it: a plain
   B-tree lookup returning a handful of candidates.
2. **Ranking is Damerau-Levenshtein**, in Go, over that handful.

# The key, and why it is not Double Metaphone

Double Metaphone is the obvious choice and it was refused on a cost the obvious
choice does not carry here: **the key has to exist in two languages**. Python
computes it for the corpus, Go computes it for the query, and the two must agree
character for character or the lookup silently returns nothing. Double Metaphone
is several hundred lines of dense, order-dependent rules; two ports of it are
two chances to disagree on a corpus of 1.2M words, and the failure is invisible
— a missed correction looks exactly like a word nobody misspelled.

So the key is the smallest thing that answers the measured cases, in fifteen
lines that port without judgement:

    lowercase, ASCII only, split on non-alphanumerics; then per word —
    `ph` -> `f`, drop non-initial `h`, keep the first letter, drop vowels
    (including `y`) and collapse runs of the same letter.

    aardvark, ardvark          -> ardvrk
    betula,   betual           -> btl
    rhinoceros, rinoceros      -> rncrs
    dolphin,  dolfin           -> dlfn

The two folding rules are not decoration and are not a slippery slope toward
re-deriving Metaphone one rule at a time. Measured over twenty misspellings,
plain vowel-dropping alone scores 16/20; `ph`->`f` and silent `h` take it to
19/20, and the twentieth was not a key failure at all. Every further English
sound rule that was tried — `c`/`k`, `z`/`s`, `v`/`f`, `x`/`ks` — bought
nothing and cost precision: folding `z` and `q` puts this project's own
benchmark string `zzzqqq` in a bucket with 69 candidates, where under this key
it has none.

**Non-ASCII words are not indexed and never corrected.** That is 3,424 of
1,250,845 distinct words, 0.27%, and it buys the whole of the Unicode question:
without it Go needs `golang.org/x/text` to normalise before it can agree with
Python's `NFKD`, which is a dependency and a second thing to keep in step for a
quarter of one percent of a corpus nobody misspells.

# Words, not whole names, and the floor that makes that safe

The unit is the **word**. Whole-name matching was built and measured first and
is 7x larger — 362 MB against 50.6 MB — because it stores 6.16M complete names
where this stores 1.25M distinct words, and it cannot correct `betual pendula`
at all, since the misspelling is in the leading token and the complete string is
not within an edit of anything.

Words are denser than names, though, and that is a precision cost paid in one
place: short words. Every false correction measured came from one — `suag` ->
`sag`, `about` -> `abut`, `abot` -> `abt`, each a single legal edit on four or
five characters. **So a word shorter than {@link MIN_CORRECTED} is never
corrected**, and that one rule takes the false-correction rate on random junk
from 25.3% to 0.5% while costing nothing real: every misspelling in the measured
corpus is six characters or longer. It is the same judgement `matchBand` makes
in `samePlural` — below a few characters, nothing regular relates two strings
and a rule that fires there is inventing a match.

The remaining guards, each of which refuses rather than approximates:

- **A word the corpus already holds is never a typo.** `racoon`, `squirel` and
  `tyranosaurus` are all real taxon names somebody registered, so the search
  answers them and this never runs.
- **A correction that yields nothing is not a correction.** The serving binary
  re-runs the search and reports the correction only if it produced results.
- **The cap is relative to length** — one edit under ten characters, two at ten
  or more. Two edits on six characters is 33% divergence, which is the `hard
  maple` mistake with a smaller number on it.

# What this deliberately does not fix

`hard maple` produces **no candidates at all**: its key is `hrd mpl`, `sugar
maple`'s is `sgr mpl`, and no threshold in this file connects them. That is the
correct outcome and the reason the key is checked before the distance. It is a
phase 6 coverage gap and belongs to its own work; see the issue.
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

    Returns nothing at all for a string containing any non-ASCII character,
    rather than splitting around it — `aapajärvensis` must not become
    `aapaj` and `rvensis`, which are not words and would be corrected to
    other things. The Go side applies the identical test.
    """
    if not text.isascii():
        return []
    return _WORD.findall(text.lower())


def fold_ph(word: str) -> str:
    """`ph` and `f` are the same sound, folded for both the key and the distance.

    It has to be in both or it is in neither, and it was in neither. Folding it
    into the key alone puts `elefant` in `elephant`'s bucket and then lets the
    distance charge two edits for the difference the bucket was built to
    forgive — over a cap of one, on a seven-character word. Every example this
    rule exists for failed at that last step: `elefant` reached nothing and
    `dolfin` reached *dolfyn*, a real genus one ordinary edit away. The key's
    measured 19/20 is a claim about which bucket a word lands in, and nothing
    was checking what happened after it landed.

    This is not a wider cap. The cap is untouched and every other difference
    costs exactly what it cost; one substitution stops being counted twice.
    Mirrored by `foldPH` in the serving binary.
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

    Transpositions count as one edit and that is load-bearing rather than
    thorough: `betual` -> `betula` is a single transposition, and under plain
    Levenshtein it is two — which puts it level with `betual` -> `betel`, a
    different plant, and the shorter string wins the tie. Counting the swap
    once is what makes the right answer the only answer within the cap.
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

    `search_name` and `fossil` both, because a corrector that can only reach one
    of them corrects toward the wrong catalogue: *Triceratops* is not a node at
    all — it is a PBDB taxon — and `triceratopps` has to be able to find it.
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
    # Both sides folded, because the bucket these came out of was built on the
    # folded form. See fold_ph.
    folded = fold_ph(word)
    best: tuple[int, int, int, str] | None = None
    for candidate, n in rows:
        # A word the corpus holds is a word somebody registered, not a typo.
        # `racoon`, `squirel` and `tyranosaurus` are all real taxon names.
        if candidate == word:
            return None
        d = damerau(folded, fold_ph(candidate), cap)
        if d > cap:
            continue
        # Distance first, then the more widely used spelling, then the shorter
        # string, then lexicographic — so the answer never depends on row order.
        scored = (d, -n, len(candidate), candidate)
        if best is None or scored < best:
            best = scored
    return best[3] if best is not None else None


def correct(con: sqlite3.Connection, text: str) -> str | None:
    """A better spelling of the whole query, or None if nothing was misspelled.

    Word by word, because with typeahead the misspelling that matters is in the
    *leading* token: a trailing one still has the prefix's results on screen,
    while `betual` kills the query before `pendula` is ever typed.
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
