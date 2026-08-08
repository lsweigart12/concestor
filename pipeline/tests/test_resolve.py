"""Unit tests for the phase 3 resolution layer.

The expensive halves — a 7.7M-row backbone scan and a paced API crawl — are
exercised against small synthetic inputs here. The gates in `resolve.run` cover
the real files; these cover the logic that decides what the gates measure.
"""

import gzip
import json
import sqlite3
from typing import TYPE_CHECKING

import numpy as np
import pytest

from concestor_build import resolve
from concestor_build.resolve import (
    CONFIDENCE,
    METHOD_ORDER,
    PBDB_DATASET_KEY,
    ChainScore,
    ChecklistRecord,
    IdMap,
    Xref,
)

if TYPE_CHECKING:
    from concestor_build.typing_ import BoolArray, JsonDict

# --- sourceinfo ---------------------------------------------------------------


def test_parse_sourceinfo_reads_the_ordinary_case():
    raw = "silva:A16379/#1,ncbi:2,worms:6,gbif:3,irmng:13,irmng:109739"
    assert list(resolve.parse_sourceinfo(raw)) == [
        ("silva", "A16379/#1"),
        ("ncbi", "2"),
        ("worms", "6"),
        ("gbif", "3"),
        ("irmng", "13"),
        ("irmng", "109739"),
    ]


def test_parse_sourceinfo_is_many_to_one():
    """One taxon carries six NCBI ids, so the table holds a list, never a scalar."""
    raw = ",".join(f"ncbi:{i}" for i in range(6))
    assert len(list(resolve.parse_sourceinfo(raw))) == 6


@pytest.mark.parametrize(
    "raw",
    [
        "https://en.wikipedia.org/wiki/Homo_sapiens_sapiens",
        "addition:6520265",
        "additions-6520052-6520144:6520100",
        "h2007:Fungi",
        "study713:361838",
        "",
        "gbif:",
    ],
)
def test_parse_sourceinfo_drops_the_malformed_prefixes(raw):
    """OTT 3.7.3 carries three malformed entries; none may become an xref row."""
    assert list(resolve.parse_sourceinfo(raw)) == []


def test_parse_sourceinfo_recovers_the_space_prefixed_entry():
    """` irmng:11258800` is a real id behind a stray space, not a broken token."""
    assert list(resolve.parse_sourceinfo("ncbi:1, irmng:11258800")) == [
        ("ncbi", "1"),
        ("irmng", "11258800"),
    ]


# --- IdMap --------------------------------------------------------------------


def test_idmap_lookup_reports_misses_as_minus_one():
    m = IdMap([10, 3, 7], [100, 30, 70])
    got = m.lookup(np.array([3, 7, 10, 11], dtype=np.int64)).tolist()
    assert got == [30, 70, 100, -1]
    assert m.get(7) == 70
    assert m.get(11) is None


def test_idmap_keeps_the_first_value_for_a_duplicated_key():
    m = IdMap([5, 5, 6], [50, 999, 60])
    assert m.get(5) == 50
    assert m.n_duplicate == 1
    assert len(m) == 2


def test_idmap_tolerates_being_empty():
    m = IdMap([], [])
    assert m.lookup(np.array([1], dtype=np.int64)).tolist() == [-1]


# --- precedence ---------------------------------------------------------------


def test_a_later_method_never_overwrites_an_earlier_one():
    x = Xref()
    assert x.add("pbdb", "1", 111, "gbif_pbdb_chain")
    assert not x.add("pbdb", "1", 222, "name_exact")
    assert x.resolved_idx("pbdb", "1") == 111
    assert x.by_method["gbif_pbdb_chain"] == 1
    assert x.blocked["name_exact"] == 1


def test_a_manual_suppression_blocks_every_later_method():
    """`idx = NULL` from `manual` is a decision, not a gap to be filled in."""
    x = Xref()
    x.add("pbdb", "52983", None, "manual")
    assert not x.add("pbdb", "52983", 42, "gbif_pbdb_chain")
    assert not x.add("pbdb", "52983", 42, "name_exact")
    row = x.get("pbdb", "52983")
    assert row is not None and row.idx is None and row.method == "manual"


