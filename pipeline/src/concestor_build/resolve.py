"""Phase 3 — the identifier resolution layer.

Emits the `xref` table (architecture §3.3) and `build/reconciliation.json`
(architecture §5). Methods run in **strict precedence order** and a later method
never overwrites an earlier one — including a `manual` row that deliberately
resolves to nothing, which is what makes suppression work.

    1. manual                     data/overrides.tsv, git-tracked
    2. ott_sourceinfo             OTT's own sourceinfo column
    3. gbif_pbdb_chain            GBIF checklist point lookup -> nubKey -> OTT
    4. gbif_backbone_provenance   the frozen backbone's provenance column
    5. phylopic_resolve           owned by phase 5; consumed here, not crawled
    6. name_exact                 exact string, unique candidate only

Then a **sweep** takes resolutions away again — see `refuse_disagreements`. It
is not a seventh method: the six above ask "what node is this?" and the sweep
asks "does anything contradict the answer?", which is why it runs last, over
every method at once, and can overwrite a row none of them may.

All resolution happens at build time. The runtime never matches names, and
there is no fuzzy method anywhere: 16% of PBDB genus names are cross-kingdom
homonyms and a system that silently picks one is worse than one that admits it
does not know. Being *unique* is not the same as being right, though, which is
what the sweep is for: OTT has exactly one *Sadleria* and it is a living fern,
so the Devonian sponge of that name matched it unopposed.

`gbif_checklist.py`'s ~450 covering shards are **superseded for this purpose**.
That module solves a bulk-export problem this build does not have; the point
lookup used here does not page, so GBIF's offset cap never applies. The module
is kept as documentation of a route not to take — see its STATUS note and
docs/phase3-pbdb-path.md §5.

The crawl is **prioritised, not exhaustive** (management.md): ordered by
`n_occs` descending, resumable from an on-disk checkpoint, and bounded by
`--budget`. 523,112 lookups at the measured 0.5 s is 73 hours; the top 25,000
genera hold 93.3% of genus occurrences, and fossils are a secondary feature.
"""

from __future__ import annotations

import csv
import gzip
import json
import random
import sqlite3
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import TYPE_CHECKING, NamedTuple

import httpx
import numpy as np

from .gates import GateSet
from .paths import BUILD, DATA, SNAPSHOT
from .provenance import USER_AGENT, Manifest, record_local

if TYPE_CHECKING:
    from collections.abc import Iterable, Iterator, Sequence
    from pathlib import Path

    from .typing_ import BoolArray, I64Array, JsonDict, Log

# --- locations ---------------------------------------------------------------

DB = BUILD / "concestor.db"
TOPOLOGY = BUILD / "topology"
TAXONOMY = BUILD / "extracted" / "ott3.7.3" / "taxonomy.tsv"
PBDB_TAXA = SNAPSHOT / "pbdb" / "pbdb_taxa.csv"
BACKBONE = SNAPSHOT / "gbif_legacy_backbone" / "simple.txt.gz"
NUBKEYS = SNAPSHOT / "gbif_pbdb_checklist" / "nubkeys.ndjson"
OVERRIDES = DATA / "overrides.tsv"
ACKNOWLEDGED = DATA / "acknowledged_regressions.tsv"
RECONCILIATION = BUILD / "reconciliation.json"

# --- the chain ---------------------------------------------------------------

PBDB_DATASET_KEY = "c33ce2f2-c3cc-43a5-a380-fe4526d63650"
GBIF_SPECIES = "https://api.gbif.org/v1/species"

# The six taxonomies OTT records verbatim. Everything else in `sourceinfo` is a
# study id or malformed — see `parse_sourceinfo`.
TAXONOMY_SOURCES = frozenset({"ncbi", "gbif", "irmng", "worms", "if", "silva"})

# Precedence order. Confidences are architecture §5's, except
# `gbif_backbone_provenance`, which postdates that table and sits directly below
# the API chain it mirrors.
METHOD_ORDER = (
    "manual",
    "ott_sourceinfo",
    "gbif_pbdb_chain",
    "gbif_backbone_provenance",
    "phylopic_resolve",
    "name_exact",
)
UNRESOLVED = "unresolved"

# The sweep in `refuse_disagreements`, which runs *after* all six methods and
# takes resolutions away. They are methods in the sense the column means — how
# this row came to say what it says — and they resolve to nothing, so they carry
# the same zero confidence as `unresolved` and are excluded from `METHOD_ORDER`,
# which is the precedence order of methods that *find* something.
REFUSED_EXTANCY = "refused_extancy_disagreement"
REFUSED_AMBIGUOUS = "refused_name_ambiguous"
REFUSALS = (REFUSED_EXTANCY, REFUSED_AMBIGUOUS)

CONFIDENCE: dict[str, float] = {
    "manual": 1.00,
    "ott_sourceinfo": 0.99,
    "gbif_pbdb_chain": 0.90,
    "gbif_backbone_provenance": 0.88,
    "phylopic_resolve": 0.98,
    "name_exact": 0.70,
    UNRESOLVED: 0.00,
    REFUSED_EXTANCY: 0.00,
    REFUSED_AMBIGUOUS: 0.00,
}

# --- measured baselines ------------------------------------------------------
# Every figure here was measured on 2026-07-31 against the pinned snapshot and
# reproduced exactly when this module was written. They are not estimates.

EXPECT_PBDB_ROWS = 523_112

# ingest.md phase 3 step 2, all reproduced exactly bar IRMNG — see the gate.
EXPECT_TAXA_PER_SOURCE = {
    "gbif": 2_562_021,
    "if": 276_248,
    "irmng": 1_480_678,
    "ncbi": 1_955_883,
    "silva": 74_255,
    "worms": 406_365,
}

EXPECT_BACKBONE_ROWS = 7_746_724
EXPECT_BACKBONE_PBDB_CITED = 212_054

# docs/phase3-pbdb-path.md §1: PBDB taxa reaching a backbone row. The file is
# frozen, so *any* movement is a bug in our code rather than upstream.
EXPECT_BACKBONE_PCT = 38.6
BACKBONE_TOLERANCE = 2.0
EXPECT_BACKBONE_OTT_PCT = 17.9

# docs/phase3-pbdb-path.md §5, conditioned on records that exist in the
# checklist. Scored on a *uniform* control cohort, because the doc's sample was
# uniform and the prioritised crawl is emphatically not — see `run`.
EXPECT_HOP1_PCT = 92.9  # checklist record -> nubKey
EXPECT_HOP2_PCT = 51.9  # nubKey -> OTT taxon
EXPECT_E2E_PCT = 48.2  # checklist record -> OTT taxon
CHAIN_TOLERANCE = 5.0

CONTROL_SAMPLE = 1_000
CONTROL_SEED = 20_260_731

ROOT_IDX = 0


# --- small helpers -----------------------------------------------------------


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def connect(path: Path = DB, *, readonly: bool = False) -> sqlite3.Connection:
    """Open the shared build database, tolerating another phase holding a lock.

    Several phases write to `concestor.db`. None of them touch `node`, but they
    do overlap in time, so every connection waits rather than failing.
    """
    uri = f"file:{path}?mode=ro" if readonly else f"file:{path}"
    con = sqlite3.connect(uri, uri=True, timeout=120.0)
    con.execute("PRAGMA busy_timeout = 120000")
    return con


