"""The FTS5 index and the baked ranking behind the palette.

Separated from `topology.py` because it consumes phase 6 as well as phase 1, and
because rebuilding the index must not mean reparsing a 31 MB Newick.

Six corpora, five columns, one query. Separate FTS5 columns are what let
ranking weight them (an exact binomial must beat a vernacular match):

| column | kind | source |
|---|---|---|
| `sci`    | 0 | `node.name` |
| `abbr`   | 1 | generated abbreviated binomials — `T. rex` |
| `syn`    | 2 | `synonyms.tsv`, joined by OTT id through `forward` |
| `vern`   | 3 | the `vernacular` table |
| `broken` | 4 | `broken_taxon` — names that are *not* nodes |
| `syn`    | 5 | `fossil` — PBDB's name for a taxon the tree holds |

Each FTS row populates exactly one column, and `kind` says which corpus a hit
came from. The two are not quite one-to-one: kinds 2 and 5 share the `syn`
column because they want the same *weight* — a name the taxon also goes by —
while staying distinguishable in the *caption*, since "the taxonomy files it
under this name" and "the fossil record calls it this" are different claims.
See `load_pbdb_names`.

The `broken` column exists because *Escherichia coli* is a non-monophyletic
taxon synthesis rejects, so it is not a node and has no name in `node.name`.
The row carries the searched name and points at the substituted MRCA, and `kind`
tells the client this is a taxon to explain rather than an answer to assert.

Abbreviated binomials are *generated* for every multi-word scientific name
rather than relying on Wikidata's aliases, because FTS5 prefix matching is only
legal on a phrase's final token (`"t* rex"` matches nothing). Ranking picks the
right one of the taxa that abbreviate the same way.

Ranking is baked, not computed at request time: `search_rank` materialises one
score per `idx`, and `search_name.id` is assigned in descending rank order so
FTS5's rowid ordering is already the ranking and a prefix scan can stop at the
first k matches (~40x on short prefixes). Session signals stay client-side.

Silhouettes (phase 5) and `age_tier` (phase 2) may not exist in a given build;
both are feature-detected and degrade to zero, and the gates record which
signals were available.
"""

from __future__ import annotations

import re
import sqlite3
import time
from typing import TYPE_CHECKING

import numpy as np

from . import spelling
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
KIND_PBDB = 5
KIND_NAMES = {
    KIND_SCI: "sci",
    KIND_ABBR: "abbr",
    KIND_SYN: "syn",
    KIND_VERN: "vern",
    KIND_BROKEN: "broken",
    KIND_PBDB: "pbdb",
}

# Measured from the phase-1 database and OTT 3.7.3, after the infraspecific
# collapse (the folded taxa are not named nodes; their names index as synonyms
# of the node they folded into — see the `folded_infraspecific` stage).
EXPECT_SCI = 2_531_141
EXPECT_SYNONYM_ROWS = 2_226_375
EXPECT_BROKEN = 9_839
# The names the fossil record uses for taxa the tree holds — `load_pbdb_names`.
#
# Was 2,584 before phase 3 grew the rank-disagreement sweep. The corpus is drawn
# from `attach_walk = 0` rows — the PBDB taxon *is* the node — and a withdrawn
# resolution stops a taxon being the node at all: 135 of the 148 rows the sweep
# takes had `attach_walk = 0` in the shipped build and 22 do now, so 113 leave
# the population and 36 of them were the only catalogue offering that spelling.
# Then 2,548 became 2,531: seventeen of PBDB's spellings are folded
# infraspecific names, which the collapse stage now offers before this one.
# The claim the corpus exists to make is unchanged and still gated at 0 — every
# taxon the tree holds stays findable under the fossil record's name.
EXPECT_PBDB_NAMES = 2_531

# Ranking weights, tuned so `log1p(tip_count)` dominates: the boolean signals
# only ever break ties between taxa of comparable size, never promoting a
# species over a family.
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
  kind  INTEGER NOT NULL,   -- 0 sci, 1 abbr, 2 syn, 3 vern, 4 broken, 5 pbdb
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

# The fossil corpus gets its own index, not a sixth column of `node_fts`:
# `node_fts` is keyed by `search_name.id` (a node id in rank order), and a PBDB
# taxon has no node, so a fossil row there would need a fabricated idx or break
# the rank-order invariant. `rowid` is `fossil.pbdb_taxon_no`, so no mapping
# table is needed; the server verifies that identity at startup.
FOSSIL_SCHEMA = """
DROP TABLE IF EXISTS fossil_fts;

CREATE VIRTUAL TABLE fossil_fts USING fts5(
  name, content='', tokenize='unicode61 remove_diacritics 2'
);
"""

