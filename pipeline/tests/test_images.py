"""Phase 5a — the silhouette propagation sweep, and the index parsing feeding it.

The sweep is the only part of this phase with real logic in it. Everything else
is HTTP and SQL, so this tests the sweep against a small hand-built tree whose
right answer is written out by hand, plus a randomised comparison against the
naive definition it is a vectorisation of.

The tree, in preorder (`parent[i] < i`, exactly as phase 1 emits):

        0 root
        ├── 1 A            <- seeded, image 10
        │   ├── 2 A1
        │   │   └── 3 A1x
        │   └── 4 A2       <- seeded, image 11
        └── 5 B
            ├── 6 B1
            └── 7 B2       <- seeded, image 12

`root` and the whole B spine above B2 have no seeded ancestor, so they are
where the descendant fallback either fires or does not.
"""

import hashlib
import json
import sqlite3

import numpy as np
import pytest

from concestor_build import images
from concestor_build.images import (
    M_ANCESTOR,
    M_DESCENDANT,
    M_EXACT,
    M_NONE,
    NO_IMAGE,
    ImageRecord,
    ott_ids_from_node,
    pick_per_ott,
    propagate,
    record_from_item,
    seed_nodes,
    svg_rel_path,
)
from concestor_build.newick import NO_OTT, NO_PARENT, derive

PARENT = np.array([NO_PARENT, 0, 1, 2, 1, 0, 5, 5], dtype=np.uint32)


@pytest.fixture
def topo():
    return derive(PARENT)


def make_seed(pairs):
    seed = np.full(PARENT.size, NO_IMAGE, dtype=np.int64)
    for idx, img in pairs:
        seed[idx] = img
    return seed


def naive(parent, seed):
    """The definition the sweep vectorises: walk up until something is seeded."""
    out = []
    for i in range(parent.size):
        cur, hops = i, 0
        while True:
            if seed[cur] != NO_IMAGE:
                out.append((int(seed[cur]), cur, hops))
                break
            if cur == 0:
                out.append((NO_IMAGE, NO_IMAGE, 0))
                break
            cur, hops = int(parent[cur]), hops + 1
    return out


def test_ancestor_propagation_matches_the_hand_worked_answer(topo):
    seed = make_seed([(1, 10), (4, 11), (7, 12)])
    a = propagate(PARENT, topo.depth, topo.subtree_out, seed, descendant_fallback=False)

    # A and A2 and B2 are exact; A1/A1x inherit A one and two hops up.
    assert a.image.tolist() == [NO_IMAGE, 10, 10, 10, 11, NO_IMAGE, NO_IMAGE, 12]
    assert a.source.tolist() == [NO_IMAGE, 1, 1, 1, 4, NO_IMAGE, NO_IMAGE, 7]
    assert a.climb.tolist() == [0, 0, 1, 2, 0, 0, 0, 0]
    assert a.method.tolist() == [
        M_NONE,  # root: nothing above it
        M_EXACT,  # A
        M_ANCESTOR,  # A1 -> A
        M_ANCESTOR,  # A1x -> A, two hops
        M_EXACT,  # A2 has its own image, so it does NOT inherit A's
        M_NONE,  # B
        M_NONE,  # B1: B2 is a sibling, not an ancestor
        M_EXACT,  # B2
    ]


def test_a_seeded_node_keeps_its_own_image_over_its_ancestors(topo):
    """A2 is inside A's clade and both are seeded; the specific one wins."""
    a = propagate(
        PARENT,
        topo.depth,
        topo.subtree_out,
        make_seed([(1, 10), (4, 11)]),
        descendant_fallback=False,
    )
    assert a.image[4] == 11
    assert a.climb[4] == 0
    assert a.method[4] == M_EXACT


