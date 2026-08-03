"""The FTS5 index and the baked ranking behind the ⌘K palette.

ingest.md phase 1 step 8 specifies this index and phase 1 never built it —
`.schema` on a freshly built `concestor.db` has no `node_fts`. It is separated
out here rather than folded back into `topology.py` because it consumes phase 6
as well as phase 1, and because rebuilding the index must not mean reparsing a
31 MB Newick.

**Five corpora, five columns, one query.** Keeping them in separate FTS5
columns is what lets ranking weight them, which is the whole requirement in
ingest.md phase 6 — an exact binomial must always beat a vernacular match:

| column | kind | rows | source |
|---|---|---|---|
| `sci`    | 0 | 2,599,664 | `node.name` |
| `abbr`   | 1 | 2,231,456 | generated abbreviated binomials — `T. rex` |
| `syn`    | 2 | 2,226,375 | `synonyms.tsv`, joined by OTT id through `forward` |
| `vern`   | 3 | phase 6   | the `vernacular` table |
| `broken` | 4 | 9,839     | `broken_taxon` — names that are *not* nodes |

Each FTS row populates exactly one column, so `kind` alone says which corpus a
hit came from and the ordering stays legible.

**The fifth column exists because of *Escherichia coli*.** It is one of the
9,839 non-monophyletic taxa that synthesis rejects outright, so it is not a
node, has no name in `node.name`, and without this column the palette returns
absolutely nothing for the single most famous bacterium there is — the same
failure as returning nothing for "dog", arrived at from a different direction.
A `broken` row carries the searched name and points at the substituted MRCA,
and `kind` tells the client that this is a taxon to *explain* rather than an
answer to assert. management.md is explicit that the app must not silently
answer a different question the way the live API does; this is what lets it
say the true thing instead.

**"T. rex" gets two independent paths, deliberately.** Wikidata already carries
`T. rex`, `T-Rex` and `T rex` as aliases of OTT 664349, so phase 6 alone
answers it. But that is one upstream's editorial choice, and the palette cannot
be built on it: abbreviated binomials are therefore *generated* for every
multi-word scientific name, from the name itself. FTS5 cannot help here —
prefix matching is only legal on the final token of a phrase, so `"t* rex"`
matches nothing and `sci:t* AND sci:rex` is an unbounded scan over every token
beginning with `t` and loses word order. Generating the alias is the only
approach that is both correct and one index lookup. It costs ~2.3M extra rows;
13 taxa in this tree abbreviate to `T. rex` and ranking is what picks the
right one.

**Ranking is baked, not computed at request time.** architecture §4 names the
corpus signals — exact match, then `tip_count` descending, then has-silhouette,
then has-measured-age — so `search_rank` materialises one score per `idx` and
the serving binary does an FTS query and a join, never a computation. It is
baked twice over: `search_name.id` is *assigned* in descending rank order, so
FTS5's natural rowid ordering is already the ranking and a prefix scan can stop
at the first k matches instead of sorting every one. That is worth 40× on the
short prefixes a palette sees on every keystroke — `"can"*` goes from 82 ms to
1.8 ms — and it is the difference between the interaction feeling instant and
feeling like a search box. Session signals (recency, frequency) stay
client-side per architecture §7; they are not this table's job.

Silhouettes (phase 5) and `age_tier` (phase 2) may not exist in a given build.
Both are feature-detected and degrade to zero rather than failing, and the
gates record which signals were actually available.
"""

from __future__ import annotations

import re
import sqlite3
import time
from typing import TYPE_CHECKING

import numpy as np

from .gates import GateSet
from .paths import BUILD
from .topology import DB, SYNONYMS
from .topology import OUT as TOPO_OUT

if TYPE_CHECKING:
    from collections.abc import Iterator

    from .typing_ import F32Array, JsonDict, Log

KIND_SCI = 0
KIND_ABBR = 1
KIND_SYN = 2
KIND_VERN = 3
KIND_BROKEN = 4
KIND_NAMES = {
    KIND_SCI: "sci",
    KIND_ABBR: "abbr",
    KIND_SYN: "syn",
    KIND_VERN: "vern",
    KIND_BROKEN: "broken",
}

# Measured 2026-07-31 from the phase-1 database and OTT 3.7.3.
EXPECT_SCI = 2_599_664
EXPECT_SYNONYM_ROWS = 2_226_375
EXPECT_BROKEN = 9_839

# Ranking weights. Unlike the gate thresholds these are design choices rather
# than measurements, and they are tuned to one property: `log1p(tip_count)`
# separates clades by orders of magnitude, while the three boolean signals only
# ever break ties between taxa of comparable size. `log1p(1) = 0.69` and
# `log1p(19) = 3.00`, so no combination of bonuses can promote a species over a
# family. What they *do* decide is which of the 13 taxa spelled `T. rex`, all of
# them tips with `tip_count = 1`, comes first.
W_SILHOUETTE = 0.50
W_MEASURED_AGE = 0.25
W_VERNACULAR = 0.60
VERNACULAR_SATURATION = 10.0

