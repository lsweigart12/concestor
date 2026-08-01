"""Unit tests for the phase 3 resolution layer.

The expensive halves — a 7.7M-row backbone scan and a paced API crawl — are
exercised against small synthetic inputs here. The gates in `resolve.run` cover
the real files; these cover the logic that decides what the gates measure.
"""

import gzip
import json
import sqlite3

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
    import numpy as np

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
    import numpy as np

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
