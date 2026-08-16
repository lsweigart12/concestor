"""Validate our baked topology against the live Open Tree API.

Generate induced subtrees for random tip sets via
`/v3/tree_of_life/induced_subtree` and diff them against our parse. Comparison
is by clade set, not by string: for each internal node take the set of query
tips beneath it; two topologies agree iff those sets agree. That normalises
away unnamed-node labelling and collapses degree-2 chains for free.

The API has no rate limiting, so requests are sequential and paced.
"""

from __future__ import annotations

import random
import time
from typing import TYPE_CHECKING

import numpy as np

from . import newick, provenance
from .newick import NO_OTT

if TYPE_CHECKING:
    from .typing_ import Json, Log, U32Array

ENDPOINT = "https://api.opentreeoflife.org/v3/tree_of_life/induced_subtree"
PACE_SECONDS = 0.34


def _our_clades(
    parent: U32Array, idx_of: dict[int, int], query: list[int]
) -> set[frozenset[int]]:
    """Clades of the induced subtree, as sets of query OTT ids."""
    below: dict[int, set[int]] = {}
    for ott in query:
        node = idx_of[ott]
        while True:
            below.setdefault(node, set()).add(ott)
            p = int(parent[node])
            if p == int(newick.NO_PARENT):
                break
            node = p
    return {frozenset(s) for s in below.values()}


def _api_clades(nwk: bytes) -> set[frozenset[int]]:
    """Clades of the API's returned Newick, as sets of query OTT ids."""
    t = newick.parse(nwk)
    topo = newick.derive(t.parent)
    n = t.n_nodes

    below: list[set[int]] = [set() for _ in range(n)]
    par = t.parent.tolist()
    for i in range(n - 1, -1, -1):
        if topo.is_tip[i]:
            o = int(t.ott_id[i])
            if o != NO_OTT:
                below[i].add(o)
        p = par[i]
        if p != int(newick.NO_PARENT):
            below[p] |= below[i]
    return {frozenset(s) for s in below if s}


def check_induced_subtrees(
    tree: newick.ParsedTree,
    topo: newick.Topology,
    *,
    samples: int = 200,
    seed: int = 20260731,
    log: Log = print,
) -> dict[str, Json]:
    rng = random.Random(seed)

    # The curated hominin graft is the one place this tree deliberately
    # disagrees with the live API, which still answers for OTT's subspecies
    # filing. Its two leaves are excluded from sampling — and only they can
    # differ: the grafted internal nodes sit on paths the API reports only
    # when both grafted leaves are in the query. Gated in phase 1 so the
    # exclusion list cannot quietly grow past the graft it exists for.
    from .topology import GRAFT_LEAVES

    excluded = np.isin(tree.ott_id, [o for o, _k, _n, _v in GRAFT_LEAVES])
    tip_idx = np.flatnonzero(topo.is_tip & (tree.ott_id != NO_OTT) & ~excluded)
    ott_of_tip = tree.ott_id[tip_idx]
    idx_of = {
        int(o): int(i)
        for o, i in zip(tree.ott_id.tolist(), range(tree.n_nodes), strict=False)
        if o != NO_OTT
    }
    log(f"  {len(tip_idx):,} tips carry an OTT id and are sampleable")

    matched = mismatched = skipped = 0
    failures: list[dict] = []
    skips: dict[str, int] = {}

    with provenance.client(timeout=180.0) as client:
        for s in range(samples):
            k = rng.randint(2, 20)
            picks = [int(ott_of_tip[rng.randrange(len(ott_of_tip))]) for _ in range(k)]
            picks = sorted(set(picks))
            if len(picks) < 2:
                continue

            try:
                # label_format "id" yields bare `ott770315` / `mrcaott…` labels,
                # matching our node_key convention; the default interpolates
                # names that can arrive Newick-quoted.
                r = client.post(ENDPOINT, json={"ott_ids": picks, "label_format": "id"})
            except Exception:
                skipped += 1
                skips["transport"] = skips.get("transport", 0) + 1
                continue
            time.sleep(PACE_SECONDS)

            if r.status_code != 200:
                skipped += 1
                reason = f"http_{r.status_code}"
                skips[reason] = skips.get(reason, 0) + 1
                continue
            d = r.json()

            # The API silently substitutes broken taxa and follows forwards;
            # those samples are excluded and counted rather than scored.
            if d.get("unknown"):
                skipped += 1
                skips["unknown_ott_id"] = skips.get("unknown_ott_id", 0) + 1
                continue
            if d.get("broken"):
                skipped += 1
                skips["broken_taxon"] = skips.get("broken_taxon", 0) + 1
                continue

            nwk = d.get("newick", "")
            if not nwk:
                skipped += 1
                skips["no_newick"] = skips.get("no_newick", 0) + 1
                continue

            theirs = _api_clades(nwk.encode())
            api_tips = set().union(*theirs) if theirs else set()
            if api_tips != set(picks):
                skipped += 1
                skips["tip_set_differs"] = skips.get("tip_set_differs", 0) + 1
                continue

            ours = _our_clades(tree.parent, idx_of, picks)

            if ours == theirs:
                matched += 1
            else:
                mismatched += 1
                if len(failures) < 5:
                    failures.append(
                        {
                            "ott_ids": picks,
                            "only_ours": [
                                sorted(c) for c in sorted(ours - theirs, key=sorted)
                            ][:4],
                            "only_theirs": [
                                sorted(c) for c in sorted(theirs - ours, key=sorted)
                            ][:4],
                        }
                    )

            if (s + 1) % 25 == 0:
                log(
                    f"  {s + 1}/{samples}: {matched} matched, "
                    f"{mismatched} mismatched, {skipped} skipped"
                )

    return {
        "samples_requested": samples,
        "compared": matched + mismatched,
        "matched": matched,
        "mismatched": mismatched,
        "skipped": skipped,
        "skip_reasons": skips,
        "failures": failures,
        "note": (
            "Samples hitting broken taxa or forwarded ids are excluded, not "
            "scored: the API answers a different question for those and does "
            "so silently."
        ),
    }