_TOKEN = re.compile(r"\W+")

SCHEMA = """
DROP TABLE IF EXISTS node_fts;
DROP TABLE IF EXISTS search_name;
DROP TABLE IF EXISTS search_rank;

CREATE VIRTUAL TABLE node_fts USING fts5(
  sci, abbr, syn, vern, broken,
  content='', tokenize='unicode61 remove_diacritics 2'
);

-- node_fts is contentless (architecture §3.3), so the matched string and the
-- node it belongs to live here. `id` is the FTS rowid, and it is **assigned in
-- descending rank order** — see `renumber_by_rank`.
CREATE TABLE search_name (
  id    INTEGER PRIMARY KEY,
  idx   INTEGER NOT NULL,
  kind  INTEGER NOT NULL,   -- 0 sci, 1 abbr, 2 syn, 3 vern, 4 broken
  name  TEXT NOT NULL
);

CREATE TABLE search_rank (
  idx              INTEGER PRIMARY KEY,
  tip_count        INTEGER NOT NULL,
  has_silhouette   INTEGER NOT NULL,
  has_measured_age INTEGER NOT NULL,
  n_vernacular     INTEGER NOT NULL,
  rank_score       REAL NOT NULL
);
"""

# The fossil corpus gets its own index, and it is deliberately not a sixth
# column of `node_fts`.
#
# `node_fts` is keyed by `search_name.id`, which is a *node* name's id assigned
# in descending node rank order. A PBDB taxon has no node and no rank_score, so
# a fossil row in that table would either need a fabricated idx — the
# `node_fts.rowid` trap, which joins cleanly to an unrelated node and returns
# confident nonsense — or would break the "id is in rank order" invariant that
# every short-prefix query depends on. Two corpora, two indexes, one query each.
#
# `rowid` is `fossil.pbdb_taxon_no`, so no mapping table is needed; the server
# verifies that identity at startup rather than trusting it.
FOSSIL_SCHEMA = """
DROP TABLE IF EXISTS fossil_fts;

CREATE VIRTUAL TABLE fossil_fts USING fts5(
  name, content='', tokenize='unicode61 remove_diacritics 2'
);
"""

INDEXES = """
CREATE INDEX search_name_idx ON search_name(idx);
"""
# There is deliberately no index on `search_rank(rank_score)`. Ordering the
# whole corpus by score is what the palette's pre-typing state needs, and
# `renumber_by_rank` already answers that from `search_name` alone:
#
#   SELECT name, idx FROM search_name WHERE kind = 0 ORDER BY id LIMIT 20
#
# 0.18 ms, against 421 ms for the same list via `search_rank` with its index —
# which SQLite declines to use once the query joins `node` — and 47 MB smaller.


# --------------------------------------------------------------------------
# Corpora
# --------------------------------------------------------------------------


def abbreviate(name: str) -> str | None:
    """`Tyrannosaurus rex` → `T. rex`; `Canis lupus familiaris` → `C. l. familiaris`.

    Returns None for anything that is not a multi-word name in the Linnean
    shape — uninomials, names whose leading tokens are already abbreviated, and
    the long connective strings OTT carries for a few unplaced taxa.
    """
    parts = name.split()
    if not 2 <= len(parts) <= 4:
        return None
    head = parts[:-1]
    if any(not p[:1].isalpha() or p.endswith(".") for p in head):
        return None
    return " ".join(f"{p[0]}." for p in head) + " " + parts[-1]


def scientific_rows(con: sqlite3.Connection) -> Iterator[tuple[int, int, str]]:
    for idx, name in con.execute(
        "SELECT idx, name FROM node WHERE name IS NOT NULL AND trim(name) <> ''"
    ):
        yield (idx, KIND_SCI, name)


def abbreviated_rows(con: sqlite3.Connection) -> Iterator[tuple[int, int, str]]:
    for idx, name in con.execute(
        "SELECT idx, name FROM node WHERE name IS NOT NULL AND name LIKE '% %'"
    ):
        short = abbreviate(name)
        if short is not None and short != name:
            yield (idx, KIND_ABBR, short)


def synonym_rows(log: Log = print) -> Iterator[tuple[int, str]]:
    """`(ott_id, name)` from `synonyms.tsv`, which is `\\t|\\t`-separated."""
    with SYNONYMS.open(encoding="utf-8") as fh:
        head = [c.strip() for c in fh.readline().split("\t|\t")]
        i_name, i_uid = head.index("name"), head.index("uid")
        n = 0
        for line in fh:
            f = line.split("\t|\t")
            if len(f) <= max(i_name, i_uid):
                continue
            name = f[i_name].strip()
            try:
                uid = int(f[i_uid])
            except ValueError:
                continue
            if name:
                n += 1
                yield (uid, name)
        log(f"  read {n:,} synonym rows")


