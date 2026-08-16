"""Phase 1 — parse the synthesis Newick into preorder-indexed topology arrays.

Output is the hot-path array data plus the `node` table for everything else.
The structural gates (tip count above all) validate the parse and the collapse;
a mismatch means a real bug, not a stale constant.

## The tree stops at species

Synthesis carries ~68k infraspecific taxa — subspecies, varieties, forms, and
the strain-level terminals beneath them. This product is about the tree of
species, and an infraspecific tip costs more than it says: it turns 22k species
into internal nodes (*Homo sapiens* was internal, because OTT hangs Neanderthals
and Denisovans off it as subspecies), it puts a rank below the reader's mental
model on the canvas, and it splits a species' images, names and fossils across
nodes nobody selects. So phase 1 collapses them: every subtree rooted at an
infraspecific taxon folds into its nearest surviving ancestor — almost always
the species — and what folded is recorded in `folded_infraspecific` so the
detail card can still say "includes 2 subspecies".

Membership is the **union** of the OTT `infraspecific` flag and the
infraspecific ranks, because the two disagree in both directions: ~37k flagged
nodes sit at `no rank`/`no rank - terminal` (Homo sapiens neanderthalensis is
one — a rank rule misses the headline case), and ~550 nodes at an
infraspecific rank lack the flag. The named non-infraspecific nodes a subtree
prune takes with it are strain-level terminals under a subspecies, measured and
gated below.
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
# surviving ancestor idx, ott_id, name, rank
type FoldedRow = tuple[int, int, str, str | None]

# Ranks below species. Checked as a union with the `infraspecific` flag — see
# the module docstring for why neither alone is enough.
INFRA_RANKS = frozenset(
    {"subspecies", "varietas", "variety", "forma", "infraspecificname"}
)

# The curated hominin graft — the one place this pipeline edits the tree by
# hand, and the reason the infraspecific collapse could be total. OTT files
# Neanderthals as a subspecies of Homo sapiens and the Denisovans as
# `Homo sapiens subsp. 'Denisova'` (absent from synthesis entirely), because
# NCBI does. The consensus reading of the ancient-DNA record is three sister
# species: (sapiens, (neanderthalensis, longi)). So after the collapse folds
# the subspecies away, phase 1 grafts the two back as species:
#
#   - `ott83926` becomes *Homo neanderthalensis*, species. The name is the
#     one Wikidata's Neanderthal item (Q40171) already cites for this OTT id,
#     and the one PBDB files its fossil record under — both joins land clean.
#   - `ott933436` becomes *Homo longi*, species, vernacular "Denisovan",
#     following the 2025 Harbin-cranium identification. OTT has no taxon by
#     this name, so the id is the Denisovan's and the name is curated.
#
# The two splits carry literature dates on the `curated` age tier
# (architecture §3.5): sapiens vs (neanderthalensis + longi) at 0.6 Ma and
# neanderthalensis vs longi at 0.4 Ma, from Prüfer et al. 2017 (Nature
# 549:429), 550–765 ka and 381–473 ka. The internal nodes take the mrca-form
# keys synthesis would give them, derived from their descendants' OTT ids.
#
# Everything else about the graft is downstream consequence, not extra
# machinery: the leaves keep their OTT ids so URLs, xref, PhyloPic citations
# and Wikidata items resolve to them directly; phase 4 attaches PBDB's
# Neanderthal at walk 0, which both gives the node its fossil range and
# removes the duplicate fossil row from search; and the phase-1 oracle
# excludes the two leaves, gated below, because the live API answers for
# OTT's filing, which is the thing this graft corrects.
GRAFT_HOST_OTT = 770315  # Homo sapiens, the sister of the grafted pair
GRAFT_LEAVES = (
    # (ott_id, node_key, name, vernacular)
    (83926, "ott83926", "Homo neanderthalensis", None),
    (933436, "ott933436", "Homo longi", "Denisovan"),
)
GRAFT_OUTER_KEY = "mrcaott770315ott83926"  # sapiens | (neanderthalensis, longi)
GRAFT_INNER_KEY = "mrcaott83926ott933436"  # neanderthalensis | longi
GRAFT_AGES_MA = {GRAFT_OUTER_KEY: 0.6, GRAFT_INNER_KEY: 0.4}

# Post-collapse, post-graft figures. The pre-collapse parse is pinned by
# EXPECT_PARSED alone; everything below it measures the shipped tree.
EXPECT_PARSED = 2_725_682
EXPECT_TIPS = 2_340_089
EXPECT_INTERNAL = 316_756
EXPECT_TOTAL = 2_656_845
EXPECT_MAX_DEPTH = 111
EXPECT_MIN_DEPTH = 2
EXPECT_MEAN_DEPTH = 41.39
EXPECT_MAX_FANOUT = 12_964
EXPECT_UNARY = 69_845
EXPECT_FORWARDS = 297_070
EXPECT_BROKEN = 9_839
EXPECT_INFRA = 67_837
EXPECT_COLLAPSED = 68_841
EXPECT_COLLATERAL = 688


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


def collapse_infraspecific(
    tree: newick.ParsedTree, taxonomy: dict[int, tuple[str, str, str]]
) -> tuple[newick.ParsedTree, list[FoldedRow], dict[str, int], JsonDict]:
    """Fold every infraspecific subtree into its nearest surviving ancestor.

    Three linear sweeps, in the style of `derive`:

    1. Down: a node is removed if it is infraspecific (flag ∪ rank) or its
       parent is removed — subtree pruning, which is safe because an
       infraspecific node's descendants are infraspecific taxa and their
       strains, never a full species (gated as `collateral` below).
    2. Up: an *unnamed* node whose surviving children all went is structure
       that existed only to arrange them (an `mrcaott…` grouping of
       subspecies); it goes too. A named node left childless is the point of
       the exercise — the species, now a tip.
    3. Down: each removed node's nearest surviving ancestor, which is where
       its named taxa are recorded as folded.

    Survivors keep their relative preorder order, so the renumbering is a
    subtraction and every invariant `derive` relies on is preserved.
    """
    n = tree.n_nodes
    par = tree.parent.astype(np.int64)
    par[0] = -1
    par_l = par.tolist()
    ott_l = tree.ott_id.tolist()

    n_flagged = n_ranked = 0
    removed = [False] * n
    for i, o in enumerate(ott_l):
        if o == NO_OTT:
            continue
        t = taxonomy.get(o)
        if t is None:
            continue
        _, rank, flags = t
        flagged = "infraspecific" in flags.split(",")
        ranked = rank in INFRA_RANKS
        if flagged:
            n_flagged += 1
        if ranked:
            n_ranked += 1
        if flagged or ranked:
            removed[i] = True
    n_infra = sum(removed)

    for i in range(1, n):
        if removed[par_l[i]]:
            removed[i] = True
    n_subtree = sum(removed)

    # Reverse sweep: children carry higher indices, so by the time `i` is
    # reached every child's fate is known and `surviving[i]` is final.
    child_count = np.bincount(par[1:][~np.array(removed[1:], dtype=bool)], minlength=n)
    was_internal = np.bincount(par[1:], minlength=n) > 0
    surviving = child_count.tolist()
    for i in range(n - 1, 0, -1):
        if removed[i]:
            continue
        if was_internal[i] and surviving[i] == 0 and ott_l[i] == NO_OTT:
            removed[i] = True
            surviving[par_l[i]] -= 1
    n_removed = sum(removed)

    anc = [0] * n
    folded: list[FoldedRow] = []
    fold_of_key: dict[str, int] = {}
    n_collateral = 0
    for i in range(n):
        if not removed[i]:
            anc[i] = i
            continue
        anc[i] = anc[par_l[i]]
        label = tree.labels[i]
        if label:
            # Anything that referenced the removed node by its Newick label —
            # a broken taxon's substitute MRCA is the known case — resolves to
            # where the node folded.
            fold_of_key[label.decode("utf-8", "replace")] = anc[i]
        o = ott_l[i]
        if o == NO_OTT:
            continue
        t = taxonomy.get(o)
        if t is None:
            continue
        name, rank, flags = t
        if not ("infraspecific" in flags.split(",") or rank in INFRA_RANKS):
            n_collateral += 1
        folded.append((anc[i], o, name, rank or None))

    keep = ~np.array(removed, dtype=bool)
    new_of_old = np.cumsum(keep, dtype=np.int64) - 1
    kept_idx = np.flatnonzero(keep)
    new_parent = np.where(
        kept_idx == 0, np.int64(NO_PARENT), new_of_old[par[kept_idx]]
    ).astype(np.uint32)
    new_ott = tree.ott_id[kept_idx]
    new_labels = [tree.labels[int(i)] for i in kept_idx.tolist()]
    collapsed = newick.ParsedTree(
        parent=new_parent, ott_id=new_ott, labels=new_labels, branch_length=None
    )
    # Fold targets renumber with everything else.
    folded = [(int(new_of_old[a]), o, name, rank) for a, o, name, rank in folded]
    fold_of_key = {k: int(new_of_old[v]) for k, v in fold_of_key.items()}

    return (
        collapsed,
        folded,
        fold_of_key,
        {
            "infraspecific (flag ∪ rank)": n_infra,
            "flagged": n_flagged,
            "at an infraspecific rank": n_ranked,
            "removed with subtrees": n_subtree,
            "unnamed structure emptied": n_removed - n_subtree,
            "removed": n_removed,
            "collateral named removals": n_collateral,
            "folded rows": len(folded),
        },
    )


def graft_hominins(
    tree: newick.ParsedTree,
    taxonomy: dict[int, tuple[str, str, str]],
    folded: list[FoldedRow],
    fold_of_key: dict[str, int],
) -> tuple[newick.ParsedTree, list[FoldedRow], JsonDict]:
    """Insert the curated hominin clade beside *Homo sapiens*.

    Four nodes go in at the host's preorder position — outer, host, inner,
    the two leaves — so relative order elsewhere is untouched and the
    renumbering is an addition, the collapse's subtraction run backwards.
    The grafted ids stop being folded: a taxon cannot be both a node and a
    record of where it went, so their `folded_infraspecific` rows (and any
    fold-key claims) are withdrawn here, and their taxonomy entries are
    overridden to the curated name and rank so `write_db` says what the
    graft means, not what NCBI filed.
    """
    n = tree.n_nodes
    hosts = [i for i, o in enumerate(tree.ott_id.tolist()) if o == GRAFT_HOST_OTT]
    if len(hosts) != 1:
        raise ValueError(f"graft host ott{GRAFT_HOST_OTT} resolves to {hosts}")
    s = hosts[0]

    # New preorder block replacing the host's single slot:
    #   s: outer, s+1: host, s+2: inner, s+3 and s+4: the leaves.
    ins = 4
    parent = np.empty(n + ins, dtype=np.uint32)
    ott = np.empty(n + ins, dtype=np.int64)
    parent[:s] = tree.parent[:s]
    ott[:s] = tree.ott_id[:s]
    old_tail = tree.parent[s + 1 :].astype(np.int64)
    parent[s + 1 + ins :] = np.where(old_tail > s, old_tail + ins, old_tail).astype(
        np.uint32
    )
    ott[s + 1 + ins :] = tree.ott_id[s + 1 :]

    parent[s] = tree.parent[s]  # outer takes the host's place under Homo
    parent[s + 1] = s  # host
    parent[s + 2] = s  # inner
    parent[s + 3] = s + 2
    parent[s + 4] = s + 2
    ott[s] = NO_OTT
    ott[s + 1] = GRAFT_HOST_OTT
    ott[s + 2] = NO_OTT
    ott[s + 3] = GRAFT_LEAVES[0][0]
    ott[s + 4] = GRAFT_LEAVES[1][0]

    labels = [
        *tree.labels[:s],
        GRAFT_OUTER_KEY.encode(),
        tree.labels[s],
        GRAFT_INNER_KEY.encode(),
        GRAFT_LEAVES[0][1].encode(),
        GRAFT_LEAVES[1][1].encode(),
        *tree.labels[s + 1 :],
    ]

    for ott_id, _key, name, _vern in GRAFT_LEAVES:
        # The curated identity: species rank, the collapse's own flag logic
        # must not see these as infraspecific again, and the extinct flag is
        # true and load-bearing (phase 5a's witness layer reads it).
        taxonomy[ott_id] = (name, "species", "extinct")

    def renumber(i: int) -> int:
        # The splice moves the host one slot down and everything after it four:
        # old s -> s+1 (the host), old > s -> +4, old < s untouched. Every
        # index recorded before the graft — fold targets, fold-key claims —
        # must come through this, or half the folded table points four nodes
        # early and "dog" resolves to an unnamed divergence.
        if i == s:
            return s + 1
        return i + ins if i > s else i

    grafted_ids = {o for o, _k, _n, _v in GRAFT_LEAVES}
    kept_folded = [
        (renumber(a), o, name, rank)
        for a, o, name, rank in folded
        if o not in grafted_ids
    ]
    withdrawn = len(folded) - len(kept_folded)
    for _o, key, _n, _v in GRAFT_LEAVES:
        fold_of_key.pop(key, None)
    for key in list(fold_of_key):
        fold_of_key[key] = renumber(fold_of_key[key])

    return (
        newick.ParsedTree(parent=parent, ott_id=ott, labels=labels, branch_length=None),
        kept_folded,
        {"grafted nodes": ins, "folded rows withdrawn": withdrawn},
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

    print("\n--- collapsing infraspecific taxa ---", flush=True)
    t1 = time.monotonic()
    tree, folded, fold_of_key, fold_stats = collapse_infraspecific(tree, taxonomy)
    print(
        f"  {fold_stats['removed']:,} nodes folded in {time.monotonic() - t1:,.1f}s",
        flush=True,
    )
    g.require(
        "infraspecific nodes (flag ∪ rank)",
        fold_stats["infraspecific (flag ∪ rank)"],
        EXPECT_INFRA,
    )
    g.require("nodes removed by the collapse", fold_stats["removed"], EXPECT_COLLAPSED)
    g.require(
        "collateral named removals",
        fold_stats["collateral named removals"],
        EXPECT_COLLATERAL,
        note=(
            "Named, non-infraspecific nodes inside pruned subtrees. All are "
            "strain-level terminals under a subspecies; a species here means "
            "the prune took something real and the build must not ship."
        ),
    )
    g.observe(
        "flag vs rank disagreement",
        f"flagged {fold_stats['flagged']:,}, "
        f"ranked {fold_stats['at an infraspecific rank']:,}",
        note="union membership; see the module docstring",
    )
    g.observe("unnamed structure emptied", fold_stats["unnamed structure emptied"])

    tree, folded, graft_stats = graft_hominins(tree, taxonomy, folded, fold_of_key)
    g.require(
        "curated hominin graft applied",
        graft_stats["grafted nodes"],
        4,
        note=(
            "Homo neanderthalensis and Homo longi as species beside Homo "
            "sapiens, with their two split nodes — see GRAFT_LEAVES. The one "
            "hand edit this pipeline makes to the tree."
        ),
    )
    g.require(
        "grafted taxa withdrawn from the fold",
        graft_stats["folded rows withdrawn"],
        1,
        note="83926 folded and is now a node; 933436 was never in synthesis.",
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

    write_db(tree, topo, taxonomy, broken, forwards, folded, fold_of_key)

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
    folded: list[FoldedRow],
    fold_of_key: dict[str, int],
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

        -- What the infraspecific collapse folded into each surviving node,
        -- so the species card can say "includes 2 subspecies" without the
        -- subspecies being nodes. Not part of the topology: nothing else
        -- joins it, and a row's taxon has no idx of its own.
        CREATE TABLE folded_infraspecific (
          idx     INTEGER NOT NULL,   -- the surviving ancestor, almost always the species
          ott_id  INTEGER NOT NULL,
          name    TEXT NOT NULL,
          rank    TEXT
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
    con.executemany("INSERT INTO folded_infraspecific VALUES (?,?,?,?)", folded)
    con.executescript(
        """
        CREATE INDEX folded_by_node ON folded_infraspecific(idx);
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
                key_to_idx.get(mrca, fold_of_key.get(mrca)),
                len(points),
                json.dumps(points, separators=(",", ":")),
                json.dumps(entry["intruding_taxa"], separators=(",", ":")),
            )

    con.executemany("INSERT INTO broken_taxon VALUES (?,?,?,?,?,?,?,?)", broken_rows())
    con.execute("CREATE INDEX broken_mrca ON broken_taxon(mrca_idx)")
    con.commit()
    con.close()
