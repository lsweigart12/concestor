"""Export GBIF's PBDB checklist, including the `nubKey` backbone match.

This is the operative half of the only identifier path from PBDB to OTT:

    PBDB taxon_no → GBIF checklist taxonID → nubKey → OTT `gbif:` source id

`taxonID` and the names come from the published Darwin Core archive, but
`nubKey` is GBIF's *matching* of the checklist against its backbone and exists
only in the API. That match is what decays, so it is snapshotted here.

GBIF caps paging at offset 100,000 on both `/species/search` and `/species`,
while the checklist holds 461,889 records. No single field partitions it under
that cap (`status` leaves 197k accepted species; `origin` and `nameType` are
degenerate; `highertaxonKey` matches every ancestor and so does not partition
at all).

So this builds a *covering* set of shards rather than a partition — cutting on
rank, then status, then phylum — accepts the resulting overlap, and
deduplicates by GBIF key. Coverage is proven afterwards by counting distinct
keys against the API's own total, which is a stronger check than trusting the
shard arithmetic.

STATUS: never run, and **do not run it**. Measured 2026-07-31, see
`docs/phase3-pbdb-path.md`: the bulk export solves a problem the build does not
have. A point lookup exists and is not subject to the offset cap, because it
does not page:

    GET /v1/species?datasetKey={PBDB_DATASET_KEY}&sourceId={pbdb_taxon_no}
        -> the checklist record carrying nubKey, one request, ~0.5 s

    GET /v1/species/{nubKey}/related?datasetKey={PBDB_DATASET_KEY}
        -> the inverse: the PBDB checklist record for a backbone key

Phase 3 needs one lookup per PBDB taxon, ordered by `n_occs`, not a dump. The
shard planner below is kept only as documentation of a route not to take, the
way it already documents the hierarchy-descent dead end.

**Superseded by `resolve.py`**, which implements the point lookup as
`gbif_pbdb_chain` with a resumable on-disk checkpoint. Nothing imports this
module; it is documentation now, deliberately kept rather than deleted.

The offline alternative was measured too, and it is a second method rather than
a substitute. The frozen backbone's `simple.txt.gz` records one contributing
dataset per row — column 8 the dataset UUID, column 10 that dataset's usage key
(GBIF's key, *not* PBDB's `taxon_no`) — and 212,054 rows cite the PBDB
checklist. Joined back to `taxon_no` by name and rank against `pbdb_taxa.csv`
that reaches 38.6% of PBDB taxa and 17.9% of them reach OTT, for zero requests
and with no decay risk. But a row records only the source that *won* the
provenance slot, and PBDB wins it only where nothing higher-priority has the
name: 8% of genera, and **0 of PBDB's 100 highest-occurrence taxa**.
*Tyrannosaurus* is in the checklist with the documented chain, yet its nub entry
cites ZooBank, so the offline map cannot see a match that exists.
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from .typing_ import JsonDict, Log

PBDB_DATASET_KEY = "c33ce2f2-c3cc-43a5-a380-fe4526d63650"
SEARCH = "https://api.gbif.org/v1/species/search"
SPECIES = "https://api.gbif.org/v1/species"

# GBIF rejects offset >= 100_000; leave headroom for a full final page.
OFFSET_CAP = 99_000
PAGE = 1000

# Fields worth keeping. The full record carries vernaculars, descriptions and a
# higherClassificationMap we do not need at ~10x the size.
KEEP = (
    "key",
    "nubKey",
    "taxonID",
    "scientificName",
    "canonicalName",
    "authorship",
    "rank",
    "taxonomicStatus",
    "parentKey",
    "acceptedKey",
    "numDescendants",
    "numOccurrences",
)


def _get(client: httpx.Client, url: str, params: JsonDict) -> JsonDict:
    for attempt in range(5):
        try:
            r = client.get(url, params=params)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(2**attempt)
                continue
            r.raise_for_status()
            return r.json()
        except httpx.TransportError:
            if attempt == 4:
                raise
            time.sleep(2**attempt)
    raise RuntimeError(f"giving up on {url} {params}")


def count(client: httpx.Client, filters: JsonDict) -> int:
    p = {"datasetKey": PBDB_DATASET_KEY, "limit": 0} | filters
    return _get(client, SEARCH, p)["count"]


def children(client: httpx.Client, key: int) -> list[int]:
    out: list[int] = []
    offset = 0
    while True:
        d = _get(
            client,
            f"{SPECIES}/{key}/children",
            {"limit": PAGE, "offset": offset},
        )
        out.extend(r["key"] for r in d.get("results", []))
        if d.get("endOfRecords") or offset >= OFFSET_CAP:
            break
        offset += PAGE
    return out


def roots(client: httpx.Client) -> list[int]:
    d = _get(
        client,
        f"{SPECIES}/root/{PBDB_DATASET_KEY}",
        {"limit": PAGE},
    )
    return [r["key"] for r in d.get("results", [])]


STATUSES = (
    "ACCEPTED",
    "SYNONYM",
    "DOUBTFUL",
    "HETEROTYPIC_SYNONYM",
    "HOMOTYPIC_SYNONYM",
    "PROPARTE_SYNONYM",
    "MISAPPLIED",
)


def _facet(
    client: httpx.Client, filters: JsonDict, field: str, limit: int = 400
) -> list[tuple[str, int]]:
    d = _get(
        client,
        SEARCH,
        {
            "datasetKey": PBDB_DATASET_KEY,
            "limit": 0,
            "facet": field,
            "facetLimit": limit,
        }
        | filters,
    )
    return [(c["name"], c["count"]) for f in d["facets"] for c in f["counts"]]


def plan_shards(client: httpx.Client, log: Log = print) -> list[JsonDict]:
    """Build a covering set of shards, each under GBIF's offset cap.

    Three fixed cuts, deepening only where needed:

        rank  ->  rank x status  ->  rank x status x phylum

    An earlier version descended the checklist hierarchy node by node until
    every shard fit. That is correct but pathological: PBDB's tree is deep and
    wide, so the descent costs one count request per node visited and does not
    terminate in usable time. `highertaxonKey` matches *any* ancestor, so a
    fixed phylum-level cut buys the same coverage in ~200 requests, and the
    duplicate records it produces are removed by the dedup-by-key step.
    """
    shards: list[JsonDict] = []
    log(f"  checklist total: {count(client, {}):,}")

    phyla: list[str] | None = None
    for rank, n_rank in _facet(client, {}, "rank", 60):
        if n_rank == 0:
            continue
        if n_rank <= OFFSET_CAP:
            shards.append({"rank": rank})
            continue

        for status in STATUSES:
            n = count(client, {"rank": rank, "status": status})
            if n == 0:
                continue
            if n <= OFFSET_CAP:
                shards.append({"rank": rank, "status": status})
                continue

            if phyla is None:
                phyla = [
                    r["key"]
                    for r in _get(
                        client,
                        SEARCH,
                        {
                            "datasetKey": PBDB_DATASET_KEY,
                            "rank": "PHYLUM",
                            "limit": PAGE,
                        },
                    )["results"]
                ]
                log(f"  using {len(phyla)} phylum-level shards where needed")
            log(f"  splitting rank={rank} status={status} ({n:,}) by phylum")
            for p in phyla:
                shards.append({"rank": rank, "status": status, "highertaxonKey": p})

    log(f"  planned {len(shards)} shards")
    return shards


def fetch_shard(client: httpx.Client, filters: JsonDict) -> Iterator[JsonDict]:
    offset = 0
    while True:
        d = _get(
            client,
            SEARCH,
            {"datasetKey": PBDB_DATASET_KEY, "limit": PAGE, "offset": offset} | filters,
        )
        results = d.get("results", [])
        yield from results
        if d.get("endOfRecords") or not results or offset >= OFFSET_CAP:
            break
        offset += PAGE


def export(client: httpx.Client, dest: Path, log: Log = print) -> JsonDict:
    """Write newline-delimited JSON of the checklist; return a coverage report."""
    total = count(client, {})
    shards = plan_shards(client, log=log)

    seen: dict[int, JsonDict] = {}
    for i, filters in enumerate(shards, 1):
        for rec in fetch_shard(client, filters):
            seen[rec["key"]] = {k: rec.get(k) for k in KEEP}
        if i % 25 == 0 or i == len(shards):
            log(f"  [{i}/{len(shards)}] {len(seen):,} distinct records so far")

    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("w") as fh:
        for key in sorted(seen):
            fh.write(json.dumps(seen[key], separators=(",", ":")) + "\n")

    with_nub = sum(1 for r in seen.values() if r.get("nubKey"))
    with_taxonid = sum(1 for r in seen.values() if r.get("taxonID"))
    report = {
        "api_total": total,
        "records_exported": len(seen),
        "missing": total - len(seen),
        "with_nub_key": with_nub,
        "with_taxon_id": with_taxonid,
        "nub_key_pct": round(100 * with_nub / max(len(seen), 1), 2),
        "shards": len(shards),
    }
    log(f"  export: {json.dumps(report)}")
    return report