def test_every_method_carries_a_confidence():
    assert set(METHOD_ORDER) <= set(CONFIDENCE)
    assert CONFIDENCE["manual"] == 1.0
    assert CONFIDENCE[resolve.UNRESOLVED] == 0.0


def test_rows_serialise_candidates_as_json_only_when_ambiguous():
    x = Xref()
    x.add("pbdb", "1", 5, "name_exact")
    x.add("pbdb", "2", None, resolve.UNRESOLVED, [7, 9])
    rows = {r[1]: r for r in x.rows()}
    assert rows["1"][5] is None
    candidates = rows["2"][5]
    assert candidates is not None
    assert json.loads(candidates) == [7, 9]
    assert rows["2"][2] is None, "ambiguous means unresolved, with the list kept"


# --- overrides ----------------------------------------------------------------


def test_overrides_round_trip_through_the_seed_writer(tmp_path):
    path = tmp_path / "overrides.tsv"
    resolve.write_seed_overrides(path)
    loaded = resolve.load_overrides(path)
    assert loaded == list(resolve.SEED_OVERRIDES)
    assert loaded[0].ott_id == 664348
    assert loaded[1].ott_id is None, "NULL means suppress, not 'unset'"
    assert all(o.reason for o in loaded)


def test_an_override_without_a_reason_is_an_error(tmp_path):
    path = tmp_path / "overrides.tsv"
    path.write_text("source\tsource_id\tott_id\treason\npbdb\t1\t2\t\n")
    with pytest.raises(ValueError, match="without a reason"):
        resolve.load_overrides(path)


def test_a_missing_overrides_file_is_not_an_error(tmp_path):
    assert resolve.load_overrides(tmp_path / "nope.tsv") == []


def test_a_manual_row_survives_the_bulk_sourceinfo_insert(tmp_path):
    """Method 2 streams 4.7M rows straight into SQLite, bypassing `Xref`.

    So precedence between methods 1 and 2 is enforced by `INSERT OR IGNORE`
    against a row that is already there — which only works if the manual rows
    are written first. They were not, once.
    """
    con = sqlite3.connect(tmp_path / "t.db")
    resolve._create_xref(con)
    con.execute(
        "INSERT OR IGNORE INTO xref VALUES (?,?,?,?,?,?)",
        ("gbif", "4822631", 654141, "manual", 1.0, None),
    )
    con.execute(
        "INSERT OR IGNORE INTO xref VALUES (?,?,?,?,?,?)",
        ("gbif", "4822631", 999, "ott_sourceinfo", 0.99, None),
    )
    assert con.execute(
        "SELECT idx, method FROM xref WHERE source='gbif'"
    ).fetchone() == (654141, "manual")
    con.close()


# --- the crawl checkpoint -----------------------------------------------------


def test_the_checkpoint_round_trips_and_survives_a_torn_line(tmp_path):
    path = tmp_path / "nubkeys.ndjson"
    good = ChecklistRecord(
        38613, True, 121494660, 4822631, "GENUS", "ACCEPTED", "T", None
    )
    missing = ChecklistRecord(1, False, None, None, None, None, None, None)
    path.write_text(good.to_json() + "\n" + missing.to_json() + "\n" + '{"taxon_no":')
    loaded = resolve.load_nubkeys(path)
    assert loaded[38613] == good
    assert loaded[1] == missing
    assert len(loaded) == 2, "the half-written final line is dropped, not fatal"


def test_a_later_line_wins_so_a_refetch_repairs(tmp_path):
    path = tmp_path / "nubkeys.ndjson"
    stale = ChecklistRecord(7, False, None, None, None, None, None, None)
    fresh = ChecklistRecord(7, True, 1, 2, "GENUS", "ACCEPTED", "X", None)
    path.write_text(stale.to_json() + "\n" + fresh.to_json() + "\n")
    assert resolve.load_nubkeys(path)[7] == fresh


