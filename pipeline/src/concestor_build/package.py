"""Consolidate the artifact set and record exactly what it is made of.

`ingest.md` ends with `concestor-build package  # → topology.bin, meta.bin,
concestor.db, manifest`. Two of those four turned out not to need making.

**There is no `topology.bin` or `meta.bin`, deliberately.** Architecture §3.2
names them, and they describe the right thing — flat typed arrays, memory
mapped, no query planner on the path lookup. But that is exactly what phase 1
already writes: a `.npy` file is a 128-byte ASCII header followed by raw
little-endian data, which is a self-describing version of the same bytes. The
serving binary reads them directly (`server/internal/npy`), so concatenating
them into a second on-disk copy would double the disk cost, add a build step
that can silently disagree with its input, and give the system two candidate
sources of truth for its most load-bearing array. The names in architecture
§3.2 should be read as describing the *format*, not demanding a file.

What this phase does produce is the thing architecture §"Build orchestration"
actually argues for: a single manifest recording the build id, every source
with its checksum, every phase's gate results, and the age provenance — served
at `/v1/about` so a running instance can state what it is made of. For a system
whose credibility rests on data provenance, that endpoint is a feature rather
than diagnostics, and this is what fills it.

It also gates the artifact set as a whole, which nothing else does: individual
phases check their own output, and only something running afterwards can notice
that the age arrays are shorter than the topology they claim to describe, or
that a phase wrote gates recording its own failure.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import numpy as np

from .gates import GateSet
from .paths import BUILD, SNAPSHOT_MANIFEST
from .topology import DB
from .topology import OUT as TOPO_OUT

if TYPE_CHECKING:
    from pathlib import Path

    from .typing_ import JsonDict

MANIFEST = BUILD / "manifest.json"

# Arrays the runtime cannot start without. Anything else is optional and its
# absence degrades a feature rather than the product.
REQUIRED_ARRAYS = ("parent.npy", "subtree_out.npy", "tip_count.npy", "depth.npy")
OPTIONAL_ARRAYS = (
    "age_ma.npy",
    "age_tier.npy",
    "age_layout.npy",
    "ott_id.npy",
    "child_count.npy",
)

# Not per-node, and checking them as if they were is a gate bug rather than a
# data bug. `ott_sorted` / `ott_to_idx` are a sorted lookup *pair* covering only
# the 2,599,664 nodes that carry an OTT id at all — mrca* nodes have none, which
# is the whole reason `idx` is the primary key (architecture §3.1). They are
# gated against each other and against that count instead.
LOOKUP_ARRAYS = ("ott_sorted.npy", "ott_to_idx.npy")


def _sha256(path: Path, limit: int = 64 << 20) -> str:
    """Checksum a file, capped so a 515 MB database does not dominate the run.

    The cap is recorded alongside the digest: a prefix hash still catches a
    truncated or replaced file, which is what this is for, and pretending it is
    a whole-file digest would be worse than saying so.
    """
    h = hashlib.sha256()
    read = 0
    with path.open("rb") as fh:
        while chunk := fh.read(1 << 20):
            h.update(chunk)
            read += len(chunk)
            if read >= limit:
                break
    return h.hexdigest()


def _gate_summaries() -> dict[str, JsonDict]:
    """Every phase's gates, as written by the phase itself.

    Excluding our own, which a previous run left on disk: reading it back makes
    this phase fail because it failed last time, and then keep failing.
    """
    out: dict[str, JsonDict] = {}
    for p in sorted(BUILD.glob("*_gates.json")):
        if p.name == "package_gates.json":
            continue
        try:
            data = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            out[p.stem] = {"error": f"{type(exc).__name__}: {exc}"}
            continue
        gates = data.get("gates", [])
        failures = [
            {"name": g["name"], "expected": g["expected"], "actual": g["actual"]}
            for g in gates
            if g.get("blocking") and not g.get("passed")
        ]
        out[p.stem] = {
            "phase": data.get("phase"),
            "ok": data.get("ok"),
            "gates": len(gates),
            "passed": sum(1 for g in gates if g.get("passed")),
            "failures": failures,
        }
    return out


def _table_counts(con: sqlite3.Connection) -> dict[str, int]:
    names = [
        r[0]
        for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' "
            "ORDER BY name"
        )
    ]
    counts: dict[str, int] = {}
    for n in names:
        try:
            counts[n] = int(con.execute(f'SELECT count(*) FROM "{n}"').fetchone()[0])
        except sqlite3.DatabaseError:
            # A virtual table can refuse a bare count; that is not a build
            # failure, and reporting the table with no number is honest.
            continue
    return counts


def run() -> int:
    g = GateSet("package")
    generated = datetime.now(UTC).isoformat(timespec="seconds")

    # --- arrays -----------------------------------------------------------
    print("--- arrays ---", flush=True)
    arrays: dict[str, JsonDict] = {}
    n_nodes = 0
    missing_required: list[str] = []
    for name in (*REQUIRED_ARRAYS, *OPTIONAL_ARRAYS, *LOOKUP_ARRAYS):
        p = TOPO_OUT / name
        if not p.exists():
            if name in REQUIRED_ARRAYS:
                missing_required.append(name)
            continue
        a = np.load(p, mmap_mode="r")
        arrays[name] = {
            "dtype": str(a.dtype),
            "length": int(a.shape[0]),
            "bytes": p.stat().st_size,
        }
        if name == "parent.npy":
            n_nodes = int(a.shape[0])

    g.require("required arrays present", missing_required, [])
    lengths = {n: int(v["length"]) for n, v in arrays.items()}
    g.require(
        "per-node arrays that disagree with the node count",
        sorted(
            n for n, ln in lengths.items() if n not in LOOKUP_ARRAYS and ln != n_nodes
        ),
        [],
        note=(
            "Every per-node array must have exactly one entry per node. A "
            "shorter age array does not error at read time — it silently "
            "answers about the wrong node."
        ),
    )

    lookup_lengths = {n: lengths[n] for n in LOOKUP_ARRAYS if n in lengths}
    if lookup_lengths:
        n_with_ott = 0
        ott_path = TOPO_OUT / "ott_id.npy"
        if ott_path.exists():
            n_with_ott = int((np.load(ott_path, mmap_mode="r")[:] != -1).sum())
        g.require(
            "ott lookup pair agrees with the count of nodes carrying an OTT id",
            sorted(set(lookup_lengths.values())),
            [n_with_ott],
            note=(
                "These two are a sorted index over named nodes only, not a "
                "per-node array. They must match each other exactly or a "
                "binary search returns the wrong idx."
            ),
        )

    # --- database ---------------------------------------------------------
    print("\n--- database ---", flush=True)
    g.require("concestor.db exists", DB.exists(), True)
    counts: dict[str, int] = {}
    if DB.exists():
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        counts = _table_counts(con)
        con.close()
        g.require("node rows match the topology arrays", counts.get("node"), n_nodes)
        for name, count in sorted(counts.items()):
            g.observe(f"table {name}", f"{count:,}")

    # --- provenance -------------------------------------------------------
    print("\n--- provenance ---", flush=True)
    age_prov: JsonDict = {}
    ap = TOPO_OUT / "age_provenance.json"
    if ap.exists():
        age_prov = json.loads(ap.read_text())
        g.require(
            "shipping ages that phase 2 accepted",
            age_prov.get("phase2_accepted"),
            True,
            note=(
                "`--provisional` writes ages tagged accepted=false for the "
                "skeleton renderer. Those must never reach an artifact set."
            ),
        )

    snapshot: JsonDict = {}
    if SNAPSHOT_MANIFEST.exists():
        snapshot = json.loads(SNAPSHOT_MANIFEST.read_text())
    else:
        g.observe("snapshot/manifest.json", "missing", note="run phase 0")

    phases = _gate_summaries()
    failed = sorted(k for k, v in phases.items() if v.get("ok") is False)
    g.require(
        "phases whose own gates record a failure",
        failed,
        [],
        note="A phase that refused its own output must not be packaged.",
    )

    # --- build id ---------------------------------------------------------
    # Derived from what the artifacts actually are, so two builds from the same
    # sources produce the same id and a changed input cannot reuse one.
    print("\n--- build id ---", flush=True)
    files: dict[str, JsonDict] = {}
    for p in sorted(TOPO_OUT.glob("*.npy")):
        files[f"topology/{p.name}"] = {"bytes": p.stat().st_size, "sha256": _sha256(p)}
    for p in (DB, BUILD / "timescale.json"):
        if p.exists():
            files[p.name] = {
                "bytes": p.stat().st_size,
                "sha256": _sha256(p),
                "sha256_partial": p.stat().st_size > (64 << 20),
            }

    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode())
        digest.update(str(files[name]["sha256"]).encode())
    build_id = digest.hexdigest()[:16]

    total = sum(int(f["bytes"]) for f in files.values())
    g.observe("artifact set size", f"{total / 1e6:,.1f} MB", "< 700 MB per §11")
    g.observe("build id", build_id)

    manifest: JsonDict = {
        "build_id": build_id,
        "generated_at": generated,
        "nodes": n_nodes,
        "arrays": arrays,
        "tables": counts,
        "files": files,
        "age": age_prov,
        "phases": phases,
        "sources": snapshot,
    }

    g.write(BUILD / "package_gates.json")
    g.exit_if_failed()

    MANIFEST.write_text(json.dumps(manifest, indent=2, default=str) + "\n")
    print(f"\nwrote {MANIFEST}  (build {build_id}, {total / 1e6:,.1f} MB)", flush=True)
    return 0
