"""A Newick parser that assigns preorder indices in one pass.

Preorder numbering gives `parent[i] < i`, makes subtree containment an interval
test, and makes tip ordering inherent. An internal node's preorder position is
the `(` that opens it, so indices are assigned at `(` and the label attached
when the matching `)` closes. The scan is driven by a numpy-located array of
structural byte offsets rather than a per-character Python loop, and keeps an
explicit stack rather than recursing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from collections.abc import Callable

    from .typing_ import BoolArray, DepthArray, F64Array, I64Array, U32Array

LPAREN = ord("(")
RPAREN = ord(")")
COMMA = ord(",")
SEMI = ord(";")

NO_PARENT: int = int(np.iinfo(np.uint32).max)
NO_OTT: int = -1


class NewickError(RuntimeError):
    pass


@dataclass(slots=True)
class ParsedTree:
    parent: U32Array  # NO_PARENT at the root
    ott_id: I64Array  # NO_OTT where the label carries none
    labels: list[bytes]
    branch_length: F64Array | None  # NaN where absent

    @property
    def n_nodes(self) -> int:
        return len(self.parent)


def _split_label(seg: bytes) -> tuple[bytes, float]:
    """Split `name:branchlength`. Newick puts the length last, after a colon."""
    colon = seg.rfind(b":")
    if colon < 0:
        return seg, float("nan")
    tail = seg[colon + 1 :]
    try:
        return seg[:colon], float(tail)
    except ValueError:
        # A colon inside a name with no length after it.
        return seg, float("nan")


def parse_ott_id(label: bytes) -> int:
    """Extract an OTT id from a synthesis node label.

    Handles `ott770315` and `Homo_sapiens_ott770315`; returns NO_OTT for
    synthesised `mrcaott83926ott3607676` labels, which carry no OTT id.
    """
    if not label:
        return NO_OTT
    if label.startswith(b"mrca"):
        return NO_OTT
    pos = label.rfind(b"_ott")
    if pos >= 0:
        digits = label[pos + 4 :]
    elif label.startswith(b"ott"):
        digits = label[3:]
    else:
        return NO_OTT
    if digits.isdigit():
        return int(digits)
    return NO_OTT


def parse(
    data: bytes,
    *,
    want_branch_lengths: bool = False,
    progress: Callable[[int, int], None] | None = None,
) -> ParsedTree:
    """Parse one Newick tree, assigning `idx` by preorder traversal."""
    buf = np.frombuffer(data, dtype=np.uint8)
    # Quoted labels can contain delimiters; refuse rather than mis-split.
    if bool(((buf == 0x27) | (buf == 0x22)).any()):
        raise NewickError(
            "quoted labels detected; this parser does not handle quoting and "
            "would mis-split on delimiters inside quotes"
        )

    is_delim = (buf == LPAREN) | (buf == RPAREN) | (buf == COMMA) | (buf == SEMI)
    positions = np.flatnonzero(is_delim)
    if positions.size == 0:
        raise NewickError("no Newick structure found")

    # An upper bound on node count: every '(' opens an internal node and every
    # ',' or ')' can close at most one leaf.
    cap = int(positions.size) + 1
    parent = np.full(cap, NO_PARENT, dtype=np.uint32)
    ott = np.full(cap, NO_OTT, dtype=np.int64)
    blen = np.full(cap, np.nan, dtype=np.float64) if want_branch_lengths else None
    labels: list[bytes] = [b""] * cap

    stack: list[int] = []
    n = 0
    prev = 0
    pending = -1  # index of an internal node whose label has not arrived yet
    root = -1
    every = max(len(positions) // 20, 1)

    for i, pos in enumerate(positions.tolist()):
        c = data[pos]
        seg = data[prev:pos].strip()
        prev = pos + 1

        if pending >= 0:
            name, bl = _split_label(seg)
            labels[pending] = name
            ott[pending] = parse_ott_id(name)
            if blen is not None:
                blen[pending] = bl
            pending = -1
        elif seg:
            # A bare label between delimiters is a leaf.
            if n >= cap:
                raise NewickError("node count exceeded bound; malformed input")
            name, bl = _split_label(seg)
            labels[n] = name
            ott[n] = parse_ott_id(name)
            if blen is not None:
                blen[n] = bl
            parent[n] = stack[-1] if stack else NO_PARENT
            if not stack:
                root = n
            n += 1

        if c == LPAREN:
            idx = n
            n += 1
            if stack:
                parent[idx] = stack[-1]
            else:
                root = idx
            stack.append(idx)
        elif c == RPAREN:
            if not stack:
                raise NewickError(f"unbalanced ')' at byte {pos}")
            pending = stack.pop()
        elif c == SEMI:
            break

        if progress is not None and i % every == 0:
            progress(i, len(positions))

    if stack:
        raise NewickError(f"{len(stack)} unclosed '(' at end of input")
    if root != 0:
        raise NewickError(f"root is idx {root}, expected 0 under preorder")

    parent = parent[:n].copy()
    ott = ott[:n].copy()
    labels = labels[:n]
    if blen is not None:
        blen = blen[:n].copy()

    bad = np.flatnonzero(parent[1:] >= np.arange(1, n, dtype=np.uint32))
    if bad.size:
        raise NewickError(
            f"preorder invariant parent[i] < i violated at {bad.size} nodes "
            f"(first: idx {bad[0] + 1})"
        )

    return ParsedTree(parent=parent, ott_id=ott, labels=labels, branch_length=blen)


@dataclass(slots=True)
class Topology:
    parent: U32Array
    depth: DepthArray
    subtree_out: U32Array  # exclusive end of the preorder interval
    tip_count: U32Array
    child_count: U32Array
    is_tip: BoolArray


def derive(parent: U32Array) -> Topology:
    """Compute depth, subtree extent and tip counts from the parent array.

    Each is a single forward or reverse pass, since preorder guarantees
    `parent[i] < i`.
    """
    n = len(parent)
    par = parent.astype(np.int64)
    par[0] = -1

    child_count = np.bincount(par[1:], minlength=n).astype(np.uint32)
    is_tip = child_count == 0

    # Sweeps run over Python lists: numpy scalar boxing makes the loop ~10x
    # slower here.
    par_l = par.tolist()

    depth_l = [0] * n
    for i in range(1, n):
        depth_l[i] = depth_l[par_l[i]] + 1

    tip_l = is_tip.tolist()
    tip_count_l = [1 if t else 0 for t in tip_l]
    size_l = [1] * n
    for i in range(n - 1, 0, -1):
        p = par_l[i]
        tip_count_l[p] += tip_count_l[i]
        size_l[p] += size_l[i]

    # u8 suffices for the synthesis tree but not a fully-resolved chronogram.
    max_depth = max(depth_l)
    depth = np.array(depth_l, dtype=np.uint8 if max_depth < 256 else np.uint32)
    tip_count = np.array(tip_count_l, dtype=np.uint32)
    subtree_out = np.arange(n, dtype=np.uint32) + np.array(size_l, dtype=np.uint32)
    return Topology(
        parent=parent,
        depth=depth,
        subtree_out=subtree_out,
        tip_count=tip_count,
        child_count=child_count,
        is_tip=is_tip,
    )
