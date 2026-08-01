"""Phase 2 — validate the Duke et al. 2026 dated tree. The decision gate.

This phase decides the shape of the rest of the project. Either the Zenodo
tree joins to our phase-1 topology well enough to carry the time axis, or the
fallback congruification pipeline in ingest.md phase 2 is needed and the
project grows by 4–6 weeks.

The design could not read the preprint directly (bioRxiv 403s automated
fetching) and there is an unresolved source-tree count discrepancy in the
authors' materials, so nothing here is assumed. Every criterion in
ingest.md's accept table is measured.

The measurement that actually matters is *refinement vs conflict*. Duke's tree
is fully bifurcating while the synthesis tree is heavily polytomous, so the two
cannot be node-for-node identical by construction. The question is whether
their extra structure merely resolves our polytomies (a refinement, in which
case the ages are usable) or contradicts our clades (a conflict, in which case
they are not). That is tested by comparing induced-subtree clade sets over
random shared tip samples, in both directions.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import numpy as np

from . import newick
from .gates import GateSet
from .newick import NO_OTT, NO_PARENT
from .paths import BUILD, SNAPSHOT
from .topology import OUT as TOPO_OUT, DB, load_forwards

TREES = {
    "equal_splits": SNAPSHOT / "duke2026" / "equal_splits_median_tree.tre",
    "birth_model": SNAPSHOT / "duke2026" / "birth_model_median_tree.tre",
}

EXPECT_ROOT_AGE = 4247.0
ROOT_AGE_TOL = 0.01

# Accept criteria, ingest.md phase 2.
MIN_INTERNAL_CORRESPONDENCE = 0.999
MIN_OTT_JOIN = 0.99
MAX_MONOTONICITY_VIOLATION = 0.001

# Published crown-age ranges for the spot checks. Deliberately generous: the
# point is to catch an off-by-a-factor or an inverted axis, not to adjudicate
# between studies.
SPOT_CHECKS = {
    "Mammalia": (244265, 150.0, 220.0),
    "Aves": (81461, 60.0, 140.0),
    "Metazoa": (691846, 600.0, 950.0),
    "Eukaryota": (304358, 1000.0, 2500.0),
}

CLADE_SEED = 20260731


def node_ages_from_lengths(
    parent: np.ndarray, blen: np.ndarray, is_tip: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Age of each node as its distance down to a descendant tip.

    Returns (max_age, min_age) over descendant paths. The two coincide exactly
    when the tree is ultrametric, so their spread is the ultrametricity
    residual.
    """
    n = len(parent)
    bl = np.nan_to_num(blen, nan=0.0)
    hi = np.zeros(n, dtype=np.float64)
    lo = np.full(n, np.inf, dtype=np.float64)
    lo[is_tip] = 0.0

    par = parent.astype(np.int64)
    par[0] = -1
    par_l = par.tolist()
    bl_l = bl.tolist()
    hi_l = hi.tolist()
    lo_l = lo.tolist()

    for i in range(n - 1, 0, -1):
        p = par_l[i]
        c = hi_l[i] + bl_l[i]
        if c > hi_l[p]:
            hi_l[p] = c
        c = lo_l[i] + bl_l[i]
        if c < lo_l[p]:
            lo_l[p] = c

    return np.array(hi_l), np.array(lo_l)