INDEXES = """
CREATE INDEX search_name_idx ON search_name(idx);
"""
# No index on `search_rank(rank_score)`: the pre-typing "top by score" list is
# already answered from `search_name` alone (ORDER BY id, which is rank order),
# 0.18 ms and 47 MB smaller than the indexed join.


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

    Forwards come from phase 1's `forward` table (chains already collapsed). A
    synonym identical to the taxon's own accepted name is dropped, so it cannot
    compete with the scientific row.
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


def load_pbdb_names(con: sqlite3.Connection) -> int:
    """Stage the name the fossil record uses for each taxon the tree holds.

    `attach_walk = 0` means the PBDB taxon *is* the node, and `store.notInTree`
    refuses those from the fossil list precisely so the node answers instead —
    fossil-grafts.md §9. But the node answers under *OTT's* spelling, and the
    two catalogues disagree about 1,559 of these names. Where OTT does not also
    carry PBDB's spelling as a synonym, refusing the fossil row took the last
    thing that could match it: searching *Opisthobranchiata* returned nothing
    that is that taxon, though the tree holds it as *Opisthobranchia*.

    **Measured against the shipped build at 779** — a defect this corpus
    inherits rather than causes. `under_accepted_name` would have added 68 more
    by converging taxa whose only remaining answer was the fossil row, taking it
    to 847; after this corpus the population is **2**, and both are broken taxa
    the `broken` corpus already answers for by explaining the substitution.

    So the fossil record's name for a taxon is a way in to that taxon, on the
    same footing as a synonym. It is indexed into the `syn` FTS column — the
    weighting question ("a name it also goes by") has the same answer — but
    carries its own `kind`, because the *caption* question does not: OTT filing
    a name and PBDB using a name are different claims and the palette says
    which. See `matchTier` and `matchStrength` in the server.

    Only names nothing else already offers for that node: the ordinary case is
    that PBDB and OTT agree, and a duplicate row would compete with the
    scientific name for the same taxon. Dropped case-insensitively, matching
    `load_synonyms`.
    """
    if not _table_exists(con, "fossil") or not _column_exists(
        con, "fossil", "attach_walk"
    ):
        return 0
    # The index is not optional. `name_raw` is a temp table with none, and the
    # anti-join below is one lookup per candidate — without it SQLite scans all
    # 6.8M staged names 38,657 times and the phase goes from 53 s to over half
    # an hour. Dropped straight after: `renumber_by_rank` reads this table once,
    # in full, and an index it never probes is only a slower insert.
    con.execute("CREATE INDEX name_raw_dedup ON name_raw(idx)")
    try:
        con.execute(
            f"""
            INSERT INTO name_raw
            SELECT DISTINCT f.attach_idx, {KIND_PBDB}, f.name
              FROM fossil f
             WHERE f.attach_walk = 0
               AND f.name IS NOT NULL AND trim(f.name) <> ''
               AND NOT EXISTS (
                     SELECT 1 FROM name_raw r
                      WHERE r.idx = f.attach_idx AND lower(r.name) = lower(f.name))
            """
        )
    finally:
        con.execute("DROP INDEX name_raw_dedup")
    return con.execute(
        f"SELECT count(*) FROM name_raw WHERE kind = {KIND_PBDB}"
    ).fetchone()[0]


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

    `age_tier.npy` (tier 0 = measured) is the honest source; if only `age_ma.npy`
    exists the signal degrades to "has a displayable age", recorded as such.
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

    FTS5 returns matches in rowid order, so `ORDER BY rowid LIMIT k` stops at k
    instead of sorting every match (~40x on short prefixes). The ordering is the
    baked one — `rank_score` desc, then `kind`, then shorter string — so nothing
    moves to request time.

    Broken names sort last whatever their score: a `broken` row's `idx` is the
    substituted MRCA, so it inherits that node's `tip_count` and would otherwise
    rank near the top. Still reachable and exact-matchable, but never ahead of a
    real name.
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

    `SearchFossils` matched `lower(name) LIKE '%q%'` against 523,112 rows with no
    index — a full scan on every keystroke, ~90% of the endpoint. This index
    answers the same queries in 0.1–15 ms.

    Every row is indexed, not just the serveable ones: `notInTree`'s filter is a
    serving policy, and an index encoding it would go wrong silently the day it
    changes. The server keeps its own WHERE.

    FTS5 matches whole tokens and prefixes, so it drops the mid-word substring
    matches `LIKE` found (`rex` reaching *Aulacorexia*) — but those are exactly
    the rows `matchBand` scores `bandNone` and `Interleave` ranks behind every
    node, so they could never reach a page.
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