def test_descendant_fallback_is_marked_distinctly(topo):
    seed = make_seed([(1, 10), (7, 12)])
    off = propagate(
        PARENT, topo.depth, topo.subtree_out, seed, descendant_fallback=False
    )
    on = propagate(PARENT, topo.depth, topo.subtree_out, seed, descendant_fallback=True)

    # Ancestor-or-self results are untouched by turning the fallback on.
    keep = off.method != M_NONE
    assert np.array_equal(off.image[keep], on.image[keep])
    assert np.array_equal(off.method[keep], on.method[keep])

    # root borrows A, the first seeded node in preorder inside its subtree;
    # B borrows B2. Both are marked `descendant`, never `ancestor`.
    assert on.method[0] == M_DESCENDANT
    assert on.source[0] == 1
    assert on.method[5] == M_DESCENDANT
    assert on.source[5] == 7

    # B1 stays unresolved. B2 is its *sibling*, not its descendant, and the
    # fallback must not reach sideways — a leaf's subtree is only itself, so
    # the descendant fallback can never improve leaf coverage at all.
    assert on.method[6] == M_NONE
    assert on.source[6] == NO_IMAGE


def test_a_seeded_root_resolves_every_node(topo):
    a = propagate(PARENT, topo.depth, topo.subtree_out, make_seed([(0, 99)]))
    assert (a.image == 99).all()
    assert (a.source == 0).all()
    assert a.climb.tolist() == topo.depth.tolist()
    assert a.method[0] == M_EXACT
    assert (a.method[1:] == M_ANCESTOR).all()


def test_nothing_seeded_resolves_nothing(topo):
    a = propagate(PARENT, topo.depth, topo.subtree_out, make_seed([]))
    assert (a.method == M_NONE).all()
    assert (a.source == NO_IMAGE).all()


def test_source_is_always_an_ancestor_under_the_preorder_interval(topo):
    """The exact check the content gate makes, on a tree small enough to read."""
    a = propagate(
        PARENT,
        topo.depth,
        topo.subtree_out,
        make_seed([(1, 10), (4, 11), (7, 12)]),
        descendant_fallback=False,
    )
    for i in range(PARENT.size):
        if a.method[i] == M_NONE:
            continue
        src = int(a.source[i])
        assert src <= i < topo.subtree_out[src]


def test_matches_the_naive_walk_on_random_trees():
    """Pointer doubling and the naive upward walk must agree everywhere."""
    rng = np.random.default_rng(7)
    for _ in range(40):
        n = int(rng.integers(2, 400))
        parent = np.zeros(n, dtype=np.uint32)
        parent[0] = NO_PARENT
        for i in range(1, n):
            parent[i] = rng.integers(0, i)  # preserves parent[i] < i
        topo = derive(parent)
        seed = np.where(
            rng.random(n) < rng.choice([0.02, 0.2, 0.8]),
            rng.integers(0, 50, size=n),
            NO_IMAGE,
        ).astype(np.int64)

        a = propagate(
            parent, topo.depth, topo.subtree_out, seed, descendant_fallback=False
        )
        expected = naive(parent, seed)
        assert [
            (int(a.image[i]), int(a.source[i]), int(a.climb[i])) for i in range(n)
        ] == expected


def test_deep_chain_needs_more_than_one_doubling_round():
    """A 200-deep unary chain: a single hop would answer wrong for most of it."""
    n = 200
    parent = np.arange(-1, n - 1, dtype=np.int64)
    parent[0] = NO_PARENT
    parent = parent.astype(np.uint32)
    topo = derive(parent)
    seed = np.full(n, NO_IMAGE, dtype=np.int64)
    seed[0] = 5
    a = propagate(parent, topo.depth, topo.subtree_out, seed)
    assert (a.source == 0).all()
    assert a.climb.tolist() == list(range(n))


def test_propagate_rejects_mismatched_arrays(topo):
    with pytest.raises(ValueError, match="lengths disagree"):
        propagate(PARENT, topo.depth, topo.subtree_out, np.zeros(3, dtype=np.int64))


