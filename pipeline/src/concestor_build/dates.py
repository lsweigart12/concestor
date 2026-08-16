"""Phase 2 — validate the Duke et al. 2026 dated tree. ACCEPTED.

Either the Zenodo tree joins to our phase-1 topology well enough to carry the
time axis, or the fallback congruification pipeline is needed. Every accept
criterion is measured; the fallback is not to be built.

The measurement that matters is refinement vs conflict. Duke's tree is fully
bifurcating while the synthesis tree is polytomous, so the two cannot be
node-for-node identical. The test is whether Duke's extra structure resolves
our polytomies (a refinement — ages usable) or contradicts our clades (a
conflict — not), done by comparing clade sets over shared tips via XOR subtree
fingerprints. Contradicted nodes are demoted to the `structural` tier rather
than failing the build.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

from . import newick
from .gates import GateSet
from .newick import NO_OTT
from .paths import BUILD, SNAPSHOT
from .topology import DB, load_forwards
from .topology import OUT as TOPO_OUT

if TYPE_CHECKING:
    from .typing_ import (
        BoolArray,
        F32Array,
        F64Array,
        I64Array,
        Json,
        JsonDict,
        Log,
        U8Array,
        U32Array,
        U64Array,
    )

TREES = {
    "equal_splits": SNAPSHOT / "duke2026" / "equal_splits_median_tree.tre",
    "birth_model": SNAPSHOT / "duke2026" / "birth_model_median_tree.tre",
}

# The tree the artifact set is built from. The other is a comparison layer and
# must NEVER write the shared artifacts (age_ma, the tier array, the canonical
# gate file); both trees pass identically, so the swap would be invisible.
PRIMARY_TREE = "equal_splits"

EXPECT_ROOT_AGE = 4247.0
ROOT_AGE_TOL = 0.01

# Accept criteria.
MIN_CLADE_COMPATIBILITY = 0.995
MIN_BRANCHING_CORRESPONDENCE = 0.98  # unary nodes excluded
MIN_OTT_JOIN = 0.99
MAX_MONOTONICITY_VIOLATION = 0.001

# Age provenance tier, stored per node. `structural` never carries a numeric age.
TIER_MEASURED = 0
TIER_INTERPOLATED = 1
TIER_STRUCTURAL = 2
# Written by phase 4, not here (the `fossil` table does not exist yet). It shares
# the array. Not a fourth grade of divergence estimate: it answers "when is this
# taxon observed in the rock", which is why it never enters `age_ma`.
TIER_OCCURRENCE = 3
# A literature estimate on a curated graft node, written here from
# `topology.GRAFT_AGES_MA`. A real published number for a split the chronogram
# cannot see — the two hominin splits, Prüfer et al. 2017 — so it may carry an
# age; the provenance is the tier itself, and the card says whose number it is.
TIER_CURATED = 4
TIER_NAMES = {
    TIER_MEASURED: "measured",
    TIER_INTERPOLATED: "interpolated",
    TIER_STRUCTURAL: "structural",
    TIER_OCCURRENCE: "occurrence",
    TIER_CURATED: "curated",
}
# The tiers that may carry a number in `age_ma`.
TIERS_WITH_AN_AGE = frozenset({TIER_MEASURED, TIER_INTERPOLATED, TIER_CURATED})

# Duke's chronogram is ultrametric to 2.7e-5 Ma, so "at the present" needs a
# tolerance rather than an equality test.
PRESENT_EPS_MA = 1e-3

# Published crown-age ranges; generous, to catch an off-by-a-factor or inverted
# axis rather than adjudicate between studies.
SPOT_CHECKS = {
    "Mammalia": (244265, 150.0, 220.0),
    "Aves": (81461, 60.0, 140.0),
    "Metazoa": (691846, 600.0, 950.0),
    "Eukaryota": (304358, 1000.0, 2500.0),
}

CLADE_SEED = 20260731


def node_ages_from_lengths(
    parent: U32Array, blen: F64Array, is_tip: BoolArray
) -> tuple[F64Array, F64Array]:
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
        hi_l[p] = max(hi_l[p], c)
        c = lo_l[i] + bl_l[i]
        lo_l[p] = min(lo_l[p], c)

    return np.array(hi_l), np.array(lo_l)


def _fingerprint(
    parent: U32Array, n: int, leaf_idx: I64Array, leaf_hash: U64Array
) -> tuple[U64Array, I64Array]:
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


def run(tree: str = PRIMARY_TREE, provisional: bool = False) -> int:
    g = GateSet(f"phase2-dates[{tree}]")
    path = TREES[tree]
    is_primary = tree == PRIMARY_TREE
    if not is_primary:
        print(
            f"--- {tree} is the COMPARISON tree — it will not write age "
            f"arrays or the canonical gate file (primary: {PRIMARY_TREE}) ---",
            flush=True,
        )

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
        for i, k in con.execute("SELECT idx, node_key FROM node WHERE ott_id IS NULL")
    }
    con.close()
    our_ott_to_idx = {int(o): i for i, o in enumerate(our_ott.tolist()) if o != NO_OTT}
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
    if dk.branch_length is None:
        raise RuntimeError(
            f"{path.name} parsed without branch lengths; there are no ages to validate"
        )
    blen: F64Array = dk.branch_length
    dk_topo = newick.derive(dk.parent)
    print(f"  parsed {dk.n_nodes:,} nodes in {time.monotonic() - t0:,.1f}s", flush=True)

    dk_tips = int(dk_topo.is_tip.sum())
    dk_internal = dk.n_nodes - dk_tips
    g.observe("dated tree nodes", f"{dk.n_nodes:,}", f"ours: {n_ours:,}")
    g.observe("dated tree tips", f"{dk_tips:,}", f"ours: {int(our_is_tip.sum()):,}")
    g.observe(
        "dated tree internal nodes",
        f"{dk_internal:,}",
        f"ours: {n_ours - int(our_is_tip.sum()):,}",
    )
    g.observe(
        "dated tree max branching factor",
        int(dk_topo.child_count.max()),
        "ours: 12,964",
        note="fully bifurcating means every synthesis polytomy was resolved",
    )

    # ---- ages ------------------------------------------------------------
    print("\n--- ages ---", flush=True)
    hi, lo = node_ages_from_lengths(dk.parent, blen, dk_topo.is_tip)
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
    neg = int((np.nan_to_num(blen, nan=0.0) < 0).sum())
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

    # Correspondence measured on our nodes: what fraction can be given an age.
    ours_covered = np.zeros(n_ours, dtype=bool)
    ours_covered[dk_to_ours[joined]] = True
    our_internal = ~our_is_tip
    internal_corr = float(ours_covered[our_internal].sum()) / int(our_internal.sum())
    tip_corr = float(ours_covered[our_is_tip].sum()) / int(our_is_tip.sum())

    g.observe(
        "phase-1 internal nodes with a directly matched age",
        f"{int(ours_covered[our_internal].sum()):,} / "
        f"{int(our_internal.sum()):,} ({100 * internal_corr:.2f}%)",
        note=(
            "Not an accept criterion. 95.2% of the shortfall is unary nodes, "
            "which Duke's pipeline suppresses; see the gate below."
        ),
    )

    # Unary nodes carry no topological information and Duke's pipeline
    # suppresses them, so score branching nodes separately (the accept criterion).
    branching = our_internal & (our_child_count > 1)
    branch_corr = float(ours_covered[branching].sum()) / int(branching.sum())
    unary = our_internal & (our_child_count == 1)
    g.require(
        "phase-1 BRANCHING internal nodes matched",
        f"{int(ours_covered[branching].sum()):,} / "
        f"{int(branching.sum()):,} ({100 * branch_corr:.2f}%)",
        f">= {MIN_BRANCHING_CORRESPONDENCE:.1%}",
        ok=branch_corr >= MIN_BRANCHING_CORRESPONDENCE,
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
        pre = (
            "mrcaimp"
            if lbl.startswith(b"mrcaimp")
            else (
                "mrcapoly"
                if lbl.startswith(b"mrcapoly")
                else "mrcaott*"
                if lbl.startswith(b"mrcaott")
                else "<empty>"
                if not lbl
                else "other"
            )
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
    c = cong.report
    g.observe("tips shared by both trees", f"{c['shared_tips']:,}")
    g.observe(
        "matched nodes subtending an identical clade",
        f"{c['identical']:,} / {c['testable_matched_nodes']:,} ({c['identical_pct']}%)",
        note="These become the `measured` tier.",
    )
    g.require(
        "matched nodes whose phase-1 clade is compatible with the dated tree",
        f"{c['compatible_subset']:,} / {c['testable_matched_nodes']:,} "
        f"({c['compatible_pct']}%)",
        f">= {MIN_CLADE_COMPATIBILITY:.1%}",
        ok=c["compatible_pct"] / 100 >= MIN_CLADE_COMPATIBILITY,
        note=(
            "Compatible = our clade is contained in theirs. Duke commits "
            "incertae sedis taxa our tree leaves unplaced, growing clades "
            "without contradicting them. Where ours is a strict subset their "
            "age is an upper bound on ours, so it renders as '<= N Ma'."
        ),
    )
    g.observe(
        "matched nodes the dated tree actively contradicts",
        f"{c['conflicting']:,} ({c['conflicting_pct']}%)",
        note=(
            "Not a failure but a demotion: every one of these loses its "
            "numeric age and renders as a dashed structural spine. Gated "
            "below, on the written arrays rather than on this count."
        ),
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

    # ---- age tiers, and content gates on what we are about to write ------
    # These gates run against the arrays themselves, so "structural nodes carry
    # no number" is verified on the artifact, not inferred from the code.
    print("\n--- age tiers ---", flush=True)
    age_arr, tier_arr = assign_tiers(hi, dk_to_ours, n_ours, cong)
    n_curated = apply_curated_ages(age_arr, tier_arr, our_key_to_idx, log=print)
    g.require(
        "curated graft splits carry their literature dates",
        n_curated,
        2,
        note="topology.GRAFT_AGES_MA; a silent miss draws the hominin splits undated",
    )
    layout_arr, join_violations = layout_ages(our_parent, age_arr, root_age)
    tier_counts = {
        name: int((tier_arr == t).sum()) for t, name in sorted(TIER_NAMES.items())
    }
    g.observe(
        "age tier distribution",
        ", ".join(
            f"{k} {v:,} ({100 * v / n_ours:.1f}%)" for k, v in tier_counts.items()
        ),
    )
    structural = tier_arr == TIER_STRUCTURAL
    g.require(
        "structural-tier nodes carrying a numeric age",
        int(np.isfinite(age_arr[structural]).sum()),
        0,
        note=(
            "The hard requirement of architecture §3.5. A confident figure "
            "where nobody has estimated one is the failure mode this whole "
            "design is organised around."
        ),
    )
    g.require(
        "contradicted nodes demoted to structural",
        int(structural[cong.conflict_our].sum()),
        len(cong.conflict_our),
        note="The phase-2 accept's second condition, checked on the array.",
    )
    g.require(
        "non-structural nodes missing a numeric age",
        int((~np.isfinite(age_arr[~structural])).sum()),
        0,
        note="A measured or interpolated tier with no number is a tiering bug.",
    )
    g.require(
        "layout positions that are not finite",
        int((~np.isfinite(layout_arr)).sum()),
        0,
        note="Every node must be drawable, including the undated ones.",
    )
    g.require(
        "layout positions younger than their parent's",
        int((layout_arr[1:] > layout_arr[our_parent[1:].astype(np.int64)]).sum()),
        0,
        note="The x-axis must not run backwards along a lineage.",
    )
    g.observe(
        "dated nodes clamped for monotonicity during the join",
        f"{join_violations:,}",
        note=(
            "Duke's tree has zero negative branch lengths; any violation here "
            "is introduced by our join, not by them."
        ),
    )
    for probe, ott_id in (("Homo sapiens", 770315), ("Tyrannosaurus rex", 664349)):
        pi = our_ott_to_idx.get(ott_id)
        if pi is not None:
            t = TIER_NAMES[int(tier_arr[pi])]
            a = float(age_arr[pi])
            shown = "none" if not np.isfinite(a) else f"{a:,.1f} Ma"
            g.observe(
                f"probe: {probe}",
                f"tier={t}, age={shown}, x={float(layout_arr[pi]):,.2f} Ma",
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
        "congruence": cong.report,
        "age_tiers": tier_counts,
        "spot_checks": spot,
        "accepted": g.ok,
        "gates": [
            {
                "name": x.name,
                "passed": x.passed,
                "blocking": x.blocking,
                "expected": str(x.expected),
                "actual": str(x.actual),
            }
            for x in g.gates
        ],
    }
    out = BUILD / f"date_validation_{tree}.json"
    out.write_text(json.dumps(report, indent=2))
    print(f"\nwrote {out}", flush=True)

    g.write(BUILD / f"phase2_gates_{tree}.json")

    # Also write the canonical unsuffixed names, but only for the primary tree,
    # so downstream globs of `phase*_gates.json` never read a stale verdict.
    if is_primary:
        g.write(BUILD / "phase2_gates.json")
        (BUILD / "date_validation.json").write_text(json.dumps(report, indent=2))
    print("\n" + g.summary(), flush=True)

    if g.ok:
        if not is_primary:
            print(
                f"\nDECISION GATE: ACCEPTED ({tree}, comparison only).\n"
                f"Age arrays NOT written — {PRIMARY_TREE} owns them. "
                f"Gates and validation are in {out.name}.",
                flush=True,
            )
            return 0
        prov = _write_ages(
            age_arr,
            tier_arr,
            layout_arr,
            our_child_count,
            tree,
            cong,
            join_violations,
            accepted=True,
        )
        print(
            f"\nDECISION GATE: ACCEPTED. Wrote age arrays — "
            f"{prov['tiers']['measured']:,} measured, "
            f"{prov['tiers']['interpolated']:,} interpolated, "
            f"{prov['tiers']['structural']:,} structural.",
            flush=True,
        )
        return 0

    print(
        "\nDECISION GATE: NOT ACCEPTED.\n"
        f"See {out.name} and ingest.md phase 2 'If it fails'.",
        flush=True,
    )
    if provisional and is_primary:
        _write_ages(
            age_arr,
            tier_arr,
            layout_arr,
            our_child_count,
            tree,
            cong,
            join_violations,
            accepted=False,
        )
        print(
            "--provisional given: age arrays written anyway, tagged "
            "accepted=false. They are for the walking-skeleton renderer only "
            "and must not be shipped.",
            flush=True,
        )
    elif provisional:
        print(
            f"--provisional ignored: {tree} is the comparison tree and never "
            "writes the shared age arrays.",
            flush=True,
        )
    return 2


@dataclass(slots=True)
class Congruence:
    """The clade comparison, as both a report and the tiering input.

    Index arrays are over our `idx` values (what the age tiers are keyed on),
    so demoting conflicts to structural is mechanical.
    """

    report: dict[str, Json]
    shared_tip_our: I64Array  # tip in both trees
    identical_our: I64Array  # our clade == Duke's clade over shared tips
    subset_our: I64Array  # our clade ⊂ Duke's clade (Duke's age bounds ours above)
    conflict_our: I64Array  # neither — Duke contradicts a clade we assert


def congruence(
    our_parent: U32Array,
    our_subtree_out: U32Array,
    our_is_tip: BoolArray,
    dk: newick.ParsedTree,
    dk_topo: newick.Topology,
    dk_to_ours: I64Array,
    names: dict[int, str],
    log: Log = print,
) -> Congruence:
    """Compare the two topologies exactly, over the tips they share.

    Three questions, kept apart because only the third is disagreement:

    1. identical  — our clade is exactly Duke's clade.
    2. subset     — our clade is contained in Duke's (Duke commits taxa we
                    leave unplaced), so Duke's age is an upper bound on ours,
                    which the `interpolated` tier renders as "≤ N Ma".
    3. conflict   — neither; Duke actively contradicts a clade we assert.
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
    report: dict[str, Json] = {
        "shared_tips": len(so),
        "testable_matched_nodes": n,
        "identical": int(identical.sum()),
        "identical_pct": round(100 * float(identical.mean()), 4),
        "compatible_subset": int(is_subset.sum()),
        "compatible_pct": round(100 * float(is_subset.mean()), 4),
        "conflicting": int((~is_subset).sum()),
        "conflicting_pct": round(100 * float((~is_subset).mean()), 4),
        "conflict_examples": conflict_examples,
    }
    return Congruence(
        report=report,
        shared_tip_our=so.astype(np.int64),
        identical_our=mo[identical].astype(np.int64),
        subset_our=mo[is_subset & ~identical].astype(np.int64),
        conflict_our=mo[~is_subset].astype(np.int64),
    )