def load_synonyms(con: sqlite3.Connection, log: Log = print) -> int:
    """Stage synonyms and resolve them to `idx`, chasing forwards.

    Forwards come from the `forward` table phase 1 already wrote rather than a
    second parse of `forwards.tsv` — the same 297,070 entries, with their
    chains already collapsed to a terminal id.

    A synonym string identical to the taxon's own accepted name is dropped: it
    would be a second row competing with the scientific one and could only
    make an exact binomial rank lower.
    """
    con.execute("CREATE TEMP TABLE syn_raw (ott_id INTEGER, name TEXT)")
    n = 0

    def rows() -> Iterator[tuple[int, str]]:
        nonlocal n
        for pair in synonym_rows(log=log):
            n += 1
            yield pair

    con.executemany("INSERT INTO syn_raw VALUES (?,?)", rows())
    con.execute(
        f"""
        INSERT INTO name_raw
        SELECT DISTINCT n.idx, {KIND_SYN}, s.name
          FROM syn_raw s
          JOIN node n ON n.ott_id = COALESCE(
                 (SELECT f.new_ott_id FROM forward f WHERE f.old_ott_id = s.ott_id),
                 s.ott_id)
         WHERE n.name IS NULL OR lower(n.name) <> lower(s.name)
        """
    )
    return n


# --------------------------------------------------------------------------
# Ranking
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


def _column_exists(con: sqlite3.Connection, table: str, column: str) -> bool:
    return any(r[1] == column for r in con.execute(f"PRAGMA table_info({table})"))


def measured_age_flags(n: int, log: Log = print) -> tuple[F32Array, str]:
    """Per-node has-measured-age, feature-detected from whatever phase 2 wrote.

    `age_tier.npy` is the honest source: tier 0 is `measured`. If only
    `age_ma.npy` exists the signal degrades to *has a displayable age*, which
    per `age_provenance.json` means measured **or** interpolated — a weaker
    claim, recorded as such rather than quietly relabelled.
    """
    tier_path = TOPO_OUT / "age_tier.npy"
    age_path = TOPO_OUT / "age_ma.npy"
    if tier_path.exists():
        tier = np.load(tier_path)
        if len(tier) == n:
            log("  age signal: age_tier.npy (measured tier)")
            return (tier == 0).astype(np.float32), "age_tier.npy (measured)"
    if age_path.exists():
        age = np.load(age_path)
        if len(age) == n:
            log("  age signal: age_ma.npy (degraded to has-any-displayable-age)")
            return np.isfinite(age).astype(np.float32), "age_ma.npy (any age)"
    log("  age signal: absent — degrading to zero")
    return np.zeros(n, dtype=np.float32), "absent"


def silhouette_flags(
    con: sqlite3.Connection, n: int, log: Log = print
) -> tuple[F32Array, str]:
    """Per-node has-silhouette, feature-detected from whatever phase 5 wrote.

    The signal has to be *has its own image*, not *has an image*. Phase 5's
    `node_image` resolves every one of the 2,725,682 nodes by climbing to an
    ancestor when the node itself has none, which is right for rendering and
    carries exactly zero ranking information — 99.7% of its rows are
    inherited. Only `climb = 0` says anything about the taxon.
    """
    out = np.zeros(n, dtype=np.float32)
    if _column_exists(con, "node", "phylopic_id"):
        for (idx,) in con.execute("SELECT idx FROM node WHERE phylopic_id IS NOT NULL"):
            out[idx] = 1.0
        log(f"  silhouette signal: node.phylopic_id ({int(out.sum()):,} nodes)")
        return out, "node.phylopic_id"
    if _table_exists(con, "node_image") and _column_exists(con, "node_image", "climb"):
        for (idx,) in con.execute("SELECT idx FROM node_image WHERE climb = 0"):
            out[idx] = 1.0
        log(f"  silhouette signal: node_image, own image only ({int(out.sum()):,})")
        return out, "node_image (climb = 0)"
    log("  silhouette signal: absent (phase 5 not built) — degrading to zero")
    return out, "absent"


def build_rank(con: sqlite3.Connection, log: Log = print) -> JsonDict:
    tip_count = np.load(TOPO_OUT / "tip_count.npy")
    n = len(tip_count)

    age_flag, age_src = measured_age_flags(n, log=log)
    sil_flag, sil_src = silhouette_flags(con, n, log=log)

    n_vern = np.zeros(n, dtype=np.float32)
    if _table_exists(con, "vernacular"):
        for idx, c in con.execute(
            "SELECT idx, count(*) FROM vernacular WHERE idx IS NOT NULL GROUP BY idx"
        ):
            n_vern[idx] = c
        log(f"  vernacular signal: {int((n_vern > 0).sum()):,} nodes")
    else:
        log("  vernacular signal: absent (phase 6 not built) — degrading to zero")

    score = (
        np.log1p(tip_count.astype(np.float64))
        + W_SILHOUETTE * sil_flag
        + W_MEASURED_AGE * age_flag
        + W_VERNACULAR
        * np.minimum(np.log1p(n_vern) / np.log1p(VERNACULAR_SATURATION), 1.0)
    )

    searchable = [int(r[0]) for r in con.execute("SELECT DISTINCT idx FROM name_raw")]

    def rows() -> Iterator[tuple[int, int, int, int, int, float]]:
        for i in searchable:
            yield (
                i,
                int(tip_count[i]),
                int(sil_flag[i]),
                int(age_flag[i]),
                int(n_vern[i]),
                float(score[i]),
            )

    con.executemany("INSERT INTO search_rank VALUES (?,?,?,?,?,?)", rows())
    return {
        "rows": len(searchable),
        "nodes_with_own_silhouette": int(sil_flag.sum()),
        "nodes_with_measured_age": int(age_flag.sum()),
        "nodes_with_a_vernacular": int((n_vern > 0).sum()),
        "age_signal": age_src,
        "silhouette_signal": sil_src,
        "vernacular_signal": "vernacular table"
        if _table_exists(con, "vernacular")
        else "absent",
    }