# --------------------------------------------------------------------------
# Seeding
# --------------------------------------------------------------------------


TIPS = np.array([9, 1, 1, 1], dtype=np.uint32)


def test_seed_nodes_chases_a_forwarded_ott_id():
    """OTT id forwarding is silent, so a direct miss is not an absent taxon."""
    ott = np.array([NO_OTT, 100, 200, NO_OTT], dtype=np.int64)
    # PhyloPic cites 999, which OTT retired in favour of 200.
    seed, stats = seed_nodes(ott, TIPS, {100: 0, 999: 1}, {999: 200})
    assert seed.tolist() == [NO_IMAGE, 0, 1, NO_IMAGE]
    assert stats["ott_ids_via_forward"] == 1
    assert stats["seeded_nodes"] == 2


def test_seed_nodes_ignores_ids_absent_from_the_tree():
    ott = np.array([NO_OTT, 100], dtype=np.int64)
    seed, stats = seed_nodes(ott, TIPS[:2], {100: 0, 555: 1}, {})
    assert seed.tolist() == [NO_IMAGE, 0]
    assert stats["ott_ids_offered"] == 2
    assert stats["ott_ids_in_tree"] == 1


def test_one_hop_lift_recovers_a_taxon_synthesis_does_not_carry():
    """The Homo sapiens case: images hang off a subspecies that is not a node."""
    ott = np.array([NO_OTT, 770315], dtype=np.int64)
    tips = np.array([9, 2], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott, tips, {5341349: 7}, {}, parents={5341349: 770315}, lift_max_tips=100
    )
    assert seed.tolist() == [NO_IMAGE, 7]
    assert stats["ott_ids_lifted_one_hop"] == 1
    assert stats["ott_ids_in_tree"] == 0


def test_one_hop_lift_refuses_a_target_that_is_too_broad():
    """A fossil family must not be lifted onto Amphibia — worse than nothing."""
    ott = np.array([NO_OTT, 500], dtype=np.int64)
    tips = np.array([10_018, 10_018], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott, tips, {999: 7}, {}, parents={999: 500}, lift_max_tips=100
    )
    assert seed.tolist() == [NO_IMAGE, NO_IMAGE]
    assert stats["ott_ids_lifted_one_hop"] == 0


def test_one_hop_lift_never_displaces_a_direct_hit():
    """An image OF the node beats an image lifted from one of its children."""
    ott = np.array([NO_OTT, 770315], dtype=np.int64)
    tips = np.array([9, 2], dtype=np.uint32)
    seed, _ = seed_nodes(
        ott, tips, {5341349: 7, 770315: 3}, {}, parents={5341349: 770315}
    )
    assert seed[1] == 3


def test_lift_only_walks_one_hop():
    """Two hops is a different claim, and the fossil cases are all multi-hop."""
    ott = np.array([NO_OTT, 100], dtype=np.int64)
    tips = np.array([9, 1], dtype=np.uint32)
    seed, stats = seed_nodes(
        ott, tips, {300: 7}, {}, parents={300: 200, 200: 100}, lift_max_tips=100
    )
    assert seed.tolist() == [NO_IMAGE, NO_IMAGE]
    assert stats["ott_ids_lifted_one_hop"] == 0


def _rec(uuid, ott_ids, primary=None, modified="2020-01-01") -> ImageRecord:
    return ImageRecord(
        uuid=uuid,
        license_url="https://creativecommons.org/publicdomain/zero/1.0/",
        attribution="A",
        contributor="A",
        modified=modified,
        node_uuid="n",
        node_title="t",
        node_primary_image=primary,
        ott_ids=list(ott_ids),
    )


def test_pick_per_ott_prefers_the_nodes_own_primary_image():
    older = _rec("aaa", [7], primary="bbb", modified="2026-01-01")
    primary = _rec("bbb", [7], primary="bbb", modified="2001-01-01")
    assert pick_per_ott([older, primary])[7] == 1


