"""Regenerate the induced-subtree fixture that pins the ports to the reference.

`web/src/tree/__fixtures__/induced.json` is the Python reference's own answer
over the real baked arrays for `render.py`'s DEFAULT_SELECTION: the eleven
species, their full root-first ancestor paths, and the expected induced
subtree — MRCA, rendered set, the 2|L|-1 bound, and every suppressed run. The
TypeScript port reads it directly; the Go port reads the same file through
`testenv`. One generated artifact, two consumers, zero hand transcription —
regenerating it by hand is how ports drift.

Run after any change to the topology arrays:  `concestor-build fixtures`
"""

from __future__ import annotations

import json

import numpy as np

from .newick import NO_OTT
from .paths import REPO_ROOT
from .render import DEFAULT_SELECTION, induced_subtree, path_to_root
from .topology import OUT as TOPO_OUT

FIXTURE = REPO_ROOT / "web" / "src" / "tree" / "__fixtures__" / "induced.json"


def run() -> int:
    parent = np.load(TOPO_OUT / "parent.npy")
    ott = np.load(TOPO_OUT / "ott_id.npy")
    ott_to_idx = {int(o): i for i, o in enumerate(ott.tolist()) if o != NO_OTT}

    labels: dict[int, str] = {}
    for label, ott_id in DEFAULT_SELECTION:
        idx = ott_to_idx.get(ott_id)
        if idx is None:
            print(f"  ! {label} (ott{ott_id}) is not in the tree; refusing")
            return 1
        labels[idx] = label
    selection = sorted(labels)  # preorder == canonical vertical order

    paths = {idx: path_to_root(parent, idx) for idx in selection}
    rendered, segments = induced_subtree(parent, selection)
    (mrca,) = (v for v, (anc, _) in segments.items() if anc is None)

    # Every node on any path, with its tier and ages, so tests exercising the
    # time axis run against real geometry rather than invented numbers.
    age_ma = np.load(TOPO_OUT / "age_ma.npy")
    age_layout = np.load(TOPO_OUT / "age_layout.npy")
    tier = np.load(TOPO_OUT / "age_tier.npy")
    on_paths = sorted({v for p in paths.values() for v in p})

    def _age(a: float) -> float | None:
        return float(a) if np.isfinite(a) else None

    nodes = {
        str(v): {
            "idx": v,
            "tier": int(tier[v]),
            "age_ma": _age(age_ma[v]),
            "age_layout": _age(age_layout[v]),
        }
        for v in on_paths
    }

    fixture = {
        "selection": selection,
        "labels": {str(ott_to_idx[o]): label for label, o in DEFAULT_SELECTION},
        "paths": {str(i): paths[i] for i in selection},
        "expected": {
            "mrca": mrca,
            "rendered": sorted(rendered),
            "bound": len(rendered),
            "segments": {
                str(v): {"anc": anc, "suppressed": sup}
                for v, (anc, sup) in sorted(segments.items())
            },
        },
        "nodes": nodes,
    }
    FIXTURE.write_text(json.dumps(fixture, indent=1) + "\n")
    print(f"wrote {FIXTURE} ({len(selection)} tips, {len(rendered)} rendered)")
    return 0