def assign_tiers(
    duke_age: F64Array,
    dk_to_ours: I64Array,
    n_ours: int,
    cong: Congruence,
) -> tuple[F32Array, U8Array]:
    """Per-node age and provenance tier.

    - `measured`      our clade is exactly Duke's clade, or a shared tip (the
                      present is not an estimate).
    - `interpolated`  matched but clade unconfirmed, or our clade is a strict
                      subset of Duke's (their age is an upper bound on ours).
    - `structural`    no match, or Duke contradicts our clade. No numeric age.

    Contradicted nodes land in the third tier by construction, not by hand.
    """
    age = np.full(n_ours, np.nan, dtype=np.float64)
    tier = np.full(n_ours, TIER_STRUCTURAL, dtype=np.uint8)

    matched = dk_to_ours >= 0
    ours_of = dk_to_ours[matched]
    age[ours_of] = duke_age[matched]
    tier[ours_of] = TIER_INTERPOLATED

    # A shared tip's age is the present, not an inference.
    tier[cong.shared_tip_our] = TIER_MEASURED

    # Any node the chronogram places at the present is measured, not dashed:
    # a node at time zero has no divergence time to be uncertain about. Catches
    # taxa we resolve one level finer than Duke (e.g. Homo sapiens, internal
    # for us because OTT carries its subspecies, so never a shared tip).
    tier[np.isfinite(age) & (age <= PRESENT_EPS_MA)] = TIER_MEASURED

    tier[cong.identical_our] = TIER_MEASURED
    tier[cong.subset_our] = TIER_INTERPOLATED

    # Applied last so it overrides: a contradicted clade gets no number.
    tier[cong.conflict_our] = TIER_STRUCTURAL
    age[cong.conflict_our] = np.nan

    # Nothing downstream may find a number on a structural node.
    age[tier == TIER_STRUCTURAL] = np.nan
    return age.astype(np.float32), tier


