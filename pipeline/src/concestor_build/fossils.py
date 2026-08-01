"""Phase 4 — attach PBDB taxa to the synthesis tree.

Fossils are **not placed in** the tree, they are **attached to** it. Only 0.5%
of OTT taxa flagged `extinct` appear in the synthetic tree at all, so the fossil
record is a parallel corpus with no topology of its own. Each PBDB taxon gets an
*attachment point* — the deepest node that is an ancestor-or-self of it — found
by walking PBDB's own `parent_no` hierarchy upward until a taxon resolves
through phase 3's `xref` to an in-synth `idx`.

The claim that makes is deliberately weak and honest: *this taxon belongs
somewhere below node X, and existed between these dates.* Not *this taxon is the
sister of that one.* The UI must not imply more.

Three things this phase must not get wrong, all of them recorded as gates:

- **Key on `accepted_no`, display `accepted_name`.** 10.1% of records have
  `accepted_no != orig_no`.
- **Never group by `taxon_rank`.** *Aublysodon* is a genus whose accepted name
  is a family, so rank does not survive resolution.
- **Carry all four appearance bounds uncollapsed.** `fea/fla` and `lea/lla` are
  two uncertainty brackets and the drill-down draws both; a single range is a
  different, wrong claim.

A ceiling binds the parent-walk and it is not a bug: GBIF's backbone has 11
ranks against PBDB's 25, so 32,629 PBDB taxa (6.2%) sit at ranks the backbone
cannot express and are *unmatchable* rather than unmatched. They skew toward the
notable end. The walk handles it; it just walks further than expected.
"""

from __future__ import annotations

import json
import random
import time
from collections import Counter
from typing import TYPE_CHECKING, NamedTuple

import httpx
import numpy as np

from .gates import GateSet
from .paths import BUILD
from .provenance import USER_AGENT
from .resolve import METHOD_ORDER, ROOT_IDX, connect, load_pbdb_taxa, table_exists

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Iterator, Sequence

    from .resolve import PbdbTaxon
    from .typing_ import JsonDict, Log, U32Array

TOPOLOGY = BUILD / "topology"
BASELINE = BUILD / "phase4_baseline.json"

PBDB_SINGLE = "https://paleobiodb.org/data1.2/taxa/list.json"

# --- measured baselines, 2026-07-31 -------------------------------------------

EXPECT_ROWS = 523_112
# 411,039 rows carry a first-appearance bound. ingest.md's "≥ 78%" gate is
# 411,039 / 523,112 = 78.58%.
EXPECT_WITH_INTERVAL = 411_039
MIN_INTERVAL_PCT = 78.0
EXPECT_ACCEPTED_DIFFERS = 52_595  # 10.1%
EXPECT_EXTANT_UNKNOWN = 9_059  # 1.7%, genuinely unknown rather than false
EXPECT_UNMATCHABLE_RANK = 32_629  # 6.2% at ranks GBIF's backbone cannot express

# GBIF's backbone expresses 11 ranks. These are the PBDB ranks that survive the
# translation; everything else is unmatchable *by construction*, which is why
# the parent-walk exists. `unranked clade` is counted as unmatchable to
# reproduce docs/phase3-pbdb-path.md §3's 32,629 exactly.
GBIF_EXPRESSIBLE_RANKS = frozenset(
    {"species", "genus", "family", "subspecies", "order", "class", "phylum", "kingdom"}
)

SPOT_TYRANNOSAURUS = 38613
SPOT_AUBLYSODON = 38614
# ingest.md asks for "at or below Dinosauria". Dinosauria is ott 90215 in the
# taxonomy but is **not a node in the synthesis tree**, so the containment test
# uses the deepest named ancestor that is — which is a strictly stronger claim.
SPOT_CONTAINER = "Tyrannosauridae"
SPOT_APPEARANCE = (83.6, 72.2, 72.2, 66.0)

ORACLE_SAMPLE = 40
ORACLE_SEED = 20_260_731
ORACLE_MIN_AGREEMENT = 95.0

