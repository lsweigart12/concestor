"""The infraspecific collapse: the tree stops at species.

A toy tree exercising every rule at once: a species with two subspecies
arranged by an unnamed mrca node (which must be emptied with them), a third
subspecies carrying a strain-level terminal (the collateral case), and a
variety hanging directly off a genus. The species must survive as a tip, the
folded table must record every named casualty against its surviving ancestor,
and the removed mrca key must still resolve for broken-taxon substitution.
"""

import numpy as np
import pytest

from concestor_build import newick
from concestor_build.newick import NO_PARENT
from concestor_build.topology import collapse_infraspecific

NWK = (
    b"(((TigA_ott11,TigB_ott12)mrcaott11ott12,(Strain_ott14)TigC_ott13)"
    b"Panthera_tigris_ott10,Bos_ott20,(Vicia_v_ott31,Vicia_s_ott32)Vicia_ott30)"
    b"life_ott1;"
)

TAXONOMY = {
    1: ("life", "no rank", ""),
    10: ("Panthera tigris", "species", ""),
    11: ("Panthera tigris altaica", "subspecies", ""),  # rank, no flag
    12: ("Panthera tigris tigris", "no rank", "infraspecific"),  # flag, no rank
    13: ("Panthera tigris sondaica", "subspecies", "infraspecific"),
    14: ("P. t. sondaica str. Bali", "no rank - terminal", ""),  # collateral
    20: ("Bos taurus", "species", ""),
    30: ("Vicia", "genus", ""),
    31: ("Vicia faba var. minuta", "varietas", ""),
    32: ("Vicia sativa", "species", ""),
}


def build():
    tree = newick.parse(NWK)
    by = {lbl: i for i, lbl in enumerate(tree.labels)}
    return tree, by


def test_species_survive_as_tips_and_structure_folds():
    tree, _ = build()
    collapsed, _, _, _ = collapse_infraspecific(tree, TAXONOMY)
    names = [lbl.decode() for lbl in collapsed.labels]
    assert names == [
        "life_ott1",
        "Panthera_tigris_ott10",
        "Bos_ott20",
        "Vicia_ott30",
        "Vicia_s_ott32",
    ]
    topo = newick.derive(collapsed.parent)
    assert bool(topo.is_tip[names.index("Panthera_tigris_ott10")])
    assert int(collapsed.parent[0]) == int(NO_PARENT)
    # Preorder survives the renumbering.
    n = collapsed.n_nodes
    assert not (collapsed.parent[1:] >= np.arange(1, n, dtype=np.uint32)).any()


def test_folded_rows_land_on_the_surviving_ancestor():
    tree, _ = build()
    collapsed, folded, _, stats = collapse_infraspecific(tree, TAXONOMY)
    names = [lbl.decode() for lbl in collapsed.labels]
    tigris, vicia = names.index("Panthera_tigris_ott10"), names.index("Vicia_ott30")
    assert sorted(folded) == sorted(
        [
            (tigris, 11, "Panthera tigris altaica", "subspecies"),
            (tigris, 12, "Panthera tigris tigris", "no rank"),
            (tigris, 13, "Panthera tigris sondaica", "subspecies"),
            (tigris, 14, "P. t. sondaica str. Bali", "no rank - terminal"),
            (vicia, 31, "Vicia faba var. minuta", "varietas"),
        ]
    )
    # The strain is named and not itself infraspecific: taken by the subtree
    # prune, so it must be counted as collateral, not slip through silently.
    assert stats["collateral named removals"] == 1


def test_removed_mrca_key_resolves_to_the_fold_target():
    tree, _ = build()
    collapsed, _, fold_of_key, _ = collapse_infraspecific(tree, TAXONOMY)
    names = [lbl.decode() for lbl in collapsed.labels]
    assert fold_of_key["mrcaott11ott12"] == names.index("Panthera_tigris_ott10")


def test_flag_and_rank_are_a_union():
    tree, _ = build()
    _, _, _, stats = collapse_infraspecific(tree, TAXONOMY)
    assert stats["flagged"] == 2  # 12 and 13
    assert stats["at an infraspecific rank"] == 3  # 11, 13, 31
    assert stats["infraspecific (flag ∪ rank)"] == 4