def test_the_crawl_does_no_work_when_everything_is_checkpointed(tmp_path):
    done = {1: ChecklistRecord(1, True, None, None, None, None, None, None)}
    assert (
        resolve.crawl_checklist([1], done, path=tmp_path / "x", log=lambda _: None) == 0
    )


# --- scoring ------------------------------------------------------------------


def test_the_chain_is_scored_as_two_hops():
    """A drop in each hop implicates a different upstream, so they never merge."""
    s = ChainScore(attempted=100, in_checklist=80, with_nub=40, to_ott=20, to_node=5)
    assert s.hop1 == pytest.approx(50.0)
    assert s.hop2 == pytest.approx(50.0)
    assert s.end_to_end == pytest.approx(25.0)


def test_scoring_an_empty_cohort_does_not_divide_by_zero():
    s = ChainScore(0, 0, 0, 0, 0)
    assert (s.hop1, s.hop2, s.end_to_end) == (0.0, 0.0, 0.0)


def test_score_chain_conditions_on_records_that_exist_in_the_checklist():
    records = {
        1: ChecklistRecord(1, True, 10, 500, "GENUS", "ACCEPTED", "A", None),
        2: ChecklistRecord(2, True, 11, 501, "GENUS", "ACCEPTED", "B", None),
        3: ChecklistRecord(3, True, 12, None, "GENUS", "ACCEPTED", "C", None),
        4: ChecklistRecord(4, False, None, None, None, None, None, None),
    }
    # 500 is in OTT and in the tree; 501 is in OTT but not a node.
    gbif_to_ott = IdMap([500, 501], [900, 901])
    score = resolve.score_chain([1, 2, 3, 4, 5], records, gbif_to_ott, {900: 42})
    assert score.attempted == 4, "taxon 5 was never crawled"
    assert score.in_checklist == 3
    assert score.with_nub == 2
    assert score.to_ott == 2
    assert score.to_node == 1, "reaching OTT and landing on a node differ"


# --- the offline backbone -----------------------------------------------------


def _backbone_row(**over: str) -> str:
    f = ["\\N"] * 30
    f[resolve.COL_NUB_KEY] = "1"
    f[resolve.COL_PARENT_KEY] = "2"
    f[resolve.COL_STATUS] = "ACCEPTED"
    f[resolve.COL_RANK] = "GENUS"
    f[resolve.COL_DATASET] = PBDB_DATASET_KEY
    f[resolve.COL_CANONICAL] = "Aaa"
    for k, v in over.items():
        f[getattr(resolve, k)] = v
    return "\t".join(f)


def test_scan_backbone_joins_by_name_and_rank_and_refuses_ambiguity(tmp_path):
    path = tmp_path / "simple.txt.gz"
    lines = [
        _backbone_row(COL_NUB_KEY="10", COL_CANONICAL="Unique"),
        _backbone_row(COL_NUB_KEY="11", COL_CANONICAL="Homonym"),
        _backbone_row(COL_NUB_KEY="12", COL_CANONICAL="Absent"),
        # another dataset won this provenance slot, so PBDB is invisible here
        _backbone_row(COL_NUB_KEY="13", COL_DATASET="not-pbdb", COL_CANONICAL="Unique"),
        _backbone_row(
            COL_NUB_KEY="14",
            COL_CANONICAL="Syn",
            COL_STATUS="SYNONYM",
            COL_PARENT_KEY="99",
        ),
    ]
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    index = {
        ("Unique", "genus"): [1],
        ("Homonym", "genus"): [2, 3],
        ("Syn", "genus"): [4],
    }
    scan = resolve.scan_backbone(index, path=path, log=lambda _: None)

    assert scan.rows == 5
    assert scan.pbdb_cited == 4
    assert scan.join_unique == 2
    assert scan.join_ambiguous == 1, "two candidates means unresolved, not a guess"
    assert scan.join_nomatch == 1
    assert scan.taxon_to_nub == {1: 10, 4: 14}
    assert scan.taxon_to_accepted_nub == {4: 99}, (
        "col 2 is the accepted key on synonyms"
    )