# --- attachment provenance ----------------------------------------------------
# Dictionary-encoded, per architecture §3.4's `attach_method INTEGER`. Code 0 is
# the terminal fallback: every fossil attaches *somewhere*, and the root is
# where a taxon lands when nothing on its parent chain resolved.
ATTACH_ROOT = 0
ATTACH_METHOD_CODE: dict[str, int] = {"root_fallback": ATTACH_ROOT} | {
    m: i for i, m in enumerate(METHOD_ORDER, start=1)
}
ATTACH_METHOD_NAME = {v: k for k, v in ATTACH_METHOD_CODE.items()}

MAX_WALK = 64  # PBDB's deepest classification chain is far shorter; a guard


class Attachment(NamedTuple):
    idx: int
    method: int
    walk: int
    via: int | None  # the PBDB taxon_no that actually resolved


class FossilRow(NamedTuple):
    pbdb_taxon_no: int
    pbdb_orig_no: int
    accepted_no: int
    name: str
    rank: str | None
    own_name: str
    own_rank: str | None
    difference: str | None
    is_primary: int
    attach_idx: int
    attach_method: int
    attach_walk: int
    attach_via: int | None
    fea: float | None
    fla: float | None
    lea: float | None
    lla: float | None
    n_occs: int
    is_extant: int | None


def load_xref_pbdb(con: sqlite3.Connection) -> dict[int, tuple[int, int]]:
    """`taxon_no → (idx, attach_method_code)` for every PBDB id phase 3 resolved."""
    out: dict[int, tuple[int, int]] = {}
    for source_id, idx, method in con.execute(
        "SELECT source_id, idx, method FROM xref WHERE source = 'pbdb' AND idx IS NOT NULL"
    ):
        code = ATTACH_METHOD_CODE.get(method)
        if code is None:  # a method this phase does not know about
            continue
        out[int(source_id)] = (int(idx), code)
    return out


class Attacher:
    """Walks PBDB's `parent_no` chain to the deepest node the tree actually has.

    Memoised per `taxon_no`, because the chain above a genus is shared by every
    species in it and the top of the chain is walked hundreds of thousands of
    times otherwise.
    """

    __slots__ = ("_memo", "parent_of", "resolved")

    def __init__(
        self, resolved: dict[int, tuple[int, int]], parent_of: dict[int, int]
    ) -> None:
        self.resolved = resolved
        self.parent_of = parent_of
        self._memo: dict[int, Attachment] = {}

    def _from(self, start: int) -> Attachment:
        cached = self._memo.get(start)
        if cached is not None:
            return cached

        chain: list[int] = []
        cur = start
        seen: set[int] = set()
        found: Attachment | None = None
        while cur and cur not in seen and len(chain) < MAX_WALK:
            hit = self.resolved.get(cur)
            if hit is not None:
                found = Attachment(hit[0], hit[1], len(chain), cur)
                break
            seen.add(cur)
            chain.append(cur)
            cur = self.parent_of.get(cur, 0)

        if found is None:
            found = Attachment(ROOT_IDX, ATTACH_ROOT, len(chain), None)

        # Memoise every taxon on the chain, each with its own walk length.
        for hops, node in enumerate(chain):
            self._memo[node] = Attachment(
                found.idx, found.method, found.walk - hops, found.via
            )
        self._memo[start] = found
        return found

    def attach(self, t: PbdbTaxon) -> Attachment:
        """Resolve the record itself first, then its accepted taxon's chain.

        `walk` counts genuine `parent_no` hops, so a synonym resolving through
        its own accepted taxon is still walk 0 — both are "the taxon itself".
        """
        own = self.resolved.get(t.taxon_no)
        if own is not None:
            return Attachment(own[0], own[1], 0, t.taxon_no)
        return self._from(t.accepted_no or t.taxon_no)