def apply_curated_ages(
    age: F32Array, tier: U8Array, node_keys: dict[str, int], log: Log = print
) -> int:
    """Write the curated graft splits — the only hand-supplied ages.

    Keyed by the graft nodes' `node_key`, which is the only identity they
    have (they carry no OTT id and the chronogram cannot know them). A key
    that fails to resolve fails the phase: a graft that silently lost its
    date would draw the marquee splits of the whole tree as undated.
    """
    from .topology import GRAFT_AGES_MA

    n = 0
    for key, ma in GRAFT_AGES_MA.items():
        idx = node_keys.get(key)
        if idx is None:
            raise ValueError(f"curated age for {key!r}, but no node carries that key")
        age[idx] = ma
        tier[idx] = TIER_CURATED
        log(f"  curated: {key} = {ma} Ma")
        n += 1
    return n


def layout_ages(
    parent: U32Array, age: F32Array, root_age: float, log: Log = print
) -> tuple[F32Array, int]:
    """Finite, monotone x-positions for every node, including undated ones.

    Undated (structural) nodes are positioned ordinally between their nearest
    dated ancestor and descendant. Two linear sweeps relying on `parent[i] < i`:
    forward for the nearest dated ancestor, reverse for the deepest dated
    descendant, then spread the undated run evenly by hop count.

    Also returns the count of dated nodes whose age exceeded their parent's — a
    monotonicity violation introduced by the join, not present in Duke's tree.
    """
    n = len(parent)
    par = parent.astype(np.int64)
    par[0] = -1
    par_l = par.tolist()

    a_l = age.astype(np.float64).tolist()
    known = np.isfinite(age).tolist()
    if not known[0]:
        a_l[0] = root_age
        known[0] = True

    # Dated nodes must not sit younger than their dated ancestors; count the
    # join-introduced violations rather than silently clamping them away.
    violations = 0
    for i in range(1, n):
        p = par_l[i]
        if known[i] and known[p] and a_l[i] > a_l[p]:
            violations += 1
            a_l[i] = a_l[p]

    inf = float("inf")
    # hi: age of the nearest dated ancestor. up: hops to it.
    hi_l = [inf] * n
    up_l = [0] * n
    hi_l[0] = a_l[0]
    for i in range(1, n):
        p = par_l[i]
        if known[p]:
            hi_l[i] = a_l[p]
            up_l[i] = 1
        else:
            hi_l[i] = hi_l[p]
            up_l[i] = up_l[p] + 1

    # lo: oldest dated descendant, which is the tightest lower bound. down:
    # hops to the nearest dated descendant, which is what sets the spacing.
    big = n + 1
    lo_l = [-inf] * n
    down_l = [big] * n
    for i in range(n - 1, 0, -1):
        p = par_l[i]
        cand_age = a_l[i] if known[i] else lo_l[i]
        if cand_age > lo_l[p]:
            lo_l[p] = cand_age
        cand_down = 1 if known[i] else down_l[i] + 1
        if cand_down < down_l[p]:
            down_l[p] = cand_down

    out_l = [0.0] * n
    for i in range(n):
        if known[i]:
            out_l[i] = a_l[i]
            continue
        top = hi_l[i] if hi_l[i] != inf else root_age
        bot = lo_l[i] if lo_l[i] != -inf else 0.0
        if bot > top:
            bot = top
        span = top - bot
        if span <= 0.0:
            # Bounds coincide: no room to spread, so collapse onto the bound.
            out_l[i] = top
            continue
        below = down_l[i] if down_l[i] != big else 1
        out_l[i] = top - span * (up_l[i] / (up_l[i] + below))

    # Final clamp: layout positions must be monotone even where the ordinal
    # fill and the dated ages disagree at a boundary.
    for i in range(1, n):
        p = par_l[i]
        if out_l[i] > out_l[p]:
            out_l[i] = out_l[p]

    log(f"  layout positions filled for {n - sum(known):,} undated nodes")
    return np.array(out_l, dtype=np.float32), violations


