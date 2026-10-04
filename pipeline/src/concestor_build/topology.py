"""Phase 1 — parse the synthesis Newick into preorder-indexed topology arrays.

Output is the hot-path array data plus the `node` table for everything else.
The structural gates (tip count above all) validate the parse and the graft;
a mismatch means a real bug, not a stale constant.

The tree is the synthesis with one hand edit: `graft_hominins` replaces the
*Homo sapiens* subtree with three sister species. See `GRAFT_LEAVES`.
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import TYPE_CHECKING

import numpy as np

from . import newick
from . import oracle as oracle_mod
from .gates import GateSet
from .newick import NO_OTT, NO_PARENT, parse_ott_id
from .paths import BUILD

if TYPE_CHECKING:
    from collections.abc import Iterator

    from .typing_ import JsonDict

EXTRACT = BUILD / "extracted"
TREE = EXTRACT / "opentree16.1_tree" / "labelled_supertree" / "labelled_supertree.tre"
TAXONOMY = EXTRACT / "ott3.7.3" / "taxonomy.tsv"
SYNONYMS = EXTRACT / "ott3.7.3" / "synonyms.tsv"
FORWARDS = EXTRACT / "ott3.7.3" / "forwards.tsv"
BROKEN = EXTRACT / "opentree16.1" / "labelled_supertree" / "broken_taxa.json"

OUT = BUILD / "topology"
DB = BUILD / "concestor.db"

# idx, ott_id, node_key, name, rank, flags, tip_count, depth
type NodeRow = tuple[int, int | None, str, str | None, str | None, str | None, int, int]
# ott_id, node_key, name, mrca_node_key, mrca_idx, n_points, points, intruders
type BrokenRow = tuple[int, str, str | None, str, int | None, int, str, str]

# The curated hominin graft — the one place this pipeline edits the tree by
# hand. OTT files Neanderthals as a subspecies of *Homo sapiens*, beside a
# nominate *Homo sapiens sapiens*, and the Denisovans as
# `Homo sapiens subsp. 'Denisova'` (absent from synthesis entirely), because
# NCBI does. That makes the human an internal node above two "subspecies" and
# leaves the Denisovan nowhere. The consensus reading of the ancient-DNA
# record is three sister species, (sapiens, (neanderthalensis, longi)), so
# phase 1 replaces the host's subtree with exactly that:
#
#   - `ott770315`, *Homo sapiens*, becomes a tip. The nominate subspecies
#     under it is the same animal and stops being a node; its id forwards to
#     the species and its name stays searchable (`GRAFT_FORMER_NAMES`).
#   - `ott83926` becomes *Homo neanderthalensis*, species. The name is the
#     one Wikidata's Neanderthal item (Q40171) already cites for this OTT id,
#     and the one PBDB files its fossil record under — both joins land clean.
#   - `ott933436` becomes *Homo longi*, species, vernacular "Denisovan",
#     following the 2025 Harbin-cranium identification. OTT has no taxon by
#     this name, so the id is the Denisovan's and the name is curated.
#
# The two splits carry literature dates on the `curated` age tier
# (architecture §3.5): sapiens vs (neanderthalensis + longi) at 0.6 Ma and
# neanderthalensis vs longi at 0.4 Ma, from Prüfer et al. 2017 (Science
# 358:655), 520–630 ka and 390–440 ka. The internal nodes take the mrca-form
# keys synthesis would give them: the lowest OTT id under each child, in
# ascending order.
#
# Everything else about the graft is downstream consequence, not extra
# machinery: the leaves keep their OTT ids so URLs, xref, PhyloPic citations
# and Wikidata items resolve to them directly; phase 4 attaches PBDB's
# Neanderthal at walk 0, which both gives the node its fossil range and
# removes the duplicate fossil row from search; and the phase-1 oracle
# excludes the two leaves, gated below, because the live API answers for
# OTT's filing, which is the thing this graft corrects.
#
# Subspecies everywhere else stay the nodes synthesis makes them. A tree that
# stopped at species was built and measured (the dog, the pig and broccoli
# stop being things a reader can pick, and 68k names need a second home); one
# species is the edit the evidence asks for.
GRAFT_HOST_OTT = 770315  # Homo sapiens, the sister of the grafted pair
GRAFT_LEAVES = (
    # (ott_id, node_key, name, vernacular)
    (83926, "ott83926", "Homo neanderthalensis", None),
    (933436, "ott933436", "Homo longi", "Denisovan"),
)
GRAFT_OUTER_KEY = "mrcaott83926ott770315"  # sapiens | (neanderthalensis, longi)
GRAFT_INNER_KEY = "mrcaott83926ott933436"  # neanderthalensis | longi
GRAFT_AGES_MA = {GRAFT_OUTER_KEY: 0.6, GRAFT_INNER_KEY: 0.4}
# What OTT called each taxon the graft renames or removes, and the node that
# answers for the name now. The search phase indexes each as a synonym, and an
# id that stopped being a node forwards to its answer, so a link or a query
# written against OTT's filing still arrives. Derived again by
# `graft_hominins` and gated equal: a subspecies OTT adds under the host
# fails the build here rather than vanishing.
GRAFT_FORMER_NAMES = (
    # (the OTT id that carried the name, the name, the OTT id that answers)
    (83926, "Homo sapiens neanderthalensis", 83926),
    (5341349, "Homo sapiens sapiens", GRAFT_HOST_OTT),
    (933436, "Homo sapiens subsp. 'Denisova'", 933436),
)

# The parse is pinned by EXPECT_PARSED; everything below it measures the
# shipped tree, which is the parse with the host's three-node subtree replaced
# by the graft's five.
EXPECT_PARSED = 2_725_682
EXPECT_TIPS = 2_385_876
EXPECT_INTERNAL = 339_808
EXPECT_TOTAL = 2_725_684
EXPECT_MAX_DEPTH = 111
EXPECT_MIN_DEPTH = 2
EXPECT_MEAN_DEPTH = 41.32
EXPECT_MAX_FANOUT = 12_964
EXPECT_UNARY = 83_305
EXPECT_FORWARDS = 297_070
EXPECT_BROKEN = 9_839


def load_forwards() -> dict[int, int]:
    """Load `forwards.tsv` and collapse every chain to its terminal id.

    Forwarding can chain and can point "backwards", so resolution is transitive
    with cycle detection rather than a single hop.
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