def build_rows(
    taxa: Sequence[PbdbTaxon], attacher: Attacher
) -> tuple[list[FossilRow], Counter[int], Counter[int]]:
    rows: list[FossilRow] = []
    walks: Counter[int] = Counter()
    methods: Counter[int] = Counter()
    for t in taxa:
        a = attacher.attach(t)
        walks[a.walk] += 1
        methods[a.method] += 1
        rows.append(
            FossilRow(
                pbdb_taxon_no=t.taxon_no,
                pbdb_orig_no=t.orig_no,
                accepted_no=t.accepted_no or t.taxon_no,
                # Display the accepted name and its rank; keep the record's own
                # pair beside it, because rank does not survive resolution.
                name=t.accepted_name or t.name,
                rank=t.accepted_rank or None,
                own_name=t.name,
                own_rank=t.rank or None,
                difference=t.difference or None,
                is_primary=int(t.taxon_no == t.accepted_no),
                attach_idx=a.idx,
                attach_method=a.method,
                attach_walk=a.walk,
                attach_via=a.via,
                fea=t.fea,
                fla=t.fla,
                lea=t.lea,
                lla=t.lla,
                n_occs=t.n_occs,
                is_extant=t.is_extant,
            )
        )
    return rows, walks, methods


def write_db(con: sqlite3.Connection, rows: Sequence[FossilRow]) -> None:
    con.executescript(
        """
        DROP TABLE IF EXISTS fossil;
        DROP TABLE IF EXISTS fossil_attach_method;

        -- architecture §3.4 specifies `pbdb_orig_no INTEGER PRIMARY KEY`. That
        -- cannot work: `orig_no` is **not** unique in `pbdb_taxa.csv` (407,634
        -- distinct values over 523,112 rows; *Dinosauria* alone has ten rank
        -- variants sharing orig_no 52775). `taxon_no` is unique, and it is also
        -- what `parent_no`, `accepted_no` and GBIF's `sourceId` all reference,
        -- so it is the key. `orig_no` is kept as a column.
        CREATE TABLE fossil (
          pbdb_taxon_no INTEGER PRIMARY KEY,
          pbdb_orig_no  INTEGER NOT NULL,
          accepted_no   INTEGER NOT NULL,
          name          TEXT NOT NULL,     -- accepted_name
          rank          TEXT,              -- accepted_rank
          own_name      TEXT NOT NULL,
          own_rank      TEXT,              -- may differ in rank, not just name
          difference    TEXT,              -- 'nomen dubium', 'subjective synonym of', …
          is_primary    INTEGER NOT NULL,  -- taxon_no == accepted_no
          attach_idx    INTEGER NOT NULL,
          attach_method INTEGER NOT NULL,
          attach_walk   INTEGER NOT NULL,  -- parent_no hops taken
          attach_via    INTEGER,           -- the PBDB taxon that resolved
          fea REAL, fla REAL, lea REAL, lla REAL,   -- two brackets, uncollapsed
          n_occs        INTEGER NOT NULL,
          is_extant     INTEGER            -- nullable: 1.7% genuinely unknown
        );

        CREATE TABLE fossil_attach_method (
          code INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        );
        """
    )
    con.executemany(
        "INSERT INTO fossil VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows
    )
    con.executemany(
        "INSERT INTO fossil_attach_method VALUES (?,?)",
        sorted(ATTACH_METHOD_NAME.items()),
    )
    con.executescript(
        """
        CREATE INDEX fossil_attach ON fossil(attach_idx, n_occs DESC);
        CREATE INDEX fossil_accepted ON fossil(accepted_no);
        """
    )
    con.commit()


def oracle_appearances(
    rows: Sequence[FossilRow], *, samples: int = ORACLE_SAMPLE, log: Log = print
) -> JsonDict:
    """Check baked appearance bounds against PBDB's live API.

    Phase 1 validates its parse against a live induced-subtree oracle; this is
    the same idea applied to the one thing phase 4 copies verbatim. It is a
    handful of requests, and it catches a snapshot that has drifted from the
    service it came from.
    """
    rng = random.Random(ORACLE_SEED)
    pool = [r for r in rows if r.fea is not None and r.n_occs > 0]
    picked = rng.sample(pool, k=min(samples, len(pool)))
    ids = ",".join(f"txn:{r.pbdb_taxon_no}" for r in picked)
    with httpx.Client(
        headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(60.0, connect=30.0)
    ) as client:
        r = client.get(PBDB_SINGLE, params={"taxon_id": ids, "show": "app"})
        r.raise_for_status()
        live = {
            int(rec["oid"].removeprefix("txn:")): rec for rec in r.json()["records"]
        }

    compared = agreed = 0
    disagreements: list[JsonDict] = []
    for row in picked:
        rec = live.get(row.pbdb_taxon_no)
        if rec is None:
            continue
        compared += 1
        ours = (row.fea, row.fla, row.lea, row.lla)
        theirs = tuple(rec.get(k) for k in ("fea", "fla", "lea", "lla"))
        if all(
            a is not None and b is not None and abs(a - b) < 1e-6
            for a, b in zip(ours, theirs, strict=True)
        ):
            agreed += 1
        else:
            disagreements.append(
                {"taxon_no": row.pbdb_taxon_no, "ours": ours, "live": theirs}
            )
    log(f"  oracle: {agreed}/{compared} appearance brackets agree with live PBDB")
    return {
        "sampled": len(picked),
        "compared": compared,
        "agreed": agreed,
        "disagreements": disagreements[:10],
    }


