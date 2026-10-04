"""The curated hominin graft: the one hand edit phase 1 makes to the tree.

A toy *Homo* shaped the way synthesis shapes the real one — *Homo sapiens*
internal, above the nominate subspecies and the Neanderthal — with a taxon
after the host so the renumbering past the splice is exercised too.
"""

import numpy as np
import pytest

from concestor_build import newick
from concestor_build.topology import (
    GRAFT_FORMER_NAMES,
    GRAFT_INNER_KEY,
    GRAFT_OUTER_KEY,
    graft_hominins,
)

NWK = (
    b"(((ott83926,ott5341349)ott770315,ott3607671)ott770309,"
    b"(ott417951,ott417952)ott417950)ott1;"
)

TAXONOMY = {
    1: ("life", "no rank", ""),
    770309: ("Homo", "genus", ""),
    770315: ("Homo sapiens", "species", ""),
    83926: ("Homo sapiens neanderthalensis", "no rank", "extinct,infraspecific"),
    5341349: ("Homo sapiens sapiens", "no rank", "infraspecific"),
    # In the taxonomy and absent from synthesis, as the real one is.
    933436: ("Homo sapiens subsp. 'Denisova'", "no rank", "extinct,infraspecific"),
    3607671: ("Homo erectus", "no rank", "extinct"),
    417950: ("Pan troglodytes", "species", ""),
    417951: ("Pan troglodytes verus", "subspecies", ""),
    417952: ("Pan troglodytes troglodytes", "subspecies", ""),
}


def graft():
    taxonomy = dict(TAXONOMY)
    tree, former = graft_hominins(newick.parse(NWK), taxonomy)
    return tree, former, taxonomy, [lbl.decode() for lbl in tree.labels]


def test_the_host_subtree_becomes_three_sister_species():
    tree, _, _, names = graft()
    assert names == [
        "ott1",
        "ott770309",
        GRAFT_OUTER_KEY,
        "ott770315",
        GRAFT_INNER_KEY,
        "ott83926",
        "ott933436",
        "ott3607671",
        "ott417950",
        "ott417951",
        "ott417952",
    ]
    n = tree.n_nodes
    assert not (tree.parent[1:] >= np.arange(1, n, dtype=np.uint32)).any()

    def parent(key: str) -> str:
        return names[int(tree.parent[names.index(key)])]

    assert parent(GRAFT_OUTER_KEY) == "ott770309"
    assert parent("ott770315") == GRAFT_OUTER_KEY
    assert parent(GRAFT_INNER_KEY) == GRAFT_OUTER_KEY
    assert parent("ott83926") == GRAFT_INNER_KEY
    assert parent("ott933436") == GRAFT_INNER_KEY

    topo = newick.derive(tree.parent)
    assert bool(topo.is_tip[names.index("ott770315")])
    assert int(topo.tip_count[names.index("ott770309")]) == 4


def test_everything_past_the_splice_keeps_its_parent():
    tree, _, _, names = graft()

    def parent(key: str) -> str:
        return names[int(tree.parent[names.index(key)])]

    # A sibling of the host, a sibling of the genus, and nodes hanging from
    # one that moved: before the block, at it, and past it.
    assert parent("ott3607671") == "ott770309"
    assert parent("ott417950") == "ott1"
    assert parent("ott417951") == "ott417950"
    assert parent("ott417952") == "ott417950"
    assert tree.ott_id.tolist()[names.index("ott417952")] == 417952


def test_subspecies_outside_the_host_stay_nodes():
    _, _, _, names = graft()
    assert "ott417951" in names
    assert "ott417952" in names


def test_the_leaves_take_the_curated_identity():
    _, _, taxonomy, _ = graft()
    assert taxonomy[83926] == ("Homo neanderthalensis", "species", "extinct")
    assert taxonomy[933436] == ("Homo longi", "species", "extinct")
    assert taxonomy[770315] == TAXONOMY[770315]


def test_what_the_graft_retired_is_the_declared_list():
    _, former, _, names = graft()
    assert former == sorted(GRAFT_FORMER_NAMES)
    # The nominate subspecies is the only id that stops being a node.
    assert "ott5341349" not in names
    assert [old for old, _name, new in former if old != new] == [5341349]


def test_graft_refuses_a_missing_host():
    tree = newick.parse(b"(ott5,ott6)ott1;")
    with pytest.raises(ValueError, match="graft host"):
        graft_hominins(tree, dict(TAXONOMY))