# Real queries the fossil index is gated on, chosen to cover shapes that behave
# differently: not-in-tree, in-tree, a genus fragment, a shared token, a short
# prefix.
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

    Asked this way round because `fossil_fts` is `content=''`, so a
    join-and-compare gate reads NULL and passes vacuously; looking each taxon up
    by its own name and requiring its own key is a question the index can be
    wrong about. Sampled from both ends of the keyspace.
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

    A phrase with the final token as a prefix, so the palette answers mid-type.
    `T. rex` becomes `"t rex"*`; FTS5 permits `*` only on a phrase's last token,
    which is why the abbreviated aliases are indexed as their own rows.
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
# vernacular. Two forms are compared because the indexed string keeps its
# punctuation (`T. rex`) while the tokenised needle has lost it (`t rex`).
_SQL_EXACT = _SELECT + " AND lower(sn.name) IN (?, ?) ORDER BY sn.kind, sn.id LIMIT ?"

# Then everything else, in the baked order that `search_name.id` encodes.
_SQL_POOL = _SELECT + " ORDER BY node_fts.rowid LIMIT ?"


def query(
    con: sqlite3.Connection, text: str, limit: int = 10, pool: int = 2000
) -> list[JsonDict]:
    """Rank candidates for `text`, deduplicated to one row per taxon.

    Two FTS queries:

    1. Exact matches, ordered by `kind` (a separate query, not an `is_exact`
       sort key, so an exact hit on an unremarkable taxon is not buried under
       higher-ranked prefix hits).
    2. Everything else in `search_name.id` order, which `renumber_by_rank` has
       already made equal to the ranking. No ranking at request time.

    Deduplication is here rather than in SQL so the best row per taxon is kept.
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
                    # A `broken` row is about the rejected taxon, so it is
                    # labelled with the searched name; `idx` still points at the
                    # substitute the client draws once it has explained itself.
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

# Each must return a taxon a person means, first. The third element says whether
# the check needs phase 6; those become observations, not blockers, without it.
SEARCH_CHECKS: tuple[tuple[str, tuple[str, ...], bool], ...] = (
    ("Homo sapiens", ("Homo sapiens",), False),
    ("dog", ("Canis lupus familiaris", "Canis familiaris", "Canis lupus"), True),
    # Both the species (Wikidata P1843) and the genus (PBDB) carry "human".
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

    # The infraspecific collapse's casualties, under the synonym kind: the
    # search question ("a name it also goes by") has the same answer, and a
    # reader typing "Canis lupus familiaris" must find the wolf. Deduplicated
    # against everything staged so far, since OTT often also carries a folded
    # trinomial as a formal synonym of the species. The index is what makes
    # the dedup probe one node's names rather than scan 4.5M rows per folded
    # taxon; dropped again so the remaining bulk inserts stay unindexed.
    n_syn_before_folded = staged(KIND_SYN)
    con.execute("CREATE INDEX name_raw_by_idx ON name_raw(idx)")
    con.execute(
        f"""
        INSERT INTO name_raw
        SELECT DISTINCT fi.idx, {KIND_SYN}, fi.name
          FROM folded_infraspecific fi
         WHERE trim(fi.name) <> ''
           AND NOT EXISTS (SELECT 1 FROM name_raw nr
                            WHERE nr.idx = fi.idx
                              AND lower(nr.name) = lower(fi.name))
        """
    )
    con.execute("DROP INDEX name_raw_by_idx")
    n_folded = staged(KIND_SYN) - n_syn_before_folded
    n_syn += n_folded
    print(f"  folded infraspecific: {n_folded:,}", flush=True)

    con.execute(
        f"""
        INSERT INTO name_raw
        SELECT mrca_idx, {KIND_BROKEN}, name FROM broken_taxon
         WHERE name IS NOT NULL AND trim(name) <> '' AND mrca_idx IS NOT NULL
        """
    )
    n_broken = staged(KIND_BROKEN)
    print(f"  broken taxa: {n_broken:,}", flush=True)

    # After the corpora it de-duplicates against, and before the vernaculars,
    # which are a different kind of name and never suppress a scientific one.
    n_pbdb = load_pbdb_names(con)
    print(f"  fossil-record names: {n_pbdb:,}", flush=True)

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
               -- A fossil-record name shares the synonym column: the weighting
               -- question ("a name it also goes by") has the same answer, and a
               -- sixth column would be a schema change for no ranking gain. The
               -- `kind` still tells them apart, which is what the caption reads.
               CASE WHEN kind IN ({KIND_SYN}, {KIND_PBDB}) THEN name END,
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

    # Last, because it reads both catalogues. It is the fallback for a query
    # that returned nothing; see `spelling.py`.
    print("\n--- spelling ---", flush=True)
    spell_counts = spelling.build(con, log=print)

    # ---- gates ----------------------------------------------------------
    print("\n--- gates ---", flush=True)
    n_names = con.execute("SELECT count(*) FROM search_name").fetchone()[0]

    g.require("scientific names indexed", n_sci, EXPECT_SCI)
    g.require("synonym rows read from synonyms.tsv", n_syn_read, EXPECT_SYNONYM_ROWS)
    g.require(
        "no name lost in the rank renumbering",
        n_names,
        n_sci + n_abbr + n_syn + n_vern_rows + n_broken + n_pbdb,
        note="renumber_by_rank is an inner join, and an inner join can drop rows",
    )
    g.require(
        "fossil-record names indexed",
        n_pbdb,
        EXPECT_PBDB_NAMES,
        note="the name PBDB uses for a taxon the tree holds, where nothing else "
        "already offers it — see `load_pbdb_names`. Without these, refusing the "
        "fossil row (fossil-grafts.md §9) leaves 847 taxa with no name that "
        "finds them: the tree answers under OTT's spelling and the reader "
        "typed PBDB's.",
    )
    g.require(
        "every taxon the tree holds is findable under the fossil record's name",
        con.execute(
            "SELECT count(*) FROM (SELECT DISTINCT attach_idx, name FROM fossil "
            " WHERE attach_walk = 0 AND name IS NOT NULL AND trim(name) <> '') f "
            "WHERE NOT EXISTS (SELECT 1 FROM search_name sn "
            "  WHERE sn.idx = f.attach_idx AND lower(sn.name) = lower(f.name))"
        ).fetchone()[0]
        if _table_exists(con, "fossil")
        else 0,
        0,
        note="the statement the corpus above exists to make, checked against "
        "the written table rather than the code that wrote it. `notInTree` "
        "refuses these rows from the fossil list, so this is the only thing "
        "left that can answer for the name.",
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

    # ---- spelling -------------------------------------------------------
    # Recall and refusal are gated separately and both are `require`. A
    # corrector is only half-tested by what it fixes: the failure this feature
    # is most likely to arrive at is the one the issue names — somebody loosens
    # a threshold until `hard maple` "works" and every other query gets worse.
    # REFUSALS is what makes that loosening fail the build.
    g.require(
        "every indexed word has a non-empty key",
        con.execute(
            "SELECT count(*) FROM spelling WHERE key IS NULL OR trim(key) = ''"
        ).fetchone()[0],
        0,
    )
    g.require(
        "no word shorter than the index floor",
        con.execute(
            f"SELECT count(*) FROM spelling WHERE length(word) < {spelling.MIN_INDEXED}"
        ).fetchone()[0],
        0,
    )
    fixed = {q: spelling.correct(con, q) for q, _ in spelling.CORRECTIONS}
    wrong = {q: fixed[q] for q, want in spelling.CORRECTIONS if fixed[q] != want}
    g.require(
        "a misspelling reaches the name it meant",
        f"{len(spelling.CORRECTIONS) - len(wrong)}/{len(spelling.CORRECTIONS)}",
        f"{len(spelling.CORRECTIONS)}/{len(spelling.CORRECTIONS)}",
        ok=not wrong,
        note="" if not wrong else f"wrong: {wrong}",
    )
    corrected = {q: spelling.correct(con, q) for q in spelling.REFUSALS}
    meddled = {q: c for q, c in corrected.items() if c is not None}
    g.require(
        "a name the corpus does not have is left alone",
        meddled,
        {},
        ok=not meddled,
        note="`hard maple` is a real name for Acer saccharum that phase 6 "
        "does not carry; no distance threshold may reach it, and the whole "
        "point of this gate is that raising one fails the build",
    )
    g.observe(
        "spelling index",
        {
            "words": f"{len(spell_counts):,}",
            "keys": f"{con.execute('SELECT count(DISTINCT key) FROM spelling').fetchone()[0]:,}",
            "max bucket": con.execute(
                "SELECT max(c) FROM (SELECT count(*) c FROM spelling GROUP BY key)"
            ).fetchone()[0],
        },
    )

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
