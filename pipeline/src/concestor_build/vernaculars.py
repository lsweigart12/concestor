"""Phase 6 — vernacular names, the palette's front door.

OTT carries no common names at all. "Tyrannosaurus" resolves; "T. rex", "dog"
and "shark" do not. When a `⌘K` palette *is* the interface (design-reference.md)
that is not a rough edge, it is the product failing at first contact — which is
why handoff.md §1 moves this from deferred to priority-one.

Three sources are ingested, in preference order.

**Wikidata property P9157** carries an OTT id, so the join needs no name
matching at all — the whole class of homonym errors that makes phase 3 hard
simply does not arise. 2,035,788 items carry it (measured against the live
endpoint 2026-07-31). Three predicates are harvested per item:

    wdt:P1843     taxon common name — the curated one, "harvestmen", "rhubarb"
    rdfs:label    the item label; for famous taxa this *is* the vernacular
                  ("dog", "lion"), for the rest it repeats the binomial
    skos:altLabel aliases — "domestic dog", "sea spider", and abbreviations

Labels that merely repeat the scientific name are dropped, so the vernacular
column stays a vernacular column and an exact binomial can never be outranked
by a "vernacular" that is the same string.

**Wikidata again, keyed on `P225` (taxon name)** for the most inclusive clades
only — because P9157 turns out to have a hole exactly where it hurts most. The
`animal` item carries no OTT id at all, so the id join alone answers "dog" and
then returns nothing for "animal". Details and the rule this pass obeys are
with the code.

**PBDB's ColDP archive** ships `VernacularName.tsv` — 9,245 English names
keyed by PBDB `taxon_no`, already on disk in `snapshot/`, free, and covering
*fossil* groups, which is the hard case. They are joined by **exact scientific
name against `node.name`, accepted only where that yields exactly one
candidate**: 6,745 of 9,245 (72.9%) resolve, 52 are ambiguous and 2,448 have
no match at all. Ambiguous and unmatched rows are still written, with `idx`
NULL and the PBDB `taxon_no` in `source_id`, so a later pass can resolve them
without a re-ingest. There is no fuzzy matching here, per architecture §5.

Phase 3's `xref` was expected to do better than that and does not. Measured
against the built table 2026-07-31: `xref` resolves **4,816** of the same
9,245, *fewer* than the name join, because the taxa that carry a common name
are high-level groups — Porifera, Scyphozoa, Trilobita — whose names sit in
OTT verbatim, while the GBIF chain `xref` depends on favours the obscure tail.
Where both resolve they agree 99.2% of the time (4,652 of 4,689), and the
union reaches 6,872 (74.3%) — **+1.4 points**. That is not worth coupling this
phase to another phase's table, so it is recorded here rather than built.

**GBIF vernaculars are not free**, contrary to ingest.md phase 6 and
management.md. `topology.py` does not parse OTT's `sourceinfo` column at all,
so there is no GBIF id in the database to join on; and the frozen backbone we
snapshotted is `simple.txt.gz`, which is 30 columns of nomenclature carrying no
vernacular names. Harvesting them would mean a fresh crawl of GBIF's
`/species/{key}/vernacularNames` — a second multi-hundred-thousand-request
crawl against the same small service phase 3 is already queued to hit. It is
not implemented here; see the report in `build/phase6_gates.json`.

Both Wikidata crawls are **resumable**: every page is checkpointed under
`build/vernaculars/wikidata/` and `build/vernaculars/wikidata_by_name/`, each
guarded by a digest of the plan it was fetched against, and a re-run re-fetches
nothing. The id-keyed crawl is also **budgeted** — if the endpoint degrades the
phase stops cleanly, ingests what it has and says so, because partial coverage
that includes the famous animals is worth far more than completeness. Its page
order is chosen so that a partial crawl is still a working palette; see
`_plan`.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import sqlite3
import time
import zipfile
from dataclasses import dataclass
from typing import TYPE_CHECKING

import httpx

from .gates import GateSet
from .paths import BUILD, SNAPSHOT
from .provenance import USER_AGENT
from .topology import DB

if TYPE_CHECKING:
    from collections.abc import Iterable, Iterator, Sequence

    from .typing_ import JsonDict, Log

PBDB_ZIP = SNAPSHOT / "gbif_pbdb_checklist" / "pbdb.zip"
OUT = BUILD / "vernaculars"
WIKIDATA_PAGES = OUT / "wikidata"
NAME_PAGES = OUT / "wikidata_by_name"

WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql"

# WDQS has a hard 60 s query timeout and does rate-limit (429), despite the
# common claim that it does not. Measured 2026-07-31 against the live endpoint:
# a VALUES batch of 10,000 OTT ids returns in 8.7 s, 20,000 in 21.1 s, and the
# obvious LIMIT/OFFSET paging degrades superlinearly (13.5 s at offset 0, 26.9 s
# at offset 20,000) as well as being unstable without an ORDER BY that costs
# more than it saves. Binding the OTT id with VALUES turns each page into an
# indexed literal lookup instead of a scan, which is why it is both fast and
# exactly reproducible.
WIKIDATA_PAGE = 10_000
# The by-name pass is small by design; see the section that uses it. 50,000
# names reaches every clade down to `tip_count = 8`, in 25 queries. Measured
# return is steeply diminishing — the first 20,000 (down to `tip_count = 30`)
# supply 423 of the 560 accepted names and every one of the top-100 gains,
# because below that P9157 already has the taxon. Widening further is cheap
# but pointless; narrowing costs the mid-sized clades.
WIKIDATA_NAME_BUDGET = 50_000
WIKIDATA_NAME_PAGE = 2_000
WIKIDATA_PAUSE_S = 1.5
WIKIDATA_BUDGET_S = 14_400.0
WIKIDATA_ATTEMPTS = 6

# BCP-47. Everything downstream keys on this column, so adding a language later
# is a re-crawl of one constant rather than a schema change.
LANGS = ("en",)

# ISO 639-3, which is what ColDP uses, onto BCP-47.
ISO3_TO_BCP47 = {"eng": "en"}

# Measured 2026-07-31 against the frozen ColDP archive. These read a file that
# cannot change, so any movement is a bug in this code, not upstream.
EXPECT_PBDB_ROWS = 9_245
EXPECT_PBDB_UNIQUE = 6_745
EXPECT_PBDB_AMBIGUOUS = 52
EXPECT_PBDB_UNMATCHED = 2_448

# Names the palette must answer. Each is a content gate: the row exists, it
# carries an idx, and that idx is a taxon a person actually means by the word.
# Counting rows is not checking them.
#
# The gate is *reachability*, not ordering: a word can legitimately name more
# than one taxon — "shark" is Selachii here, but Elasmobranchii and
# Chondrichthyes would also be right, and "human" is carried by both the
# species (Wikidata) and the genus (PBDB) — and deciding which comes first is
# `search.py`'s job, gated there.
SPOT_CHECKS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("dog", ("Canis lupus familiaris", "Canis familiaris", "Canis lupus")),
    ("human", ("Homo sapiens", "Homo")),
    ("mammal", ("Mammalia",)),
    ("shark", ("Selachii", "Selachimorpha", "Elasmobranchii", "Chondrichthyes")),
    ("sponge", ("Porifera",)),
)

# The words above are carried *bare* by the taxon a person means. These three
# are not, and no amount of crawling will change that:
#
#   butterfly  the bare word is on a Caribbean reef fish and nowhere else;
#              Papilionidae is "swallowtail butterflies"
#   eagle      the bare word is PBDB's category label on a fossil genus;
#              Haliaeetus is "Sea eagles"
#   oak        **no node carries it at all.** *Quercus* is non-monophyletic in
#              the synthesis and is a broken taxon, so it is not a node and is
#              never asked for by the crawl. The oaks are reachable only one
#              species at a time, through names like "Pedunculate Oak"
#
# So the corpus claim they need is a weaker one, and it is the claim the
# server's ranking rests on: some taxon a person means carries an English name
# whose **head word** is the query. `server/internal/store/band.go` is
# authoritative on what a head word is; `_head_word` here asserts only that the
# names exist, which is phase 6's business rather than the ranking's.
GROUP_WORD_CHECKS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("butterfly", ("Papilionidae", "Danaini", "Libytheinae")),
    ("eagle", ("Haliaeetus", "Aquila chrysaetos", "Hieraaetus pennatus")),
    ("oak", ("Quercus petraea", "Quercus robur", "Quercus castaneifolia")),
    # Held alongside them so the head-word claim is not tested only where it
    # was needed: these already worked and must keep working.
    ("frog", ("Anura", "Hylidae", "Ranidae")),
    ("bird", ("Aves",)),
)

# Rank words a common name ends with when it names a rank rather than a thing.
# Kept in step with `rankWords` in band.go — this list is the short one, since
# it only has to cover the names GROUP_WORD_CHECKS reaches.
_RANK_WORDS = frozenset({"family", "order", "genus", "group", "species"})


def _head_word(name: str) -> str:
    """The word a common name is *about*: its last, skipping any rank word."""
    parts = [p for p in name.lower().replace("-", " ").split() if p]
    while len(parts) > 1 and parts[-1] in _RANK_WORDS:
        parts.pop()
    return parts[-1] if parts else ""


def head_word_is(name: str, word: str) -> bool:
    """Is `word` the head of `name`, allowing a regular English plural?"""
    head, w = _head_word(name), word.lower()
    if head == w:
        return True
    if len(w) < 3:
        return False
    return head in {f"{w}s", f"{w}es"} or (w.endswith("y") and head == f"{w[:-1]}ies")


@dataclass(slots=True)
class RawRow:
    """One harvested name, before resolution and deduplication."""

    ott_id: int | None
    source: str
    source_id: str | None
    sci_name: str | None  # set instead of ott_id; the string the name-join uses
    name: str
    lang: str
    kind: str  # 'v' declared common name | 'l' item label | 'a' alias


# --------------------------------------------------------------------------
# Wikidata
# --------------------------------------------------------------------------


def _sparql(ott_ids: Sequence[int]) -> str:
    values = " ".join(f'"{o}"' for o in ott_ids)
    langs = ", ".join(f'"{lang}"' for lang in LANGS)
    return (
        "SELECT ?o ?q ?c ?k ?sci WHERE {\n"
        f"  VALUES ?o {{ {values} }}\n"
        "  ?q wdt:P9157 ?o .\n"
        # The item's own taxon name, which is what makes a mis-tagged P9157
        # detectable at all. Optional because a few items carry P9157 and no
        # P225; those simply cannot be checked and are kept.
        "  OPTIONAL { ?q wdt:P225 ?sci }\n"
        '  { ?q wdt:P1843 ?c     BIND("v" AS ?k) }\n'
        '  UNION { ?q rdfs:label ?c    BIND("l" AS ?k) }\n'
        '  UNION { ?q skos:altLabel ?c BIND("a" AS ?k) }\n'
        f"  FILTER(LANG(?c) IN ({langs}))\n"
        "}"
    )


def _query(client: httpx.Client, query: str, log: Log) -> JsonDict:
    """POST a query, backing off on 429 and 5xx.

    GET is not usable: a 10,000-element VALUES clause exceeds the front-end
    proxy's URL limit and comes back as `503 VCL failed`.
    """
    last = ""
    for attempt in range(WIKIDATA_ATTEMPTS):
        try:
            r = client.post(
                WIKIDATA_ENDPOINT,
                data={"query": query, "format": "json"},
                headers={"Accept": "application/sparql-results+json"},
            )
            if r.status_code == 429:
                wait = float(r.headers.get("Retry-After", 2**attempt * 5))
                log(f"    429; sleeping {wait:.0f}s")
                time.sleep(min(wait, 120.0))
                continue
            if r.status_code >= 500:
                last = f"HTTP {r.status_code}"
                time.sleep(2**attempt * 5)
                continue
            r.raise_for_status()
            payload: JsonDict = r.json()
        except (httpx.TransportError, json.JSONDecodeError) as exc:
            # A query that exceeds the 60 s limit is truncated mid-JSON rather
            # than being reported as an error, so a decode failure is a timeout.
            last = f"{type(exc).__name__}: {exc}"
            time.sleep(2**attempt * 5)
        else:
            return payload
    raise RuntimeError(f"WDQS gave up after {WIKIDATA_ATTEMPTS} attempts: {last}")


def _plan(con: sqlite3.Connection) -> list[int]:
    """Every OTT id worth asking about, most-notable first.

    Order matters, because a crawl that is interrupted must still leave the
    palette able to answer "dog". `tip_count` descending puts the 134,801
    clades first — the same corpus signal architecture §4 ranks search on —
    and then, since every tip ties at 1, the secondary `ott_id` key takes over
    and turns out to be a good notability proxy in its own right: OTT numbers
    taxa roughly in the order its source taxonomies were ingested, so NCBI's
    well-studied organisms get low ids and IRMNG's bulk tail gets high ones.
    Measured: *Canis lupus familiaris* is the 82,865th tip in this order,
    *Arabidopsis thaliana* the 103,746th, *Caenorhabditis elegans* the
    132,559th, *Drosophila melanogaster* the 169,995th, *Tyrannosaurus rex*
    the 222,878th and *Homo sapiens* the 258,583rd — every one of them inside
    the first 11% of 2,464,863 tips.

    Retired ids come last: OTT id forwarding is silent, and a Wikidata item
    edited before the retirement still cites the old id. `forward` maps them
    back, so asking for both costs one extra page in ten and cannot mis-resolve.
    """
    ids = [
        int(r[0])
        for r in con.execute(
            "SELECT ott_id FROM node WHERE ott_id IS NOT NULL "
            "ORDER BY tip_count DESC, ott_id"
        )
    ]
    retired = [
        int(r[0])
        for r in con.execute(
            "SELECT f.old_ott_id FROM forward f "
            "JOIN node n ON n.ott_id = f.new_ott_id ORDER BY f.old_ott_id"
        )
    ]
    return ids + retired


def _plan_digest(ids: Sequence[int]) -> str:
    h = hashlib.sha256()
    h.update(f"{WIKIDATA_PAGE}|{','.join(LANGS)}|{len(ids)}|".encode())
    for i in ids:
        h.update(f"{i},".encode())
    return h.hexdigest()


def crawl_wikidata(con: sqlite3.Connection, log: Log = print) -> JsonDict:
    """Fetch every page not already checkpointed. Returns a crawl report."""
    WIKIDATA_PAGES.mkdir(parents=True, exist_ok=True)
    ids = _plan(con)
    digest = _plan_digest(ids)
    n_pages = (len(ids) + WIKIDATA_PAGE - 1) // WIKIDATA_PAGE

    plan_path = WIKIDATA_PAGES / "plan.json"
    if plan_path.exists():
        prior = json.loads(plan_path.read_text())
        if prior.get("digest") != digest:
            log("  plan changed since the last crawl; discarding checkpoints")
            for stale in WIKIDATA_PAGES.glob("page_*.jsonl"):
                stale.unlink()
    plan_path.write_text(
        json.dumps(
            {
                "digest": digest,
                "n_ids": len(ids),
                "page_size": WIKIDATA_PAGE,
                "n_pages": n_pages,
                "langs": list(LANGS),
            },
            indent=2,
        )
    )

    done = {p.name for p in WIKIDATA_PAGES.glob("page_*.jsonl")}
    log(f"  {len(ids):,} OTT ids in {n_pages} pages; {len(done)} already on disk")

    t0 = time.monotonic()
    fetched = 0
    stopped = ""
    with httpx.Client(
        headers={"User-Agent": USER_AGENT},
        timeout=httpx.Timeout(180.0, connect=30.0),
        follow_redirects=True,
    ) as client:
        for page in range(n_pages):
            name = f"page_{page:05d}.jsonl"
            if name in done:
                continue
            elapsed = time.monotonic() - t0
            if elapsed > WIKIDATA_BUDGET_S:
                stopped = f"budget of {WIKIDATA_BUDGET_S:.0f}s exhausted"
                break
            chunk = ids[page * WIKIDATA_PAGE : (page + 1) * WIKIDATA_PAGE]
            try:
                payload = _query(client, _sparql(chunk), log)
            except RuntimeError as exc:
                stopped = str(exc)
                break

            rows = payload.get("results", {}).get("bindings", [])
            part = WIKIDATA_PAGES / (name + ".part")
            with part.open("w", encoding="utf-8") as fh:
                for b in rows:
                    fh.write(
                        json.dumps(
                            {
                                "o": b["o"]["value"],
                                "q": b["q"]["value"].rsplit("/", 1)[-1],
                                "k": b["k"]["value"],
                                "c": b["c"]["value"],
                                "g": b["c"].get("xml:lang", LANGS[0]),
                                # The item's own taxon name. Absent for the
                                # few items with P9157 and no P225, which are
                                # kept rather than refused.
                                "s": b.get("sci", {}).get("value"),
                            },
                            separators=(",", ":"),
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
            part.replace(WIKIDATA_PAGES / name)
            fetched += 1
            if fetched % 10 == 0 or page == n_pages - 1:
                rate = (time.monotonic() - t0) / fetched
                left = (n_pages - len(done) - fetched) * rate
                log(
                    f"    page {page + 1}/{n_pages}  {len(rows):,} rows  "
                    f"{rate:.1f}s/page  ~{left / 60:.0f} min left"
                )
            time.sleep(WIKIDATA_PAUSE_S)

    on_disk = len(list(WIKIDATA_PAGES.glob("page_*.jsonl")))
    report = {
        "pages_total": n_pages,
        "pages_on_disk": on_disk,
        "pages_fetched_this_run": fetched,
        "complete": on_disk == n_pages,
        "ott_ids_asked": len(ids),
        "elapsed_s": round(time.monotonic() - t0, 1),
        "stopped_early": stopped,
    }
    if stopped:
        log(f"  crawl stopped early: {stopped} — re-run to resume")
    return report


def read_wikidata_pages(log: Log = print) -> Iterator[RawRow]:
    """Replay every checkpointed page. Works with no network at all."""
    files = sorted(WIKIDATA_PAGES.glob("page_*.jsonl"))
    for n, path in enumerate(files, 1):
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                d = json.loads(line)
                name = d["c"].strip()
                if not name:
                    continue
                # P9157 is a free-text external identifier, so a malformed
                # value is the editor's mistake, not a reason to fail a build.
                if not d["o"].isdigit():
                    continue
                yield RawRow(
                    ott_id=int(d["o"]),
                    source="wikidata",
                    source_id=d["q"],
                    # Carried so the P225 mismatch check can run. Pages written
                    # before that check existed have no "s" and are simply not
                    # checked; the next crawl replaces them.
                    sci_name=(d.get("s") or "").strip() or None,
                    name=name,
                    lang=d.get("g", LANGS[0]),
                    kind=d["k"],
                )
        if n % 50 == 0:
            log(f"    read {n}/{len(files)} checkpoint pages")


# --------------------------------------------------------------------------
# Wikidata, keyed on the taxon name rather than the OTT id
# --------------------------------------------------------------------------
#
# P9157 is not a complete map of OTT, and the holes are not where you would
# guess. Verified against the live endpoint 2026-07-31: **Wikidata's `animal`
# item Q729 carries no P9157 statement at all**, and neither do Metazoa
# (691846), Bilateria (117569) or `cellular organisms` (93302). The property
# was populated from the species end, so the deepest, most-typed clades are
# exactly the ones it misses — a palette built only on the id join answers
# "dog" and "shark" and then returns nothing for "animal".
#
# So a second, deliberately small pass keys on `wdt:P225` (taxon name) instead,
# for the most inclusive clades only. It is a *name* match and therefore a
# weaker method, and it obeys architecture §5's rule for those exactly: the
# name must yield **one** Wikidata item and **one** node, or it is dropped
# rather than guessed at. It gets its own `source` value so nothing downstream
# has to take it on the id join's authority.


def _sparql_by_name(names: Sequence[str]) -> str:
    values = " ".join(f'"{n}"' for n in names)
    langs = ", ".join(f'"{lang}"' for lang in LANGS)
    return (
        "SELECT ?s ?q ?c ?k WHERE {\n"
        f"  VALUES ?s {{ {values} }}\n"
        "  ?q wdt:P225 ?s .\n"
        '  { ?q wdt:P1843 ?c     BIND("v" AS ?k) }\n'
        '  UNION { ?q rdfs:label ?c    BIND("l" AS ?k) }\n'
        '  UNION { ?q skos:altLabel ?c BIND("a" AS ?k) }\n'
        f"  FILTER(LANG(?c) IN ({langs}))\n"
        "}"
    )


def _plan_by_name(con: sqlite3.Connection) -> list[str]:
    """The most inclusive named clades, as SPARQL-safe literals."""
    return [
        r[0]
        for r in con.execute(
            "SELECT name FROM node WHERE name IS NOT NULL AND trim(name) <> '' "
            "GROUP BY name ORDER BY max(tip_count) DESC LIMIT ?",
            (WIKIDATA_NAME_BUDGET,),
        )
        if not ({'"', "\\", "\n", "\r"} & set(r[0]))
    ]


def crawl_wikidata_by_name(con: sqlite3.Connection, log: Log = print) -> JsonDict:
    """Fetch common names for the top clades by taxon name. Resumable.

    Guarded by the same plan digest as the id-keyed crawl: page *n* means
    "names 2000n..2000n+1999 of this exact ordered list", so a checkpoint
    directory left over from a different plan would silently ingest the wrong
    names against the right taxa. Widening `WIKIDATA_NAME_BUDGET` alone does
    not invalidate anything — the ordering is stable and only appends — but
    the digest is what makes that a checked property rather than a hope.
    """
    NAME_PAGES.mkdir(parents=True, exist_ok=True)
    names = _plan_by_name(con)
    n_pages = (len(names) + WIKIDATA_NAME_PAGE - 1) // WIKIDATA_NAME_PAGE

    # Digest the first page only. That prefix is what every already-fetched
    # page is positioned against, and it is invariant under widening the
    # budget — which is the one change that should *not* throw work away.
    plan_path = NAME_PAGES / "plan.json"
    prefix_digest = hashlib.sha256(
        f"{WIKIDATA_NAME_PAGE}|{','.join(LANGS)}|".encode()
        + "\n".join(names[:WIKIDATA_NAME_PAGE]).encode()
    ).hexdigest()
    if plan_path.exists():
        prior = json.loads(plan_path.read_text())
        if prior.get("prefix_digest") != prefix_digest:
            log("  by-name plan changed; discarding checkpoints")
            for stale in NAME_PAGES.glob("page_*.jsonl"):
                stale.unlink()
    plan_path.write_text(
        json.dumps(
            {
                "prefix_digest": prefix_digest,
                "n_names": len(names),
                "page_size": WIKIDATA_NAME_PAGE,
                "n_pages": n_pages,
                "langs": list(LANGS),
            },
            indent=2,
        )
    )

    done = {p.name for p in NAME_PAGES.glob("page_*.jsonl")}
    log(f"  {len(names):,} clade names in {n_pages} pages; {len(done)} on disk")

    fetched = 0
    stopped = ""
    with httpx.Client(
        headers={"User-Agent": USER_AGENT},
        timeout=httpx.Timeout(180.0, connect=30.0),
        follow_redirects=True,
    ) as client:
        for page in range(n_pages):
            fname = f"page_{page:05d}.jsonl"
            if fname in done:
                continue
            chunk = names[page * WIKIDATA_NAME_PAGE : (page + 1) * WIKIDATA_NAME_PAGE]
            try:
                payload = _query(client, _sparql_by_name(chunk), log)
            except RuntimeError as exc:
                stopped = str(exc)
                break
            part = NAME_PAGES / (fname + ".part")
            with part.open("w", encoding="utf-8") as fh:
                for b in payload.get("results", {}).get("bindings", []):
                    fh.write(
                        json.dumps(
                            {
                                "s": b["s"]["value"],
                                "q": b["q"]["value"].rsplit("/", 1)[-1],
                                "k": b["k"]["value"],
                                "c": b["c"]["value"],
                                "g": b["c"].get("xml:lang", LANGS[0]),
                            },
                            separators=(",", ":"),
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
            part.replace(NAME_PAGES / fname)
            fetched += 1
            time.sleep(WIKIDATA_PAUSE_S)

    on_disk = len(list(NAME_PAGES.glob("page_*.jsonl")))
    return {
        "pages_total": n_pages,
        "pages_on_disk": on_disk,
        "pages_fetched_this_run": fetched,
        "complete": on_disk == n_pages,
        "names_asked": len(names),
        "stopped_early": stopped,
    }


def read_wikidata_name_pages(log: Log = print) -> list[RawRow]:
    """Replay the by-name pages, dropping every ambiguous taxon name.

    A name that two Wikidata items both claim as their `P225` is not resolved
    to one of them — it is dropped whole. That is architecture §5 method 5's
    rule, and 16% of PBDB genus names are why it exists.
    """
    by_name: dict[str, list[JsonDict]] = {}
    for path in sorted(NAME_PAGES.glob("page_*.jsonl")):
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                d = json.loads(line)
                if d["c"].strip():
                    by_name.setdefault(d["s"], []).append(d)

    out: list[RawRow] = []
    ambiguous = 0
    for sci, rows in by_name.items():
        items = {d["q"] for d in rows}
        if len(items) != 1:
            ambiguous += 1
            continue
        for d in rows:
            out.append(
                RawRow(
                    ott_id=None,
                    source="wikidata_p225",
                    source_id=d["q"],
                    sci_name=sci,
                    name=d["c"].strip(),
                    lang=d.get("g", LANGS[0]),
                    kind=d["k"],
                )
            )
    log(
        f"  P225: {len(out):,} names from {len(by_name) - ambiguous:,} taxa; "
        f"{ambiguous:,} taxon names dropped as ambiguous in Wikidata"
    )
    return out


# --------------------------------------------------------------------------
# PBDB ColDP
# --------------------------------------------------------------------------


def read_pbdb(log: Log = print) -> list[RawRow]:
    """`VernacularName.tsv` joined to `NameUsage.tsv` for the scientific name.

    ColDP gives *synonym* names a compound id of the form `txn:{accepted}#{name}`
    — the trap that produced an 11% error rate in phase-3 testing. It does not
    bite here: all 9,245 vernacular `col:taxonID` values are plain `txn:N`,
    checked below rather than assumed, because a vernacular attaches to a taxon
    and never to a name.
    """
    with zipfile.ZipFile(PBDB_ZIP) as z:
        with z.open("VernacularName.tsv") as fh:
            r = csv.reader(io.TextIOWrapper(fh, encoding="utf-8"), delimiter="\t")
            head = next(r)
            i_id = head.index("col:taxonID")
            i_name = head.index("col:name")
            i_lang = head.index("col:language")
            entries = [(row[i_id], row[i_name].strip(), row[i_lang]) for row in r]

        wanted = {taxon_id for taxon_id, _, _ in entries}
        compound = sum(1 for t in wanted if "#" in t)
        if compound:
            raise ValueError(
                f"{compound} vernacular rows carry a ColDP compound synonym id; "
                "joining those to a taxon_no would map a synonym onto the "
                "accepted taxon (see docs/management.md)"
            )

        sci: dict[str, str] = {}
        with z.open("NameUsage.tsv") as fh:
            r = csv.reader(io.TextIOWrapper(fh, encoding="utf-8"), delimiter="\t")
            head = next(r)
            i_uid = head.index("col:ID")
            i_sci = head.index("col:scientificName")
            for row in r:
                if row[i_uid] in wanted:
                    sci[row[i_uid]] = row[i_sci].strip()

    log(f"  PBDB: {len(entries):,} vernacular rows, {len(sci):,} with a taxon name")
    out: list[RawRow] = []
    for taxon_id, name, lang in entries:
        if not name:
            continue
        out.append(
            RawRow(
                ott_id=None,
                source="pbdb_coldp",
                source_id=taxon_id,
                sci_name=sci.get(taxon_id),
                name=name,
                lang=ISO3_TO_BCP47.get(lang, lang),
                kind="v",
            )
        )
    return out


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

SCHEMA = """
DROP TABLE IF EXISTS vernacular;
CREATE TABLE vernacular (
  idx        INTEGER,        -- NULL when unresolved; phase 3 fills these in
  ott_id     INTEGER,
  name       TEXT NOT NULL,
  lang       TEXT NOT NULL,  -- BCP-47
  source     TEXT NOT NULL,  -- 'wikidata' | 'pbdb_coldp' | 'wikidata_p225'
  source_id  TEXT,           -- Wikidata QID, or PBDB 'txn:N'
  is_primary INTEGER NOT NULL DEFAULT 0   -- the headline name, vs an alias
);
"""

INDEXES = """
CREATE INDEX vernacular_idx ON vernacular(idx) WHERE idx IS NOT NULL;
CREATE INDEX vernacular_name ON vernacular(name);
CREATE INDEX vernacular_primary ON vernacular(idx, lang) WHERE is_primary = 1;
CREATE INDEX vernacular_unresolved ON vernacular(source, source_id) WHERE idx IS NULL;
"""


type StageTuple = tuple[int | None, str, str | None, str | None, str, str, str]


def stage(con: sqlite3.Connection, rows: Iterable[RawRow]) -> int:
    """Append harvested rows to the staging table, returning how many."""
    n = 0

    def tuples() -> Iterator[StageTuple]:
        nonlocal n
        for r in rows:
            n += 1
            yield (r.ott_id, r.source, r.source_id, r.sci_name, r.name, r.lang, r.kind)

    con.executemany("INSERT INTO v_raw VALUES (?,?,?,?,?,?,?)", tuples())
    return n


def load(con: sqlite3.Connection, log: Log = print) -> JsonDict:
    """Resolve staged rows to `idx`, deduplicate, and write `vernacular`.

    Resolution is done in SQL rather than in Python dictionaries: the maps
    involved are 2.6M entries wide and the indexes that answer them already
    exist on `node`.
    """
    con.executescript(SCHEMA)

    # Wikidata rows carry an OTT id. Chase the forward before joining, since a
    # Wikidata item edited before a retirement still cites the old id.
    con.execute(
        """
        CREATE TEMP TABLE v_res AS
        SELECT n.idx AS idx,
               n.ott_id AS ott_id,
               v.name AS name,
               v.lang AS lang,
               v.source AS source,
               v.source_id AS source_id,
               v.kind AS kind,
               -- What Wikidata says the item's own taxon is, for the P225
               -- mismatch check below. Null on the PBDB rows and on pages
               -- crawled before the check existed.
               v.sci_name AS sci_name
          FROM v_raw v
          LEFT JOIN node n
                 ON n.ott_id = COALESCE(
                      (SELECT f.new_ott_id FROM forward f
                        WHERE f.old_ott_id = v.ott_id), v.ott_id)
         WHERE v.ott_id IS NOT NULL
        """
    )

    # The two name-keyed sources — PBDB's `taxon_no`, which has no id path into
    # OTT, and the `P225` pass, which deliberately has none — join on the exact
    # scientific name and are accepted only where that is unambiguous. A name
    # matching two nodes is recorded unresolved, never guessed at.
    con.execute(
        """
        CREATE TEMP TABLE name_cand AS
        SELECT v.rowid AS vrow, count(*) AS n_cand, min(n.idx) AS idx
          FROM v_raw v JOIN node n ON n.name = v.sci_name
         WHERE v.ott_id IS NULL AND v.sci_name IS NOT NULL
         GROUP BY v.rowid
        """
    )
    con.execute("CREATE INDEX name_cand_row ON name_cand(vrow)")
    con.execute(
        """
        INSERT INTO v_res (idx, ott_id, name, lang, source, source_id, kind,
                           sci_name)
        SELECT CASE WHEN c.n_cand = 1 THEN c.idx END,
               (SELECT n.ott_id FROM node n
                 WHERE c.n_cand = 1 AND n.idx = c.idx),
               v.name, v.lang, v.source, v.source_id, v.kind, v.sci_name
          FROM v_raw v LEFT JOIN name_cand c ON c.vrow = v.rowid
         WHERE v.ott_id IS NULL
        """
    )

    # A "vernacular" that repeats the binomial is not one, and leaving it in
    # would let a vernacular-column hit tie an exact scientific hit.
    dropped = con.execute(
        """
        DELETE FROM v_res
         WHERE idx IS NOT NULL
           AND EXISTS (SELECT 1 FROM node n
                        WHERE n.idx = v_res.idx
                          AND lower(n.name) = lower(v_res.name))
        """
    ).rowcount

    # Nor is *another taxon's* scientific name a vernacular of this one. Two
    # Wikidata items can claim the same OTT id — 770315 is claimed by both
    # Homo sapiens and Homo floresiensis — and without this a search for
    # "Homo floresiensis" would confidently return Homo sapiens. The rule is
    # exact and data-driven rather than a pattern guess: if the string is a
    # name `node` already carries for a different idx, it belongs to the
    # scientific column, not the vernacular one. OTT's own synonyms.tsv
    # carries the legitimate cases (`Canis familiaris`) already.
    #
    # **It reaches only names that are in the tree, and that is not enough.**
    # *Homo floresiensis* is extinct and so is not a node, so it survived this
    # and shipped: the card read "Homo sapiens — also known as Human, Homo
    # floresiensis, man, men, humans, Flores Man". The arbitration below is
    # what catches the rest of the family.
    shadowed = con.execute(
        """
        DELETE FROM v_res
         WHERE source LIKE 'wikidata%'
           AND EXISTS (SELECT 1 FROM node n
                        WHERE n.name = v_res.name
                          AND (v_res.idx IS NULL OR n.idx <> v_res.idx))
        """
    ).rowcount

    # One taxon has one Wikidata item, so a node claimed by two QIDs is a
    # conflict rather than a richer harvest — and 4,262 nodes were. P9157 is a
    # free-text external identifier and nothing stops an item carrying somebody
    # else's OTT id: Q186266 (*Homo floresiensis*) carries *Homo sapiens*'s,
    # and Q387319 (*Pyxicephalus adspersus*) carries **Archaea's**, which put
    # "Giant Bullfrog" on a domain of 2,080 archaea and returned it second for
    # a search on "frog".
    #
    # The item's own `wdt:P225` settles it: if Wikidata says the item is
    # *Pyxicephalus adspersus* and OTT says the node is *Archaea*, the item is
    # not about this node whatever its P9157 says. No arbitration, no
    # heuristic, and it costs no extra requests — one OPTIONAL triple on a
    # query that was already being made.
    #
    # **Three cheaper rules were tried against the real data first and all
    # three fail**, which is worth recording so nobody re-derives them:
    #
    #   - *Refuse a name that is another taxon's scientific name.* Already
    #     present above, and it reaches only names that are in the tree.
    #     *Homo floresiensis* is extinct, so it is not a node, so it shipped.
    #   - *Keep the QID contributing the most names.* Fits *Homo sapiens*
    #     (6 against 2) and **fails on Archaea**, where the bullfrog item
    #     carries four English names and the real one carries four — handing
    #     the domain to the frog and deleting "archaeans".
    #   - *Drop every claimant.* Correct in principle and too expensive in
    #     fact: it takes "Dog" off *Canis lupus familiaris* and fails the
    #     `dog` spot check, which is the single most important query here.
    #
    # A row with no P225 is kept rather than refused: not every item has one,
    # and absent evidence of a bad claim is not evidence of one.
    contested = con.execute(
        """
        DELETE FROM v_res
         WHERE source = 'wikidata'
           AND idx IS NOT NULL
           AND sci_name IS NOT NULL
           AND EXISTS (SELECT 1 FROM node n
                        WHERE n.idx = v_res.idx
                          AND lower(n.name) <> lower(v_res.sci_name))
        """
    ).rowcount

    # Deduplicate, then elect one headline name per (idx, lang). Precedence is
    # source first, ordered by how the row reached its taxon rather than by how
    # good the string is: `wikidata` came through an explicit OTT id and — once
    # the arbitration above has run — is not pointing at the wrong taxon; `pbdb_coldp` came through an exact unique
    # name match against a curated vernacular list; `wikidata_p225` came
    # through an exact unique name match against a Wikidata item that merely
    # claims the same taxon name. Then kind, where a declared `P1843` taxon
    # common name beats an item label, which beats an alias. The last two keys
    # only decide dead heats, shortest first so the palette shows "dog" rather
    # than "domesticated dog".
    con.execute(
        """
        INSERT INTO vernacular (idx, ott_id, name, lang, source, source_id, is_primary)
        SELECT idx, ott_id, name, lang, source, source_id,
               CASE WHEN idx IS NOT NULL AND primary_rn = 1 THEN 1 ELSE 0 END
          FROM (
            SELECT idx, ott_id, name, lang, source, source_id,
                   ROW_NUMBER() OVER (
                     PARTITION BY idx, lang
                     ORDER BY src_rank, kind_rank, length(name), name
                   ) AS primary_rn
              FROM (
                SELECT idx, ott_id, name, lang, source, source_id,
                       CASE source WHEN 'wikidata' THEN 0 WHEN 'pbdb_coldp' THEN 1 ELSE 2 END
                         AS src_rank,
                       CASE kind WHEN 'v' THEN 0 WHEN 'l' THEN 1 ELSE 2 END
                         AS kind_rank,
                       ROW_NUMBER() OVER (
                         PARTITION BY
                           COALESCE(CAST(idx AS TEXT), 'u:' || source || ':' ||
                                    COALESCE(source_id, '')),
                           lang, lower(name)
                         ORDER BY CASE source WHEN 'wikidata' THEN 0
                                          WHEN 'pbdb_coldp' THEN 1 ELSE 2 END,
                                  CASE kind WHEN 'v' THEN 0 WHEN 'l' THEN 1
                                            ELSE 2 END,
                                  source_id
                       ) AS dedup_rn
                  FROM v_res
              ) WHERE dedup_rn = 1
          )
        """
    )
    con.executescript(INDEXES)
    con.commit()
    log(f"  dropped {dropped:,} names that merely repeated the scientific name")
    log(f"  dropped {shadowed:,} names that are another taxon's scientific name")
    log(f"  dropped {contested:,} names from items whose P225 is a different taxon")
    return {
        "dropped_as_scientific_name": dropped,
        "dropped_as_other_taxon_name": shadowed,
        "dropped_as_p225_mismatch": contested,
    }


# --------------------------------------------------------------------------
# Phase entry point
# --------------------------------------------------------------------------


def _coverage(con: sqlite3.Connection) -> JsonDict:
    """Plain coverage, and coverage weighted by `tip_count`.

    The weighted figure is the one that matters for a palette: a person types
    "mammal", not "Nannospalax golani". Weighting by subtree size is the same
    corpus signal architecture §4 ranks on, so it measures the same notion of
    notable that search will.
    """
    total, weight = con.execute(
        "SELECT count(*), sum(tip_count) FROM node WHERE name IS NOT NULL"
    ).fetchone()
    covered, cov_weight = con.execute(
        "SELECT count(*), sum(n.tip_count) FROM node n "
        "WHERE n.name IS NOT NULL AND EXISTS "
        "(SELECT 1 FROM vernacular v WHERE v.idx = n.idx AND v.lang = 'en')"
    ).fetchone()
    tips, tips_cov = con.execute(
        "SELECT count(*), sum(EXISTS (SELECT 1 FROM vernacular v "
        "WHERE v.idx = n.idx AND v.lang = 'en')) "
        "FROM node n WHERE n.name IS NOT NULL AND n.tip_count = 1"
    ).fetchone()
    # The clearest statement of the same thing: of the N most inclusive named
    # clades, how many can a person name in English? This is what the palette
    # is actually judged on, and unlike the weighted share it needs no
    # explanation of what a weighted share of a nested hierarchy means.
    top: dict[str, float] = {}
    for n in (100, 1_000, 10_000, 100_000):
        hit = con.execute(
            "SELECT count(*) FROM (SELECT idx FROM node WHERE name IS NOT NULL "
            "ORDER BY tip_count DESC LIMIT ?) t WHERE EXISTS "
            "(SELECT 1 FROM vernacular v WHERE v.idx = t.idx AND v.lang = 'en')",
            (n,),
        ).fetchone()[0]
        top[f"pct_top_{n}_by_tip_count"] = round(100 * hit / n, 1)

    return {
        **top,
        "named_nodes": total,
        "named_nodes_with_vernacular": covered or 0,
        "pct_nodes": round(100 * (covered or 0) / max(total, 1), 2),
        "tip_count_weight_total": weight or 0,
        "tip_count_weight_covered": cov_weight or 0,
        "pct_tip_count_weighted": round(
            100 * (cov_weight or 0) / max(weight or 1, 1), 2
        ),
        "tips": tips,
        "tips_with_vernacular": tips_cov or 0,
        "pct_tips": round(100 * (tips_cov or 0) / max(tips, 1), 2),
    }


def run(use_api: bool = True) -> int:
    g = GateSet("phase6-vernaculars")
    OUT.mkdir(parents=True, exist_ok=True)

    con = sqlite3.connect(DB, timeout=120.0)
    con.execute("PRAGMA busy_timeout = 120000")
    # `synchronous = OFF` only; the rollback journal stays on, because other
    # phases write this database too and journal_mode = OFF is only safe for
    # the single-writer, build-from-scratch case topology.py is.
    con.execute("PRAGMA synchronous = OFF")

    print("--- wikidata P9157 ---", flush=True)
    if use_api:
        crawl = crawl_wikidata(con, log=print)
    else:
        on_disk = len(list(WIKIDATA_PAGES.glob("page_*.jsonl")))
        plan_path = WIKIDATA_PAGES / "plan.json"
        planned = (
            json.loads(plan_path.read_text()).get("n_pages")
            if plan_path.exists()
            else None
        )
        crawl = {
            "pages_total": planned,
            "pages_on_disk": on_disk,
            "pages_fetched_this_run": 0,
            "complete": on_disk == planned,
            "stopped_early": "--no-api",
        }
        print(
            f"  --no-api: replaying {on_disk} of {planned} checkpointed pages",
            flush=True,
        )

    print("\n--- wikidata P225, top clades by name ---", flush=True)
    if use_api:
        name_crawl = crawl_wikidata_by_name(con, log=print)
    else:
        name_crawl = {
            "pages_on_disk": len(list(NAME_PAGES.glob("page_*.jsonl"))),
            "pages_fetched_this_run": 0,
            "stopped_early": "--no-api",
        }
    by_name = read_wikidata_name_pages(log=print)

    print("\n--- pbdb ColDP VernacularName.tsv ---", flush=True)
    pbdb = read_pbdb(log=print)

    print("\n--- staging ---", flush=True)
    t0 = time.monotonic()
    con.execute(
        "CREATE TEMP TABLE v_raw ("
        "  ott_id INTEGER, source TEXT, source_id TEXT, sci_name TEXT,"
        "  name TEXT, lang TEXT, kind TEXT)"
    )
    n_wikidata = stage(con, read_wikidata_pages(log=print))
    n_by_name = stage(con, by_name)
    n_pbdb = stage(con, pbdb)
    print(
        f"  staged {n_wikidata:,} wikidata + {n_by_name:,} wikidata-by-name + "
        f"{n_pbdb:,} pbdb rows in {time.monotonic() - t0:,.1f}s",
        flush=True,
    )

    print("\n--- resolving and loading ---", flush=True)
    stats = load(con, log=print)

    # ---- gates ----------------------------------------------------------
    print("\n--- gates ---", flush=True)

    pbdb_unique, pbdb_amb, pbdb_none = con.execute(
        """
        SELECT sum(idx IS NOT NULL),
               sum(idx IS NULL AND n_cand > 1),
               sum(idx IS NULL AND n_cand IS NULL)
          FROM (SELECT v.rowid AS r, c.n_cand AS n_cand,
                       CASE WHEN c.n_cand = 1 THEN c.idx END AS idx
                  FROM v_raw v LEFT JOIN name_cand c ON c.vrow = v.rowid
                 WHERE v.source = 'pbdb_coldp')
        """
    ).fetchone()

    g.require("pbdb VernacularName.tsv rows", n_pbdb, EXPECT_PBDB_ROWS)
    g.require(
        "pbdb rows resolving to exactly one node", pbdb_unique, EXPECT_PBDB_UNIQUE
    )
    g.require(
        "pbdb rows whose name is ambiguous",
        pbdb_amb,
        EXPECT_PBDB_AMBIGUOUS,
        note="recorded with idx NULL rather than guessed at; phase 3 resolves them",
    )
    g.require("pbdb rows with no name match at all", pbdb_none, EXPECT_PBDB_UNMATCHED)

    total_rows, resolved, unresolved, primaries = con.execute(
        "SELECT count(*), count(idx), sum(idx IS NULL), sum(is_primary) FROM vernacular"
    ).fetchone()
    g.require("vernacular rows written", total_rows, ok=total_rows > 0)
    g.require(
        "vernacular rows carrying a non-empty name",
        con.execute(
            "SELECT count(*) FROM vernacular WHERE name IS NULL OR trim(name) = ''"
        ).fetchone()[0],
        0,
        note="a column that silently goes NULL is this repo's signature bug",
    )
    g.require(
        "resolved rows pointing at a real node",
        con.execute(
            "SELECT count(*) FROM vernacular v LEFT JOIN node n ON n.idx = v.idx "
            "WHERE v.idx IS NOT NULL AND n.idx IS NULL"
        ).fetchone()[0],
        0,
    )
    g.require(
        "at most one primary name per (idx, lang)",
        con.execute(
            "SELECT count(*) FROM (SELECT idx, lang FROM vernacular "
            "WHERE is_primary = 1 GROUP BY idx, lang HAVING count(*) > 1)"
        ).fetchone()[0],
        0,
    )
    g.require(
        "no resolved name merely repeats its scientific name",
        con.execute(
            "SELECT count(*) FROM vernacular v JOIN node n ON n.idx = v.idx "
            "WHERE lower(n.name) = lower(v.name)"
        ).fetchone()[0],
        0,
    )
    g.require(
        "no wikidata name shadows another taxon's scientific name",
        con.execute(
            "SELECT count(*) FROM vernacular v WHERE v.source LIKE 'wikidata%' "
            "AND EXISTS (SELECT 1 FROM node n WHERE n.name = v.name "
            "AND (v.idx IS NULL OR n.idx <> v.idx))"
        ).fetchone()[0],
        0,
        note="otherwise searching 'Homo floresiensis' returns Homo sapiens",
    )
    g.require(
        "unresolved rows keep their upstream id",
        con.execute(
            "SELECT count(*) FROM vernacular WHERE idx IS NULL AND source_id IS NULL"
        ).fetchone()[0],
        0,
        note="phase 3 needs the PBDB taxon_no to finish the job",
    )

    cov = _coverage(con)
    for common, expect in SPOT_CHECKS:
        got = [
            r[0]
            for r in con.execute(
                "SELECT n.name FROM vernacular v JOIN node n ON n.idx = v.idx "
                "WHERE lower(v.name) = ? AND v.lang = 'en' "
                "ORDER BY n.tip_count DESC LIMIT 8",
                (common,),
            )
        ]
        hit = [n for n in got if n in expect]
        if crawl.get("complete") or hit:
            g.require(f"'{common}' resolves to a taxon", got, expect, ok=bool(hit))
        else:
            g.observe(
                f"'{common}' resolves to a taxon",
                got,
                expect,
                note="wikidata crawl incomplete; re-run to resume",
            )

    for common, expect in GROUP_WORD_CHECKS:
        got = [
            n
            for n, v in con.execute(
                "SELECT n.name, v.name FROM vernacular v JOIN node n ON n.idx = v.idx "
                "WHERE v.lang = 'en' AND n.name IN "
                f"({','.join('?' * len(expect))})",
                expect,
            )
            if head_word_is(v, common)
        ]
        if crawl.get("complete") or got:
            g.require(
                f"'{common}' is the head of some taxon's common name",
                sorted(set(got)),
                expect,
                ok=bool(got),
                note="the palette's ranking rests on head position; see "
                "GROUP_WORD_CHECKS",
            )
        else:
            g.observe(
                f"'{common}' is the head of some taxon's common name",
                got,
                expect,
                note="wikidata crawl incomplete; re-run to resume",
            )

    g.observe(
        "wikidata crawl",
        f"{crawl.get('pages_on_disk')}/{crawl.get('pages_total', '?')} pages",
        "complete",
        note=str(crawl.get("stopped_early") or ""),
    )
    g.observe("wikidata rows harvested", f"{n_wikidata:,}")
    g.observe(
        "wikidata P225 by-name pass",
        f"{name_crawl.get('pages_on_disk')}/{name_crawl.get('pages_total', '?')} "
        f"pages, {n_by_name:,} rows",
        note=(
            "P9157 has no statement for Q729 (animal), Metazoa, Bilateria or "
            "cellular organisms; this pass is what answers 'animal'"
        ),
    )
    g.observe(
        "rows by source",
        dict(con.execute("SELECT source, count(*) FROM vernacular GROUP BY source")),
    )
    g.observe("rows resolved / unresolved", f"{resolved:,} / {unresolved or 0:,}")
    g.observe("nodes carrying a headline vernacular", f"{primaries or 0:,}")
    g.observe(
        "names dropped as a repeat of the scientific name",
        f"{stats['dropped_as_scientific_name']:,}",
    )
    g.observe(
        "names dropped as another taxon's scientific name",
        f"{stats['dropped_as_other_taxon_name']:,}",
        note="two Wikidata items can claim one OTT id; see load()",
    )
    g.observe(
        "named nodes with an English vernacular",
        f"{cov['named_nodes_with_vernacular']:,} / {cov['named_nodes']:,} "
        f"({cov['pct_nodes']}%)",
    )
    g.observe(
        "tip_count-weighted coverage",
        f"{cov['pct_tip_count_weighted']}%",
        note="the number that matters for a palette: notability is subtree size",
    )
    g.observe(
        "coverage of the most inclusive clades",
        {
            "top 100": f"{cov['pct_top_100_by_tip_count']}%",
            "top 1k": f"{cov['pct_top_1000_by_tip_count']}%",
            "top 10k": f"{cov['pct_top_10000_by_tip_count']}%",
            "top 100k": f"{cov['pct_top_100000_by_tip_count']}%",
        },
        note="ranked by tip_count — the same signal search ranks on",
    )
    g.observe(
        "tips (tip_count = 1) with an English vernacular",
        f"{cov['tips_with_vernacular']:,} / {cov['tips']:,} ({cov['pct_tips']}%)",
    )
    g.observe(
        "gbif vernaculars",
        "not ingested",
        "free via ott_sourceinfo",
        note=(
            "ingest.md phase 6 and management.md are wrong about this. "
            "topology.py does not parse OTT's sourceinfo column, so no GBIF id "
            "exists in the database to join on, and the snapshotted backbone "
            "(simple.txt.gz) carries no vernacular names. Harvesting them means "
            "a fresh /species/{key}/vernacularNames crawl — optional, lowest "
            "priority, and a second large crawl against the service phase 3 "
            "already queues."
        ),
    )

    report = {
        "crawl": crawl,
        "crawl_by_name": name_crawl,
        "coverage": cov,
        "load": stats,
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2))
    con.close()

    g.write(BUILD / "phase6_gates.json")
    g.exit_if_failed()
    return 0