def test_a_taxon_cited_by_two_backbone_rows_keeps_both_keys(tmp_path):
    """The join is unique per row, not per taxon — 298 taxa are cited twice."""
    path = tmp_path / "simple.txt.gz"
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        fh.write(
            _backbone_row(COL_NUB_KEY="10", COL_CANONICAL="Twice")
            + "\n"
            + _backbone_row(COL_NUB_KEY="11", COL_CANONICAL="Twice")
            + "\n"
        )
    scan = resolve.scan_backbone(
        {("Twice", "genus"): [1]}, path=path, log=lambda _: None
    )
    assert scan.join_unique == 2
    assert scan.taxon_to_nub == {1: 10}
    assert scan.taxon_alt_nub == {1: [11]}, "the taxon reaches OTT if either does"


def test_scan_backbone_counts_rows_that_are_not_30_fields(tmp_path):
    path = tmp_path / "simple.txt.gz"
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        fh.write(_backbone_row() + "\n" + "a\tb\tc\n")
    scan = resolve.scan_backbone({}, path=path, log=lambda _: None)
    assert scan.rows == 2
    assert scan.malformed == 1


# --- forwards -----------------------------------------------------------------


def test_forwarded_ott_ids_are_chased_and_counted():
    """OTT id forwarding is silent, so a miss is never assumed dead."""
    r = resolve.OttResolver({100: 5}, {99: 100})
    assert r.idx_for(100) == 5
    assert r.idx_for(99) == 5
    assert r.chased == {99: 100}
    assert r.idx_for(1234) is None


def test_a_self_forward_does_not_loop():
    r = resolve.OttResolver({}, {7: 7})
    assert r.idx_for(7) is None


# --- the disagreement sweep ---------------------------------------------------


def _taxon(
    taxon_no: int,
    name: str,
    is_extant: int | None,
    accepted_no: int | None = None,
    rank: str = "genus",
) -> resolve.PbdbTaxon:
    """A PbdbTaxon carrying only the fields the sweep reads."""
    return resolve.PbdbTaxon(
        taxon_no=taxon_no,
        orig_no=taxon_no,
        rank=rank,
        name=name,
        accepted_no=accepted_no if accepted_no is not None else taxon_no,
        accepted_rank=rank,
        accepted_name=name,
        parent_no=0,
        n_occs=1,
        is_extant=is_extant,
        difference="",
        fea=None,
        fla=None,
        lea=None,
        lla=None,
        flags="",
    )


def _sweep(
    taxa: list[resolve.PbdbTaxon],
    resolutions: list[tuple[str, int | None, str]],
    *,
    extinct_ott: tuple[int, ...] = (),
    living: BoolArray | None = None,
    idx_to_ott: dict[int, int] | None = None,
    ott_rank: dict[int, str] | None = None,
) -> tuple[Xref, JsonDict]:
    x = Xref()
    for source_id, idx, method in resolutions:
        x.add("pbdb", source_id, idx, method)
    stats = resolve.refuse_disagreements(
        x,
        taxa,
        idx_to_ott if idx_to_ott is not None else {5: 500, 6: 600},
        set(extinct_ott),
        living,
        ott_rank if ott_rank is not None else {},
    )
    return x, stats


def test_revoke_takes_the_resolution_but_keeps_what_it_withdrew():
    x = Xref()
    x.add("pbdb", "1", 42, "name_exact")
    assert x.revoke("pbdb", "1", resolve.REFUSED_EXTANCY, None)
    row = x.get("pbdb", "1")
    assert row is not None
    assert row.idx is None
    assert row.method == resolve.REFUSED_EXTANCY
    assert row.candidates == [42], "the withdrawn node stays visible"
    assert x.by_method["name_exact"] == 0
    assert x.by_method[resolve.REFUSED_EXTANCY] == 1


