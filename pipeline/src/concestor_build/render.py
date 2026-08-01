"""A deliberately ugly renderer. Not the real UI.

It exists to prove the premise end to end: pick some species, walk their
ancestor paths through the baked arrays, suppress degree-2 nodes, and draw the
induced subtree against a time axis. If this produces a recognisable tree with
plausible dates, the architecture's load-bearing claim — that everything is
ancestor paths (architecture §2) — holds.

Everything here is throwaway: inline SVG, no build step, no interaction, no
attempt at the typography or provenance rendering the real UI needs. The one
thing it does take seriously is not lying about ages, because that is the
failure mode the whole design is organised around.
"""

from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path

import numpy as np

from .newick import NO_OTT, NO_PARENT
from .paths import BUILD
from .topology import OUT as TOPO_OUT, DB

OUT_SVG = BUILD / "skeleton.svg"

# A deliberately awkward set: two primates, a rodent, a bird, one of the 1,129
# extinct taxa that do survive into the synthesis tree, a fish, a mollusc, an
# insect, two plants and a fungus. If the layout holds across 1.5 Ga of
# divergence it will hold for anything the UI throws at it.
DEFAULT_SELECTION = [
    ("Homo sapiens", 770315),
    ("Pan troglodytes", 417950),
    ("Mus musculus", 542509),
    ("Gallus gallus", 153563),
    ("Tyrannosaurus rex", 664349),
    ("Danio rerio", 1005914),
    ("Octopus vulgaris", 110468),
    ("Drosophila melanogaster", 505714),
    ("Arabidopsis thaliana", 309263),
    ("Sequoiadendron giganteum", 810380),
    ("Amanita muscaria", 75257),
]

W, H = 1500, 40
MARGIN_L, MARGIN_R, MARGIN_T, MARGIN_B = 260, 300, 96, 96
SYMLOG_T0 = 1.0  # Ma; below this the axis is linear, above it logarithmic


def path_to_root(parent: np.ndarray, idx: int) -> list[int]:
    """The load-bearing primitive. Root-first ancestor chain."""
    out = [idx]
    cur = idx
    sentinel = int(NO_PARENT)
    while True:
        p = int(parent[cur])
        if p == sentinel:
            break
        out.append(p)
        cur = p
    out.reverse()
    return out


def induced_subtree(parent: np.ndarray, selection: list[int]):
    """Marked set, rendered set and segments, per architecture §2."""
    paths = {leaf: path_to_root(parent, leaf) for leaf in selection}

    # The MRCA is the last common element of the paths — interaction 1 falls
    # out of the same primitive, with no separate endpoint (architecture §2).
    first = paths[selection[0]]
    mrca_depth = min(len(p) for p in paths.values())
    while mrca_depth > 0:
        cand = first[mrca_depth - 1]
        if all(len(p) >= mrca_depth and p[mrca_depth - 1] == cand for p in paths.values()):
            break
        mrca_depth -= 1
    mrca = first[mrca_depth - 1]

    # Everything above the MRCA is outside the induced subtree; including it
    # would break the 2|L|-1 bound with a chain of unary ancestors.
    paths = {leaf: p[mrca_depth - 1 :] for leaf, p in paths.items()}

    marked: set[int] = set()
    for p in paths.values():
        marked.update(p)

    children_in_marked: dict[int, set[int]] = {}
    for p in paths.values():
        for a, b in zip(p, p[1:]):
            children_in_marked.setdefault(a, set()).add(b)

    chosen = set(selection)
    rendered = {
        v
        for v in marked
        if v in chosen or len(children_in_marked.get(v, ())) >= 2
    }
    rendered.add(mrca)

    # Each rendered node's nearest rendered ancestor, plus the suppressed nodes
    # between them. Those intermediates are interaction 3's content — already
    # computed, already ordered, and dropped by the suppression rule.
    segments: dict[int, tuple[int | None, list[int]]] = {}
    for v in rendered:
        chain: list[int] = []
        for p in paths.values():
            if v in p:
                chain = p[: p.index(v)]
                break
        suppressed: list[int] = []
        anc = None
        for u in reversed(chain):
            if u in rendered:
                anc = u
                break
            suppressed.append(u)
        segments[v] = (anc, list(reversed(suppressed)))
    return rendered, segments


def symlog(age: float, max_age: float) -> float:
    """Fraction of the axis for an age, linear under t0 and log above.

    log(0) is undefined at the present, which is where a naive implementation
    emits -Infinity and the layout silently collapses.
    """
    if age <= SYMLOG_T0:
        lin = age / SYMLOG_T0
        return lin * _LIN_SHARE
    span = math.log10(max_age / SYMLOG_T0)
    return _LIN_SHARE + (1 - _LIN_SHARE) * math.log10(age / SYMLOG_T0) / span