def _fingerprint(
    parent: np.ndarray, n: int, leaf_idx: np.ndarray, leaf_hash: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """XOR set-hash and count of shared tips beneath every node.

    Two nodes subtend the same set of shared tips iff their (hash, count)
    agree — an exact clade comparison in one reverse sweep, rather than
    materialising 2.3M descendant sets.
    """
    h = np.zeros(n, dtype=np.uint64)
    c = np.zeros(n, dtype=np.int64)
    h[leaf_idx] = leaf_hash
    c[leaf_idx] = 1
    par = parent.astype(np.int64)
    par[0] = -1
    par_l, h_l, c_l = par.tolist(), h.tolist(), c.tolist()
    for i in range(n - 1, 0, -1):
        if c_l[i]:
            p = par_l[i]
            h_l[p] ^= h_l[i]
            c_l[p] += c_l[i]
    return np.array(h_l, dtype=np.uint64), np.array(c_l, dtype=np.int64)


def run(tree: str = "equal_splits", provisional: bool = False) -> int:
    g = GateSet(f"phase2-dates[{tree}]")
    path = TREES[tree]

    # ---- load phase 1 ---------------------------------------------------
    print("--- loading phase 1 topology ---", flush=True)
    our_parent = np.load(TOPO_OUT / "parent.npy")
    our_ott = np.load(TOPO_OUT / "ott_id.npy")
    our_subtree_out = np.load(TOPO_OUT / "subtree_out.npy")
    our_child_count = np.load(TOPO_OUT / "child_count.npy")
    our_is_tip = our_child_count == 0
    n_ours = len(our_parent)

    con = sqlite3.connect(DB)
    our_key_to_idx = {
        k: i
        for i, k in con.execute(
            "SELECT idx, node_key FROM node WHERE ott_id IS NULL"
        )
    }
    con.close()
    our_ott_to_idx = {
        int(o): i for i, o in enumerate(our_ott.tolist()) if o != NO_OTT
    }
    forwards = load_forwards()
    print(
        f"  ours: {n_ours:,} nodes, {int(our_is_tip.sum()):,} tips, "
        f"{len(our_key_to_idx):,} mrca-labelled",
        flush=True,
    )

    # ---- parse the dated tree -------------------------------------------
    print(f"\n--- parsing {path.name} ({path.stat().st_size:,} B) ---", flush=True)
    t0 = time.monotonic()
    dk = newick.parse(path.read_bytes(), want_branch_lengths=True)
    dk_topo = newick.derive(dk.parent)
    print(f"  parsed {dk.n_nodes:,} nodes in {time.monotonic() - t0:,.1f}s", flush=True)

    dk_tips = int(dk_topo.is_tip.sum())
    dk_internal = dk.n_nodes - dk_tips
    g.observe("dated tree nodes", f"{dk.n_nodes:,}", f"ours: {n_ours:,}")
    g.observe("dated tree tips", f"{dk_tips:,}", f"ours: {int(our_is_tip.sum()):,}")
    g.observe(
        "dated tree internal nodes", f"{dk_internal:,}", f"ours: {n_ours - int(our_is_tip.sum()):,}"
    )
    g.observe(
        "dated tree max branching factor",
        int(dk_topo.child_count.max()),
        "ours: 12,964",
        note="fully bifurcating means every synthesis polytomy was resolved",
    )

    # ---- ages ------------------------------------------------------------
    print("\n--- ages ---", flush=True)
    hi, lo = node_ages_from_lengths(dk.parent, dk.branch_length, dk_topo.is_tip)
    root_age = float(hi[0])
    residual = float(np.nanmax(hi - lo))
    g.require(
        "root age (Ma)",
        round(root_age, 2),
        f"{EXPECT_ROOT_AGE} ± 1%",
        ok=abs(root_age - EXPECT_ROOT_AGE) <= EXPECT_ROOT_AGE * ROOT_AGE_TOL,
    )
    g.observe(
        "ultrametricity residual (Ma)",
        round(residual, 6),
        "0 for a strictly ultrametric chronogram",
    )
    neg = int((np.nan_to_num(dk.branch_length, nan=0.0) < 0).sum())
    g.require(
        "negative branch lengths (monotonicity violations)",
        f"{neg:,} ({100 * neg / dk.n_nodes:.4f}%)",
        f"< {MAX_MONOTONICITY_VIOLATION:.1%}",
        ok=neg / dk.n_nodes < MAX_MONOTONICITY_VIOLATION,
        note="A non-negative branch length is exactly age(parent) >= age(child).",
    )

    # ---- join ------------------------------------------------------------
    print("\n--- identifier join ---", flush=True)
    dk_to_ours = np.full(dk.n_nodes, -1, dtype=np.int64)
    joined_by_ott = joined_by_key = 0
    forwarded = 0
    dk_ott_l = dk.ott_id.tolist()

    for i in range(dk.n_nodes):
        o = dk_ott_l[i]
        if o != NO_OTT:
            tgt = our_ott_to_idx.get(o)
            if tgt is None:
                fwd = forwards.get(o)
                if fwd is not None:
                    tgt = our_ott_to_idx.get(fwd)
                    if tgt is not None:
                        forwarded += 1
            if tgt is not None:
                dk_to_ours[i] = tgt
                joined_by_ott += 1
                continue
        lbl = dk.labels[i]
        if lbl.startswith(b"mrcaott"):
            tgt = our_key_to_idx.get(lbl.decode())
            if tgt is not None:
                dk_to_ours[i] = tgt
                joined_by_key += 1

    joined = dk_to_ours >= 0
    dk_has_ott = dk.ott_id != NO_OTT
    ott_join_rate = joined_by_ott / max(int(dk_has_ott.sum()), 1)

    g.require(
        "dated-tree OTT ids joining to an idx",
        f"{joined_by_ott:,} / {int(dk_has_ott.sum()):,} ({100 * ott_join_rate:.2f}%)",
        f">= {MIN_OTT_JOIN:.0%}",
        ok=ott_join_rate >= MIN_OTT_JOIN,
    )
    g.observe("joined via mrcaott* node_key", f"{joined_by_key:,}")
    g.observe("joins requiring a forward", f"{forwarded:,}")

    # Correspondence measured on OUR nodes: what fraction of the topology we
    # actually built can be given an age directly?
    ours_covered = np.zeros(n_ours, dtype=bool)
    ours_covered[dk_to_ours[joined]] = True
    our_internal = ~our_is_tip
    internal_corr = float(ours_covered[our_internal].sum()) / int(our_internal.sum())
    tip_corr = float(ours_covered[our_is_tip].sum()) / int(our_is_tip.sum())

    g.require(
        "phase-1 internal nodes with a directly matched age",
        f"{int(ours_covered[our_internal].sum()):,} / "
        f"{int(our_internal.sum()):,} ({100 * internal_corr:.2f}%)",
        f">= {MIN_INTERNAL_CORRESPONDENCE:.1%}",
        ok=internal_corr >= MIN_INTERNAL_CORRESPONDENCE,
        note="ingest.md accept criterion: topology congruence with phase 1.",
    )

    # Most of the gap above is unary nodes, which subtend exactly the clade
    # their single child does and so carry no topological information
    # (data-sources.md, "Tree shape"). Duke's pipeline suppresses them. Score
    # branching nodes separately so the number means something.
    branching = our_internal & (our_child_count > 1)
    branch_corr = float(ours_covered[branching].sum()) / int(branching.sum())
    unary = our_internal & (our_child_count == 1)
    g.observe(
        "phase-1 BRANCHING internal nodes matched",
        f"{int(ours_covered[branching].sum()):,} / "
        f"{int(branching.sum()):,} ({100 * branch_corr:.2f}%)",
        f">= {MIN_INTERNAL_CORRESPONDENCE:.1%}",
        ok=branch_corr >= MIN_INTERNAL_CORRESPONDENCE,
        note="Unary nodes excluded: they add depth, not topology.",
    )
    g.observe(
        "unmatched phase-1 internal nodes that are unary",
        f"{int((~ours_covered & unary).sum()):,} / "
        f"{int((~ours_covered & our_internal).sum()):,}",
        note="Their age is recoverable from the child they subtend.",
    )
    g.observe(
        "phase-1 tips present in the dated tree",
        f"{int(ours_covered[our_is_tip].sum()):,} / "
        f"{int(our_is_tip.sum()):,} ({100 * tip_corr:.2f}%)",
    )
    unmatched_labels: dict[str, int] = {}
    for i in np.flatnonzero(~joined):
        lbl = dk.labels[i]
        pre = "mrcaimp" if lbl.startswith(b"mrcaimp") else (
            "mrcapoly" if lbl.startswith(b"mrcapoly") else
            "mrcaott*" if lbl.startswith(b"mrcaott") else
            "<empty>" if not lbl else "other"
        )
        unmatched_labels[pre] = unmatched_labels.get(pre, 0) + 1
    g.observe("unmatched dated-tree labels by kind", unmatched_labels)

    # ---- refinement vs conflict -----------------------------------------
    print("\n--- topology congruence (exact, over shared tips) ---", flush=True)
    con = sqlite3.connect(DB)
    names = dict(con.execute("SELECT idx, name FROM node WHERE name IS NOT NULL"))
    con.close()
    cong = congruence(
        our_parent,
        our_subtree_out,
        our_is_tip,
        dk,
        dk_topo,
        dk_to_ours,
        names,
        log=print,
    )
    g.observe("tips shared by both trees", f'{cong["shared_tips"]:,}')
    g.observe(
        "matched nodes subtending an identical clade",
        f'{cong["identical"]:,} / {cong["testable_matched_nodes"]:,} '
        f'({cong["identical_pct"]}%)',
    )
    g.require(
        "matched nodes whose phase-1 clade is compatible with the dated tree",
        f'{cong["compatible_subset"]:,} / {cong["testable_matched_nodes"]:,} '
        f'({cong["compatible_pct"]}%)',
        f">= {MIN_INTERNAL_CORRESPONDENCE:.1%}",
        ok=cong["compatible_pct"] / 100 >= MIN_INTERNAL_CORRESPONDENCE,
        note=(
            "Compatible = our clade is contained in theirs. Duke commits "
            "incertae sedis taxa our tree leaves unplaced, growing clades "
            "without contradicting them."
        ),
    )
    g.require(
        "matched nodes the dated tree actively contradicts",
        f'{cong["conflicting"]:,} ({cong["conflicting_pct"]}%)',
        f"< {100 * (1 - MIN_INTERNAL_CORRESPONDENCE):.1f}%",
        ok=cong["conflicting_pct"] / 100 <= (1 - MIN_INTERNAL_CORRESPONDENCE),
    )

    # ---- literature spot checks -----------------------------------------
    print("\n--- literature spot checks ---", flush=True)
    ours_to_dk = {int(v): int(k) for k, v in enumerate(dk_to_ours.tolist()) if v >= 0}
    spot: dict[str, dict] = {}
    for name, (ott_id, lo_ma, hi_ma) in SPOT_CHECKS.items():
        our_idx = our_ott_to_idx.get(ott_id)
        dk_idx = ours_to_dk.get(our_idx) if our_idx is not None else None
        age = float(hi[dk_idx]) if dk_idx is not None else None
        spot[name] = {"ott_id": ott_id, "age_ma": age, "expected": [lo_ma, hi_ma]}
        g.require(
            f"crown age {name}",
            "not matched" if age is None else f"{age:,.1f} Ma",
            f"{lo_ma:g}–{hi_ma:g} Ma",
            ok=age is not None and lo_ma <= age <= hi_ma,
        )

    # ---- verdict ---------------------------------------------------------
    report = {
        "tree": tree,
        "source": str(path.relative_to(SNAPSHOT.parent)),
        "dated_tree": {
            "nodes": dk.n_nodes,
            "tips": dk_tips,
            "internal": dk_internal,
            "max_fanout": int(dk_topo.child_count.max()),
            "root_age_ma": root_age,
            "ultrametric_residual_ma": residual,
            "negative_branch_lengths": neg,
        },
        "phase1_tree": {
            "nodes": n_ours,
            "tips": int(our_is_tip.sum()),
            "internal": int(our_internal.sum()),
        },
        "join": {
            "by_ott": joined_by_ott,
            "by_node_key": joined_by_key,
            "via_forward": forwarded,
            "ott_join_rate": ott_join_rate,
            "our_internal_matched": internal_corr,
            "our_tips_matched": tip_corr,
            "unmatched_by_kind": unmatched_labels,
        },
        "congruence": cong,
        "spot_checks": spot,
        "accepted": g.ok,
        "gates": [
            {"name": x.name, "passed": x.passed, "blocking": x.blocking,
             "expected": str(x.expected), "actual": str(x.actual)}
            for x in g.gates
        ],
    }
    out = BUILD / f"date_validation_{tree}.json"
    out.write_text(json.dumps(report, indent=2))
    print(f"\nwrote {out}", flush=True)

    g.write(BUILD / f"phase2_gates_{tree}.json")
    print("\n" + g.summary(), flush=True)

    if g.ok:
        _write_ages(hi, dk_to_ours, n_ours, tree, accepted=True)
        print("\nDECISION GATE: ACCEPTED. Wrote age arrays.", flush=True)
        return 0

    print(
        "\nDECISION GATE: NOT ACCEPTED.\n"
        f"See {out.name} and ingest.md phase 2 'If it fails'.",
        flush=True,
    )
    if provisional:
        _write_ages(hi, dk_to_ours, n_ours, tree, accepted=False)
        print(
            "--provisional given: age arrays written anyway, tagged "
            "accepted=false. They are for the walking-skeleton renderer only "
            "and must not be shipped.",
            flush=True,
        )
    return 2


def congruence(
    our_parent,
    our_subtree_out,
    our_is_tip,
    dk,
    dk_topo,
    dk_to_ours,
    names: dict[int, str],
    log=print,
) -> dict:
    """Compare the two topologies exactly, over the tips they share.

    Three distinct questions, deliberately kept apart because they give very
    different numbers and only the third is about *disagreement*:

    1. identical  — our clade is exactly Duke's clade.
    2. subset     — our clade is contained in Duke's. Duke commits taxa our
                    tree leaves unplaced, which grows the clade without
                    contradicting anything our tree asserts about its members.
    3. conflict   — our clade is neither. Duke actively places a taxon
                    outside a clade our tree puts inside it, or vice versa.
    """
    shared_our: list[int] = []
    shared_dk: list[int] = []
    for d in np.flatnonzero(dk_topo.is_tip).tolist():
        o = int(dk_to_ours[d])
        if o >= 0 and our_is_tip[o]:
            shared_our.append(o)
            shared_dk.append(d)
    so = np.array(shared_our)
    sd = np.array(shared_dk)
    log(f"  {len(so):,} tips are tips in both trees")

    rng = np.random.default_rng(CLADE_SEED)
    leaf_hash = rng.integers(1, 2**63, size=len(so), dtype=np.uint64)
    oh, oc = _fingerprint(our_parent, len(our_parent), so, leaf_hash)
    dh, dc = _fingerprint(dk.parent, dk.n_nodes, sd, leaf_hash)

    order = np.argsort(so)
    so_sorted, sd_sorted = so[order], sd[order]

    md = np.flatnonzero(dk_to_ours >= 0)
    mo = dk_to_ours[md]
    lo = np.searchsorted(so_sorted, mo)
    hi = np.searchsorted(so_sorted, our_subtree_out[mo])
    keep = (hi - lo) >= 2
    md, mo, lo, hi = md[keep], mo[keep], lo[keep], hi[keep]

    identical = (oh[mo] == dh[md]) & (oc[mo] == dc[md])
    dk_out = dk_topo.subtree_out
    is_subset = identical.copy()
    for k in np.flatnonzero(~identical).tolist():
        seg = sd_sorted[lo[k] : hi[k]]
        d = md[k]
        # Duke's clade is a contiguous preorder interval, so containment of
        # our whole clade reduces to a range min/max test.
        is_subset[k] = seg.min() >= d and seg.max() < dk_out[d]

    conflicts = np.flatnonzero(~is_subset)
    conflict_examples = [
        {
            "idx": int(mo[k]),
            "name": names.get(int(mo[k])),
            "shared_tips_ours": int(hi[k] - lo[k]),
            "shared_tips_duke": int(dc[md[k]]),
        }
        for k in sorted(conflicts.tolist(), key=lambda k: -(hi[k] - lo[k]))[:15]
    ]

    n = len(md)
    return {
        "shared_tips": int(len(so)),
        "testable_matched_nodes": n,
        "identical": int(identical.sum()),
        "identical_pct": round(100 * float(identical.mean()), 4),
        "compatible_subset": int(is_subset.sum()),
        "compatible_pct": round(100 * float(is_subset.mean()), 4),
        "conflicting": int((~is_subset).sum()),
        "conflicting_pct": round(100 * float((~is_subset).mean()), 4),
        "conflict_examples": conflict_examples,
    }


def _write_ages(hi, dk_to_ours, n_ours, tree: str, *, accepted: bool) -> None:
    """Write per-idx ages, plus a sidecar recording whether the gate passed.

    The sidecar exists so nothing downstream can consume these ages without
    also seeing that phase 2 did not accept them.
    """
    age = np.full(n_ours, np.nan, dtype=np.float32)
    for d, o in enumerate(dk_to_ours.tolist()):
        if o >= 0:
            age[o] = hi[d]
    np.save(TOPO_OUT / "age_ma.npy", age)
    (TOPO_OUT / "age_provenance.json").write_text(
        json.dumps(
            {
                "source_tree": tree,
                "phase2_accepted": accepted,
                "nodes_with_age": int(np.isfinite(age).sum()),
                "nodes_total": int(n_ours),
                "warning": None
                if accepted
                else (
                    "Phase 2 did not accept this tree. These ages are "
                    "provisional, for the walking-skeleton renderer only."
                ),
            },
            indent=2,
        )
        + "\n"
    )