def test_revoke_does_not_invent_a_row_or_re_refuse_one():
    x = Xref()
    x.add("pbdb", "1", None, resolve.UNRESOLVED)
    assert not x.revoke("pbdb", "1", resolve.REFUSED_EXTANCY, None)
    assert not x.revoke("pbdb", "nobody", resolve.REFUSED_EXTANCY, None)


def test_an_extinct_taxon_landing_on_a_living_lineage_is_refused():
    """PBDB's Sadleria is a Devonian sponge; OTT's is a living Hawaiian fern."""
    living = np.array([True, True, True, True, True, True], dtype=bool)
    x, stats = _sweep(
        [_taxon(3277, "Sadleria", 0)], [("3277", 5, "name_exact")], living=living
    )
    assert stats["extancy_refused"] == 1
    row = x.get("pbdb", "3277")
    assert row is not None and row.idx is None
    assert row.method == resolve.REFUSED_EXTANCY


def test_a_taxon_ott_also_calls_extinct_keeps_its_node():
    """Tyrannosaurus. The corpora agree, so the name is not in dispute."""
    living = np.array([True] * 6, dtype=bool)
    x, stats = _sweep(
        [_taxon(38613, "Tyrannosaurus", 0)],
        [("38613", 5, "name_exact")],
        extinct_ott=(500,),
        living=living,
    )
    assert stats["extancy_refused"] == 0
    assert x.resolved_idx("pbdb", "38613") == 5


def test_an_unflagged_extinct_genus_on_a_dead_lineage_keeps_its_node():
    """Neochelys, and the 1,162 like it. OTT has not flagged them; the
    chronogram has nothing below them either, which is the guard."""
    living = np.array([True, True, True, True, True, False], dtype=bool)
    x, stats = _sweep(
        [_taxon(37595, "Neochelys", 0)], [("37595", 5, "name_exact")], living=living
    )
    assert stats["extancy_refused"] == 0, "index 5 has no dated descendant"
    assert x.resolved_idx("pbdb", "37595") == 5
    # And the same taxon on a living lineage does lose it, so the guard is what
    # made the difference rather than something else in the row.
    living[5] = True
    x2, stats2 = _sweep(
        [_taxon(37595, "Neochelys", 0)], [("37595", 5, "name_exact")], living=living
    )
    assert stats2["extancy_refused"] == 1
    assert x2.resolved_idx("pbdb", "37595") is None


def test_the_sweep_reaches_every_method_not_just_name_exact():
    """gbif_backbone_provenance supplies 7,191 of these. Id provenance is not
    a defence: the backbone merges the fossil name onto the living genus too."""
    living = np.array([True] * 6, dtype=bool)
    x, stats = _sweep(
        [_taxon(1, "A", 0), _taxon(2, "B", 0)],
        [("1", 5, "gbif_backbone_provenance"), ("2", 5, "gbif_pbdb_chain")],
        living=living,
    )
    assert stats["extancy_refused"] == 2
    assert x.resolved_idx("pbdb", "1") is None
    assert x.resolved_idx("pbdb", "2") is None


def test_an_extant_or_unknown_taxon_is_never_swept():
    """`is_extant` is nullable for a reason — 1.7% are genuinely unknown, and
    unknown is not a claim that the thing is dead."""
    living = np.array([True] * 6, dtype=bool)
    x, stats = _sweep(
        [_taxon(1, "A", 1), _taxon(2, "B", None)],
        [("1", 5, "name_exact"), ("2", 5, "name_exact")],
        living=living,
    )
    assert stats["extancy_refused"] == 0
    assert x.resolved_idx("pbdb", "1") == 5
    assert x.resolved_idx("pbdb", "2") == 5