_LIN_SHARE = 0.06


def run() -> int:
    parent = np.load(TOPO_OUT / "parent.npy")
    ott = np.load(TOPO_OUT / "ott_id.npy")
    tip_count = np.load(TOPO_OUT / "tip_count.npy")

    age_path = TOPO_OUT / "age_ma.npy"
    if not age_path.exists():
        print(
            "No age array. Run:  concestor-build dates --provisional\n"
            "(phase 2 has not accepted a dated tree; see build/"
            "date_validation_equal_splits.json)"
        )
        return 1
    age = np.load(age_path)
    prov = json.loads((TOPO_OUT / "age_provenance.json").read_text())

    ott_to_idx = {int(o): i for i, o in enumerate(ott.tolist()) if o != NO_OTT}
    con = sqlite3.connect(DB)
    names = {}

    selection = []
    labels = {}
    for label, ott_id in DEFAULT_SELECTION:
        idx = ott_to_idx.get(ott_id)
        if idx is None:
            print(f"  ! {label} (ott{ott_id}) not in the tree; skipping")
            continue
        selection.append(idx)
        labels[idx] = label
    selection.sort()  # preorder order == canonical vertical order (§3.1)

    rendered, segments = induced_subtree(parent, selection)
    for idx in rendered:
        row = con.execute(
            "SELECT name, rank FROM node WHERE idx=?", (int(idx),)
        ).fetchone()
        names[idx] = row if row else (None, None)
    con.close()

    print(f"selection: {len(selection)} tips")
    print(f"marked -> rendered: {len(rendered)} nodes "
          f"(2n-1 bound = {2 * len(selection) - 1})")

    svg = _draw(parent, age, tip_count, rendered, segments, selection, labels, names, prov)
    OUT_SVG.parent.mkdir(parents=True, exist_ok=True)
    OUT_SVG.write_text(svg)
    print(f"wrote {OUT_SVG}")
    return 0