# --------------------------------------------------------------------------
# The curated hominin graft
# --------------------------------------------------------------------------

GRAFT_NWK = (
    b"((Homo_sapiens_ott770315,Homo_erectus_ott3607671)Homo_ott770309,"
    b"Pan_ott417950)life_ott1;"
)

GRAFT_TAXONOMY = {
    1: ("life", "no rank", ""),
    770309: ("Homo", "genus", ""),
    770315: ("Homo sapiens", "species", ""),
    3607671: ("Homo erectus", "no rank", "extinct"),
    417950: ("Pan troglodytes", "species", ""),
    83926: ("Homo sapiens neanderthalensis", "no rank", "extinct,infraspecific"),
    933436: ("Homo sapiens subsp. 'Denisova'", "no rank", "extinct,infraspecific"),
}


def test_graft_inserts_the_hominin_clade_beside_sapiens():
    from concestor_build.topology import (
        GRAFT_INNER_KEY,
        GRAFT_OUTER_KEY,
        graft_hominins,
    )

    tree = newick.parse(GRAFT_NWK)
    taxonomy = dict(GRAFT_TAXONOMY)
    # Fold targets on the host itself (old idx 2 = sapiens) and after it (old
    # idx 4 = Pan): the splice must renumber both, or every fold target past
    # the graft points four nodes early — the bug the 'dog' gate caught.
    folded: list[tuple[int, int, str, str | None]] = [
        (1, 83926, "Homo sapiens neanderthalensis", None),
        (2, 5341349, "Homo sapiens sapiens", "no rank"),
        (4, 417951, "Pan troglodytes verus", "subspecies"),
    ]
    fold_of_key = {"ott83926": 1, "ott5341349": 2, "ott417951": 4}

    grafted, kept, stats = graft_hominins(tree, taxonomy, folded, fold_of_key)
    names = [lbl.decode() for lbl in grafted.labels]
    assert names == [
        "life_ott1",
        "Homo_ott770309",
        GRAFT_OUTER_KEY,
        "Homo_sapiens_ott770315",
        GRAFT_INNER_KEY,
        "ott83926",
        "ott933436",
        "Homo_erectus_ott3607671",
        "Pan_ott417950",
    ]
    # Preorder holds and the new parents are what the shape says.
    n = grafted.n_nodes
    assert not (grafted.parent[1:] >= np.arange(1, n, dtype=np.uint32)).any()
    topo = newick.derive(grafted.parent)
    homo = names.index("Homo_ott770309")
    outer = names.index(GRAFT_OUTER_KEY)
    inner = names.index(GRAFT_INNER_KEY)
    assert int(grafted.parent[outer]) == homo
    assert int(grafted.parent[names.index("Homo_sapiens_ott770315")]) == outer
    assert int(grafted.parent[inner]) == outer
    assert int(grafted.parent[names.index("ott83926")]) == inner
    assert int(grafted.parent[names.index("ott933436")]) == inner
    assert int(topo.tip_count[homo]) == 4  # sapiens + the two grafts + erectus

    # The curated identity replaces NCBI's filing, and the fold lets go —
    # with every surviving target renumbered through the splice.
    assert taxonomy[83926] == ("Homo neanderthalensis", "species", "extinct")
    assert taxonomy[933436] == ("Homo longi", "species", "extinct")
    assert kept == [
        (
            names.index("Homo_sapiens_ott770315"),
            5341349,
            "Homo sapiens sapiens",
            "no rank",
        ),
        (names.index("Pan_ott417950"), 417951, "Pan troglodytes verus", "subspecies"),
    ]
    assert "ott83926" not in fold_of_key
    assert fold_of_key == {
        "ott5341349": names.index("Homo_sapiens_ott770315"),
        "ott417951": names.index("Pan_ott417950"),
    }
    assert stats == {"grafted nodes": 4, "folded rows withdrawn": 1}


def test_graft_refuses_an_ambiguous_host():
    from concestor_build.topology import graft_hominins

    tree = newick.parse(b"(A_ott5,B_ott6)life_ott1;")
    with pytest.raises(ValueError, match="graft host"):
        graft_hominins(tree, dict(GRAFT_TAXONOMY), [], {})