def renumber_by_rank(con: sqlite3.Connection, log: Log = print) -> None:
    """Reassign `search_name.id` so that rowid order *is* rank order.

    This is the difference between a palette that feels instant and one that
    does not, and it is free. FTS5 returns matches in rowid order, so
    `ORDER BY rowid LIMIT k` terminates as soon as it has k of them instead of
    scanning and sorting every match. Measured on the built index, for the
    kind of short prefix a palette sees on every keystroke:

    | query | ranked at request time | rowid order |
    |---|---:|---:|
    | `"a"*`   | 1,434 ms | 75 ms |
    | `"ca"*`  |   ~90 ms | 17 ms |
    | `"can"*` |    82 ms |  2 ms |

    The ordering is the baked one — `rank_score` descending, then `kind`, then
    the shorter string — so nothing about ranking moves to request time. It
    just stops being a sort.

    **Broken names sort last, whatever their score.** A `broken` row's `idx` is
    the *substituted MRCA*, so it inherits that node's `tip_count` and lands
    near the top of the corpus — which is how typing "can" came back
    Canalipalpata, Canthocamptidae, Canthocamptus, three taxa that are not in
    the tree, ahead of every real one. The score is true of the substitute and
    says nothing about the rejected taxon, and there is no honest size for the
    rejected taxon because it has no position. So a name that is not a node is
    the last resort: still reachable, still exact-matchable — which is how
    "Escherichia coli" and "Dinosauria" work — but never ahead of a real name.
    """
    t0 = time.monotonic()
    con.execute(
        f"""
        INSERT INTO search_name (id, idx, kind, name)
        SELECT ROW_NUMBER() OVER (
                 ORDER BY (nr.kind = {KIND_BROKEN}), r.rank_score DESC,
                          nr.kind, length(nr.name), nr.name),
               nr.idx, nr.kind, nr.name
          FROM name_raw nr JOIN search_rank r ON r.idx = nr.idx
        """
    )
    log(f"  renumbered in rank order in {time.monotonic() - t0:,.1f}s")


def build_fossil_index(con: sqlite3.Connection, log: Log = print) -> int:
    """Index every PBDB taxon name, so `/v1/search` stops scanning the table.

    `SearchFossils` matched with `lower(name) LIKE '%q%'` against 523,112 rows
    and no index on `name`, ordering the survivors. That is a full scan of the
    69 MB table on **every keystroke**, measured at 100–117 ms in the serving
    binary and flat against match count — `zzzqqq`, which matches nothing, cost
    100 ms. It was 90% of the endpoint. Against the deployed container, which is
    a `standard-1` instance with **half a vCPU**, that is several times worse
    again, and it is the whole reason search feels fine locally and slow in
    production. This index answers the same queries in 0.1–15 ms.

    **Every row is indexed, not just the searchable ones.** `SearchFossils`
    only ever returns taxa with `is_primary = 1 AND attach_walk <> 0` — see
    `notInTree` in the serving binary — and restricting the index to those would
    make it 40% smaller. It is refused because that filter is a *serving*
    policy, argued out in one place and revisable there, and an index that
    quietly encodes it is an index that goes wrong without anything failing on
    the day the policy changes. This table means one thing: the names in
    `fossil`, tokenised. The server keeps its own WHERE.

    **What this cannot match, and why that is the right trade.** FTS5 matches
    whole tokens and token prefixes; `LIKE '%q%'` also matched inside a word, so
    "rex" reached *Aulacorexia* and 525 others. Measured over nine real queries
    the index returns **no row LIKE would not** — it is a strict subset — and
    the rows it drops are exactly those the serving binary's `matchBand` already
    scores `bandNone`, its worst band, which `Interleave` then ranks behind
    every node. They could not reach a 24-row page. The one `matchBand` rule a
    prefix cannot reproduce is `samePlural`, and it is inert here: PBDB names
    are Linnean, not vernacular, so there are no plurals to miss.
    """
    if not _table_exists(con, "fossil"):
        log("  fossil: table absent — run `concestor-build fossils`")
        return 0
    con.executescript(FOSSIL_SCHEMA)
    t0 = time.monotonic()
    con.execute(
        "INSERT INTO fossil_fts(rowid, name) "
        "SELECT pbdb_taxon_no, name FROM fossil WHERE trim(name) <> ''"
    )
    con.commit()
    con.execute("INSERT INTO fossil_fts(fossil_fts) VALUES ('optimize')")
    con.commit()
    n = con.execute("SELECT count(*) FROM fossil_fts").fetchone()[0]
    log(f"  fossil names indexed: {n:,} in {time.monotonic() - t0:,.1f}s")
    return int(n)


