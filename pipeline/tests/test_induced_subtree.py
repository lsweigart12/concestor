"""The induced-subtree primitive from architecture §2.

`|L|` selections must produce at most `2|L| - 1` rendered nodes after
degree-2 suppression. Getting this wrong is easy and silent: including the
chain of unary ancestors above the MRCA still *draws*, it just quietly breaks
the bound the rendering budget is derived from.
"""

from concestor_build.newick import parse
from concestor_build.render import induced_subtree, path_to_root


def build(nwk: bytes):
    t = parse(nwk)
    return t, {lbl: i for i, lbl in enumerate(t.labels)}


def test_path_is_root_first_and_complete():
    t, by = build(b"((((A,B)C,D)E,F)G,H)R;")
    assert [t.labels[i] for i in path_to_root(t.parent, by[b"A"])] == [
        b"R",
        b"G",
        b"E",
        b"C",
        b"A",
    ]


def test_two_leaves_reduce_to_their_mrca():
    # Interaction 1 is just |L| = 2; the LCA is the last common path element.
    t, by = build(b"((((A,B)C,D)E,F)G,H)R;")
    rendered, segments = induced_subtree(t.parent, sorted([by[b"A"], by[b"B"]]))
    assert {t.labels[v] for v in rendered} == {b"C", b"A", b"B"}
    assert segments[by[b"C"]][0] is None  # C is the induced root


def test_degree_two_nodes_are_suppressed_and_retained_on_the_segment():
    t, by = build(b"((((A,B)C,D)E,F)G,H)R;")
    rendered, segments = induced_subtree(
        t.parent, sorted([by[b"A"], by[b"B"], by[b"F"]])
    )
    assert {t.labels[v] for v in rendered} == {b"G", b"C", b"A", b"B", b"F"}
    # E sits between G and C with one marked child, so it is suppressed — but
    # it survives on the segment, which is interaction 3's content.
    anc, suppressed = segments[by[b"C"]]
    assert anc == by[b"G"]
    assert [t.labels[u] for u in suppressed] == [b"E"]


def test_rendered_count_never_exceeds_2n_minus_1():
    t, by = build(b"((((A,B)C,D)E,F)G,(H,(I,J)K)L)R;")
    leaves = [by[c] for c in (b"A", b"B", b"D", b"F", b"H", b"I", b"J")]
    for k in range(2, len(leaves) + 1):
        sel = sorted(leaves[:k])
        rendered, _ = induced_subtree(t.parent, sel)
        assert len(rendered) <= 2 * k - 1, f"{k} selections gave {len(rendered)}"


def test_unary_chain_above_the_mrca_is_excluded():
    # The root here is a chain of unary nodes; none of them belong to the
    # induced subtree of A and B.
    t, by = build(b"(((((A,B)C)U1)U2)U3)R;")
    rendered, _ = induced_subtree(t.parent, sorted([by[b"A"], by[b"B"]]))
    assert {t.labels[v] for v in rendered} == {b"C", b"A", b"B"}


def test_selection_order_does_not_change_the_result():
    t, by = build(b"((((A,B)C,D)E,F)G,(H,(I,J)K)L)R;")
    sel = sorted([by[b"A"], by[b"J"], by[b"F"]])
    a, _ = induced_subtree(t.parent, sel)
    b, _ = induced_subtree(t.parent, sorted(sel, reverse=True))
    assert a == b


def test_preorder_sort_gives_a_stable_vertical_order():
    # Adding a leaf must insert it in place, never permute the others —
    # this is what makes reflow animate rather than reshuffle (§3.1).
    _, by = build(b"((((A,B)C,D)E,F)G,(H,(I,J)K)L)R;")
    first = sorted([by[b"A"], by[b"J"]])
    second = sorted([by[b"A"], by[b"J"], by[b"D"]])
    assert [x for x in second if x in first] == first
