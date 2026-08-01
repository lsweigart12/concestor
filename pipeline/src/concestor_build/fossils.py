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
    from .typing_ import F32Array, F64Array, JsonDict, Log, U32Array

TOPOLOGY = BUILD / "topology"
BASELINE = BUILD / "phase4_baseline.json"
LAYOUT_BASELINE = BUILD / "phase4_layout.json"
# Phase 2's un-fossil-informed layout, kept so the two can be diffed and so a
# re-run of this phase clamps the original rather than compounding its own
# output. Without it, running phase 4 twice would be indistinguishable from
# running it once — which is exactly the class of silent bug this repo keeps
# finding.
LAYOUT_PHASE2 = TOPOLOGY / "age_layout_phase2.npy"

# Float32 positions and REAL bounds do not compare exactly, and a violation of
# a few thousand years is a rounding artefact rather than a trilobite in the
# Neogene. 0.01 Ma is well below the resolution of any PBDB interval.
LAYOUT_TOLERANCE_MA = 0.01

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

    print("\n--- bounding age_layout by the fossil record ---", flush=True)
    parent = np.load(TOPOLOGY / "parent.npy")
    age_ma = np.load(TOPOLOGY / "age_ma.npy")
    # Re-run safe: clamp phase 2's output, never this phase's own.
    if LAYOUT_PHASE2.exists():
        before = np.load(LAYOUT_PHASE2)
    else:
        before = np.load(TOPOLOGY / "age_layout.npy")
        np.save(LAYOUT_PHASE2, before)
    bound, direct, refused = layout_bounds(con, parent, age_ma)
    after, moved, conflicts = bound_layout(before, age_ma, parent, bound)
    np.save(TOPOLOGY / "age_layout.npy", after)
    layout_report = layout_gates(
        g, parent, age_ma, before, after, bound, direct, refused, moved, conflicts
    )
    LAYOUT_BASELINE.write_text(json.dumps(layout_report, indent=2) + "\n")
    print(f"  {moved:,} undated nodes moved back", flush=True)

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


# ------------------------------------------------------------------------------
# Bounding the layout by the fossil record
# ------------------------------------------------------------------------------
#
# `age_layout` is finite everywhere so that undated nodes can be drawn at all,
# and phase 2 fills an undated run by spreading it between the nearest dated
# ancestor and the *deepest dated descendant*. An extinct lineage has no dated
# descendant — every age in the artifact set comes from a chronogram of extant
# species — so the fill drags it toward the present. Measured: *T. rex* is drawn
# at 25.9 Ma against a last occurrence at 66, 1,078 undated nodes sit younger
# than their own last fossil, and Cambrian trilobites land in the Neogene.
#
# The dashed spine says the position is ordinal. It does not say the position is
# wrong by 450 Ma, and a reader has no way to tell those apart.
#
# This runs here because phase 4 is the first point in the build where a fossil
# bound exists at all — hence a rewrite of `age_layout.npy` rather than an edit
# to `layout_ages`, which runs four phases earlier. **`age_ma` is not touched
# and no node gains a number.** The three arrays are separate precisely so a
# position and a displayable age can disagree.


def _pick_bracket_end() -> str:
    """Documentation of a decision, in the one place it is applied.

    ingest.md phase 4 step 6 calls for "an occurrence-count floor or an outlier
    rule" as a prerequisite, because `fea` is frequently junk-wide — *Homo
    erectus* carries `fea = 5.333`, the base of the Zanclean, against a true
    first appearance near 2 Ma. **Measured, an occurrence-count floor does not
    work**: the first-appearance bracket does not narrow as occurrences
    accumulate, it widens, from a median 5.24 Ma at one occurrence to 6.20 Ma
    at fifty or more. The "one bad record" theory is wrong. `fea` is wide
    because it is a genuinely conservative earliest bound, and more occurrences
    mean more chances to include a poorly resolved one.

    What does discriminate is *which end of the bracket* is read. PBDB gives
    two per appearance — earliest and latest possible — and the latest end is
    the trustworthy one throughout:

        Homo erectus   fea   5.33  ->  fla   1.80   (true ~2 Ma)
        Trilobita      fea 538.80   ->  fla 521.00   (true ~521 Ma)
        Dimetrodon     fea 298.90   ->  fla 293.52   (true ~295 Ma)

    So no floor is applied and `fea` is never read. The layout bound uses
    `lla` alone — the *latest* possible last appearance, the weakest and safest
    of the four numbers. Its error direction is what makes it safe: a
    spuriously young occurrence makes `lla` more recent, which only weakens the
    bound, while a spuriously old one moves `fea` and is therefore not read.
    """
    return "lla"