# The words the fossil index is gated on. Real queries rather than synthetic
# ones, and chosen to cover the shapes that behave differently: a taxon the tree
# does not contain (`triceratops`), one it does (`tyrannosaurus`), a bare genus
# fragment (`stegosaur`), a word that is a token inside many names (`rex`), and
# a two-character prefix, which is the shortest the palette ever sends.
FOSSIL_GATE_QUERIES = (
    "tyrannosaurus",
    "triceratops",
    "stegosaur",
    "georgicus",
    "rex",
    "dino",
    "whale",
    "oak",
    "ca",
)


def fossil_index_miskeyed(con: sqlite3.Connection, per_end: int = 16) -> int:
    """Count sampled taxa the index does not return under their own name.

    Zero is the only acceptable answer, and the question has to be asked this
    way round. `fossil_fts` is `content=''`, so its columns read back as NULL
    and any gate phrased as "join on the key and compare the names" is vacuous
    — it answers 0 whatever the index was built from. Looking each taxon up *by
    its own name* and requiring its own key in the answer is a question the
    index can actually be wrong about.

    Sampled from both ends of the keyspace, because a key that partly overlaps
    the right one agrees across a whole region and diverges outside it.
    """
    rows: list[tuple[int, str]] = []
    for direction in ("ASC", "DESC"):
        rows += con.execute(
            "SELECT pbdb_taxon_no, name FROM fossil WHERE trim(name) <> '' "
            f"ORDER BY pbdb_taxon_no {direction} LIMIT ?",
            (per_end,),
        ).fetchall()
    missing = 0
    for taxon_no, name in rows:
        expr = match_expression(name)
        if not expr:
            continue
        found = con.execute(
            "SELECT count(*) FROM fossil_fts WHERE fossil_fts MATCH ? AND rowid = ?",
            (expr, taxon_no),
        ).fetchone()[0]
        missing += found == 0
    return missing


def fossil_index_recall(
    con: sqlite3.Connection, queries: tuple[str, ...] = FOSSIL_GATE_QUERIES
) -> tuple[int, int]:
    """Compare the index against the scan it replaces.

    Returns `(invented, dropped)` — rows the index returns that the `LIKE` scan
    would not, and rows the scan returns that the index does not. `invented`
    must be zero: the index may narrow the corpus, never widen it. `dropped` is
    recorded rather than required, because it is the mid-word substring class
    that `matchBand` already ranks last.
    """
    invented = dropped = 0
    for q in queries:
        fts = {
            r[0]
            for r in con.execute(
                "SELECT rowid FROM fossil_fts WHERE fossil_fts MATCH ?", (f'"{q}"*',)
            )
        }
        like = {
            r[0]
            for r in con.execute(
                "SELECT pbdb_taxon_no FROM fossil WHERE lower(name) LIKE ?",
                (f"%{q.lower()}%",),
            )
        }
        invented += len(fts - like)
        dropped += len(like - fts)
    return invented, dropped


# --------------------------------------------------------------------------
# Querying — the reference implementation of what the serving binary does
# --------------------------------------------------------------------------


def match_expression(text: str, prefix: bool = True) -> str:
    """User text → an FTS5 MATCH expression.

    A phrase, with the final token treated as a prefix so the palette answers
    while the user is still typing. `T. rex` becomes `"t rex"*`, which is why
    the abbreviated aliases are indexed as their own rows: FTS5 permits `*`
    only on a phrase's last token, so no query shape can turn `T.` into a
    prefix match against `Tyrannosaurus`.
    """
    tokens = [t for t in _TOKEN.split(text.strip().lower()) if t]
    if not tokens:
        return '""'
    return '"' + " ".join(tokens) + ('"*' if prefix else '"')


_SELECT = """
    SELECT sn.idx, sn.kind, sn.name, n.name, n.rank, n.tip_count,
           COALESCE(r.rank_score, 0.0)
      FROM node_fts
      JOIN search_name sn ON sn.id = node_fts.rowid
      JOIN node n ON n.idx = sn.idx
      LEFT JOIN search_rank r ON r.idx = sn.idx
     WHERE node_fts MATCH ?
"""

