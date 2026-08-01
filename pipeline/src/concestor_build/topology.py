"""Phase 1 — parse the synthesis Newick into preorder-indexed topology arrays.

Output is the hot-path data described in architecture §3.2, plus the `node`
table that carries everything not on the hot path.

The gate on tip count is the single best structural check in the build: one
number validates the whole parse. Every figure here was measured during
research, so a mismatch means a real parse bug, not a stale constant.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import numpy as np

from . import newick
from . import oracle as oracle_mod
from .gates import GateSet
from .newick import NO_OTT, NO_PARENT
from .paths import BUILD

EXTRACT = BUILD / "extracted"
TREE = (
    EXTRACT / "opentree16.1_tree" / "labelled_supertree" / "labelled_supertree.tre"
)
TAXONOMY = EXTRACT / "ott3.7.3" / "taxonomy.tsv"
SYNONYMS = EXTRACT / "ott3.7.3" / "synonyms.tsv"
FORWARDS = EXTRACT / "ott3.7.3" / "forwards.tsv"
BROKEN = EXTRACT / "opentree16.1" / "labelled_supertree" / "broken_taxa.json"

OUT = BUILD / "topology"
DB = BUILD / "concestor.db"

# Measured 2026-07-31; corroborated by OTT's own out-degree distribution and
# input_output_stats.json shipped in the synthesis output tarball.
EXPECT_TIPS = 2_385_875
EXPECT_INTERNAL = 339_807
EXPECT_TOTAL = 2_725_682
EXPECT_MAX_DEPTH = 111
EXPECT_MIN_DEPTH = 2
EXPECT_MEAN_DEPTH = 41.32
EXPECT_MAX_FANOUT = 12_964
EXPECT_UNARY = 83_305
EXPECT_FORWARDS = 297_070
EXPECT_BROKEN = 9_839


def load_forwards() -> dict[int, int]:
    """Load `forwards.tsv` and collapse every chain to its terminal id.

    OTT id forwarding is silent and can chain, and can point "backwards"
    relative to release order because the project has restored previously
    changed ids. So resolution is transitive, with cycle detection rather than
    an assumed single hop.
    """
    raw: dict[int, int] = {}
    with FORWARDS.open() as fh:
        header = next(fh)
        assert header.split()[:2] == ["id", "replacement"], header
        for line in fh:
            a, _, b = line.partition("\t")
            b = b.strip()
            if b:
                raw[int(a)] = int(b)

    resolved: dict[int, int] = {}
    for start in raw:
        seen = [start]
        cur = start
        while cur in raw:
            cur = raw[cur]
            if cur in seen:  # cycle; stop at the entry point
                cur = seen[-1]
                break
            seen.append(cur)
            if len(seen) > 64:
                break
        for node in seen[:-1]:
            resolved[node] = cur
    return resolved


def load_taxonomy() -> tuple[dict[int, tuple[str, str, str]], int]:
    """Return `{ott_id: (name, rank, flags)}` from the `\\t|\\t` taxonomy file."""
    out: dict[int, tuple[str, str, str]] = {}
    with TAXONOMY.open(encoding="utf-8") as fh:
        header = fh.readline()
        cols = [c.strip() for c in header.split("\t|\t")]
        i_uid, i_name = cols.index("uid"), cols.index("name")
        i_rank, i_flags = cols.index("rank"), cols.index("flags")
        for line in fh:
            f = line.split("\t|\t")
            if len(f) <= i_flags:
                continue
            try:
                uid = int(f[i_uid])
            except ValueError:
                continue
            out[uid] = (f[i_name], f[i_rank], f[i_flags].strip())
    return out, len(out)


def load_broken() -> dict[str, dict]:
    with BROKEN.open() as fh:
        return json.load(fh)["non_monophyletic_taxa"]


def run(oracle: bool = True, oracle_samples: int = 200) -> int:
    g = GateSet("phase1-topology")
    OUT.mkdir(parents=True, exist_ok=True)

    print(f"--- parsing {TREE.name} ({TREE.stat().st_size:,} B) ---", flush=True)
    t0 = time.monotonic()
    data = TREE.read_bytes()
    tree = newick.parse(data)
    print(f"  parsed {tree.n_nodes:,} nodes in {time.monotonic() - t0:,.1f}s", flush=True)

    t1 = time.monotonic()
    topo = newick.derive(tree.parent)
    print(f"  derived arrays in {time.monotonic() - t1:,.1f}s", flush=True)

    n_tips = int(topo.is_tip.sum())
    n_internal = tree.n_nodes - n_tips
    # "Root-to-tip depth" in data-sources.md is over tips, not over all nodes;
    # including internal nodes pulls the mean to 41.67 because internal nodes
    # sit deeper on average (44.14).
    tip_depth = topo.depth[topo.is_tip]
    mean_depth = float(tip_depth.mean())
    n_unary = int((topo.child_count == 1).sum())

    print("\n--- structural gates ---", flush=True)
    g.require("tip count", n_tips, EXPECT_TIPS)
    g.require("internal node count", n_internal, EXPECT_INTERNAL)
    g.require("total node count", tree.n_nodes, EXPECT_TOTAL)
    g.require("max root-to-tip depth", int(tip_depth.max()), EXPECT_MAX_DEPTH)
    g.require("min root-to-tip depth", int(tip_depth.min()), EXPECT_MIN_DEPTH)
    g.require(
        "mean root-to-tip depth",
        round(mean_depth, 2),
        EXPECT_MEAN_DEPTH,
        ok=abs(mean_depth - EXPECT_MEAN_DEPTH) <= 0.01,
    )
    g.require("max branching factor", int(topo.child_count.max()), EXPECT_MAX_FANOUT)
    g.require("unary internal nodes", n_unary, EXPECT_UNARY)
    g.require(
        "preorder invariant parent[i] < i",
        int((tree.parent[1:] >= np.arange(1, tree.n_nodes, dtype=np.uint32)).sum()),
        0,
    )
    g.require("root has no parent", int(tree.parent[0]), int(NO_PARENT))
    g.observe(
        "polytomous internal nodes",
        f"{int((topo.child_count > 2).sum()):,} "
        f"({100 * (topo.child_count > 2).sum() / n_internal:.1f}%)",
        "31.2%",
    )
    g.observe(
        "subtree_out is a valid interval",
        int((topo.subtree_out <= np.arange(tree.n_nodes)).sum()),
        0,
    )

    # --- identifiers -----------------------------------------------------
    print("\n--- identifiers ---", flush=True)
    has_ott = tree.ott_id != NO_OTT
    g.observe(
        "nodes carrying an OTT id",
        f"{int(has_ott.sum()):,} ({100 * has_ott.mean():.1f}%)",
        note="mrca* nodes carry none, which is why idx is the primary key.",
    )
    n_with_ott = int(has_ott.sum())
    g.require(
        "duplicate OTT ids in the tree",
        n_with_ott - len(set(tree.ott_id[has_ott].tolist())),
        0,
        note="OTT id is a secondary key, but it must still be unique where present.",
    )

    forwards = load_forwards()
    g.require("forwards.tsv entries", len(forwards), EXPECT_FORWARDS)
    chained = sum(1 for k, v in forwards.items() if v in forwards)
    g.observe("forwards needing >1 hop", chained, note="chased transitively")

    taxonomy, n_tax = load_taxonomy()
    g.observe("taxonomy.tsv rows", f"{n_tax:,}")

    ott_ids = tree.ott_id
    named = sum(1 for o in ott_ids[has_ott].tolist() if o in taxonomy)
    g.require(
        "tree OTT ids resolving in taxonomy.tsv",
        f"{named:,} / {n_with_ott:,}",
        "100%",
        ok=named == n_with_ott,
    )

    print("  loading broken_taxa.json (259 MB)…", flush=True)
    broken = load_broken()
    g.require("non-monophyletic (broken) taxa", len(broken), EXPECT_BROKEN)

    # --- write artifacts -------------------------------------------------
    print("\n--- writing artifacts ---", flush=True)
    np.save(OUT / "parent.npy", tree.parent)
    np.save(OUT / "depth.npy", topo.depth)
    np.save(OUT / "subtree_out.npy", topo.subtree_out)
    np.save(OUT / "tip_count.npy", topo.tip_count)
    np.save(OUT / "ott_id.npy", tree.ott_id)
    np.save(OUT / "child_count.npy", topo.child_count)

    # ott_id -> idx, as a sorted pair of arrays for O(log n) lookup without
    # materialising a 2.4M-entry Python dict at runtime.
    order = np.argsort(ott_ids, kind="stable")
    order = order[ott_ids[order] != NO_OTT]
    np.save(OUT / "ott_sorted.npy", ott_ids[order])
    np.save(OUT / "ott_to_idx.npy", order.astype(np.uint32))

    write_db(tree, topo, taxonomy, broken, forwards)
    total_bytes = sum(p.stat().st_size for p in OUT.glob("*.npy"))
    g.observe("topology arrays on disk", f"{total_bytes / 1e6:,.1f} MB")
    g.observe("concestor.db", f"{DB.stat().st_size / 1e6:,.1f} MB")

    # --- oracle ----------------------------------------------------------
    if oracle:
        print("\n--- oracle: live induced_subtree ---", flush=True)
        rep = oracle_mod.check_induced_subtrees(
            tree, topo, samples=oracle_samples, log=print
        )
        (BUILD / "phase1_oracle.json").write_text(json.dumps(rep, indent=2))
        g.require(
            "oracle induced-subtree agreement",
            f'{rep["matched"]}/{rep["compared"]}',
            "all",
            ok=rep["compared"] > 0 and rep["mismatched"] == 0,
            note=rep.get("note", ""),
        )
    else:
        g.observe("oracle induced-subtree agreement", "skipped (--no-oracle)")

    g.write(BUILD / "phase1_gates.json")
    g.exit_if_failed()
    return 0


def write_db(tree, topo, taxonomy, broken, forwards) -> None:
    DB.unlink(missing_ok=True)
    con = sqlite3.connect(DB)
    con.executescript(
        """
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        CREATE TABLE node (
          idx        INTEGER PRIMARY KEY,
          ott_id     INTEGER,
          node_key   TEXT NOT NULL,
          name       TEXT,
          rank       TEXT,
          flags      TEXT,
          is_broken  INTEGER NOT NULL DEFAULT 0,
          tip_count  INTEGER NOT NULL,
          depth      INTEGER NOT NULL
        );
        """
    )

    ott = tree.ott_id.tolist()
    tipc = topo.tip_count.tolist()
    dep = topo.depth.tolist()

    def rows():
        for i, lbl in enumerate(tree.labels):
            key = lbl.decode("utf-8", "replace")
            o = ott[i]
            name = rank = flags = None
            if o != NO_OTT:
                t = taxonomy.get(o)
                if t:
                    name, rank, flags = t
            yield (
                i,
                None if o == NO_OTT else o,
                key,
                name,
                rank,
                flags,
                1 if key in broken else 0,
                tipc[i],
                dep[i],
            )

    con.executemany("INSERT INTO node VALUES (?,?,?,?,?,?,?,?,?)", rows())
    con.executescript(
        """
        CREATE UNIQUE INDEX node_ott ON node(ott_id) WHERE ott_id IS NOT NULL;
        CREATE INDEX node_key_idx ON node(node_key);
        CREATE INDEX node_name ON node(name) WHERE name IS NOT NULL;
        CREATE TABLE forward (old_ott_id INTEGER PRIMARY KEY, new_ott_id INTEGER NOT NULL);
        """
    )
    con.executemany("INSERT INTO forward VALUES (?,?)", forwards.items())
    con.commit()
    con.close()