def test_pick_per_ott_falls_back_to_most_recently_modified():
    a = _rec("aaa", [7], primary="zzz", modified="2001-01-01")
    b = _rec("bbb", [7], primary="zzz", modified="2026-01-01")
    assert pick_per_ott([a, b])[7] == 1


def test_pick_per_ott_skips_images_with_no_licence():
    r = _rec("aaa", [7])
    r.license_url = ""
    assert pick_per_ott([r]) == {}


# --------------------------------------------------------------------------
# Index payload parsing
# --------------------------------------------------------------------------

# Shape verified against the live API on 2026-07-31, build 545.
ITEM = {
    "uuid": "87782103-d7e2-4574-a932-ef445dd112fa",
    "attribution": "Amy Beauvois",
    "modified": "2026-07-22T06:40:10.428Z",
    "_links": {
        "license": {"href": "https://creativecommons.org/publicdomain/zero/1.0/"},
        "contributor": {
            "href": "/contributors/x?build=545",
            "title": "T. Michael Keesey",
        },
        "vectorFile": {
            "href": "https://images.phylopic.org/images/87782103/vector.svg"
        },
    },
    "_embedded": {
        "specificNode": {
            "uuid": "5009dab6-2315-4192-8a41-e7ecd7919e63",
            "_links": {
                "self": {
                    "href": "/nodes/5009dab6?build=545",
                    "title": "Diabloceratops",
                },
                "primaryImage": {"href": "/images/aaaa-bbbb?build=545"},
                "external": [
                    {"href": "/resolve/gbif.org/species/8559524?build=545"},
                    {"href": "/resolve/opentreeoflife.org/taxonomy/6150271?build=545"},
                    {"href": "/resolve/paleobiodb.org/txn/170568?build=545"},
                ],
            },
        }
    },
}


def test_record_from_item_keeps_creator_and_uploader_apart():
    """Conflating them credits the wrong person; they differ 31% of the time."""
    r = record_from_item(ITEM)
    assert r.attribution == "Amy Beauvois"
    assert r.contributor == "T. Michael Keesey"
    assert r.license_url.endswith("/zero/1.0/")
    assert r.ott_ids == [6150271]
    assert r.node_primary_image == "aaaa-bbbb"


def test_record_survives_an_image_with_no_specific_node():
    bare = {"uuid": "u", "_links": {"license": {"href": "x"}}}
    r = record_from_item(bare)
    assert r.ott_ids == []
    assert r.node_uuid is None


def test_ott_ids_reads_every_declared_id_not_just_the_first():
    node = {
        "_links": {
            "external": [
                {"href": "/resolve/opentreeoflife.org/taxonomy/1?build=545"},
                {"href": "/resolve/opentreeoflife.org/taxonomy/2"},
                {"href": "/resolve/gbif.org/species/3"},
                {"href": "/resolve/opentreeoflife.org/taxonomy/notanumber"},
            ]
        }
    }
    assert ott_ids_from_node(node) == [1, 2]


def test_ott_ids_on_a_node_with_no_external_block():
    assert ott_ids_from_node({"_links": {"external": None}}) == []
    assert ott_ids_from_node({}) == []


def test_index_round_trips_through_jsonl(tmp_path, monkeypatch):
    monkeypatch.setattr(images, "MIRROR", tmp_path)
    monkeypatch.setattr(images, "INDEX", tmp_path / "index.jsonl")
    monkeypatch.setattr(images, "INDEX_META", tmp_path / "index_meta.json")
    recs = [record_from_item(ITEM), _rec("z", [1, 2])]
    images.save_index(recs, 545, total_items=2)
    back, meta = images.load_index()
    assert meta == {"build": 545, "images": 2, "total_items": 2}
    assert [r.to_json() for r in back] == [r.to_json() for r in recs]


