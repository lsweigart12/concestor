import numpy as np
import pytest

from concestor_build.newick import (
    NO_OTT,
    NO_PARENT,
    NewickError,
    derive,
    parse,
    parse_ott_id,
)


def test_preorder_indices_are_assigned_at_the_opening_paren():
    # Y is the root; X opens before its children A and B, so preorder is
    # Y, X, A, B, C even though Newick writes the labels Y and X last.
    t = parse(b"((A,B)X,C)Y;")
    assert t.labels == [b"Y", b"X", b"A", b"B", b"C"]
    assert t.parent.tolist() == [NO_PARENT, 0, 1, 1, 0]


def test_parent_is_always_less_than_index():
    t = parse(b"((((A,B)C,D)E,F)G,(H,I)J)K;")
    assert all(t.parent[i] < i for i in range(1, t.n_nodes))


def test_flat_tree_and_single_leaf():
    assert parse(b"(A,B,C)R;").parent.tolist() == [NO_PARENT, 0, 0, 0]
    t = parse(b"A;")
    assert t.labels == [b"A"] and t.parent.tolist() == [NO_PARENT]


def test_unnamed_internal_nodes_keep_their_slot():
    t = parse(b"((A,B),C);")
    assert t.labels == [b"", b"", b"A", b"B", b"C"]
    assert t.parent.tolist() == [NO_PARENT, 0, 1, 1, 0]


def test_branch_lengths_split_off_the_label():
    t = parse(b"((A:1.5,B:2)X:0.25,C:3)Y;", want_branch_lengths=True)
    assert t.labels == [b"Y", b"X", b"A", b"B", b"C"]
    np.testing.assert_allclose(
        t.branch_length, [np.nan, 0.25, 1.5, 2.0, 3.0]
    )


def test_ott_id_extraction_covers_every_synthesis_label_form():
    assert parse_ott_id(b"ott770315") == 770315
    assert parse_ott_id(b"Homo_sapiens_ott770315") == 770315
    # mrca* labels are synthesised divergence points with no OTT id at all.
    assert parse_ott_id(b"mrcaott83926ott3607676") == NO_OTT
    assert parse_ott_id(b"") == NO_OTT
    assert parse_ott_id(b"Nameless") == NO_OTT


def test_ott_ids_survive_a_branch_length():
    t = parse(b"(ott770315:1,mrcaott1ott2:2)ott314146:3;", want_branch_lengths=True)
    assert t.ott_id.tolist() == [314146, 770315, NO_OTT]


def test_whitespace_and_newlines_are_ignored():
    t = parse(b"(\n  A ,\n  B\n)\nR ;\n")
    assert t.labels == [b"R", b"A", b"B"]


def test_malformed_input_raises_rather_than_guessing():
    with pytest.raises(NewickError, match="unclosed"):
        parse(b"((A,B);")
    with pytest.raises(NewickError, match="unbalanced"):
        parse(b"(A,B));")
    with pytest.raises(NewickError, match="quoted"):
        parse(b"('A name',B)R;")


def test_derive_computes_depth_extent_and_tip_counts():
    #        K
    #      /   \
    #     G     J
    #    / \   / \
    #   E   F H   I
    #  / \
    # C   D
    # (C is itself (A,B))
    t = parse(b"((((A,B)C,D)E,F)G,(H,I)J)K;")
    topo = derive(t.parent)
    by = {lbl: i for i, lbl in enumerate(t.labels)}

    assert topo.depth[by[b"K"]] == 0
    assert topo.depth[by[b"A"]] == 4
    assert topo.tip_count[by[b"K"]] == 6  # A B D F H I
    assert topo.tip_count[by[b"G"]] == 4  # A B D F
    assert topo.is_tip.sum() == topo.tip_count[by[b"K"]]

    # Subtree containment is an interval test: in[u] <= in[v] < out[u].
    g = by[b"G"]
    for leaf in (b"A", b"B", b"D", b"F"):
        assert g <= by[leaf] < topo.subtree_out[g]
    for outside in (b"H", b"I", b"J"):
        assert not (g <= by[outside] < topo.subtree_out[g])


def test_unary_nodes_are_preserved_not_collapsed():
    # 24.5% of OTT internal nodes have exactly one child; they must survive
    # the parse so the gate on that count means something.
    t = parse(b"(((A)B)C)D;")
    topo = derive(t.parent)
    assert (topo.child_count == 1).sum() == 3
    assert topo.depth.max() == 3