def layout_bounds(
    con: sqlite3.Connection, parent: U32Array, age_ma: F32Array
) -> tuple[F64Array, int, int]:
    """Oldest last-appearance a node must be drawn at or before, per node.

    A taxon observed in the rock at `lla` was alive then, so the node standing
    for it cannot be drawn younger than that — and neither can any ancestor,
    since a lineage's origin precedes its occurrences. That is the propagation.

    Exact attachments only (`attach_walk = 0`). A bracket attached at a parent
    belongs to *some* taxon below that parent and records no clue which, so it
    constrains no particular child; borrowing it would put a Neanderthal range
    on any undated sibling. handoff.md §7 records why the apparent fix for that
    is an `xref` rank-resolution gap and not a relaxed walk.
    """
    n = parent.size
    bound = np.zeros(n, dtype=np.float64)
    rows = con.execute(
        f"SELECT attach_idx, max({_pick_bracket_end()}) FROM fossil "
        f"WHERE attach_walk = 0 AND {_pick_bracket_end()} IS NOT NULL "
        "GROUP BY attach_idx"
    ).fetchall()
    for idx, val in rows:
        if 0 <= idx < n and val is not None:
            bound[idx] = float(val)

    # A last-appearance bound is only ever evidence about a lineage that
    # *ended*. Where a node has a dated descendant its position is already
    # pinned by something still alive, and a bound saying it last appeared in
    # the Ediacaran is not a conflict to resolve — it is a bad attachment.
    #
    # Measured, and worth recording because it is a phase 3 defect this pass
    # only happened to surface: `xref` resolves PBDB to OTT by name, and OTT
    # carries **homonyms across kingdoms**. PBDB's *Ivesia* is a rangeomorph
    # and OTT's is a rose-family plant, so a 538.8 Ma bound landed on a living
    # genus. PBDB's *Heraultia* is the Cambrian mollusc *Watsonella*; OTT's is
    # not. `images.py` refuses an ambiguous name outright for exactly this
    # reason and phase 3 does not.
    #
    # So this is not a plausibility threshold — there is no defensible one —
    # but the statement that makes the bound meaningful at all. It also happens
    # to catch every homonym whose OTT node is extant, which is most of them.
    p_l = parent.astype(np.int64).tolist()
    d_l = np.isfinite(age_ma).tolist()
    for i in range(n - 1, 0, -1):
        if d_l[i]:
            d_l[p_l[i]] = True
    dated_below = np.array(d_l, dtype=bool)
    refused = int(((bound > 0) & dated_below).sum())
    bound[dated_below] = 0.0
    direct = int((bound > 0).sum())

    # Preorder gives parent[i] < i, so one reverse pass carries every bound to
    # the root.
    b = bound.tolist()
    for i in range(n - 1, 0, -1):
        if b[i] > b[p_l[i]]:
            b[p_l[i]] = b[i]
    return np.array(b, dtype=np.float64), direct, refused


def bound_layout(
    layout: F32Array, age_ma: F32Array, parent: U32Array, bound: F64Array
) -> tuple[F32Array, int, int]:
    """Push undated nodes back to their fossil bound, then restore monotonicity.

    Only undated nodes move. A dated node's position *is* its displayed number,
    and moving one would make the figure on the card disagree with where the
    reader sees it — a worse failure than the one being fixed, and a different
    kind. Where a dated ancestor is younger than a fossil beneath it, the
    monotonicity sweep pulls the descendant back down and the conflict is
    counted rather than silently resolved: it is a real disagreement between
    the chronogram and the rock, and the number of them is worth knowing.
    """
    out = layout.astype(np.float64).copy()
    undated = ~np.isfinite(age_ma)
    moved = int((undated & (bound > out)).sum())
    out = np.where(undated & (bound > out), bound, out)

    par = parent.astype(np.int64).tolist()
    o = out.tolist()
    conflicts = 0
    for i in range(1, len(o)):
        if o[i] > o[par[i]]:
            if bound[i] > 0:
                conflicts += 1
            o[i] = o[par[i]]
    return np.array(o, dtype=np.float32), moved, conflicts


