"""Validate our baked topology against the live Open Tree API.

This is the strongest correctness test available: generate induced subtrees for
random tip sets via `/v3/tree_of_life/induced_subtree` and diff them against
what our parse produces.

Comparison is by **clade set**, not by string. For each internal node, take the
set of query tips beneath it; two topologies agree iff those sets agree. That
normalises away unnamed-node labelling and suppresses degree-2 chains for free,
since a unary chain yields duplicate clades that collapse in a set.

The API is one `waitress` process behind a small academic project with no rate
limiting — because nobody implemented it, not because none is wanted. Requests
are sequential and paced.
"""

from __future__ import annotations

import random
import time
from typing import Any

import numpy as np

from . import newick, provenance
from .newick import NO_OTT

ENDPOINT = "https://api.opentreeoflife.org/v3/tree_of_life/induced_subtree"
PACE_SECONDS = 0.34


def _our_clades(
    parent: np.ndarray, idx_of: dict[int, int], query: list[int]
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


def _api_clades(nwk: bytes) -> tuple[set[frozenset[int]], int]:
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
    return {frozenset(s) for s in below if s}, int(topo.is_tip.sum())


def check_induced_subtrees(
    tree: newick.ParsedTree,
    topo: newick.Topology,
    *,
    samples: int = 200,
    seed: int = 20260731,
    log=print,
) -> dict[str, Any]:
    rng = random.Random(seed)

    tip_idx = np.flatnonzero(topo.is_tip & (tree.ott_id != NO_OTT))
    ott_of_tip = tree.ott_id[tip_idx]
    idx_of = {
        int(o): int(i)
        for o, i in zip(tree.ott_id.tolist(), range(tree.n_nodes))
        if o != NO_OTT
    }
    log(f"  {len(tip_idx):,} tips carry an OTT id and are sampleable")

    matched = mismatched = skipped = 0
    failures: list[dict] = []
    skips: dict[str, int] = {}

    with provenance.client(timeout=180.0) as client:
        for s in range(samples):
            k = rng.randint(2, 20)
            picks = [
                int(ott_of_tip[rng.randrange(len(ott_of_tip))]) for _ in range(k)
            ]
            picks = sorted(set(picks))
            if len(picks) < 2:
                continue

            try:
                # label_format "id" yields bare `ott770315` / `mrcaott…`
                # labels, matching our node_key convention exactly. The
                # default format interpolates names, which can contain
                # apostrophes and so arrive Newick-quoted.
                r = client.post(
                    ENDPOINT, json={"ott_ids": picks, "label_format": "id"}
                )
            except Exception as e:  # noqa: BLE001
                skipped += 1
                skips["transport"] = skips.get("transport", 0) + 1
                continue
            time.sleep(PACE_SECONDS)

            if r.status_code != 200:
                skipped += 1
                reason = "http_%d" % r.status_code
                skips[reason] = skips.get(reason, 0) + 1
                continue
            d = r.json()

            # The API silently substitutes broken taxa and follows forwards.
            # Those samples answer a different question, so they are excluded
            # and counted rather than scored.
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

            theirs, n_api_tips = _api_clades(nwk.encode())
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
                            "only_ours": [sorted(c) for c in sorted(ours - theirs, key=sorted)][:4],
                            "only_theirs": [sorted(c) for c in sorted(theirs - ours, key=sorted)][:4],
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