# Exact hits first, ordered by kind so an exact binomial beats an exact
# vernacular. The non-prefixed phrase keeps this cheap: only names actually
# containing the whole typed sequence are scanned.
#
# Two forms are compared, not one. The indexed string keeps its punctuation
# (`T. rex`) while the tokenised needle has lost it (`t rex`), so a single
# equality test would mean `T. rex` never matched itself exactly and every
# abbreviation fell through to the ranked pool.
_SQL_EXACT = _SELECT + " AND lower(sn.name) IN (?, ?) ORDER BY sn.kind, sn.id LIMIT ?"

# Then everything else, in the baked order that `search_name.id` encodes.
_SQL_POOL = _SELECT + " ORDER BY node_fts.rowid LIMIT ?"


def query(
    con: sqlite3.Connection, text: str, limit: int = 10, pool: int = 2000
) -> list[JsonDict]:
    """Rank candidates for `text`, deduplicated to one row per taxon.

    Two FTS queries, in architecture §4's order.

    1. **Exact matches**, ordered by `kind` — this is what guarantees an exact
       binomial beats a vernacular, and it is a separate query rather than an
       `is_exact DESC` sort key because an exact hit on an unremarkable taxon
       can otherwise sit far below thousands of higher-ranked prefix hits.
    2. **Everything else**, in `search_name.id` order, which `renumber_by_rank`
       has already made equal to `rank_score` descending then `kind` then
       length. No ranking happens at request time; the pool arrives sorted.

    Deduplication happens here rather than in SQL because `GROUP BY` would pick
    an arbitrary row from each group and the point is to keep the *best* one.
    """
    tokens = [t for t in _TOKEN.split(text.strip().lower()) if t]
    if not tokens:
        return []
    needle = " ".join(tokens)
    typed = " ".join(text.strip().lower().split())
    exact_forms = {needle, typed}

    seen: set[int] = set()
    out: list[JsonDict] = []
    for sql, params in (
        (_SQL_EXACT, (match_expression(text, prefix=False), typed, needle, limit * 4)),
        (_SQL_POOL, (match_expression(text), pool)),
    ):
        for row in con.execute(sql, params):
            idx = row[0]
            if idx in seen:
                continue
            seen.add(idx)
            out.append(
                {
                    "idx": idx,
                    "kind": KIND_NAMES[row[1]],
                    "matched": row[2],
                    # A `broken` row is *about* the rejected taxon, not about
                    # the node it was substituted with, so it must be labelled
                    # with the name that was searched. Showing `Sauria` for
                    # "dinosaur" would be the live API's mistake — silently
                    # answering a different question — reproduced in the
                    # palette. `idx` still points at the substitute, which is
                    # what the client draws once it has explained itself.
                    "name": row[2] if row[1] == KIND_BROKEN else (row[3] or row[2]),
                    "rank": row[4],
                    "tip_count": row[5],
                    "rank_score": round(row[6], 4),
                    "exact": row[2].lower() in exact_forms,
                }
            )
            if len(out) >= limit:
                return out
    return out


# --------------------------------------------------------------------------
# Phase entry point
# --------------------------------------------------------------------------

# Every one of these must return a taxon a person means, first. They are the
# palette's reason to exist: one exact binomial, four everyday words, and one
# abbreviated binomial that thirteen taxa in this tree spell identically. The
# third element says whether the check depends on phase 6 having been run; the
# ones that do become observations rather than blockers without it, because a
# build with no vernaculars is an intermediate state and not a broken one.
SEARCH_CHECKS: tuple[tuple[str, tuple[str, ...], bool], ...] = (
    ("Homo sapiens", ("Homo sapiens",), False),
    ("dog", ("Canis lupus familiaris", "Canis familiaris", "Canis lupus"), True),
    # Both the species (Wikidata `P1843`) and the genus (PBDB) carry
    # "human", and both are right; the palette shows both.
    ("human", ("Homo sapiens", "Homo"), True),
    ("shark", ("Selachii", "Selachimorpha", "Elasmobranchii", "Chondrichthyes"), True),
    ("T. rex", ("Tyrannosaurus rex",), True),
    # The word P9157 alone cannot answer; see vernaculars.py on `P225`.
    ("animal", ("Metazoa",), True),
)