def layout_gates(
    g: GateSet,
    parent: U32Array,
    age_ma: F32Array,
    before: F32Array,
    after: F32Array,
    bound: F64Array,
    direct: int,
    refused: int,
    moved: int,
    conflicts: int,
) -> JsonDict:
    """The gate ingest.md phase 4 names, over the population it can act on.

    The claim is "no **undated** node is laid out younger than its own last
    fossil". Written over *every* bounded node instead, it reads 27,951 before
    and 25,843 after and looks like a failure — but 24,415 of those are dated
    nodes, and this pass deliberately does not move a dated node, because its
    layout position *is* the figure printed on its card. Blocking on a number
    the step is not allowed to change would be a gate measuring the wrong
    thing, which this project has now done twice.

    So the requirement is the undated population and the dated one is an
    observation — and a substantial finding in its own right: PBDB attaching a
    stem fossil to a crown node older than the chronogram dates it is common,
    not exceptional.
    """
    has = bound > 0
    undated = ~np.isfinite(age_ma)
    late_before = before < bound - LAYOUT_TOLERANCE_MA
    late_after = after < bound - LAYOUT_TOLERANCE_MA

    viol_before = int((has & undated & late_before).sum())
    viol_after = int((has & undated & late_after).sum())
    dated_before = int((has & ~undated & late_before).sum())

    # What the pass can actually reach. A node cannot be drawn older than its
    # parent without inverting the tree, and a *dated* parent does not move,
    # because its position is the figure printed on its card. So the achievable
    # target is the fossil bound capped by the parent's final position, and
    # that — not the raw bound — is the blocking claim. The gap between the two
    # is reported below rather than absorbed, because it is a real conflict
    # between the chronogram and the rock and not a shortfall in this pass.
    par = parent.astype(np.int64)
    par[0] = 0  # the root's parent is the NO_PARENT sentinel, not an index
    reach = np.minimum(bound, after[par])
    reach[0] = bound[0]
    short = int((has & undated & (after < reach - LAYOUT_TOLERANCE_MA)).sum())

    capped = has & undated & late_after
    residual = (bound - after)[capped]

    g.observe(
        "nodes carrying an exact-attach fossil bound",
        f"{direct:,} directly, {int(has.sum()):,} including ancestors",
        note=(
            "Exact attachments only. A bracket at a parent belongs to some "
            "taxon below it and names no child, so it constrains none."
        ),
    )
    g.observe(
        "fossil bounds refused because the node has a living descendant",
        f"{refused:,}",
        note=(
            "A last appearance is evidence about a lineage that ended. Most of "
            "these are cross-kingdom homonyms out of phase 3's name-based "
            "`xref`: PBDB's *Ivesia* is an Ediacaran rangeomorph and OTT's is a "
            "rose-family plant, so a 538.8 Ma bound reached a living genus. "
            "`images.py` refuses an ambiguous name outright; phase 3 does not, "
            "and that is worth fixing there rather than guarding against here."
        ),
    )
    g.observe("undated nodes pushed back to their fossil bound", f"{moved:,}")
    g.require(
        "every undated node is pushed back as far as its fossil bound allows",
        f"{short:,} short of reachable",
        "0 short",
        ok=short == 0,
        note=(
            f"{viol_before:,} before this pass. Uses `lla`, the latest possible "
            "last appearance — the weakest of PBDB's four bounds and the only "
            "one whose error direction is safe, since a spuriously young "
            "occurrence only weakens the bound. `fea` is never read: measured, "
            "its bracket widens with occurrence count rather than narrowing "
            "(5.24 Ma median at one occurrence, 6.20 at fifty or more), so the "
            "occurrence-count floor ingest.md proposes as a prerequisite does "
            "not address what it was meant to. See `_pick_bracket_end`."
        ),
    )
    g.observe(
        "dated nodes younger than a fossil attaching at or below them",
        f"{dated_before:,}",
        note=(
            "Not fixed here and not a defect in this pass: a dated node's "
            "layout position is the figure on its card, and moving it would "
            "make the number and the picture disagree — a worse failure than "
            "the one being repaired, and a different kind. Mostly PBDB "
            "attaching a stem fossil to a crown node the chronogram dates "
            "younger. Worth a look if the drill-down ever renders these "
            "side by side, because there the disagreement becomes visible."
        ),
    )
    g.observe(
        "undated nodes still younger than their own last fossil",
        f"{viol_after:,} of {viol_before:,}, all capped by a dated ancestor"
        + (
            f"; median remaining gap {float(np.median(residual)):,.1f} Ma"
            if residual.size
            else ""
        ),
        note=(
            "Not reachable without either inverting the tree or moving a dated "
            "node away from its own printed figure. *Allosaurus fragilis* is "
            "the shape of these: drawn at 18.5 Ma before this pass, 129.6 Ma "
            "after, against a last fossil at 143.1 — the remaining 13.5 Ma is "
            "its nearest dated ancestor refusing to be older. The fix for the "
            "residual is upstream, in whatever attaches a stem fossil to a "
            "crown node, not here."
        ),
    )
    return {
        "undated_violations_before": viol_before,
        "undated_violations_after": viol_after,
        "dated_violations": dated_before,
        "nodes_bounded_directly": direct,
        "nodes_bounded_including_ancestors": int(has.sum()),
        "undated_nodes_moved": moved,
        "short_of_reachable": short,
        "pulled_back_by_dated_ancestor": conflicts,
    }