def test_a_synonym_row_is_swept_too():
    """Ivesia's 538.8 Ma bound rides on a synonym, and `layout_bounds` reads
    every row's attachment without filtering on `is_primary`."""
    living = np.array([True] * 6, dtype=bool)
    x, stats = _sweep(
        [_taxon(121434, "Ivesia", 0, accepted_no=999)],
        [("121434", 5, "name_exact")],
        living=living,
    )
    assert stats["extancy_refused"] == 1
    assert x.resolved_idx("pbdb", "121434") is None


def test_the_sweep_does_nothing_without_phase_2():
    """No `age_ma`, no way to tell a lineage that ended from one that did not.
    Refusing on OTT's flag alone would cost 1,162 correct attachments."""
    x, stats = _sweep(
        [_taxon(3277, "Sadleria", 0)], [("3277", 5, "name_exact")], living=None
    )
    assert stats["extancy_skipped"]
    assert stats["extancy_refused"] == 0
    assert x.resolved_idx("pbdb", "3277") == 5


def test_two_accepted_taxa_of_one_name_both_lose_it():
    """PBDB carries homonyms internally — 1,429 names — and each matched the
    same single OTT node. At most one can be right and nothing says which."""
    living = np.array([True] * 6, dtype=bool)
    x, stats = _sweep(
        [_taxon(1, "Anomalina", None), _taxon(2, "Anomalina", None)],
        [("1", 5, "name_exact"), ("2", 5, "name_exact")],
        living=living,
    )
    assert stats["ambiguous_names"] == 1
    assert stats["ambiguous_refused"] == 2
    assert x.resolved_idx("pbdb", "1") is None
    second = x.get("pbdb", "2")
    assert second is not None and second.method == resolve.REFUSED_AMBIGUOUS


def test_the_extancy_sweep_runs_first_so_scopus_keeps_its_hamerkop():
    """The order is the whole reason the correct resolution survives. Both
    PBDB `Scopus` rows matched OTT's hamerkop; the extancy sweep takes the
    Permian one, one claimant is left, and the ambiguity refusal has nothing
    to refuse. Reversed, it would have thrown away both."""
    living = np.array([True] * 6, dtype=bool)
    x, stats = _sweep(
        [_taxon(39639, "Scopus", 1), _taxon(57557, "Scopus", 0)],
        [("39639", 5, "name_exact"), ("57557", 5, "name_exact")],
        living=living,
    )
    assert stats["extancy_refused"] == 1
    assert stats["ambiguous_refused"] == 0
    assert x.resolved_idx("pbdb", "39639") == 5, "the hamerkop"
    assert x.resolved_idx("pbdb", "57557") is None, "the Permian genus"


def test_a_suprageneric_taxon_landing_on_a_genus_is_refused():
    """Eutheria. GBIF's backbone matched the placental clade to a leaf-beetle
    genus and 1,191 fossils followed it into Coleoptera."""
    x, stats = _sweep(
        [_taxon(137726, "Eutheria", 1, rank="unranked clade")],
        [("137726", 5, "gbif_pbdb_chain")],
        ott_rank={5: "genus"},
    )
    assert stats["rank_refused"] == 1
    row = x.get("pbdb", "137726")
    assert row is not None and row.idx is None
    assert row.method == resolve.REFUSED_RANK
    assert row.candidates == [5], "the withdrawn node stays visible"


def test_rank_catches_what_extancy_structurally_cannot():
    """The reason this refusal exists at all. A clade holding living species is
    flagged extant, so the extancy sweep is blind to it by construction — and
    every one of these passed it."""
    living = np.array([True] * 6, dtype=bool)
    x, stats = _sweep(
        [_taxon(5113, "Rugosa", 1, rank="order")],
        [("5113", 5, "name_exact")],
        living=living,
        ott_rank={5: "genus"},
    )
    assert stats["extancy_refused"] == 0, "PBDB calls it extant, so extancy passes"
    assert stats["rank_refused"] == 1
    assert x.resolved_idx("pbdb", "5113") is None