def load_broken() -> dict[str, JsonDict]:
    with BROKEN.open() as fh:
        return json.load(fh)["non_monophyletic_taxa"]


def graft_hominins(
    tree: newick.ParsedTree, taxonomy: dict[int, tuple[str, str, str]]
) -> tuple[newick.ParsedTree, list[tuple[int, str, int]]]:
    """Replace the *Homo sapiens* subtree with the curated hominin clade.

    The host's subtree is one contiguous preorder block, and five nodes go in
    where it was — outer, host, inner, the two leaves — so relative order
    elsewhere is untouched and the renumbering is one offset past the block.
    The leaves' taxonomy entries are overridden to the curated name and rank,
    so `write_db` says what the graft means, not what NCBI filed.

    Returns the tree and what the edit retired, in `GRAFT_FORMER_NAMES`'
    shape: every named taxon that sat under the host, plus each leaf's filed
    name, against the id that answers for it now.
    """
    n = tree.n_nodes
    ott_l = tree.ott_id.tolist()
    hosts = [i for i, o in enumerate(ott_l) if o == GRAFT_HOST_OTT]
    if len(hosts) != 1:
        raise ValueError(f"graft host ott{GRAFT_HOST_OTT} resolves to {hosts}")
    s = hosts[0]
    # Preorder: the host's descendants are the run after it whose parents
    # are inside the run.
    e = s + 1
    while e < n and int(tree.parent[e]) >= s:
        e += 1

    leaf_ids = [o for o, _k, _n, _v in GRAFT_LEAVES]
    former: list[tuple[int, str, int]] = []
    for i in range(s + 1, e):
        o = ott_l[i]
        if o != NO_OTT and o in taxonomy:
            former.append((o, taxonomy[o][0], o if o in leaf_ids else GRAFT_HOST_OTT))
    for o in leaf_ids:
        if o in taxonomy and all(f[0] != o for f in former):
            former.append((o, taxonomy[o][0], o))

    # New preorder block: s outer, s+1 host, s+2 inner, s+3 and s+4 the leaves.
    block = 5
    shift = block - (e - s)
    parent = np.empty(n + shift, dtype=np.uint32)
    ott = np.empty(n + shift, dtype=np.int64)
    parent[:s] = tree.parent[:s]
    ott[:s] = tree.ott_id[:s]
    # Nothing past the block hangs inside it, so a parent there is either
    # before the host (unmoved) or past the block (moved with everything).
    old_tail = tree.parent[e:].astype(np.int64)
    parent[s + block :] = np.where(old_tail >= e, old_tail + shift, old_tail).astype(
        np.uint32
    )
    ott[s + block :] = tree.ott_id[e:]

    parent[s] = tree.parent[s]  # outer takes the host's place under Homo
    parent[s + 1] = s  # host
    parent[s + 2] = s  # inner
    parent[s + 3] = s + 2
    parent[s + 4] = s + 2
    ott[s] = NO_OTT
    ott[s + 1] = GRAFT_HOST_OTT
    ott[s + 2] = NO_OTT
    ott[s + 3] = leaf_ids[0]
    ott[s + 4] = leaf_ids[1]

    labels = [
        *tree.labels[:s],
        GRAFT_OUTER_KEY.encode(),
        tree.labels[s],
        GRAFT_INNER_KEY.encode(),
        GRAFT_LEAVES[0][1].encode(),
        GRAFT_LEAVES[1][1].encode(),
        *tree.labels[e:],
    ]

    for ott_id, _key, name, _vern in GRAFT_LEAVES:
        # The extinct flag is true and load-bearing: phase 5a's witness layer
        # reads it.
        taxonomy[ott_id] = (name, "species", "extinct")

    return (
        newick.ParsedTree(parent=parent, ott_id=ott, labels=labels, branch_length=None),
        sorted(former),
    )