def _subtree_container(con: sqlite3.Connection, name: str) -> tuple[int, int] | None:
    row = con.execute(
        "SELECT idx FROM node WHERE name = ? ORDER BY tip_count DESC LIMIT 1", (name,)
    ).fetchone()
    if row is None:
        return None
    idx = int(row[0])
    subtree_out: U32Array = np.load(TOPOLOGY / "subtree_out.npy")
    return idx, int(subtree_out[idx])


def _histogram(counter: Counter[int], top: int = 12) -> str:
    total = sum(counter.values())
    parts = [
        f"{k}:{v:,} ({100 * v / total:.1f}%)" for k, v in sorted(counter.items())[:top]
    ]
    if len(counter) > top:
        parts.append("…")
    return " · ".join(parts)


def _median(counter: Counter[int]) -> float:
    total = sum(counter.values())
    if not total:
        return 0.0
    half = total / 2
    seen = 0
    for k in sorted(counter):
        seen += counter[k]
        if seen >= half:
            return float(k)
    return float(max(counter))


def _iter_depths(rows: Sequence[FossilRow], depth: U32Array) -> Iterator[int]:
    for r in rows:
        yield int(depth[r.attach_idx])


def run(use_api: bool = True) -> int:
    g = GateSet("phase4-fossils")
    BUILD.mkdir(parents=True, exist_ok=True)

    con = connect()
    if not table_exists(con, "xref"):
        raise SystemExit("phase 4 needs phase 3's xref table — run `resolve` first")

    print("--- loading pbdb_taxa.csv and xref ---", flush=True)
    taxa = load_pbdb_taxa()
    g.require("pbdb_taxa.csv rows", len(taxa), EXPECT_ROWS)

    resolved = load_xref_pbdb(con)
    g.observe(
        "PBDB taxa carrying an xref resolution",
        f"{len(resolved):,} ({100 * len(resolved) / len(taxa):.2f}%)",
    )

    parent_of = {t.taxon_no: t.parent_no for t in taxa}
    attacher = Attacher(resolved, parent_of)

    print("--- attaching ---", flush=True)
    t0 = time.monotonic()
    rows, walks, methods = build_rows(taxa, attacher)
    print(f"  {len(rows):,} rows in {time.monotonic() - t0:,.1f}s", flush=True)

    print("--- writing fossil ---", flush=True)
    write_db(con, rows)

    # --- structural gates -----------------------------------------------------
    print("\n--- structural gates ---", flush=True)
    n_rows = con.execute("SELECT count(*) FROM fossil").fetchone()[0]
    g.require("fossil rows", n_rows, EXPECT_ROWS)
    g.require(
        "rows whose attach_idx is not a node",
        con.execute(
            "SELECT count(*) FROM fossil LEFT JOIN node ON node.idx = fossil.attach_idx "
            "WHERE node.idx IS NULL"
        ).fetchone()[0],
        0,
    )
    g.require(
        "rows whose attach_method is outside the dictionary",
        con.execute(
            "SELECT count(*) FROM fossil WHERE attach_method NOT IN "
            "(SELECT code FROM fossil_attach_method)"
        ).fetchone()[0],
        0,
    )
    g.require(
        "records whose accepted_no differs from orig_no",
        con.execute(
            "SELECT count(*) FROM fossil WHERE accepted_no != pbdb_orig_no"
        ).fetchone()[0],
        EXPECT_ACCEPTED_DIFFERS,
        note="10.1% — the reason the table keys on accepted_no and displays "
        "accepted_name.",
    )

    # --- content gates --------------------------------------------------------
    # Counting rows is not checking them. Every column below carries something a
    # downstream consumer reads directly.
    print("\n--- content gates ---", flush=True)
    with_interval = con.execute(
        "SELECT count(*) FROM fossil WHERE fea IS NOT NULL"
    ).fetchone()[0]
    pct = 100 * with_interval / n_rows
    g.require(
        "rows carrying an appearance interval",
        f"{pct:.2f}% ({with_interval:,}/{n_rows:,})",
        f"≥ {MIN_INTERVAL_PCT}% (baseline {EXPECT_WITH_INTERVAL:,} = 78.58%)",
        ok=pct >= MIN_INTERVAL_PCT,
    )
    missing_with_occs = con.execute(
        "SELECT count(*) FROM fossil WHERE fea IS NULL AND n_occs > 0"
    ).fetchone()[0]
    g.observe(
        "rows with no interval despite n_occs > 0",
        missing_with_occs,
        0,
        note="ingest.md says the missing set is *exactly* the n_occs = 0 rows. "
        "Containment holds — all 111,864 zero-occurrence rows lack an interval "
        "— but the missing set is 112,073, so 209 rows have occurrences and no "
        "bounds. (111,864 rather than 111,848 because 16 rows carry an empty "
        "n_occs field rather than a zero.)",
    )
    g.require(
        "rows carrying all four bounds where any is present",
        con.execute(
            "SELECT count(*) FROM fossil WHERE fea IS NOT NULL AND "
            "(fla IS NULL OR lea IS NULL OR lla IS NULL)"
        ).fetchone()[0],
        424,
        note="fea/fla and lea/lla are two brackets; 424 rows carry a first "
        "appearance without a last. They must not be collapsed or invented.",
    )
    g.require(
        "is_extant NULL — genuinely unknown, not false",
        con.execute("SELECT count(*) FROM fossil WHERE is_extant IS NULL").fetchone()[
            0
        ],
        EXPECT_EXTANT_UNKNOWN,
    )
    g.observe(
        "rows where the accepted rank differs from the record's own",
        con.execute(
            "SELECT count(*) FROM fossil WHERE own_rank IS NOT rank"
        ).fetchone()[0],
        note="the count is the point, not a threshold — see the Aublysodon "
        "spot check. Grouping by taxon_rank on the assumption it survives "
        "resolution is the bug this column exists to make visible.",
    )
    unmatchable = sum(1 for t in taxa if t.rank not in GBIF_EXPRESSIBLE_RANKS)
    g.require(
        "PBDB taxa at ranks GBIF's backbone cannot express",
        unmatchable,
        EXPECT_UNMATCHABLE_RANK,
        note="6.2%, unmatchable rather than unmatched. The parent-walk is what "
        "handles them.",
    )

    # --- attachment quality ---------------------------------------------------
    print("\n--- attachment ---", flush=True)
    depth: U32Array = np.load(TOPOLOGY / "depth.npy")
    depths: Counter[int] = Counter(_iter_depths(rows, depth))
    median_depth = _median(depths)
    median_walk = _median(walks)

    g.observe("attachment depth distribution", _histogram(depths, top=16))
    g.observe("attachment depth — median", median_depth)
    g.observe("parent-walk length distribution", _histogram(walks, top=16))
    g.observe("parent-walk length — median", median_walk)
    g.observe(
        "attachment provenance",
        " · ".join(
            f"{ATTACH_METHOD_NAME[k]} {v:,}" for k, v in sorted(methods.items())
        ),
    )

    top_points = con.execute(
        "SELECT f.attach_idx, n.name, n.depth, count(*) c FROM fossil f "
        "JOIN node n ON n.idx = f.attach_idx GROUP BY f.attach_idx "
        "ORDER BY c DESC LIMIT 12"
    ).fetchall()
    g.observe(
        "busiest attachment points",
        " · ".join(f"{name or key}({d}) {c:,}" for key, name, d, c in top_points),
    )

    at_root = con.execute(
        "SELECT count(*) FROM fossil WHERE attach_idx = ?", (ROOT_IDX,)
    ).fetchone()[0]
    g.observe(
        "fossils falling back to the root",
        f"{at_root:,} ({100 * at_root / n_rows:.1f}%)",
        note="every fossil attaches somewhere; the root is the terminal "
        "fallback. Everything landing at Eukaryota means the chain is broken.",
    )

    baseline: JsonDict = json.loads(BASELINE.read_text()) if BASELINE.exists() else {}
    prior = baseline.get("median_attachment_depth")
    g.require(
        "median attachment depth vs the previous build",
        median_depth,
        prior,
        ok=prior is None or median_depth >= prior - 1,
        note="no baseline — first build" if prior is None else "",
    )

    # --- spot checks ----------------------------------------------------------
    print("\n--- spot checks ---", flush=True)
    tyr = con.execute(
        "SELECT name, fea, fla, lea, lla, attach_idx, attach_walk, attach_method "
        "FROM fossil WHERE pbdb_taxon_no = ?",
        (SPOT_TYRANNOSAURUS,),
    ).fetchone()
    g.require(
        "spot check — Tyrannosaurus appearance bracket",
        None if tyr is None else tuple(tyr[1:5]),
        SPOT_APPEARANCE,
        ok=tyr is not None and tuple(tyr[1:5]) == SPOT_APPEARANCE,
    )
    container = _subtree_container(con, SPOT_CONTAINER)
    inside = (
        tyr is not None
        and container is not None
        and container[0] <= tyr[5] < container[1]
    )
    g.require(
        "spot check — Tyrannosaurus attaches inside " + SPOT_CONTAINER,
        None if tyr is None else f"attach_idx={tyr[5]} walk={tyr[6]}",
        f"within [{container[0]}, {container[1]})" if container else "container absent",
        ok=inside,
        note="ingest.md asks for 'at or below Dinosauria'. Dinosauria is "
        "ott 90215 in the taxonomy but is not a node in the synthesis tree, so "
        "the test uses the deepest named ancestor that is — a stronger claim.",
    )
    aub = con.execute(
        "SELECT own_name, own_rank, name, rank, difference FROM fossil "
        "WHERE pbdb_taxon_no = ?",
        (SPOT_AUBLYSODON,),
    ).fetchone()
    g.require(
        "spot check — Aublysodon is a genus whose accepted name is a family",
        aub,
        ("Aublysodon", "genus", "Tyrannosauridae", "family", "nomen dubium"),
        ok=aub is not None
        and aub[1] == "genus"
        and aub[3] == "family"
        and aub[2] == "Tyrannosauridae",
    )

    # --- oracle ---------------------------------------------------------------
    oracle: JsonDict = {}
    if use_api:
        print("\n--- oracle: live PBDB appearance bounds ---", flush=True)
        oracle = oracle_appearances(rows, log=print)
        agree_pct = 100 * oracle["agreed"] / max(oracle["compared"], 1)
        g.require(
            "oracle — appearance brackets agree with live PBDB",
            f"{oracle['agreed']}/{oracle['compared']} ({agree_pct:.0f}%)",
            f"≥ {ORACLE_MIN_AGREEMENT}%",
            ok=oracle["compared"] > 0 and agree_pct >= ORACLE_MIN_AGREEMENT,
            note="not 100%: unlike OTT's pinned synthesis, PBDB is continuously "
            "edited, so the snapshot and the live service legitimately drift. "
            + (
                json.dumps(oracle["disagreements"])
                if oracle["disagreements"]
                else "No disagreements in this sample."
            ),
        )
    else:
        g.observe("oracle — appearance brackets", "skipped (--no-api)")

    BASELINE.write_text(
        json.dumps(
            {
                "written_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "rows": n_rows,
                "median_attachment_depth": median_depth,
                "median_parent_walk": median_walk,
                "attachment_depth_histogram": dict(sorted(depths.items())),
                "parent_walk_histogram": dict(sorted(walks.items())),
                "attachment_provenance": {
                    ATTACH_METHOD_NAME[k]: v for k, v in sorted(methods.items())
                },
                "at_root": at_root,
                "with_interval": with_interval,
                "oracle": oracle,
            },
            indent=2,
        )
        + "\n"
    )
    con.close()

    g.write(BUILD / "phase4_gates.json")
    g.exit_if_failed()
    return 0