def test_load_index_with_nothing_cached(tmp_path, monkeypatch):
    monkeypatch.setattr(images, "INDEX", tmp_path / "nope.jsonl")
    monkeypatch.setattr(images, "INDEX_META", tmp_path / "nope.json")
    assert images.load_index() == ([], {})


# --------------------------------------------------------------------------
# Attribution and mirror layout
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "required"),
    [
        ("https://creativecommons.org/licenses/by/4.0/", True),
        ("https://creativecommons.org/licenses/by-sa/3.0/", True),
        ("https://creativecommons.org/licenses/by-nc-sa/3.0/", True),
        ("https://creativecommons.org/publicdomain/zero/1.0/", False),
        ("https://creativecommons.org/publicdomain/mark/1.0/", False),
    ],
)
def test_attribution_requirement_follows_the_licence(url, required):
    r = _rec("u", [])
    r.license_url = url
    assert r.needs_attribution is required


def test_svg_paths_are_sharded():
    p = svg_rel_path("87782103-d7e2-4574-a932-ef445dd112fa")
    assert p == "svg/87/87782103-d7e2-4574-a932-ef445dd112fa.svg"


def test_resume_keeps_good_files_and_refetches_ruined_ones(tmp_path, monkeypatch):
    """Resumability is by content, not by presence.

    An interrupted run leaves a half-written or empty file behind. Skipping it
    because the path exists would bake a broken silhouette into the mirror and
    then record a checksum for it, so nothing downstream would ever notice.
    """
    monkeypatch.setattr(images, "MIRROR", tmp_path)
    good, empty, junk = _rec("a" * 8, []), _rec("b" * 8, []), _rec("c" * 8, [])
    body = b"<svg><path d='M0 0'/></svg>"
    for rec, content in ((good, body), (empty, b""), (junk, b"<!doctype html>oops")):
        p = tmp_path / svg_rel_path(rec.uuid)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content)

    have = images.existing_mirror(
        [good, empty, junk, _rec("d" * 8, [])], lambda _m: None
    )
    assert set(have) == {good.uuid, junk.uuid}  # junk still parses as markup
    assert have[good.uuid].bytes == len(body)
    assert have[good.uuid].sha256 == hashlib.sha256(body).hexdigest()
    assert have[good.uuid].rel_path == svg_rel_path(good.uuid)


def test_budget_caps_one_run_and_takes_the_highest_priority_first(monkeypatch):
    """A budgeted run must fetch the *front* of the priority order, not any N."""
    monkeypatch.setattr(images, "MIRROR_WORKERS", 1)
    recs = [_rec(f"u{i}", []) for i in range(5)]
    fetched: list[str] = []

    def fake(_client, rec) -> images.MirrorRow:
        fetched.append(rec.uuid)
        return images.MirrorRow(rec.uuid, svg_rel_path(rec.uuid), "x" * 64, 10)

    monkeypatch.setattr(images, "fetch_svg", fake)
    have, failures = images.mirror_svgs(recs, [3, 1, 4, 0, 2], {}, 2, lambda _m: None)
    assert fetched == ["u3", "u1"]
    assert set(have) == {"u3", "u1"}
    assert failures == []


def test_a_single_bad_image_does_not_stop_the_mirror(monkeypatch):
    monkeypatch.setattr(images, "MIRROR_WORKERS", 1)
    recs = [_rec("ok1", []), _rec("bad", []), _rec("ok2", [])]

    def fake(_client, rec) -> images.MirrorRow:
        if rec.uuid == "bad":
            raise images.PhylopicError("not SVG")
        return images.MirrorRow(rec.uuid, svg_rel_path(rec.uuid), "x" * 64, 10)

    monkeypatch.setattr(images, "fetch_svg", fake)
    have, failures = images.mirror_svgs(recs, [0, 1, 2], {}, 0, lambda _m: None)
    assert set(have) == {"ok1", "ok2"}
    assert len(failures) == 1
    assert "bad" in failures[0]