def run(oracle: bool = True, oracle_samples: int = 200) -> int:
    g = GateSet("phase1-topology")
    OUT.mkdir(parents=True, exist_ok=True)

    print(f"--- parsing {TREE.name} ({TREE.stat().st_size:,} B) ---", flush=True)
    t0 = time.monotonic()
    data = TREE.read_bytes()
    tree = newick.parse(data)
    print(
        f"  parsed {tree.n_nodes:,} nodes in {time.monotonic() - t0:,.1f}s", flush=True
    )
    g.require("parsed node count", tree.n_nodes, EXPECT_PARSED)

    taxonomy, n_tax = load_taxonomy()

    tree, former = graft_hominins(tree, taxonomy)
    g.require(
        "names the hominin graft retired",
        former,
        sorted(GRAFT_FORMER_NAMES),
        note=(
            "Every named taxon under Homo sapiens, and the two leaves' filed "
            "names. A mismatch means OTT's filing moved under the hand edit."
        ),
    )

    t1 = time.monotonic()
    topo = newick.derive(tree.parent)
    print(f"  derived arrays in {time.monotonic() - t1:,.1f}s", flush=True)

    n_tips = int(topo.is_tip.sum())
    n_internal = tree.n_nodes - n_tips
    # Root-to-tip depth is measured over tips, not all nodes.
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

    # The graft, read back off the arrays rather than trusted from the splice.
    at = {lbl: i for i, lbl in enumerate(tree.labels)}
    host = at[f"ott{GRAFT_HOST_OTT}".encode()]
    outer, inner = at[GRAFT_OUTER_KEY.encode()], at[GRAFT_INNER_KEY.encode()]
    leaves = [at[key.encode()] for _o, key, _n, _v in GRAFT_LEAVES]
    g.require(
        "curated hominin clade",
        {
            "host is a tip": bool(topo.is_tip[host]),
            "host under outer": int(tree.parent[host]) == outer,
            "inner under outer": int(tree.parent[inner]) == outer,
            "leaves under inner": [int(tree.parent[i]) for i in leaves] == [inner] * 2,
            "outer holds three tips": int(topo.tip_count[outer]) == 3,
        },
        dict.fromkeys(
            (
                "host is a tip",
                "host under outer",
                "inner under outer",
                "leaves under inner",
                "outer holds three tips",
            ),
            True,
        ),
        note=(
            "(sapiens, (neanderthalensis, longi)) — see GRAFT_LEAVES. The one "
            "hand edit this pipeline makes to the tree."
        ),
    )
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

    # ott_id -> idx as a sorted pair of arrays, for O(log n) lookup.
    order = np.argsort(ott_ids, kind="stable")
    order = order[ott_ids[order] != NO_OTT]
    np.save(OUT / "ott_sorted.npy", ott_ids[order])
    np.save(OUT / "ott_to_idx.npy", order.astype(np.uint32))

    # An id the graft retired forwards like one OTT retired, and so does
    # anything that already forwarded to it.
    retired = {old: new for old, _name, new in former if old != new}
    forwards = {k: retired.get(v, v) for k, v in forwards.items()} | retired
    write_db(tree, topo, taxonomy, broken, forwards)

    # Content gates: structural gates count nodes but not whether columns carry
    # data. A rename once emptied `rank` and every structural gate still passed.
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    n_named, n_ranked = con.execute(
        "SELECT count(*), count(rank) FROM node WHERE ott_id IS NOT NULL"
    ).fetchone()
    n_broken_rows, n_broken_resolved = con.execute(
        "SELECT count(*), count(mrca_idx) FROM broken_taxon"
    ).fetchone()
    con.close()

    g.require("node rows carrying a rank", n_ranked, n_named)
    g.require("broken_taxon rows", n_broken_rows, EXPECT_BROKEN)
    g.require(
        "broken taxa whose substitute MRCA resolves to a node",
        n_broken_resolved,
        EXPECT_BROKEN,
        note=(
            "Broken taxa are rejected from synthesis and so are not nodes "
            "themselves; the MRCA is what the live API silently substitutes."
        ),
    )

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
            f"{rep['matched']}/{rep['compared']}",
            "all",
            ok=rep["compared"] > 0 and rep["mismatched"] == 0,
            note=rep.get("note", ""),
        )
        g.require(
            "tips the oracle may not sample",
            rep["excluded"],
            len(GRAFT_LEAVES),
            note="The grafted leaves and nothing else: the live API files them as OTT does.",
        )
    else:
        g.observe("oracle induced-subtree agreement", "skipped (--no-oracle)")

    g.write(BUILD / "phase1_gates.json")
    g.exit_if_failed()
    return 0