def _write_ages(
    age: F32Array,
    tier: U8Array,
    layout: F32Array,
    child_count: U32Array,
    tree: str,
    cong: Congruence,
    violations: int,
    *,
    accepted: bool,
) -> JsonDict:
    """Write the age arrays, the tier array, and the provenance sidecar.

    Three arrays, not one: `age_ma` is what may be shown (NaN where nothing may
    be), `age_tier` is how, `age_layout` is where to draw it. Merging them is
    how a structural node ends up rendering a confident number.
    """
    n_ours = len(age)
    np.save(TOPO_OUT / "age_ma.npy", age)
    np.save(TOPO_OUT / "age_tier.npy", tier)
    np.save(TOPO_OUT / "age_layout.npy", layout)

    # Phase 4 keeps its own copies of what this phase wrote (so a re-run clamps
    # the original rather than compounding). Delete the now-stale copies so
    # phase 4 takes a fresh baseline. Only the primary tree reaches here.
    for stale in ("age_layout_phase2.npy", "age_tier_phase2.npy"):
        (TOPO_OUT / stale).unlink(missing_ok=True)

    counts = {name: int((tier == t).sum()) for t, name in sorted(TIER_NAMES.items())}

    # Split by tip vs internal: the tier totals are dominated by extant tips at
    # the present. The figure describing the chronogram is the internal one.
    is_tip = child_count == 0
    internal_total = int((~is_tip).sum())
    measured_internal = int(((tier == TIER_MEASURED) & ~is_tip).sum())
    prov: JsonDict = {
        "source_tree": tree,
        "phase2_accepted": accepted,
        "nodes_total": int(n_ours),
        "nodes_with_age": int(np.isfinite(age).sum()),
        "tiers": counts,
        "tiers_internal_only": {
            name: int(((tier == t) & ~is_tip).sum())
            for t, name in sorted(TIER_NAMES.items())
        },
        "internal_nodes_total": internal_total,
        "headline": (
            f"{measured_internal:,} of {internal_total:,} internal nodes "
            f"({100 * measured_internal / internal_total:.1f}%) carry a "
            "clade-verified divergence age. The tier totals are dominated by "
            "extant tips at the present, which is true and is not a statement "
            "about the chronogram."
        ),
        "conflicting_nodes_demoted": len(cong.conflict_our),
        "monotonicity_violations_after_join": violations,
        "arrays": {
            "age_ma.npy": (
                "float32; NaN wherever no numeric age may be displayed. "
                "structural-tier nodes are always NaN."
            ),
            "age_tier.npy": (
                "uint8; 0=measured, 1=interpolated (age is an UPPER BOUND — "
                "render as '≤ N Ma'), 2=structural (no number, dashed)."
            ),
            "age_layout.npy": (
                "float32; finite everywhere and monotone non-increasing "
                "root-to-tip. x-position only — never display it as an age."
            ),
        },
        "warning": None
        if accepted
        else (
            "Phase 2 did not accept this tree. These ages are provisional, "
            "for the walking-skeleton renderer only."
        ),
    }
    (TOPO_OUT / "age_provenance.json").write_text(json.dumps(prov, indent=2) + "\n")
    return prov