# --------------------------------------------------------------------------
# Output tables, on a throwaway database
# --------------------------------------------------------------------------


def test_tables_carry_data_and_not_just_rows(tmp_path, monkeypatch):
    """`silhouette.svg_path` stays NULL until fetched, and must fill when it is.

    CLAUDE.md records a column that was permanently NULL while every gate
    passed. Counting rows is not checking them.
    """
    db = tmp_path / "t.db"
    monkeypatch.setattr(images, "DB", db)
    monkeypatch.setattr(images, "OUT", tmp_path / "out")

    recs = [_rec("img-a", [1]), _rec("img-b", [2])]
    mirrored = {"img-a": images.MirrorRow("img-a", "svg/im/img-a.svg", "d" * 64, 1234)}
    topo = derive(PARENT)
    assign = propagate(
        PARENT,
        topo.depth,
        topo.subtree_out,
        make_seed([(1, 0), (7, 1)]),
        descendant_fallback=False,
    )

    con = images.connect_rw()
    images.write_silhouette(con, recs, mirrored)
    n_rows = images.write_node_image(con, recs, assign)
    con.close()

    con = sqlite3.connect(db)
    fetched, missing = con.execute(
        "SELECT count(svg_path), count(*) - count(svg_path) FROM silhouette"
    ).fetchone()
    assert (fetched, missing) == (1, 1)
    assert con.execute(
        "SELECT sha256, bytes FROM silhouette WHERE phylopic_id='img-a'"
    ).fetchone() == ("d" * 64, 1234)
    assert (
        con.execute("SELECT count(*) FROM silhouette WHERE license_url=''").fetchone()[
            0
        ]
        == 0
    )

    # Only resolved nodes get a row, and every row names a real silhouette.
    assert n_rows == int((assign.method != M_NONE).sum())
    assert (
        con.execute(
            "SELECT count(*) FROM node_image "
            "WHERE phylopic_id NOT IN (SELECT phylopic_id FROM silhouette)"
        ).fetchone()[0]
        == 0
    )
    assert con.execute(
        "SELECT phylopic_id, source_idx, climb, method FROM node_image WHERE idx=3"
    ).fetchone() == ("img-a", 1, 2, "ancestor")
    assert {m for (m,) in con.execute("SELECT DISTINCT method FROM node_image")} <= {
        "exact",
        "ancestor",
        "descendant",
    }
    con.close()

    images.write_arrays(recs, assign)
    assert json.loads((tmp_path / "out" / "silhouette_ids.json").read_text()) == [
        "img-a",
        "img-b",
    ]
    assert (
        np.load(tmp_path / "out" / "node_image_climb.npy").tolist()
        == assign.climb.tolist()
    )


def test_mirror_order_puts_the_biggest_clades_first():
    """An interrupted crawl should already have Mammalia, not a monotypic genus."""
    tip_count = np.array([8, 3, 1, 1, 1, 3, 1, 1], dtype=np.uint32)
    topo = derive(PARENT)
    # image 0 resolves the A clade (3 tips), image 1 resolves only B2 (1 tip).
    assign = propagate(
        PARENT,
        topo.depth,
        topo.subtree_out,
        make_seed([(1, 0), (7, 1)]),
        descendant_fallback=False,
    )
    recs = [_rec("small-clade", [1]), _rec("big-clade", [2]), _rec("unused", [3])]
    order = images.mirror_order(recs, tip_count, assign)
    assert order[0] == 0  # weight 3, the A clade
    assert order[1] == 1  # weight 1, B2 alone
    assert order[2] == 2  # weight 0, resolves nothing


def test_mirror_order_without_a_resolution_is_index_order():
    recs = [_rec("a", []), _rec("b", [])]
    assert images.mirror_order(recs, np.ones(8, dtype=np.uint32), None) == [0, 1]