def write_db(
    tree: newick.ParsedTree,
    topo: newick.Topology,
    taxonomy: dict[int, tuple[str, str, str]],
    broken: dict[str, JsonDict],
    forwards: dict[int, int],
) -> None:
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
          tip_count  INTEGER NOT NULL,
          depth      INTEGER NOT NULL
        );

        -- Broken taxa are NOT nodes: a non-monophyletic taxon is rejected from
        -- synthesis, so an `is_broken` flag on `node` would be permanently
        -- zero. They get their own table with their attachment points.
        CREATE TABLE broken_taxon (
          ott_id            INTEGER PRIMARY KEY,
          node_key          TEXT NOT NULL,
          name              TEXT,
          mrca_node_key     TEXT NOT NULL,
          mrca_idx          INTEGER,
          n_attachment_points INTEGER NOT NULL,
          attachment_points TEXT NOT NULL,   -- JSON
          intruding_taxa    TEXT NOT NULL    -- JSON
        );
        """
    )

    ott = tree.ott_id.tolist()
    tipc = topo.tip_count.tolist()
    dep = topo.depth.tolist()

    def rows() -> Iterator[NodeRow]:
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
                tipc[i],
                dep[i],
            )

    con.executemany("INSERT INTO node VALUES (?,?,?,?,?,?,?,?)", rows())
    con.executescript(
        """
        CREATE UNIQUE INDEX node_ott ON node(ott_id) WHERE ott_id IS NOT NULL;
        CREATE INDEX node_key_idx ON node(node_key);
        CREATE INDEX node_name ON node(name) WHERE name IS NOT NULL;
        CREATE TABLE forward (old_ott_id INTEGER PRIMARY KEY, new_ott_id INTEGER NOT NULL);
        """
    )
    con.executemany("INSERT INTO forward VALUES (?,?)", forwards.items())

    key_to_idx = {k: i for i, k in con.execute("SELECT idx, node_key FROM node")}

    def broken_rows() -> Iterator[BrokenRow]:
        for key, entry in broken.items():
            ott_id = parse_ott_id(key.encode())
            name = taxonomy.get(ott_id, (None, None, None))[0]
            points = entry["attachment_points"]
            mrca = entry["mrca"]
            yield (
                ott_id,
                key,
                name,
                mrca,
                key_to_idx.get(mrca),
                len(points),
                json.dumps(points, separators=(",", ":")),
                json.dumps(entry["intruding_taxa"], separators=(",", ":")),
            )

    con.executemany("INSERT INTO broken_taxon VALUES (?,?,?,?,?,?,?,?)", broken_rows())
    con.execute("CREATE INDEX broken_mrca ON broken_taxon(mrca_idx)")
    con.commit()
    con.close()