def _draw(parent, age, tip_count, rendered, segments, selection, labels, names, prov):
    # y: one slot per selected tip, internal nodes at the midpoint of their
    # children's extent.
    row_h = 46
    y_of: dict[int, float] = {}
    for i, leaf in enumerate(selection):
        y_of[leaf] = MARGIN_T + i * row_h

    kids: dict[int, list[int]] = {}
    for v, (anc, _) in segments.items():
        if anc is not None:
            kids.setdefault(anc, []).append(v)

    def resolve_y(v: int) -> float:
        if v in y_of:
            return y_of[v]
        ys = [resolve_y(c) for c in kids.get(v, [])]
        y_of[v] = sum(ys) / len(ys) if ys else MARGIN_T
        return y_of[v]

    root = next(v for v, (a, _) in segments.items() if a is None)
    resolve_y(root)

    ages = {v: float(age[v]) for v in rendered}
    known = [a for a in ages.values() if math.isfinite(a)]
    max_age = max(known) if known else 4247.0
    plot_w = W - MARGIN_L - MARGIN_R
    height = MARGIN_T + len(selection) * row_h + MARGIN_B

    def x_of(v: int) -> float:
        a = ages.get(v, float("nan"))
        if not math.isfinite(a):
            return float("nan")
        return MARGIN_L + plot_w * (1 - symlog(a, max_age))

    # Nodes with no matched age get an ordinal position between their nearest
    # dated ancestor and descendant, and are drawn dashed — never with a
    # number attached. This is architecture §3.5's `structural` tier, and it
    # is the whole reason the renderer is worth building.
    ordinal: dict[int, float] = {}
    for v in rendered:
        if math.isfinite(x_of(v)):
            continue
        anc = segments[v][0]
        xa = x_of(anc) if anc is not None else float(MARGIN_L)
        if not math.isfinite(xa):
            xa = float(MARGIN_L)
        xk = [x for x in (x_of(c) for c in kids.get(v, [])) if math.isfinite(x)]
        ordinal[v] = (xa + min(xk)) / 2 if xk else xa + 24

    def px(v: int) -> float:
        x = x_of(v)
        return x if math.isfinite(x) else ordinal.get(v, float(MARGIN_L))

    p: list[str] = []
    add = p.append
    add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{height}" '
        f'viewBox="0 0 {W} {height}" font-family="Georgia,serif">')
    add(f'<rect width="{W}" height="{height}" fill="#fbfaf7"/>')

    banner = (
        "PROVISIONAL — phase 2 did NOT accept this dated tree"
        if not prov.get("phase2_accepted")
        else "phase 2 accepted"
    )
    add(f'<text x="{MARGIN_L}" y="28" font-size="15" fill="#a3320b" '
        f'font-weight="bold">{banner}</text>')
    add(f'<text x="{MARGIN_L}" y="50" font-size="12" fill="#555">'
        f'ugly walking skeleton · source: {prov.get("source_tree")} · '
        f'{prov.get("nodes_with_age"):,} of {prov.get("nodes_total"):,} nodes carry a '
        f'matched age</text>')

    # --- time axis (symlog) ---
    ticks = [0, 1, 10, 66, 100, 252, 541, 1000, 2500, 4000]
    axis_y = height - MARGIN_B + 34
    add(f'<line x1="{MARGIN_L}" y1="{axis_y}" x2="{MARGIN_L + plot_w}" '
        f'y2="{axis_y}" stroke="#333"/>')
    for t in ticks:
        if t > max_age:
            continue
        x = MARGIN_L + plot_w * (1 - symlog(float(t), max_age))
        add(f'<line x1="{x}" y1="{MARGIN_T - 24}" x2="{x}" y2="{axis_y}" '
            f'stroke="#ddd"/>')
        add(f'<line x1="{x}" y1="{axis_y}" x2="{x}" y2="{axis_y + 6}" stroke="#333"/>')
        add(f'<text x="{x}" y="{axis_y + 22}" font-size="12" fill="#333" '
            f'text-anchor="middle">{t}</text>')
    # The axis changes character at t0; a scale that bends without saying so
    # misleads.
    xb = MARGIN_L + plot_w * (1 - _LIN_SHARE)
    add(f'<line x1="{xb}" y1="{MARGIN_T - 30}" x2="{xb}" y2="{axis_y + 6}" '
        f'stroke="#a3320b" stroke-width="1.5" stroke-dasharray="2 3"/>')
    add(f'<text x="{xb - 6}" y="{MARGIN_T - 36}" font-size="11" fill="#a3320b" '
        f'text-anchor="end">symlog knee ({SYMLOG_T0:g} Ma)</text>')
    add(f'<text x="{MARGIN_L + plot_w / 2}" y="{axis_y + 44}" font-size="13" '
        f'fill="#333" text-anchor="middle">millions of years before present '
        f'(symlog)</text>')

    # --- edges ---
    for v, (anc, suppressed) in segments.items():
        if anc is None:
            continue
        x1, y1 = px(anc), y_of[anc]
        x2, y2 = px(v), y_of[v]
        dashed = not math.isfinite(x_of(v)) or not math.isfinite(x_of(anc))
        style = ' stroke-dasharray="5 4"' if dashed else ""
        add(f'<path d="M {x1} {y1} L {x1} {y2} L {x2} {y2}" fill="none" '
            f'stroke="#555" stroke-width="1.6"{style}/>')
        # Below the edge, because node labels sit above it.
        n_sup = len(suppressed)
        if n_sup and abs(x2 - x1) > 70:
            add(f'<text x="{x1 + (x2 - x1) * 0.35}" y="{y2 + 13}" font-size="10" '
                f'fill="#8a2b6b" text-anchor="middle">{n_sup} suppressed</text>')

    # --- nodes ---
    for v in sorted(rendered):
        x, y = px(v), y_of[v]
        is_leaf = v in labels
        dated = math.isfinite(x_of(v))
        if is_leaf:
            add(f'<circle cx="{x}" cy="{y}" r="4.5" fill="#1b3a5c"/>')
            add(f'<text x="{x + 10}" y="{y + 4}" font-size="14" '
                f'font-style="italic" fill="#111">{labels[v]}</text>')
        else:
            nm, rank = names.get(v, (None, None))
            fill = "#1b3a5c" if dated else "#fff"
            add(f'<circle cx="{x}" cy="{y}" r="3.6" fill="{fill}" '
                f'stroke="#1b3a5c" stroke-width="1.4"/>')
            lab = nm or "(unnamed divergence)"
            a = ages.get(v, float("nan"))
            # A structural-tier node never shows a numeric age.
            suffix = f" · {a:,.0f} Ma" if dated and math.isfinite(a) else " · undated"
            anchor = "end"
            add(f'<text x="{x - 8}" y="{y - 7}" font-size="12" '
                f'text-anchor="{anchor}" fill="#333">{_esc(lab)}'
                f'<tspan fill="#888">{suffix}</tspan></text>')

    add("</svg>")
    return "\n".join(p)



def _esc(s: str) -> str:
    return (
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )
