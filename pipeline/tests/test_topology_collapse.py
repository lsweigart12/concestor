"""The infraspecific collapse: the tree stops at species.

A toy tree exercising every rule at once: a species with two subspecies
arranged by an unnamed mrca node (which must be emptied with them), a third
subspecies carrying a strain-level terminal (the collateral case), and a
variety hanging directly off a genus. The species must survive as a tip, the
folded table must record every named casualty against its surviving ancestor,
and the removed mrca key must still resolve for broken-taxon substitution.
"""

import numpy as np

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