def test_rank_runs_before_ambiguity_so_cytherelloidea_keeps_its_genus():
    """The `Scopus` argument, for rank. PBDB's ostracod genus and PBDB's
    superfamily of that name both reached OTT's genus; only the superfamily is
    wrong, and refusing it leaves one claimant rather than none."""
    living = np.array([True] * 6, dtype=bool)
    x, stats = _sweep(
        [
            _taxon(24714, "Cytherelloidea", 1, rank="genus"),
            _taxon(187297, "Cytherelloidea", 1, rank="superfamily"),
        ],
        [("24714", 5, "gbif_pbdb_chain"), ("187297", 5, "name_exact")],
        living=living,
        ott_rank={5: "genus"},
    )
    assert stats["rank_refused"] == 1
    assert stats["ambiguous_refused"] == 0
    assert x.resolved_idx("pbdb", "24714") == 5, "the genus"
    assert x.resolved_idx("pbdb", "187297") is None, "the superfamily"


def test_a_suprageneric_node_is_a_fine_home_for_a_suprageneric_taxon():
    """Only the crossing is refused. An OTT `section` is suprageneric in
    zoology and every one this corpus reaches is zoological — Schizophora at
    56,619 tips, Eubrachyura at 8,465 — so reading it as botanical would
    withdraw three correct resolutions."""
    x, stats = _sweep(
        [
            _taxon(129039, "Eubrachyura", 1, rank="infraorder"),
            _taxon(1, "Anything", 1, rank="family"),
        ],
        [("129039", 5, "name_exact"), ("1", 6, "name_exact")],
        ott_rank={5: "section", 6: "no rank"},
    )
    assert stats["rank_refused"] == 0
    assert x.resolved_idx("pbdb", "129039") == 5
    assert x.resolved_idx("pbdb", "1") == 6, "unranked is where a clade name lands"


def test_a_genus_reaching_a_higher_node_is_left_alone():
    """One direction only. A PBDB genus or species on a family is GBIF and OTT
    filing a name they cannot place at its container, which is where the fossil
    belongs anyway — Hesperopithecus haroldcookii really is a peccary."""
    x, stats = _sweep(
        [_taxon(1, "Hesperopithecus haroldcookii", 0, rank="species")],
        [("1", 5, "gbif_backbone_provenance")],
        ott_rank={5: "family"},
    )
    assert stats["rank_refused"] == 0
    assert x.resolved_idx("pbdb", "1") == 5


def test_a_rank_in_neither_set_never_refuses():
    """`informal` and one blank row. The sweep destroys resolutions, so a rank
    it cannot place must not read as evidence against one."""
    x, stats = _sweep(
        [_taxon(1, "A", 1, rank="informal"), _taxon(2, "B", 1, rank="")],
        [("1", 5, "name_exact"), ("2", 5, "name_exact")],
        ott_rank={5: "genus"},
    )
    assert stats["rank_refused"] == 0
    assert stats["rank_unclassified"] == 2
    assert x.resolved_idx("pbdb", "1") == 5


def test_the_two_rank_sets_do_not_overlap():
    assert not (resolve.PBDB_ABOVE_GENUS & resolve.PBDB_GENUS_OR_BELOW)
    assert "section" not in resolve.OTT_GENUS_OR_BELOW, "zoological, suprageneric"
    assert "no rank" not in resolve.OTT_GENUS_OR_BELOW, "where a clade name lands"


def test_a_refusal_carries_a_confidence_and_resolves_to_nothing():
    for m in resolve.REFUSALS:
        assert CONFIDENCE[m] == 0.0
        assert m not in METHOD_ORDER, "a refusal is not a claimant in precedence"


def test_a_manual_override_is_exempt_from_the_sweep():
    """Two rows in this build are somebody's reviewed judgement, and a gate
    fails the build if one stops applying. A sweep overruling one quietly is
    the same class of bug that gate was written to catch."""
    living = np.array([True] * 6, dtype=bool)
    x, stats = _sweep([_taxon(1, "A", 0)], [("1", 5, "manual")], living=living)
    assert stats["extancy_refused"] == 0
    assert x.resolved_idx("pbdb", "1") == 5
