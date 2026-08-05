"""Phase 0 — pin and snapshot upstream sources.

Ordering is deliberate. The GBIF legacy backbone goes first: it was frozen
2023-08-28, GBIF has moved on to Catalogue of Life Extended Release, and it is
the only identifier path from PBDB to OTT. Everything else here is either
actively maintained or already versioned, so it can wait.

Nothing in `snapshot/` is ever modified after write.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

from . import gbif_checklist, provenance
from .gates import GateSet
from .paths import SNAPSHOT
from .provenance import Manifest, fetch, record_local

if TYPE_CHECKING:
    import httpx

    from .typing_ import JsonDict

OTT_SYNTH = "https://files.opentreeoflife.org/synthesis/opentree16.1"
OTT_TAX = "https://files.opentreeoflife.org/ott/ott3.7.3"
GBIF_BACKBONE = "https://hosted-datasets.gbif.org/datasets/backbone/2023-08-28"
ZENODO_RECORD = "19049120"

# Sizes measured 2026-07-31 (docs/data-sources.md). A mismatch is reported but
# does not fail the phase on its own — the SHA-256 is the real identity.
DOWNLOADS: list[JsonDict] = [
    # --- decaying sources, captured first -------------------------------
    {
        "name": "gbif_legacy_backbone_simple",
        "url": f"{GBIF_BACKBONE}/simple.txt.gz",
        "rel": "gbif_legacy_backbone/simple.txt.gz",
        "note": (
            "GBIF backbone frozen 2023-08-28, never to be updated. Headerless "
            "TSV. The only identifier path from PBDB to OTT runs through this."
        ),
    },
    {
        "name": "gbif_legacy_backbone_readme",
        "url": f"{GBIF_BACKBONE}/README.html",
        "rel": "gbif_legacy_backbone/README.html",
        "note": "Release notes for the frozen backbone; records its CoL July 2023 basis.",
    },
    {
        "name": "gbif_pbdb_checklist_dwca",
        "url": "https://hosted-datasets.gbif.org/datasets/pbdb.zip",
        "rel": "gbif_pbdb_checklist/pbdb.zip",
        "note": (
            "PBDB checklist ColDP archive, 518,442 rows — not a Darwin Core "
            "archive of 461,889, which is GBIF's ingested count. Preserves "
            "PBDB taxon_no verbatim in taxonID (col:ID is txn:38613). "
            "Carries no nubKey — see the API export."
        ),
    },
    # --- Open Tree ------------------------------------------------------
    {
        "name": "opentree16.1_tree",
        "url": f"{OTT_SYNTH}/opentree16.1_tree.tgz",
        "rel": "opentree/opentree16.1_tree.tgz",
        "expect_bytes": 41_608_973,
        "note": "labelled_supertree.tre and friends. Phase 1 input.",
    },
    {
        "name": "opentree16.1_output",
        "url": f"{OTT_SYNTH}/opentree16.1_output.tgz",
        "rel": "opentree/opentree16.1_output.tgz",
        "note": "Full synthesis output; carries broken_taxa.json (259 MB) for phase 1 step 7.",
    },
    {
        "name": "ott3.7.3",
        "url": f"{OTT_TAX}/ott3.7.3.tgz",
        "rel": "opentree/ott3.7.3.tgz",
        "expect_bytes": 111_278_327,
        "note": "taxonomy.tsv, synonyms.tsv, forwards.tsv (297,070 entries).",
    },
    {
        "name": "ott3.7.3_properties",
        "url": f"{OTT_TAX}/properties.json",
        "rel": "opentree/ott3.7.3_properties.json",
        "note": 'Declares "legal": "cc0" and the upstream source versions.',
    },
    # --- Duke et al. dated trees (phase 2 decision gate) ----------------
    {
        "name": "duke_equal_splits_median_tree",
        "url": (
            "https://zenodo.org/api/records/"
            f"{ZENODO_RECORD}/files/equal_splits_median_tree.tre/content"
        ),
        "rel": "duke2026/equal_splits_median_tree.tre",
        "expect_bytes": 145_750_830,
        "note": "Zenodo 10.5281/zenodo.19049120, CC-BY-4.0. md5:8c667dc557b17bbd8e33d9867c347e9a",
    },
    {
        "name": "duke_birth_model_median_tree",
        "url": (
            "https://zenodo.org/api/records/"
            f"{ZENODO_RECORD}/files/birth_model_median_tree.tre/content"
        ),
        "rel": "duke2026/birth_model_median_tree.tre",
        "expect_bytes": 146_184_627,
        "note": "Comparison layer. md5:a01b2f8290bc10c750a74c9a33eb02fa",
    },
    # --- timescale ------------------------------------------------------
    {
        "name": "ics_chart_ttl",
        "url": "https://raw.githubusercontent.com/i-c-stratigraphy/chart/main/chart.ttl",
        "rel": "ics/chart.ttl",
        "note": "ICS v2026/06, CC-BY-4.0. Cite Cohen et al., Episodes 2025;48:105-115.",
    },
]

PBDB_TAXA_URL = (
    "https://paleobiodb.org/data1.2/taxa/list.csv"
    "?all_records&show=app,attr,parent,size,seq&limit=all"
)
PBDB_DATAINFO_URL = (
    "https://paleobiodb.org/data1.2/taxa/list.json?all_records&limit=1&datainfo"
)


def _zenodo_metadata(client: httpx.Client, dest: Path) -> JsonDict:
    r = client.get(f"https://zenodo.org/api/records/{ZENODO_RECORD}")
    r.raise_for_status()
    d = r.json()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(d, indent=2) + "\n")
    return d


def run(skip_checklist: bool = False, force: bool = False) -> int:
    g = GateSet("phase0-snapshot")
    m = Manifest()
    SNAPSHOT.mkdir(parents=True, exist_ok=True)

    with provenance.client() as client:
        # Gate first: if the live API has moved past v16.1, later phases'
        # oracle checks compare against a tree we did not build from.
        about = client.post(
            "https://api.opentreeoflife.org/v3/tree_of_life/about", json={}
        )
        about.raise_for_status()
        a = about.json()
        m.meta |= {
            "synth_id": a.get("synth_id"),
            "taxonomy_version": a.get("taxonomy_version"),
            "synth_date_created": a.get("date_created"),
            "num_source_studies": a.get("num_source_studies"),
            "num_source_trees": a.get("num_source_trees"),
        }
        g.require("live API synth_id", a.get("synth_id"), "opentree16.1")
        g.require("live API taxonomy_version", a.get("taxonomy_version"), "3.7draft3")
        g.observe("live API date_created", a.get("date_created"), "2025-12-20 …")

        print("\n--- downloads ---", flush=True)
        for spec in DOWNLOADS:
            fetch(
                client,
                m,
                name=spec["name"],
                url=spec["url"],
                dest=SNAPSHOT / spec["rel"],
                expect_bytes=spec.get("expect_bytes"),
                note=spec.get("note", ""),
                force=force,
            )
            m.write()

        print("\n--- Zenodo deposit metadata ---", flush=True)
        z = _zenodo_metadata(client, SNAPSHOT / "duke2026" / "zenodo_record.json")
        record_local(
            m,
            name="duke_zenodo_record",
            path=SNAPSHOT / "duke2026" / "zenodo_record.json",
            url=f"https://zenodo.org/api/records/{ZENODO_RECORD}",
            note="Deposit metadata incl. per-file md5 and license.",
        )
        g.require(
            "Duke deposit license",
            (z.get("metadata") or {}).get("license", {}).get("id"),
            "cc-by-4.0",
        )

        print("\n--- PBDB taxa export (~110 MB, ~64 s) ---", flush=True)
        fetch(
            client,
            m,
            name="pbdb_taxa",
            url=PBDB_TAXA_URL,
            dest=SNAPSHOT / "pbdb" / "pbdb_taxa.csv",
            note="523,113 rows. show=seq adds lft/rgt nested-set bounds.",
            force=force,
        )
        di = client.get(PBDB_DATAINFO_URL)
        di.raise_for_status()
        (SNAPSHOT / "pbdb" / "datainfo.json").write_text(
            json.dumps(di.json(), indent=2) + "\n"
        )
        record_local(
            m,
            name="pbdb_datainfo",
            path=SNAPSHOT / "pbdb" / "datainfo.json",
            url=PBDB_DATAINFO_URL,
            note=(
                "Embeds access timestamp, license declaration and a re-runnable "
                "data_url. This block IS the citation PBDB asks for."
            ),
        )
        g.observe(
            "PBDB declared license",
            di.json().get("data_license", "<absent>"),
            "CC0 per API &datainfo",
            note="Site FAQ contradicts this; confirm before any commercial use.",
        )
        m.write()

        if not skip_checklist:
            print("\n--- GBIF checklist nubKey export ---", flush=True)
            dest = SNAPSHOT / "gbif_pbdb_checklist" / "checklist_nubkeys.jsonl"
            report = gbif_checklist.export(client, dest)
            record_local(
                m,
                name="gbif_pbdb_checklist_nubkeys",
                path=dest,
                url=f"{gbif_checklist.SEARCH}?datasetKey={gbif_checklist.PBDB_DATASET_KEY}",
                note=(
                    "taxonID → nubKey, sharded around GBIF's 100k offset cap. "
                    + json.dumps(report)
                ),
            )
            m.meta["gbif_checklist_report"] = report
            g.require(
                "GBIF checklist records exported",
                report["records_exported"],
                report["api_total"],
                ok=report["missing"] <= 0,
                note="Distinct GBIF keys must cover the API's own total.",
            )
            g.observe(
                "GBIF checklist rows carrying nubKey",
                f"{report['with_nub_key']:,} ({report['nub_key_pct']}%)",
                "~88% reach a nubKey (docs §4)",
            )

    # Every artifact carries a digest by construction; assert it anyway.
    missing = [a.name for a in m.artifacts.values() if not a.sha256]
    g.require("artifacts without SHA-256", missing, [])
    g.observe(
        "total snapshot bytes",
        f"{sum(a.bytes for a in m.artifacts.values()):,}",
    )

    m.meta["phase0_gates_ok"] = g.ok
    m.write()
    g.write(Path(SNAPSHOT.parent) / "build" / "phase0_gates.json")
    g.exit_if_failed()
    return 0