def table_exists(con: sqlite3.Connection, name: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


class IdMap:
    """A sorted key/value pair of arrays used as an integer→integer map.

    A Python dict over 2.6M GBIF ids costs roughly 250 MB; the same data as two
    `int64` arrays is 41 MB, and every lookup site here is naturally batched.
    First key wins on duplicates, which is the same precedence rule the rest of
    the phase runs on.
    """

    __slots__ = ("keys", "n_duplicate", "values")

    def __init__(self, keys: Iterable[int], values: Iterable[int]) -> None:
        k = np.fromiter(keys, dtype=np.int64)
        v = np.fromiter(values, dtype=np.int64)
        order = np.argsort(k, kind="stable")
        k, v = k[order], v[order]
        keep = np.ones(k.shape, dtype=np.bool_)
        if k.size:
            keep[1:] = k[1:] != k[:-1]
        self.n_duplicate = int(k.size - keep.sum())
        self.keys: I64Array = k[keep]
        self.values: I64Array = v[keep]

    def __len__(self) -> int:
        return int(self.keys.size)

    def lookup(self, query: I64Array) -> I64Array:
        """Return the mapped values for `query`, `-1` where the key is absent."""
        if self.keys.size == 0:
            return np.full(query.shape, -1, dtype=np.int64)
        pos = np.searchsorted(self.keys, query)
        pos = np.clip(pos, 0, self.keys.size - 1)
        hit = self.keys[pos] == query
        return np.where(hit, self.values[pos], -1)

    def get(self, key: int) -> int | None:
        v = int(self.lookup(np.array([key], dtype=np.int64))[0])
        return None if v < 0 else v


# --- PBDB ---------------------------------------------------------------------


class PbdbTaxon(NamedTuple):
    """One row of `pbdb_taxa.csv`.

    `taxon_no` is the unique key: `orig_no` is **not** unique (407,634 distinct
    values over 523,112 rows — *Dinosauria* alone has ten rank variants sharing
    orig_no 52775), which is why the primary key architecture §3.4 specifies
    cannot be used as written. `parent_no` and `accepted_no` both reference
    `taxon_no`, confirmed against the whole file.
    """

    taxon_no: int
    orig_no: int
    rank: str
    name: str
    accepted_no: int
    accepted_rank: str
    accepted_name: str
    parent_no: int
    n_occs: int
    is_extant: int | None
    difference: str
    fea: float | None
    fla: float | None
    lea: float | None
    lla: float | None
    # PBDB's own flags, a character set: `I` ichnotaxon, `F` form taxon, `V`
    # variant. Phase 4 reads `I` and `F` — for those two a genus-level
    # identification is the *finest one that exists*, so their own appearance
    # range is their real one and must not be second-guessed against species
    # that were never going to be named. See `fossils.young_ends`.
    flags: str


def _num(raw: str) -> float | None:
    return float(raw) if raw else None


def _int(raw: str) -> int:
    return int(raw) if raw else 0


_EXTANT = {"extant": 1, "extinct": 0}


def load_pbdb_taxa(path: Path = PBDB_TAXA) -> list[PbdbTaxon]:
    """Read `pbdb_taxa.csv` into memory. ~523k rows, a couple of seconds."""
    out: list[PbdbTaxon] = []
    with path.open(newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            out.append(
                PbdbTaxon(
                    taxon_no=int(r["taxon_no"]),
                    orig_no=int(r["orig_no"]),
                    rank=r["taxon_rank"],
                    name=r["taxon_name"],
                    accepted_no=_int(r["accepted_no"]),
                    accepted_rank=r["accepted_rank"],
                    accepted_name=r["accepted_name"],
                    parent_no=_int(r["parent_no"]),
                    n_occs=_int(r["n_occs"]),
                    # Nullable on purpose: 9,059 records (1.7%) are genuinely
                    # unknown, which is not the same claim as "not extant".
                    is_extant=_EXTANT.get(r["is_extant"]),
                    difference=r["difference"],
                    fea=_num(r["firstapp_max_ma"]),
                    fla=_num(r["firstapp_min_ma"]),
                    lea=_num(r["lastapp_max_ma"]),
                    lla=_num(r["lastapp_min_ma"]),
                    flags=r["flags"] or "",
                )
            )
    return out


# --- the accumulator ----------------------------------------------------------


class Resolution(NamedTuple):
    idx: int | None
    method: str
    candidates: list[int] | None


class Xref:
    """Set-if-absent map of `(source, source_id) -> Resolution`.

    Precedence is enforced by refusing every write to a key that already has
    one, so the method order in `run` *is* the precedence order and a `manual`
    row resolving to `None` blocks everything downstream of it.
    """

    __slots__ = ("_rows", "blocked", "by_method")

    def __init__(self) -> None:
        self._rows: dict[tuple[str, str], Resolution] = {}
        self.by_method: Counter[str] = Counter()
        self.blocked: Counter[str] = Counter()

    def add(
        self,
        source: str,
        source_id: str,
        idx: int | None,
        method: str,
        candidates: list[int] | None = None,
    ) -> bool:
        key = (source, source_id)
        if key in self._rows:
            self.blocked[method] += 1
            return False
        self._rows[key] = Resolution(idx, method, candidates)
        self.by_method[method] += 1
        return True

    def revoke(
        self, source: str, source_id: str, method: str, candidates: list[int] | None
    ) -> bool:
        """Take a resolution away, recording which sweep took it.

        The only writer that may overwrite an existing row, and deliberately so:
        `add`'s refuse-every-rewrite is what makes `METHOD_ORDER` a precedence
        order, and a refusal is not another claimant in that order — it is the
        statement that no claimant was good enough. The candidate list keeps
        what was withdrawn, so a reader can see what the sweep decided against
        rather than an unexplained absence.

        `manual` is exempt. Those two rows are somebody's reviewed judgement
        against the pinned snapshot, and a gate exists purely to fail the build
        if one stops applying; a sweep quietly overruling one would be the same
        class of bug that gate was written to catch.
        """
        cur = self._rows.get((source, source_id))
        if cur is None or cur.idx is None or cur.method == "manual":
            return False
        keep = candidates if candidates is not None else [cur.idx]
        self._rows[(source, source_id)] = Resolution(None, method, keep)
        self.by_method[cur.method] -= 1
        self.by_method[method] += 1
        return True

    def get(self, source: str, source_id: str) -> Resolution | None:
        return self._rows.get((source, source_id))

    def resolved_idx(self, source: str, source_id: str) -> int | None:
        r = self._rows.get((source, source_id))
        return None if r is None else r.idx

    def __contains__(self, key: tuple[str, str]) -> bool:
        return key in self._rows

    def __len__(self) -> int:
        return len(self._rows)

    def rows(self) -> Iterator[tuple[str, str, int | None, str, float, str | None]]:
        for (source, source_id), r in self._rows.items():
            yield (
                source,
                source_id,
                r.idx,
                r.method,
                CONFIDENCE.get(r.method, 0.0),
                None
                if not r.candidates
                else json.dumps(r.candidates, separators=(",", ":")),
            )


# --- method 1: manual ---------------------------------------------------------


class Override(NamedTuple):
    source: str
    source_id: str
    ott_id: int | None
    reason: str


OVERRIDE_HEADER = ("source", "source_id", "ott_id", "reason")

# The two rows architecture §5 gives as examples. Both were verified against the
# pinned snapshot before being written out:
#   - pbdb 38613 is *Tyrannosaurus*; GBIF nubKey 4822631 carries OTT 664348,
#     which is node idx 654141 in the synthesis tree.
#   - pbdb 52983 is *Brontosaurus*, which PBDB currently accepts alongside
#     *Apatosaurus* (38665) as a separate genus — the instability the override
#     is suppressing is real and present in the snapshot.
SEED_OVERRIDES = (
    Override("pbdb", "38613", 664348, "verified via GBIF nubKey 4822631, 2026-07-31"),
    Override(
        "pbdb", "52983", None, "Brontosaurus/Apatosaurus synonymy unstable; suppress"
    ),
)


def write_seed_overrides(path: Path = OVERRIDES) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = ["\t".join(OVERRIDE_HEADER)]
    lines += [
        "\t".join(
            (
                o.source,
                o.source_id,
                "NULL" if o.ott_id is None else str(o.ott_id),
                o.reason,
            )
        )
        for o in SEED_OVERRIDES
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def load_overrides(path: Path = OVERRIDES) -> list[Override]:
    """Read `data/overrides.tsv`. `reason` is required; a blank one is an error.

    An override is a judgement call about contested taxonomy, which is why the
    file is git-tracked rather than a database row: judgement calls need review,
    attribution and history.
    """
    if not path.exists():
        return []
    out: list[Override] = []
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        for n, row in enumerate(reader, start=2):
            missing = [c for c in OVERRIDE_HEADER if row.get(c) is None]
            if missing:
                raise ValueError(f"{path}:{n} missing column(s) {missing}")
            reason = (row["reason"] or "").strip()
            if not reason:
                raise ValueError(f"{path}:{n} override without a reason")
            raw = (row["ott_id"] or "").strip()
            ott = None if raw.upper() in ("", "NULL", "NONE") else int(raw)
            out.append(
                Override(row["source"].strip(), row["source_id"].strip(), ott, reason)
            )
    return out


def load_acknowledged(path: Path = ACKNOWLEDGED) -> set[tuple[str, str]]:
    """Regressions someone has looked at and signed off. Same shape as overrides."""
    if not path.exists():
        return set()
    out: set[tuple[str, str]] = set()
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh, delimiter="\t"):
            out.add((row["source"].strip(), row["source_id"].strip()))
    return out


# --- method 2: ott_sourceinfo -------------------------------------------------


def parse_sourceinfo(raw: str) -> Iterator[tuple[str, str]]:
    """Yield `(source, source_id)` pairs from OTT's `sourceinfo` column.

    Parsed defensively because three entries in OTT 3.7.3 are malformed and one
    of them is not even a prefix:

        https://en.wikipedia.org/wiki/Homo_sapiens_sapiens   (a bare URL)
        addition:6520265                                     (singular)
        " irmng:11258800"                                    (leading space)

    Whitelisting the six real taxonomies drops the URL and the `addition*` and
    `study*` entries without needing to enumerate them, and `.strip()` recovers
    the space-prefixed one rather than losing an IRMNG id to whitespace.
    """
    for token in raw.split(","):
        source, sep, source_id = token.strip().partition(":")
        if not sep:
            continue
        source = source.strip().lower()
        source_id = source_id.strip()
        if source_id and source in TAXONOMY_SOURCES:
            yield source, source_id


class SourceInfoScan(NamedTuple):
    gbif_to_ott: IdMap
    per_source: Counter[
        str
    ]  # source ids, which is larger — the relation is many-to-one
    taxa_per_source: Counter[str]  # distinct OTT taxa, which is what ingest.md counts
    rows_offered: int
    rows_written: int
    malformed: int
    taxa_scanned: int


def scan_sourceinfo(
    con: sqlite3.Connection,
    ott_to_idx: dict[int, int],
    *,
    log: Log = print,
) -> SourceInfoScan:
    """Stream `taxonomy.tsv`, writing `ott_sourceinfo` rows and building gbif→OTT.

    Two things come out of one pass. The `xref` rows are the cheap, broad half
    of the resolution layer. The `gbif_id → ott_id` map is the *second hop* of
    the fossil chain, and it has to cover every OTT taxon rather than only the
    ones in the synthetic tree — "resolves in OTT" and "lands on a node" are
    different questions and the gates score them separately.
    """
    per_source: Counter[str] = Counter()
    taxa_per_source: Counter[str] = Counter()
    malformed = 0
    taxa = 0
    gbif_keys: list[int] = []
    gbif_ott: list[int] = []
    offered = 0

    before = con.total_changes

    def rows() -> Iterator[tuple[str, str, int | None, str, float, None]]:
        nonlocal malformed, taxa, offered
        conf = CONFIDENCE["ott_sourceinfo"]
        with TAXONOMY.open(encoding="utf-8") as fh:
            fh.readline()
            for line in fh:
                f = line.split("\t|\t")
                if len(f) < 5:
                    malformed += 1
                    continue
                try:
                    uid = int(f[0])
                except ValueError:
                    malformed += 1
                    continue
                taxa += 1
                raw = f[4]
                if not raw:
                    continue
                idx = ott_to_idx.get(uid)
                # All of a taxon's ids are on its own line, so distinct taxa per
                # source is a per-line set rather than six 1.5M-entry sets.
                seen_here: set[str] = set()
                for source, source_id in parse_sourceinfo(raw):
                    per_source[source] += 1
                    seen_here.add(source)
                    if source == "gbif" and source_id.isdigit():
                        gbif_keys.append(int(source_id))
                        gbif_ott.append(uid)
                    if idx is None:
                        continue
                    offered += 1
                    yield (source, source_id, idx, "ott_sourceinfo", conf, None)
                for source in seen_here:
                    taxa_per_source[source] += 1

    con.executemany("INSERT OR IGNORE INTO xref VALUES (?,?,?,?,?,?)", rows())
    written = con.total_changes - before
    log(f"  taxonomy.tsv: {taxa:,} taxa, {sum(per_source.values()):,} source ids")
    return SourceInfoScan(
        gbif_to_ott=IdMap(gbif_keys, gbif_ott),
        per_source=per_source,
        taxa_per_source=taxa_per_source,
        rows_offered=offered,
        rows_written=written,
        malformed=malformed,
        taxa_scanned=taxa,
    )


# --- method 3: gbif_pbdb_chain (the API point lookup) -------------------------


class ChecklistRecord(NamedTuple):
    taxon_no: int
    found: bool
    key: int | None
    nub_key: int | None
    rank: str | None
    status: str | None
    canonical_name: str | None
    accepted_key: int | None

    def to_json(self) -> str:
        return json.dumps(self._asdict(), separators=(",", ":"))


def load_nubkeys(path: Path = NUBKEYS) -> dict[int, ChecklistRecord]:
    """Load the crawl checkpoint. Later lines win, so a re-fetch is a repair."""
    out: dict[int, ChecklistRecord] = {}
    if not path.exists():
        return out
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                d: JsonDict = json.loads(line)
            except json.JSONDecodeError:  # a torn final line from a killed run
                continue
            out[int(d["taxon_no"])] = ChecklistRecord(
                taxon_no=int(d["taxon_no"]),
                found=bool(d["found"]),
                key=d.get("key"),
                nub_key=d.get("nub_key"),
                rank=d.get("rank"),
                status=d.get("status"),
                canonical_name=d.get("canonical_name"),
                accepted_key=d.get("accepted_key"),
            )
    return out


def _fetch_record(client: httpx.Client, taxon_no: int) -> ChecklistRecord:
    """One point lookup. Does not page, so GBIF's offset cap never applies."""
    params = {"datasetKey": PBDB_DATASET_KEY, "sourceId": str(taxon_no), "limit": 5}
    last: Exception | None = None
    for attempt in range(5):
        try:
            r = client.get(GBIF_SPECIES, params=params)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(2**attempt)
                continue
            r.raise_for_status()
            results = r.json().get("results", [])
            if not results:
                return ChecklistRecord(
                    taxon_no, False, None, None, None, None, None, None
                )
            rec = results[0]
            return ChecklistRecord(
                taxon_no=taxon_no,
                found=True,
                key=rec.get("key"),
                nub_key=rec.get("nubKey"),
                rank=rec.get("rank"),
                status=rec.get("taxonomicStatus"),
                canonical_name=rec.get("canonicalName"),
                accepted_key=rec.get("acceptedKey"),
            )
        except (httpx.TransportError, json.JSONDecodeError) as exc:
            last = exc
            time.sleep(2**attempt)
    raise RuntimeError(f"GBIF lookup failed for sourceId={taxon_no}") from last


def crawl_checklist(
    wanted: Sequence[int],
    done: dict[int, ChecklistRecord],
    *,
    path: Path = NUBKEYS,
    workers: int = 4,
    pace: float = 0.05,
    log: Log = print,
) -> int:
    """Point-look-up every `taxon_no` in `wanted` that is not already checkpointed.

    Appends to `path` as results arrive, so an interrupted crawl loses at most
    one in-flight request and the next run resumes from where it stopped. Paced
    deliberately: GBIF still has no rate limit because nobody implemented one.
    """
    # `wanted` is the control cohort followed by the prioritised one and the two
    # overlap, so dedupe before spending requests on the same taxon twice.
    todo = list(dict.fromkeys(t for t in wanted if t not in done))
    if not todo:
        log(f"  crawl: nothing to do, {len(done):,} records already checkpointed")
        return 0

    path.parent.mkdir(parents=True, exist_ok=True)
    lock = threading.Lock()
    t0 = time.monotonic()
    n = 0

    with (
        path.open("a", encoding="utf-8") as sink,
        httpx.Client(
            headers={"User-Agent": USER_AGENT},
            timeout=httpx.Timeout(60.0, connect=30.0),
            limits=httpx.Limits(max_connections=workers),
        ) as client,
        ThreadPoolExecutor(max_workers=workers) as pool,
    ):

        def task(taxon_no: int) -> ChecklistRecord:
            time.sleep(pace)
            return _fetch_record(client, taxon_no)

        for rec in pool.map(task, todo):
            with lock:
                done[rec.taxon_no] = rec
                sink.write(rec.to_json() + "\n")
                n += 1
                if n % 500 == 0:
                    sink.flush()
                    rate = n / max(time.monotonic() - t0, 1e-9)
                    left = (len(todo) - n) / max(rate, 1e-9)
                    log(
                        f"  crawl {n:,}/{len(todo):,}  {rate:.1f} req/s  "
                        f"~{left / 60:.0f} min left"
                    )
        sink.flush()

    log(f"  crawl: {n:,} new records in {time.monotonic() - t0:,.0f}s")
    return n


class ChainScore(NamedTuple):
    """The chain scored as two hops, because they implicate different upstreams."""

    attempted: int
    in_checklist: int
    with_nub: int
    to_ott: int
    to_node: int

    @property
    def hop1(self) -> float:
        return 100 * self.with_nub / self.in_checklist if self.in_checklist else 0.0

    @property
    def hop2(self) -> float:
        return 100 * self.to_ott / self.with_nub if self.with_nub else 0.0

    @property
    def end_to_end(self) -> float:
        return 100 * self.to_ott / self.in_checklist if self.in_checklist else 0.0

    def as_dict(self) -> JsonDict:
        return {
            "attempted": self.attempted,
            "in_checklist": self.in_checklist,
            "with_nub_key": self.with_nub,
            "to_ott_taxon": self.to_ott,
            "to_synth_node": self.to_node,
            "hop1_pct": round(self.hop1, 2),
            "hop2_pct": round(self.hop2, 2),
            "end_to_end_pct": round(self.end_to_end, 2),
        }


def score_chain(
    taxon_nos: Sequence[int],
    records: dict[int, ChecklistRecord],
    gbif_to_ott: IdMap,
    ott_to_idx: dict[int, int],
) -> ChainScore:
    present = [records[t] for t in taxon_nos if t in records]
    in_checklist = [r for r in present if r.found]
    with_nub = [r for r in in_checklist if r.nub_key]
    if with_nub:
        nubs = np.array([r.nub_key for r in with_nub], dtype=np.int64)
        otts = gbif_to_ott.lookup(nubs)
    else:
        otts = np.empty(0, dtype=np.int64)
    to_ott = int((otts >= 0).sum())
    to_node = sum(1 for o in otts.tolist() if o >= 0 and o in ott_to_idx)
    return ChainScore(len(present), len(in_checklist), len(with_nub), to_ott, to_node)


# --- method 4: gbif_backbone_provenance ---------------------------------------

# Confirmed column layout, docs/phase3-pbdb-path.md §2. Headerless TSV, `\N` for
# null, 7,746,724 rows of exactly 30 fields.
COL_NUB_KEY = 0
COL_PARENT_KEY = 1  # ...and the *accepted* key on a synonym row
COL_STATUS = 4
COL_RANK = 5
COL_DATASET = 7
COL_CANONICAL = 19
BACKBONE_FIELDS = 30

SYNONYM_STATUSES = frozenset({"SYNONYM", "HOMOTYPIC", "HETEROTYPIC", "PROPARTE"})


class BackboneScan(NamedTuple):
    rows: int
    malformed: int
    pbdb_cited: int
    join_unique: int
    join_ambiguous: int
    join_nomatch: int
    ranks: Counter[str]
    # taxon_no -> nub key, for rows that joined to exactly one PBDB record
    taxon_to_nub: dict[int, int]
    # 298 PBDB taxa are cited by more than one backbone row. The join is unique
    # in the row->taxon direction, not the other way, so the extras are kept:
    # the taxon reaches OTT if *any* of its rows does.
    taxon_alt_nub: dict[int, list[int]]
    # taxon_no -> accepted nub key, for synonym rows whose own key misses OTT
    taxon_to_accepted_nub: dict[int, int]


def scan_backbone(
    name_rank_index: dict[tuple[str, str], list[int]],
    *,
    path: Path = BACKBONE,
    log: Log = print,
) -> BackboneScan:
    """Read the frozen backbone's provenance column into a `taxon_no → nubKey` map.

    A backbone row records **one** contributing dataset — whichever source won
    the provenance slot — and PBDB wins it only where no higher-priority source
    has the name at all. That is why this method is accurate whenever it fires
    and still reaches 0 of PBDB's 100 highest-occurrence taxa.

    PBDB's own `taxon_no` is not in the file, so the join is by canonical name
    and rank **against `pbdb_taxa.csv`** — never against the ColDP archive,
    whose compound synonym ids of the form `txn:{accepted}#{name}` map a synonym
    onto the accepted taxon's number and produced an 11% error rate in testing.
    """
    rows = malformed = cited = uniq = amb = nomatch = 0
    ranks: Counter[str] = Counter()
    taxon_to_nub: dict[int, int] = {}
    taxon_alt_nub: dict[int, list[int]] = {}
    taxon_to_accepted: dict[int, int] = {}

    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            rows += 1
            f = line.rstrip("\n").split("\t")
            if len(f) != BACKBONE_FIELDS:
                malformed += 1
                continue
            if f[COL_DATASET] != PBDB_DATASET_KEY:
                continue
            cited += 1
            rank = f[COL_RANK]
            ranks[rank] += 1
            candidates = name_rank_index.get((f[COL_CANONICAL], rank.lower()))
            if candidates is None:
                nomatch += 1
                continue
            if len(candidates) > 1:
                amb += 1
                continue
            uniq += 1
            taxon_no = candidates[0]
            nub = int(f[COL_NUB_KEY])
            if taxon_no in taxon_to_nub:
                taxon_alt_nub.setdefault(taxon_no, []).append(nub)
            else:
                taxon_to_nub[taxon_no] = nub
            parent = f[COL_PARENT_KEY]
            if f[COL_STATUS] in SYNONYM_STATUSES and parent.isdigit():
                taxon_to_accepted.setdefault(taxon_no, int(parent))

    log(f"  backbone: {rows:,} rows, {cited:,} cite the PBDB checklist")
    return BackboneScan(
        rows=rows,
        malformed=malformed,
        pbdb_cited=cited,
        join_unique=uniq,
        join_ambiguous=amb,
        join_nomatch=nomatch,
        ranks=ranks,
        taxon_to_nub=taxon_to_nub,
        taxon_alt_nub=taxon_alt_nub,
        taxon_to_accepted_nub=taxon_to_accepted,
    )


# --- the sweep: refusing what a name cannot decide -----------------------------
#
# Every method above answers "what OTT node is this PBDB taxon?" and the last of
# them answers it with a bare string. A string is only evidence of identity when
# both corpora mean the same thing by it, and they frequently do not: PBDB's
# *Ivesia* is an Ediacaran rangeomorph and OTT's is a rose-family plant, PBDB's
# *Sadleria* is a Devonian sponge and OTT's a Hawaiian fern. Nothing in the name
# says which, and the resolution was silently confident either way.
#
# Phase 4 found this rather than phase 3, because phase 4 is the first place a
# resolution can be checked against *time*: a taxon last seen before the Permian
# cannot be a living genus. 1,019 of the 1,048 exact attachments older than
# 250 Ma landed on a node with living descendants. That is the defect, and this
# is where it belongs.
#
# The check is the one cross-corpus fact both sides record independently:
# **whether the thing is still alive.** PBDB carries `is_extant` per taxon and
# OTT flags 313,300 taxa `extinct` in `taxonomy.tsv`. Where PBDB says extinct
# and OTT's taxon says nothing of the sort, the name has matched two different
# concepts and the honest answer is no resolution — the same discipline
# `images.py`'s `_seed_by_name` applies when a title reaches two nodes.
#
# Measured against phase 4's own signal (an extinct taxon last seen before
# 250 Ma resolving onto a lineage the chronogram still dates), 709 suspect and
# 22 clean:
#
#   refuse on the flag alone            704/709 suspect, 3/22 clean, 17,995 rows
#   refuse only onto a living lineage   704/709 suspect, 0/22 clean, 16,833 rows
#
# So the guard is kept: OTT not flagging a taxon extinct is weak evidence on its
# own — nobody has gone through the fossil record ticking boxes — and it becomes
# decisive only when the node OTT resolves to still has descendants in a tree of
# living species. Without the guard 1,162 genuinely extinct genera that OTT
# simply has not flagged lose an exact attachment: *Neochelys*, *Baptemys* and
# *Roxochelys*, all fossil turtles, among them. With it *Tyrannosaurus* (which
# OTT does flag) keeps its node, *Sadleria*'s Devonian sponge moves off the fern
# and onto Porifera where PBDB always had it, and the extant *Scopus* keeps the
# hamerkop while the Permian one loses it.


def load_ott_extinct(path: Path = TAXONOMY) -> set[int]:
    """OTT ids whose taxon carries an `extinct` flag. 313,300 of 4,529,570.

    `extinct_inherited` counts too and is the commoner of the two: OTT marks a
    clade extinct and propagates it downward, so a member of an extinct group is
    flagged by inheritance rather than in its own right. Both mean the same
    thing here — OTT does not think this taxon is alive.
    """
    out: set[int] = set()
    if not path.exists():
        return out
    with path.open(encoding="utf-8") as fh:
        header = fh.readline().split("\t|\t")
        try:
            i_uid, i_flags = header.index("uid"), header.index("flags")
        except ValueError:
            return out
        for line in fh:
            f = line.split("\t|\t")
            if len(f) <= i_flags or "extinct" not in f[i_flags]:
                continue
            uid = f[i_uid].strip()
            if uid.isdigit():
                out.add(int(uid))
    return out


def living_lineages() -> BoolArray | None:
    """Per node: does a tree of *living* species still date something below it?

    Phase 2's `age_ma` is finite only where a chronogram of extant taxa reached
    the node, so "has a finite age at or below it" is the closest thing the
    build has to "this lineage did not end". Preorder gives `parent[i] < i`, so
    one reverse pass carries the flag to the root.

    Returns None when phase 2 has not run, which disables the sweep rather than
    guessing at it — refusing on the flag alone costs 1,162 correct attachments
    and the guard is the whole reason it does not.
    """
    ages = TOPOLOGY / "age_ma.npy"
    parents = TOPOLOGY / "parent.npy"
    if not ages.exists() or not parents.exists():
        return None
    par = np.load(parents).astype(np.int64).tolist()
    alive = np.isfinite(np.load(ages)).tolist()
    for i in range(len(alive) - 1, 0, -1):
        if alive[i]:
            alive[par[i]] = True
    return np.array(alive, dtype=bool)


def refuse_disagreements(
    xref: Xref,
    taxa: Sequence[PbdbTaxon],
    idx_to_ott: dict[int, int],
    extinct_ott: set[int],
    living: BoolArray | None,
) -> JsonDict:
    """Withdraw the resolutions the evidence does not support. Two refusals.

    **Extancy disagreement**, over every method rather than `name_exact` alone.
    Phase 4 measured that `gbif_backbone_provenance` and `gbif_pbdb_chain`
    produce these too — the backbone merges a fossil name onto the living genus
    just as a bare string match does — so trusting id provenance is not the fix.
    Over every row rather than accepted taxa only: phase 4 gives each
    `taxon_no` its own attachment from its own resolution and `layout_bounds`
    reads them without filtering on `is_primary`, so a synonym's bad resolution
    moves a node on the axis exactly as an accepted one does. PBDB's *Ivesia* is
    that case — the row carrying the 538.8 Ma bound is a synonym.

    **Residual ambiguity**, `name_exact` only, ported from `_seed_by_name`. PBDB
    carries homonyms internally: 1,429 names belong to more than one accepted
    taxon, and each of them matched the same single OTT node, so at most one can
    be right and nothing says which. Run *after* the extancy sweep on purpose —
    it decides most of them on evidence, and `Scopus` is the case that shows why
    order matters. Both PBDB *Scopus* rows resolved to OTT's hamerkop; the sweep
    takes the Permian one, one claimant is left, and the correct resolution
    survives. Refusing on ambiguity first would have thrown away both.
    """
    stats: JsonDict = {
        "extancy_refused": 0,
        "extancy_skipped": living is None,
        "ambiguous_names": 0,
        "ambiguous_refused": 0,
    }
    if living is not None:
        for t in taxa:
            if t.is_extant != 0:
                continue
            idx = xref.resolved_idx("pbdb", str(t.taxon_no))
            if idx is None or not (0 <= idx < living.size) or not bool(living[idx]):
                continue
            ott = idx_to_ott.get(idx)
            if ott is not None and ott in extinct_ott:
                continue
            if xref.revoke("pbdb", str(t.taxon_no), REFUSED_EXTANCY, [idx]):
                stats["extancy_refused"] += 1

    claimants: dict[str, list[int]] = {}
    for t in taxa:
        if t.taxon_no != t.accepted_no:
            continue
        r = xref.get("pbdb", str(t.taxon_no))
        if r is None or r.idx is None or r.method != "name_exact":
            continue
        claimants.setdefault(t.name, []).append(t.taxon_no)
    for nos in claimants.values():
        if len(nos) < 2:
            continue
        stats["ambiguous_names"] += 1
        for no in nos:
            # `candidates` is a list of node indices everywhere else in this
            # table, so it stays one here: what was withdrawn, not who claimed
            # it. The counts below are where the ambiguity itself is recorded.
            if xref.revoke("pbdb", str(no), REFUSED_AMBIGUOUS, None):
                stats["ambiguous_refused"] += 1
    return stats


# The cases the sweep exists for, and the ones it must not take with them.
# Counting refusals is not checking them — a sweep this broad is exactly the
# shape of change that passes every count while removing the wrong 16,000 rows —
# so these five are asserted by PBDB taxon number against the pinned snapshot.
XREF_ANCHORS: tuple[tuple[int, str, bool, str], ...] = (
    (
        3277,
        "Sadleria",
        False,
        "a Devonian sponge. OTT's Sadleria is a living Hawaiian fern genus, and "
        "it carried a 382 Ma bound until this sweep existed.",
    ),
    (
        3296,
        "Streptosolen",
        False,
        "an Ordovician taxon. OTT's is a South American shrub.",
    ),
    (
        57557,
        "Scopus",
        False,
        "the Permian genus, 254-252 Ma. OTT has only the hamerkop under this name.",
    ),
    (
        39639,
        "Scopus",
        True,
        "the hamerkop itself, extant in both corpora. It must survive the sweep "
        "that takes its Permian homonym, which is why the ambiguity refusal runs "
        "second: by then one claimant is left and the name is no longer in doubt.",
    ),
    (
        18884,
        "Hallucigenia",
        True,
        "extinct in both corpora, so nothing is in dispute — and reached by "
        "`name_exact`, which is what makes it the anchor that fails if the "
        "sweep starts refusing extinct taxa outright rather than extinct taxa "
        "landing on a living lineage.",
    ),
    (
        38613,
        "Tyrannosaurus",
        True,
        "a `manual` override, and exempt from the sweep by construction. Here "
        "because a reviewed judgement silently overruled is the failure mode "
        "`revoke` is written to avoid.",
    ),
    (
        37595,
        "Neochelys",
        True,
        "an Eocene turtle genus OTT simply has not flagged extinct. It has 11 "
        "tips and no dated descendant, so the living-lineage guard keeps it — "
        "and without that guard 1,162 like it lose an exact attachment.",
    ),
)


def _refusal_gates(g: GateSet, refused: JsonDict, con: sqlite3.Connection) -> None:
    """Report the sweep, then check the six cases it was written for."""
    g.require(
        "the extancy sweep ran",
        "skipped" if refused["extancy_skipped"] else "ran",
        "ran",
        ok=not refused["extancy_skipped"],
        note=(
            "It needs phase 2's `age_ma.npy` to tell a lineage that ended from "
            "one that did not. Refusing on OTT's extinct flag alone costs 1,162 "
            "correct attachments — Neochelys, Baptemys and Roxochelys among "
            "them — so with no guard the sweep does not run at all."
        ),
    )
    g.observe(
        "resolutions withdrawn on an extancy disagreement",
        f"{refused['extancy_refused']:,}",
        note=(
            "PBDB says extinct, OTT's taxon carries no extinct flag, and the "
            "node still has a chronogram-dated descendant. Measured against "
            "phase 4's own signal this catches 704 of 709 suspect resolutions "
            "and 0 of 22 clean ones. Not confined to `name_exact`: "
            "`gbif_backbone_provenance` supplies 7,191 of them, because the "
            "backbone merges a fossil name onto the living genus too."
        ),
    )
    g.observe(
        "name_exact rows withdrawn as still ambiguous",
        f"{refused['ambiguous_refused']:,} over {refused['ambiguous_names']:,} names",
        note=(
            "A name claimed by two accepted PBDB taxa that both matched the "
            "same single OTT node. At most one can be right and the string "
            "says nothing about which, so both go — `_seed_by_name`'s rule, "
            "in the other direction."
        ),
    )
    for taxon_no, name, resolves, why in XREF_ANCHORS:
        row = con.execute(
            "SELECT idx, method FROM xref WHERE source='pbdb' AND source_id=?",
            (str(taxon_no),),
        ).fetchone()
        got = row is not None and row[0] is not None
        g.require(
            f"pbdb {taxon_no} ({name}) {'keeps' if resolves else 'loses'} its node",
            f"{'idx ' + str(row[0]) if got else 'unresolved'} via {row[1]}"
            if row
            else "absent",
            "resolved" if resolves else "unresolved",
            ok=got == resolves,
            note=why,
        )


# --- the phase ----------------------------------------------------------------


def load_ott_to_idx() -> dict[int, int]:
    """`ott_id → idx` for every node in the synthesis tree, from phase 1's arrays."""
    ott = np.load(TOPOLOGY / "ott_sorted.npy")
    idx = np.load(TOPOLOGY / "ott_to_idx.npy")
    return dict(zip(ott.tolist(), idx.tolist(), strict=True))


def load_forward_map(con: sqlite3.Connection) -> dict[int, int]:
    """Phase 1 already collapsed every forward chain; reuse rather than re-chase."""
    if not table_exists(con, "forward"):
        return {}
    return dict(con.execute("SELECT old_ott_id, new_ott_id FROM forward"))


class OttResolver:
    """`ott_id → idx`, chasing forwards and counting every hop it needed.

    OTT id forwarding is silent — 297,070 entries in this release — so an id
    that fails to resolve is never assumed dead until its forward has been
    followed. Phase 1's `forward` table is already transitively collapsed.
    """

    __slots__ = ("chased", "forwards", "ott_to_idx")

    def __init__(self, ott_to_idx: dict[int, int], forwards: dict[int, int]) -> None:
        self.ott_to_idx = ott_to_idx
        self.forwards = forwards
        self.chased: dict[int, int] = {}

    def idx_for(self, ott_id: int) -> int | None:
        direct = self.ott_to_idx.get(ott_id)
        if direct is not None:
            return direct
        forwarded = self.forwards.get(ott_id)
        if forwarded is None or forwarded == ott_id:
            return None
        idx = self.ott_to_idx.get(forwarded)
        if idx is not None:
            self.chased[ott_id] = forwarded
        return idx


def _previous_state(
    con: sqlite3.Connection,
) -> tuple[set[tuple[str, str]], set[tuple[str, str]]]:
    """`(resolved, ambiguous)` keys from the previous build's `xref`, if any."""
    if not table_exists(con, "xref"):
        return set(), set()
    resolved = {
        (s, i)
        for s, i in con.execute(
            "SELECT source, source_id FROM xref WHERE idx IS NOT NULL"
        )
    }
    ambiguous = {
        (s, i)
        for s, i in con.execute(
            "SELECT source, source_id FROM xref WHERE idx IS NULL AND candidates IS NOT NULL"
        )
    }
    return resolved, ambiguous


def _create_xref(con: sqlite3.Connection) -> None:
    con.executescript(
        """
        DROP TABLE IF EXISTS xref;
        -- WITHOUT ROWID: the primary key *is* the row here, and storing it once
        -- rather than as a table plus a shadow unique index halves ~5M rows.
        CREATE TABLE xref (
          source      TEXT NOT NULL,
          source_id   TEXT NOT NULL,
          idx         INTEGER,          -- NULL = deliberately unresolved
          method      TEXT NOT NULL,
          confidence  REAL NOT NULL,
          candidates  TEXT,             -- JSON array when ambiguous
          PRIMARY KEY (source, source_id)
        ) WITHOUT ROWID;
        """
    )


def run(budget: int = 25_000, use_api: bool = True) -> int:
    g = GateSet("phase3-resolve")
    BUILD.mkdir(parents=True, exist_ok=True)
    report: JsonDict = {"phase": 3, "written_at": _now(), "budget": budget}

    con = connect()
    prev_resolved, prev_ambiguous = _previous_state(con)

    print("--- loading the synthesis tree's identifiers ---", flush=True)
    ott_to_idx = load_ott_to_idx()
    forwards = load_forward_map(con)
    ott = OttResolver(ott_to_idx, forwards)
    g.observe("nodes carrying an OTT id", f"{len(ott_to_idx):,}")
    g.observe("forwards available", f"{len(forwards):,}", "297,070")

    print("--- loading pbdb_taxa.csv ---", flush=True)
    taxa = load_pbdb_taxa()
    g.require("pbdb_taxa.csv rows", len(taxa), EXPECT_PBDB_ROWS)

    name_rank_index: dict[tuple[str, str], list[int]] = {}
    for t in taxa:
        name_rank_index.setdefault((t.name, t.rank), []).append(t.taxon_no)

    xref = Xref()
    _create_xref(con)

    # --- 1. manual ------------------------------------------------------------
    print("\n--- method 1: manual ---", flush=True)
    seeded = False
    if not OVERRIDES.exists():
        write_seed_overrides()
        seeded = True
        print(f"  created {OVERRIDES} with architecture §5's two verified rows")
    overrides = load_overrides()
    override_failures: list[JsonDict] = []
    for o in overrides:
        if o.ott_id is None:
            xref.add(o.source, o.source_id, None, "manual")
            continue
        idx = ott.idx_for(o.ott_id)
        if idx is None:
            override_failures.append(
                {"source": o.source, "source_id": o.source_id, "ott_id": o.ott_id}
            )
            continue
        xref.add(o.source, o.source_id, idx, "manual")
    print(f"  {len(overrides)} override(s), {len(override_failures)} unresolvable")

    # Write them **now**, before anything else touches the table. Method 2
    # streams 4.7M rows straight into SQLite rather than through `xref`, so an
    # override on a taxonomy source id would otherwise lose the `INSERT OR
    # IGNORE` race against the very method it is there to overrule.
    con.executemany("INSERT OR IGNORE INTO xref VALUES (?,?,?,?,?,?)", xref.rows())
    con.commit()

    # --- 2. ott_sourceinfo ----------------------------------------------------
    print("\n--- method 2: ott_sourceinfo ---", flush=True)
    t0 = time.monotonic()
    con.execute("BEGIN")
    scan = scan_sourceinfo(con, ott_to_idx, log=print)
    con.commit()
    print(
        f"  wrote {scan.rows_written:,} xref rows in {time.monotonic() - t0:,.0f}s",
        flush=True,
    )
    gbif_to_ott = scan.gbif_to_ott

    # --- 3. gbif_pbdb_chain ---------------------------------------------------
    print("\n--- method 3: gbif_pbdb_chain ---", flush=True)
    # Prioritised, not exhaustive. Deterministic tie-break so a re-run with the
    # same budget crawls the same set.
    ordered = sorted(taxa, key=lambda t: (-t.n_occs, t.taxon_no))
    prioritised = [t.taxon_no for t in ordered[: max(budget, 0)]]

    # ...plus a *uniform* control cohort. The 48.2% baseline was measured on a
    # uniform random sample; the crawl is ordered by n_occs descending, and the
    # same memo measures the notable end at 58.0%/32.0% rather than 92.9%/48.2%.
    # Scoring the gate on the prioritised cohort would compare two different
    # populations and fail for a reason that is not a bug.
    rng = random.Random(CONTROL_SEED)
    control = rng.sample([t.taxon_no for t in taxa], k=min(CONTROL_SAMPLE, len(taxa)))

    records = load_nubkeys()
    print(f"  checkpoint holds {len(records):,} records", flush=True)
    if use_api:
        crawl_checklist(control + prioritised, records, log=print)
    else:
        print("  --no-api: scoring the existing checkpoint only", flush=True)

    # The crawl captures the decaying half of the chain, so it is phase-0 work
    # in spirit even though it runs here — hence a manifest entry beside the
    # files phase 0 pinned.
    if NUBKEYS.exists():
        manifest = Manifest()
        record_local(
            manifest,
            name="gbif_pbdb_checklist_nubkeys",
            path=NUBKEYS,
            url=f"{GBIF_SPECIES}?datasetKey={PBDB_DATASET_KEY}&sourceId={{taxon_no}}",
            note=f"{len(records):,} point lookups, ordered by n_occs descending, "
            "resumable. Not a bulk export: the lookup does not page, so GBIF's "
            "offset cap never applies.",
        )
        manifest.write()

    control_score = score_chain(control, records, gbif_to_ott, ott_to_idx)
    priority_score = score_chain(prioritised, records, gbif_to_ott, ott_to_idx)
    crawled = sorted(records)
    all_score = score_chain(crawled, records, gbif_to_ott, ott_to_idx)

    chain_resolved = 0
    if crawled:
        nubs = np.array(
            [records[t].nub_key or -1 for t in crawled],
            dtype=np.int64,
        )
        otts = gbif_to_ott.lookup(nubs).tolist()
        for taxon_no, ott_id in zip(crawled, otts, strict=True):
            if ott_id < 0:
                continue
            idx = ott.idx_for(int(ott_id))
            if idx is None:
                continue
            if xref.add("pbdb", str(taxon_no), idx, "gbif_pbdb_chain"):
                chain_resolved += 1
    print(f"  resolved {chain_resolved:,} PBDB taxa to a synthesis node", flush=True)

    # --- 4. gbif_backbone_provenance -----------------------------------------
    print("\n--- method 4: gbif_backbone_provenance ---", flush=True)
    t0 = time.monotonic()
    bb = scan_backbone(name_rank_index, log=print)
    print(f"  scanned in {time.monotonic() - t0:,.0f}s", flush=True)

    bb_taxa = sorted(bb.taxon_to_nub)
    bb_direct = bb_fallback = 0
    bb_to_ott = bb_ott_direct = 0
    if bb_taxa:
        nubs = np.array([bb.taxon_to_nub[t] for t in bb_taxa], dtype=np.int64)
        direct = gbif_to_ott.lookup(nubs).tolist()
        acc = np.array(
            [bb.taxon_to_accepted_nub.get(t, -1) for t in bb_taxa], dtype=np.int64
        )
        fallback = gbif_to_ott.lookup(acc).tolist()
        for taxon_no, d, f in zip(bb_taxa, direct, fallback, strict=True):
            # The name+rank join is unique per *row*; 298 taxa are cited by more
            # than one row, and a taxon reaches OTT if any of them does. Testing
            # only the first loses 82 of them.
            own: list[int] = [d] if d >= 0 else []
            own += [
                hit
                for alt in bb.taxon_alt_nub.get(taxon_no, ())
                if (hit := gbif_to_ott.get(alt)) is not None
            ]
            if own:
                bb_ott_direct += 1
            candidates = own + ([f] if f >= 0 else [])
            if not candidates:
                continue
            bb_to_ott += 1
            # Reaching an OTT taxon and landing on a synthesis node are
            # different questions, so take the first candidate that does both
            # rather than the first that merely resolves.
            for pos, ott_id in enumerate(candidates):
                idx = ott.idx_for(int(ott_id))
                if idx is None:
                    continue
                if xref.add("pbdb", str(taxon_no), idx, "gbif_backbone_provenance"):
                    if pos < len(own):
                        bb_direct += 1
                    else:
                        bb_fallback += 1
                break

    # --- 5. phylopic_resolve --------------------------------------------------
    print("\n--- method 5: phylopic_resolve ---", flush=True)
    phylopic_rows = 0
    phylopic_note = ""
    image_table = next(
        (t for t in ("node_image", "silhouette") if table_exists(con, t)), None
    )
    if image_table is None:
        phylopic_note = (
            "skipped — phase 5 (images.py) owns the PhyloPic crawl and neither "
            "node_image nor silhouette exists yet. Re-run after it lands; "
            "re-crawling /resolve/opentreeoflife.org/taxonomy/{ott} here would "
            "duplicate 2.7M requests."
        )
    else:
        cols = {r[1] for r in con.execute(f"PRAGMA table_info({image_table})")}
        # `node_image` is keyed by the node the image is *shown on*, and the
        # same silhouette legitimately serves a whole clade — 6,458 images over
        # 2.7M nodes. The xref wants the inverse, so it wants `source_idx`: the
        # node the image is actually **of**.
        target = "source_idx" if "source_idx" in cols else "idx"
        if {"phylopic_id", target} <= cols:
            for pid, idx in con.execute(
                f"SELECT DISTINCT phylopic_id, {target} FROM {image_table} "
                f"WHERE phylopic_id IS NOT NULL AND {target} IS NOT NULL"
            ):
                if xref.add("phylopic", str(pid), int(idx), "phylopic_resolve"):
                    phylopic_rows += 1
            phylopic_note = (
                f"consumed {image_table}.{target} rather than re-crawling "
                "/resolve/opentreeoflife.org/taxonomy/{ott_id}"
            )
        else:
            phylopic_note = (
                f"{image_table} exists but carries no (idx, phylopic_id) pair yet"
            )
    print(f"  {phylopic_rows:,} rows — {phylopic_note}", flush=True)

    # --- 6. name_exact --------------------------------------------------------
    print("\n--- method 6: name_exact ---", flush=True)
    unresolved_names = {t.name for t in taxa if ("pbdb", str(t.taxon_no)) not in xref}
    node_names: dict[str, list[int]] = {}
    for name, idx in con.execute("SELECT name, idx FROM node WHERE name IS NOT NULL"):
        if name in unresolved_names:
            node_names.setdefault(name, []).append(int(idx))

    name_resolved = 0
    ambiguous_rows = 0
    for t in taxa:
        key = ("pbdb", str(t.taxon_no))
        if key in xref:
            continue
        cands = node_names.get(t.name)
        if not cands:
            continue
        if len(cands) == 1:
            if xref.add("pbdb", str(t.taxon_no), cands[0], "name_exact"):
                name_resolved += 1
        # Two candidates means unresolved, with the candidate list recorded.
        # There is no fuzzy method: 16% of PBDB genus names are cross-kingdom
        # homonyms and silently picking one is worse than admitting ignorance.
        elif xref.add("pbdb", str(t.taxon_no), None, UNRESOLVED, sorted(cands)[:32]):
            ambiguous_rows += 1
    print(
        f"  {name_resolved:,} unique matches, {ambiguous_rows:,} ambiguous", flush=True
    )

    # --- the sweep: withdraw what the evidence does not support ---------------
    print("\n--- refusing disagreements ---", flush=True)
    extinct_ott = load_ott_extinct()
    living = living_lineages()
    refused = refuse_disagreements(
        xref, taxa, {i: o for o, i in ott_to_idx.items()}, extinct_ott, living
    )
    print(
        f"  {refused['extancy_refused']:,} withdrawn on an extancy disagreement, "
        f"{refused['ambiguous_refused']:,} on a name still claimed twice",
        flush=True,
    )

    # --- every remaining PBDB taxon is deliberately unresolved ----------------
    for t in taxa:
        xref.add("pbdb", str(t.taxon_no), None, UNRESOLVED)

    # --- write ----------------------------------------------------------------
    print("\n--- writing xref ---", flush=True)
    before = con.total_changes
    con.execute("BEGIN")
    con.executemany("INSERT OR IGNORE INTO xref VALUES (?,?,?,?,?,?)", xref.rows())
    con.commit()
    print(f"  {con.total_changes - before:,} rows", flush=True)
    con.execute(
        "CREATE INDEX IF NOT EXISTS xref_idx ON xref(idx) WHERE idx IS NOT NULL"
    )
    con.commit()

    # --- gates ----------------------------------------------------------------
    print("\n--- structural gates ---", flush=True)
    n_rows, n_resolved = con.execute("SELECT count(*), count(idx) FROM xref").fetchone()
    g.observe("xref rows", f"{n_rows:,}", note=f"{n_resolved:,} resolve to a node")

    g.require(
        "rows with idx set but no method",
        con.execute(
            "SELECT count(*) FROM xref WHERE idx IS NOT NULL "
            "AND (method IS NULL OR method = '' OR method = ?)",
            (UNRESOLVED,),
        ).fetchone()[0],
        0,
    )
    # Counting rows is not checking them: `idx` is what phase 4 walks to, so it
    # has to point at a real node, and `confidence` has to match its method.
    g.require(
        "resolved rows whose idx is not a node",
        con.execute(
            "SELECT count(*) FROM xref LEFT JOIN node USING (idx) "
            "WHERE xref.idx IS NOT NULL AND node.idx IS NULL"
        ).fetchone()[0],
        0,
    )
    g.require(
        "rows whose confidence disagrees with their method",
        sum(
            con.execute(
                "SELECT count(*) FROM xref WHERE method = ? AND confidence != ?",
                (m, c),
            ).fetchone()[0]
            for m, c in CONFIDENCE.items()
        ),
        0,
    )
    known = (*METHOD_ORDER, UNRESOLVED, *REFUSALS)
    g.require(
        "rows carrying a method outside the precedence order",
        con.execute(
            "SELECT count(*) FROM xref WHERE method NOT IN "
            "(" + ",".join("?" * len(known)) + ")",
            known,
        ).fetchone()[0],
        0,
    )
    # A refusal that kept its idx would be the worst of both: the row reads as
    # withdrawn and every consumer joining on `idx` still follows it.
    g.require(
        "refusals that still carry a resolution",
        con.execute(
            "SELECT count(*) FROM xref WHERE idx IS NOT NULL AND method IN (?,?)",
            REFUSALS,
        ).fetchone()[0],
        0,
    )
    _refusal_gates(g, refused, con)

    print("\n--- method gates ---", flush=True)
    for method in known:
        n = con.execute(
            "SELECT count(*) FROM xref WHERE method = ?", (method,)
        ).fetchone()[0]
        g.observe(f"rows by method: {method}", f"{n:,}")

    # manual: an override whose target no longer exists is a hard failure —
    # it means someone's reviewed judgement was silently dropped.
    g.require(
        "manual overrides still applying",
        f"{len(overrides) - len(override_failures)}/{len(overrides)}",
        f"{len(overrides)}/{len(overrides)}",
        ok=not override_failures,
        note=json.dumps(override_failures) if override_failures else "",
    )
    if seeded:
        g.observe(
            "data/overrides.tsv",
            "created with architecture §5's two rows",
            note="both verified against the pinned snapshot before writing",
        )

    # ott_sourceinfo — a content gate, because a silently mis-parsed prefix
    # loses ids without changing any row count that anything else checks.
    g.require(
        "ott_sourceinfo — distinct OTT taxa per source",
        dict(sorted(scan.taxa_per_source.items())),
        EXPECT_TAXA_PER_SOURCE,
        ok=dict(scan.taxa_per_source) == EXPECT_TAXA_PER_SOURCE,
        note="ingest.md's figures, reproduced exactly except IRMNG, which is "
        "1,480,678 rather than 1,480,677. The extra taxon is OTT 7494610 "
        "*Ficus variegata*, whose only IRMNG id is the space-prefixed "
        "' irmng:11258800' — so the doc's figure is the naive parse's and the "
        "+1 is the defensive parse working.",
    )
    g.observe(
        "ott_sourceinfo — source ids per source",
        ", ".join(f"{k}={v:,}" for k, v in sorted(scan.per_source.items())),
        note="ids, not taxa: the relation is many-to-one, so a taxon carrying "
        "six NCBI ids contributes six. IRMNG adds 80,539 ids beyond its taxa "
        "and GBIF 15,089; Index Fungorum and SILVA never repeat.",
    )
    g.observe(
        "ott_sourceinfo rows collided with an earlier method",
        f"{scan.rows_offered - scan.rows_written:,}",
    )

    # gbif_pbdb_chain — two hops, scored separately, on the uniform cohort.
    print("\n--- gbif_pbdb_chain ---", flush=True)
    have_control = control_score.in_checklist > 0
    chain_gate = g.require if have_control else g.observe
    note = (
        f"uniform control cohort, n={control_score.attempted:,} crawled of "
        f"{len(control):,} sampled (seed {CONTROL_SEED}). The prioritised crawl "
        "is ordered by n_occs descending and is a different population; it is "
        "scored separately below."
    )
    chain_gate(
        "chain hop 1 — checklist record reaches a nubKey",
        f"{control_score.hop1:.1f}% ({control_score.with_nub:,}/{control_score.in_checklist:,})",
        f"{EXPECT_HOP1_PCT}% ± {CHAIN_TOLERANCE}",
        ok=abs(control_score.hop1 - EXPECT_HOP1_PCT) <= CHAIN_TOLERANCE,
        note=note + " A drop here means GBIF's checklist moved.",
    )
    chain_gate(
        "chain hop 2 — nubKey resolves in OTT",
        f"{control_score.hop2:.1f}% ({control_score.to_ott:,}/{control_score.with_nub:,})",
        f"{EXPECT_HOP2_PCT}% ± {CHAIN_TOLERANCE}",
        ok=abs(control_score.hop2 - EXPECT_HOP2_PCT) <= CHAIN_TOLERANCE,
        note="A drop here means OTT's GBIF snapshot moved. The fixes differ.",
    )
    chain_gate(
        "chain end to end",
        f"{control_score.end_to_end:.1f}% ({control_score.to_ott:,}/{control_score.in_checklist:,})",
        f"{EXPECT_E2E_PCT}% ± {CHAIN_TOLERANCE}",
        ok=abs(control_score.end_to_end - EXPECT_E2E_PCT) <= CHAIN_TOLERANCE,
    )
    g.observe(
        "chain — prioritised cohort (n_occs descending)",
        json.dumps(priority_score.as_dict()),
        note="docs/phase3-pbdb-path.md §5's n_occs>=100 column: 94.7% in the "
        "checklist, 58.0% to a nubKey, 32.0% to OTT. Coverage really is worse "
        "at the notable end.",
    )
    g.observe(
        "chain — crawl progress",
        f"{len(records):,} / {EXPECT_PBDB_ROWS:,} PBDB taxa "
        f"({100 * len(records) / EXPECT_PBDB_ROWS:.1f}%)",
        note="prioritised and resumable by design; --budget raises it.",
    )
    crawled_set = set(records)
    g.observe(
        "chain — occurrence coverage of the crawl",
        f"{_occurrence_coverage(taxa, crawled_set):.1f}% of genus-rank occurrences",
        note=f"{sum(1 for t in taxa if t.rank == 'genus' and t.taxon_no in crawled_set):,}"
        " of the crawled taxa are genera.",
    )
    g.observe(
        "chain — what an n_occs-ordered budget actually buys",
        f"a budget of {budget:,} over all ranks reaches "
        f"{_occurrence_coverage(taxa, {t.taxon_no for t in ordered[:budget]}):.1f}% "
        "of genus occurrences",
        "93.3% at 25,000",
        note="management.md's 93.3% is the top 25,000 *genera*. Ordering by "
        "n_occs across all ranks puts only 7,946 genera in the first 25,000 — "
        "n_occs is a subtree total, so higher taxa dominate the ordering, and "
        "the 25,000th genus sits at all-rank position 87,126. The ordering is "
        "still the right one for phase 4 (higher taxa are the attachment "
        "points the parent-walk lands on) but the two figures are not the same "
        "measurement.",
    )

    # gbif_backbone_provenance — a frozen file, so any movement is our bug.
    print("\n--- gbif_backbone_provenance ---", flush=True)
    g.require("backbone rows", bb.rows, EXPECT_BACKBONE_ROWS)
    g.require("backbone rows of 30 fields", bb.malformed, 0)
    g.require(
        "backbone rows citing the PBDB checklist",
        bb.pbdb_cited,
        EXPECT_BACKBONE_PBDB_CITED,
    )
    bb_pct = 100 * len(bb.taxon_to_nub) / len(taxa)
    g.require(
        "backbone — PBDB taxa reaching a backbone row",
        f"{bb_pct:.2f}% ({len(bb.taxon_to_nub):,}/{len(taxa):,})",
        f"{EXPECT_BACKBONE_PCT}% ± {BACKBONE_TOLERANCE}",
        ok=abs(bb_pct - EXPECT_BACKBONE_PCT) <= BACKBONE_TOLERANCE,
        note="frozen input: any movement is a bug in our code, not upstream.",
    )
    g.observe(
        "backbone — name+rank join",
        f"unique {bb.join_unique:,} · ambiguous {bb.join_ambiguous:,} · "
        f"no match {bb.join_nomatch:,}",
        "unique 202,042 · ambiguous 1,557 · no match 8,455",
    )
    g.observe(
        "backbone — ranks present",
        " · ".join(f"{k} {v:,}" for k, v in bb.ranks.most_common()),
        "SPECIES 196,116 · GENUS 9,587 · FAMILY 3,225 · SUBSPECIES 3,126",
    )
    bb_ott_pct = 100 * bb_ott_direct / len(taxa)
    g.observe(
        "backbone — reaching an OTT taxon directly",
        f"{bb_ott_pct:.2f}% ({bb_ott_direct:,})",
        f"{EXPECT_BACKBONE_OTT_PCT}%",
    )
    g.observe(
        "backbone — reaching an OTT taxon with the accepted-key fallback",
        f"{100 * bb_to_ott / len(taxa):.2f}% ({bb_to_ott:,})",
        "26.7% (139,740)",
        note="reproduces 26.41%/138,180 here. The memo does not state the rule "
        "it used; this applies col 2 only on synonym rows, where §2 confirms it "
        "is the accepted key.",
    )
    g.observe(
        "backbone — new xref rows (behind the API chain)",
        f"{bb_direct + bb_fallback:,} "
        f"(direct {bb_direct:,}, accepted-key {bb_fallback:,})",
    )

    # name_exact
    g.observe("name_exact — unique matches", f"{name_resolved:,}")
    g.observe("name_exact — ambiguous, candidates recorded", f"{ambiguous_rows:,}")

    # phylopic
    g.observe("phylopic_resolve rows", f"{phylopic_rows:,}", note=phylopic_note)

    # --- regressions ----------------------------------------------------------
    print("\n--- regressions ---", flush=True)
    now_resolved = {
        (s, i)
        for s, i in con.execute(
            "SELECT source, source_id FROM xref WHERE idx IS NOT NULL"
        )
    }
    now_ambiguous = {
        (s, i)
        for s, i in con.execute(
            "SELECT source, source_id FROM xref WHERE idx IS NULL AND candidates IS NOT NULL"
        )
    }
    acknowledged = load_acknowledged()
    # A row the sweep withdrew is not a regression. A regression is something
    # that used to resolve and now quietly does not; a refusal is a decision
    # this build made on stated evidence, counted by its own gates and anchored
    # on six named taxa. Signing 17,068 of them off one line at a time in
    # `acknowledged_regressions.tsv` would bury the reviewed exceptions that
    # file exists for under a systematic change, and the file is the record of
    # what somebody *looked at*.
    withdrawn = {
        (s, i)
        for s, i in con.execute(
            "SELECT source, source_id FROM xref WHERE method IN (?,?)", REFUSALS
        )
    }
    regressions = sorted(prev_resolved - now_resolved - acknowledged - withdrawn)
    new_ambiguities = sorted(now_ambiguous - prev_ambiguous)

    g.require(
        "regressions (previously resolved, now failing)",
        len(regressions),
        0,
        note="no baseline — first build of xref"
        if not prev_resolved
        else f"e.g. {regressions[:5]}"
        if regressions
        else f"{len(prev_resolved & withdrawn):,} further rows were withdrawn by "
        "the disagreement sweep and are excluded here; see its own gates.",
    )
    g.observe(
        "new ambiguities since the last build",
        f"{len(new_ambiguities):,}",
        note="no baseline" if not prev_resolved else "",
    )
    g.observe("forwards chased", f"{len(ott.chased):,}")

    # --- content spot check ---------------------------------------------------
    tyrannosaurus = con.execute(
        "SELECT x.idx, x.method, n.name FROM xref x JOIN node n ON n.idx = x.idx "
        "WHERE x.source = 'pbdb' AND x.source_id = '38613'"
    ).fetchone()
    g.require(
        "spot check — pbdb 38613 resolves to Tyrannosaurus",
        tyrannosaurus,
        "(654141, 'manual', 'Tyrannosaurus')",
        ok=bool(tyrannosaurus) and tyrannosaurus[2] == "Tyrannosaurus",
    )
    suppressed = con.execute(
        "SELECT idx, method FROM xref WHERE source='pbdb' AND source_id='52983'"
    ).fetchone()
    g.require(
        "spot check — pbdb 52983 stays suppressed",
        suppressed,
        "(None, 'manual')",
        ok=bool(suppressed) and suppressed[0] is None and suppressed[1] == "manual",
    )

    # --- reconciliation.json --------------------------------------------------
    report |= {
        "counts_by_method": {
            m: con.execute(
                "SELECT count(*) FROM xref WHERE method = ?", (m,)
            ).fetchone()[0]
            for m in (*METHOD_ORDER, UNRESOLVED)
        },
        "xref_rows": n_rows,
        "xref_resolved": n_resolved,
        "regressions": len(regressions),
        "regressions_sample": regressions[:50],
        "regressions_acknowledged": len(acknowledged),
        "new_ambiguities": len(new_ambiguities),
        "new_ambiguities_sample": [list(k) for k in new_ambiguities[:50]],
        "forwards_available": len(forwards),
        "forwards_chased": len(ott.chased),
        "ott_sourceinfo": {
            "taxa_scanned": scan.taxa_scanned,
            "ids_per_source": dict(sorted(scan.per_source.items())),
            "taxa_per_source": dict(sorted(scan.taxa_per_source.items())),
            "rows_offered": scan.rows_offered,
            "rows_written": scan.rows_written,
            "gbif_to_ott_entries": len(gbif_to_ott),
            "gbif_id_collisions": gbif_to_ott.n_duplicate,
        },
        "gbif_pbdb_chain": {
            "checkpoint_records": len(records),
            "budget": budget,
            "control_seed": CONTROL_SEED,
            "control": control_score.as_dict(),
            "prioritised": priority_score.as_dict(),
            "all_crawled": all_score.as_dict(),
            "xref_rows": chain_resolved,
        },
        "gbif_backbone_provenance": {
            "rows": bb.rows,
            "pbdb_cited": bb.pbdb_cited,
            "join_unique": bb.join_unique,
            "join_ambiguous": bb.join_ambiguous,
            "join_nomatch": bb.join_nomatch,
            "pbdb_taxa_reached": len(bb.taxon_to_nub),
            "pct_of_pbdb": round(bb_pct, 2),
            "to_ott_direct": bb_ott_direct,
            "to_ott_with_fallback": bb_to_ott,
            "xref_rows": bb_direct + bb_fallback,
        },
        "phylopic_resolve": {"rows": phylopic_rows, "note": phylopic_note},
        "name_exact": {"unique": name_resolved, "ambiguous": ambiguous_rows},
        "refusals": refused,
        "manual": {
            "overrides": len(overrides),
            "unresolvable": override_failures,
        },
    }
    RECONCILIATION.write_text(json.dumps(report, indent=2) + "\n")
    print(f"\nwrote {RECONCILIATION}", flush=True)

    con.close()
    g.write(BUILD / "phase3_gates.json")
    g.exit_if_failed()
    return 0


def _occurrence_coverage(taxa: Sequence[PbdbTaxon], crawled: set[int]) -> float:
    """Share of genus-rank occurrences the crawl has reached.

    Weighted **within a rank**: `n_occs` is a subtree total, so summing it
    across ranks double-counts heavily — PBDB's 523,112 rows sum to 72.1M
    against ~2.0M real occurrences.
    """
    total = hit = 0
    for t in taxa:
        if t.rank != "genus":
            continue
        total += t.n_occs
        if t.taxon_no in crawled:
            hit += t.n_occs
    return 100 * hit / total if total else 0.0