def run() -> int:
    g = GateSet("search-fts")
    t_start = time.monotonic()

    size_before = DB.stat().st_size
    con = sqlite3.connect(DB, timeout=120.0)
    con.execute("PRAGMA busy_timeout = 120000")
    # `synchronous = OFF` only; the rollback journal stays on, because other
    # phases write this database too and journal_mode = OFF is only safe for
    # the single-writer, build-from-scratch case topology.py is.
    con.execute("PRAGMA synchronous = OFF")
    con.executescript(SCHEMA)
    # The corpora are gathered into a staging table first, because the id a row
    # ends up with has to encode its rank and the ranking is not known until
    # every corpus is in.
    con.execute("CREATE TEMP TABLE name_raw (idx INTEGER, kind INTEGER, name TEXT)")

    have_vernacular = _table_exists(con, "vernacular")

    def staged(kind: int) -> int:
        return con.execute(
            "SELECT count(*) FROM name_raw WHERE kind = ?", (kind,)
        ).fetchone()[0]

    print("--- corpora ---", flush=True)
    t0 = time.monotonic()
    con.executemany("INSERT INTO name_raw VALUES (?,?,?)", scientific_rows(con))
    n_sci = staged(KIND_SCI)
    print(f"  scientific: {n_sci:,} in {time.monotonic() - t0:,.1f}s", flush=True)

    t0 = time.monotonic()
    con.executemany("INSERT INTO name_raw VALUES (?,?,?)", abbreviated_rows(con))
    n_abbr = staged(KIND_ABBR)
    print(f"  abbreviated: {n_abbr:,} in {time.monotonic() - t0:,.1f}s", flush=True)

    t0 = time.monotonic()
    n_syn_read = load_synonyms(con, log=print)
    n_syn = staged(KIND_SYN)
    print(
        f"  synonyms: {n_syn:,} resolved of {n_syn_read:,} "
        f"in {time.monotonic() - t0:,.1f}s",
        flush=True,
    )

    con.execute(
        f"""
        INSERT INTO name_raw
        SELECT mrca_idx, {KIND_BROKEN}, name FROM broken_taxon
         WHERE name IS NOT NULL AND trim(name) <> '' AND mrca_idx IS NOT NULL
        """
    )
    n_broken = staged(KIND_BROKEN)
    print(f"  broken taxa: {n_broken:,}", flush=True)

    n_vern_rows = 0
    if have_vernacular:
        con.execute(
            f"""
            INSERT INTO name_raw
            SELECT DISTINCT idx, {KIND_VERN}, name FROM vernacular
             WHERE idx IS NOT NULL AND trim(name) <> ''
            """
        )
        n_vern_rows = staged(KIND_VERN)
        print(f"  vernacular: {n_vern_rows:,}", flush=True)
    else:
        print("  vernacular: table absent — run `concestor-build vernaculars`")

    print("\n--- ranking ---", flush=True)
    rank_report = build_rank(con, log=print)
    renumber_by_rank(con, log=print)

    print("\n--- fts5 ---", flush=True)
    t0 = time.monotonic()
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
    print(f"  indexed in {time.monotonic() - t0:,.1f}s", flush=True)
    con.executescript(INDEXES)
    con.commit()
    con.execute("INSERT INTO node_fts(node_fts) VALUES ('optimize')")
    con.commit()

    print("\n--- fossil names ---", flush=True)
    n_fossil_fts = build_fossil_index(con, log=print)

    # ---- gates ----------------------------------------------------------
    print("\n--- gates ---", flush=True)
    n_names = con.execute("SELECT count(*) FROM search_name").fetchone()[0]

    g.require("scientific names indexed", n_sci, EXPECT_SCI)
    g.require("synonym rows read from synonyms.tsv", n_syn_read, EXPECT_SYNONYM_ROWS)
    g.require(
        "no name lost in the rank renumbering",
        n_names,
        n_sci + n_abbr + n_syn + n_vern_rows + n_broken,
        note="renumber_by_rank is an inner join, and an inner join can drop rows",
    )
    g.require(
        "search_name.id really is in rank order",
        con.execute(
            "SELECT count(*) FROM search_name a JOIN search_name b ON b.id = a.id + 1 "
            "JOIN search_rank ra ON ra.idx = a.idx JOIN search_rank rb ON rb.idx = b.idx "
            "WHERE a.id <= 200000 AND ra.rank_score < rb.rank_score"
        ).fetchone()[0],
        0,
        note="the whole latency argument for renumbering rests on this",
    )
    g.require(
        "fts rows match search_name rows",
        con.execute("SELECT count(*) FROM node_fts").fetchone()[0],
        n_names,
    )
    g.require(
        "every indexed name is non-empty",
        con.execute(
            "SELECT count(*) FROM search_name WHERE name IS NULL OR trim(name) = ''"
        ).fetchone()[0],
        0,
        note="the column this repo has already lost once to a lint fix",
    )
    g.require(
        "every indexed name points at a real node",
        con.execute(
            "SELECT count(*) FROM search_name sn LEFT JOIN node n ON n.idx = sn.idx "
            "WHERE n.idx IS NULL"
        ).fetchone()[0],
        0,
    )
    g.require(
        "every searchable node has a rank row",
        con.execute(
            "SELECT count(*) FROM (SELECT DISTINCT idx FROM search_name) s "
            "LEFT JOIN search_rank r ON r.idx = s.idx WHERE r.idx IS NULL"
        ).fetchone()[0],
        0,
    )
    g.require(
        "rank_score is finite and positive everywhere",
        con.execute(
            "SELECT count(*) FROM search_rank WHERE rank_score IS NULL "
            "OR rank_score <= 0"
        ).fetchone()[0],
        0,
    )
    g.require(
        "rank_score orders a nested lineage by clade size",
        [
            r[0]
            for r in con.execute(
                "SELECT n.name FROM search_rank r JOIN node n ON n.idx = r.idx "
                "WHERE n.ott_id IN (93302, 244265, 770315) "
                "ORDER BY r.rank_score DESC"
            )
        ],
        ["cellular organisms", "Mammalia", "Homo sapiens"],
        note="the signal that makes 'can' surface Canidae before Cania",
    )
    g.require(
        "broken taxa reachable by name",
        n_broken,
        EXPECT_BROKEN,
        note="Escherichia coli is one of them and is not a node at all",
    )
    g.require(
        "no name that is not a node outranks one that is",
        con.execute(
            f"SELECT count(*) FROM search_name WHERE kind <> {KIND_BROKEN} "
            f"AND id > (SELECT min(id) FROM search_name WHERE kind = {KIND_BROKEN})"
        ).fetchone()[0],
        0,
        note="a broken row inherits its substitute MRCA's tip_count, which is "
        "true of the substitute and says nothing about the rejected taxon",
    )
    g.require(
        "'Escherichia coli' returns the broken taxon rather than nothing",
        [(h["name"], h["kind"]) for h in query(con, "Escherichia coli", limit=1)],
        [("Escherichia coli", "broken")],
        ok=[(h["name"], h["kind"]) for h in query(con, "Escherichia coli", limit=1)]
        == [("Escherichia coli", "broken")],
    )
    g.require(
        "abbreviated binomials generated",
        n_abbr,
        ok=n_abbr > 1_000_000,
        note="T. rex has no query-side path; FTS5 prefix matching is legal "
        "only on a phrase's final token",
    )

    for text, expect, needs_vern in SEARCH_CHECKS:
        hits = query(con, text, limit=5)
        top = hits[0]["name"] if hits else None
        ok = top in expect
        if needs_vern and not have_vernacular:
            g.observe(
                f"search {text!r} ranks a sensible taxon first",
                top,
                expect,
                note="phase 6 not built",
            )
        else:
            g.require(
                f"search {text!r} ranks a sensible taxon first",
                top,
                expect,
                ok=ok,
                note="" if ok else f"top 5: {[h['name'] for h in hits]}",
            )

    # `T. rex` must at least be *reachable* even with no vernaculars at all,
    # because that is what the generated abbreviation is for.
    g.require(
        "'T. rex' candidates include Tyrannosaurus rex",
        "Tyrannosaurus rex" in [h["name"] for h in query(con, "T. rex", limit=40)],
        True,
    )

    if n_fossil_fts:
        g.require(
            "every fossil name is indexed",
            n_fossil_fts,
            con.execute(
                "SELECT count(*) FROM fossil WHERE trim(name) <> ''"
            ).fetchone()[0],
        )
        # The identity the serving binary depends on and cannot infer: the FTS
        # rowid is a `pbdb_taxon_no`. Getting this wrong does not error — it
        # joins cleanly to the wrong animal, which is the `node_fts.rowid`
        # failure this project has already paid for once.
        #
        # The check goes through MATCH, and it has to. `fossil_fts` is
        # `content=''`, so `SELECT f.name FROM fossil_fts f` yields NULL,
        # `NULL <> t.name` is NULL rather than true, and the obvious join-and-
        # compare gate reports 0 for a correct index and a corrupted one alike.
        # It was written that way first and passed on an index built from the
        # wrong key.
        g.require(
            "fossil_fts.rowid is pbdb_taxon_no",
            fossil_index_miskeyed(con),
            0,
            note="each sampled taxon must be returned by a search for its own "
            "name; a column comparison cannot answer this, the table is "
            "contentless",
        )
        invented, dropped = fossil_index_recall(con)
        g.require(
            "the index never returns a row the scan would not",
            invented,
            0,
            note="it may narrow the corpus and may not widen it; the rows it "
            "drops are mid-word substring matches, which matchBand scores "
            "bandNone and Interleave ranks behind every node",
        )
        g.observe("fossil rows dropped vs the LIKE scan", f"{dropped:,}")

    size_after = DB.stat().st_size
    g.observe(
        "rows by kind",
        {
            KIND_NAMES[k]: v
            for k, v in con.execute(
                "SELECT kind, count(*) FROM search_name GROUP BY kind"
            )
        },
    )
    g.observe("total indexed names", f"{n_names:,}")
    g.observe("vernacular names indexed", f"{n_vern_rows:,}")
    g.observe("fossil names indexed", f"{n_fossil_fts:,}")
    g.observe("rank signals", rank_report)
    g.observe(
        "concestor.db grew by",
        f"{(size_after - size_before) / 1e6:,.1f} MB "
        f"(to {size_after / 1e6:,.1f} MB total)",
        "~600 MB for the FTS index, architecture §3.3",
        note=(
            "the delta is this phase; the total is shared with every other "
            "phase writing the same file"
        ),
    )
    g.observe("build time", f"{time.monotonic() - t_start:,.1f}s")

    con.close()
    g.write(BUILD / "search_gates.json")
    g.exit_if_failed()
    return 0
