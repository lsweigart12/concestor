# Data sources: verified facts and corrections

Facts checked against the live API, file server, or data file on 2026-07-31. Where a
project's own prose disagrees with its machine-generated artifacts, the artifact wins.
Read this before the architecture doc.

---

## Dating: use the Duke et al. dated tree

**Duke et al. (2026), "Assembling a fully-dated complete tree of life."** bioRxiv
`doi:10.64898/2026.03.05.709771`.

- Built on **Open Tree synthesis v16.1** (`labelled_supertree_ottnames.tre`) and
  **OTT 3.7.3** — every tip and internal node is keyed by OTT id.
- Root fixed at 4247 Ma. Dates harvested from published chronograms via `chronosynth`.
- **Data: Zenodo `doi:10.5281/zenodo.19049120`, CC-BY.**
  `equal_splits_median_tree.tre` (145.8 MB), `birth_model_median_tree.tre` (146.2 MB).
- **Code:** `github.com/jdduke24/dated-complete-tree`, BSD-3. Ships
  `interpolate_newick.py` (linear-time BLADJ replacement) and a cached `node_ages.json`
  recording which nodes got ages from matched chronograms (`measured`) vs interpolation.

This eliminates the graft-dates-onto-OTT pipeline that would otherwise be the hardest,
least defensible part of the build. Phase 2 validated it: the join measured 99.93% with
no forward-chasing needed.

## TimeTree cannot be shipped

TimeTree's terms: data are for "personal research and teaching use" only, and
**"redistribution of TimeTree data and its transformations are not permitted."** A tree
carrying grafted TimeTree ages is a transformation. No public bulk download exists.
**Excluded from the architecture entirely.**

## Extinct taxa are mostly absent from the synthetic tree

`extinct` is not one of OTT's 11 hard suppression flags (it sits in
`additional_regrafting_flags`), so extinct taxa *can* appear — but rarely:

| Flag | Taxa in OTT 3.7.3 | Present in synth tree | % |
|---|---:|---:|---:|
| `extinct` | 221,717 | 1,129 | **0.5%** |
| `extinct_inherited` | 91,584 | 614 | **0.7%** |
| (no flags at all) | 2,123,462 | 2,114,889 | 99.6% |

Membership is not predictable from flags: *T. rex* (ott664349) resolves; *Triceratops*
(ott4947055) has an identical flag set and returns `pruned_ott_id`. **The fossil layer
is the only way ~99.5% of the fossil record appears in the app.** Attach fossils to a
branch, not as tree siblings.

Related trap: `taxonomy/taxon_info` returns `is_suppressed_from_synth: false` for
*Triceratops*, which is absent from synthesis. **Do not trust that field.**

## PBDB → OTT resolves by identifier, not just by name

GBIF's PBDB checklist preserves PBDB's `taxon_no` verbatim in `taxonID`. The chain is
`PBDB taxon_no → GBIF checklist taxonID → nubKey → OTT gbif: source id`. Measured yield
(uniform sample of 253 checklist records): 92.9% reach a `nubKey`, 51.9% of those resolve
in OTT → **48.2% end to end** (phase 3 gates on this).

Decay warnings — capture as a snapshot, do not depend live:
- The chain runs on GBIF's **legacy backbone, frozen 2023-08-28**. GBIF now defaults to
  Catalogue of Life Extended Release, where PBDB is reduced to 24,656 names.
- OTT's GBIF snapshot is Sept 2019 vs the 2023 backbone; that skew is most of the
  second-hop loss.
- **Ceiling:** GBIF's backbone has 11 ranks against PBDB's 25, so 32,629 PBDB taxa
  (6.2%) — subgenus, subfamily, superfamily, suborder, tribe — are unmatchable by
  construction, and they skew notable.

Related:
- **OTT does not ingest PBDB.** `source_id:pbdb:*` is unknown to the API. No PBDB id
  survives the trip; OTT's `extinct` flag is PBDB-derived but laundered through GBIF.
- **Do not route fossils through NCBI** — only 0.47% of fossil Wikidata items carry both
  a PBDB/Fossilworks id and an NCBI id.
- **Wikidata is a viable secondary hub:** P10907 (PBDB taxon ID) and **P842 (Fossilworks
  taxon ID)** share one namespace; union is 114,185 items. OTT is property P9157 (~2.03M).
- **Name fallback is unsafe:** 16% of PBDB genus names resolve to multiple GBIF keys,
  including cross-kingdom homonyms. Authorship does not save you (PBDB ships
  `Tyranosaurus rex Osborn, 1905`, sic).
- **`pbdb.zip`** is a ColDP archive dated 2026-07-26 with 518,442 rows (not a Darwin Core
  archive of 461,889 — that is GBIF's *ingested* checklist count). Do **not** join
  against the ColDP for the backbone path: its compound synonym ids silently map a
  synonym onto the accepted taxon's number, so that join goes against `pbdb_taxa.csv`.

## PhyloPic resolves internal-node thumbnails server-side and speaks OTT

- **OTT is a supported resolve namespace:**
  `/resolve/opentreeoflife.org/taxonomy/{ott_id}` → 308 to the node. (`/ott/` 404s.)
  `paleobiodb.org/txn` is also supported.
- **`primaryImage` is populated even for nodes with zero images of their own**, by
  climbing to the nearest ancestor whose clade contains images. Effective ~100% coverage;
  internal-node coverage 88.6%, leaf 94.0%.
- **Corrections:** stale `build` values return **`410 Gone`** (current build is in the
  error body — retry from that), and **`primaryImage` ignores license filters entirely**.
  For anything commercial, use
  `/images?filter_clade={uuid}&filter_license_nc=false&page=0&embed_items=true` and take
  item 0 (93.7% coverage); walk `/lineage` for the remainder.

- **A PhyloPic node's name is not a key, and the synthesis tree cannot tell you
  that.** 1,783 images cite no OTT id and are reachable only through
  `node_title`, so the name pass is load-bearing — but a name has to be
  unambiguous in **OTT**, not in synthesis. Synthesis carries a small fraction
  of OTT, so when two kingdoms share a name the other kingdom is usually the
  one missing: of 350 homonyms among the names this build looks up, only 11
  resolve two ways *in the tree*. Testing there reports no ambiguity precisely
  when the wrong answer is about to be used, and it put a wheatear on the
  celery genus *Oenanthe* (issue #137), a fig on a sea snail, an anthrax
  bacillus on a stick insect, a stinging wasp on a fungus and a cholera
  vibrio on a diatom. **The image's own citation settles it**: 20 of the 22
  homonym seeds that carried an OTT id were contradicted by that id. OTT marks
  these itself in `uniqname` — `Oenanthe (genus in kingdom Archaeplastida)`
  against `Oenanthe (genus in Opisthokonta)`.

Corpus: 12,863 images, 24,007 nodes, 883 contributors, ~150 MB mirrored. License:
CC0 51.8%, CC-BY 4.0 18.9%, CC-BY-SA 3.0 9.3%, CC-BY 3.0 8.2%, Public Domain Mark 6.0%,
CC-BY-NC 3.0 3.3%, CC-BY-NC-SA 3.0 2.5%. Attribution is two fields: `attribution` is the
**original creator**, `_links.contributor.title` the **uploader** — they differ 50.0% of
the time. `attribution` is null 19.3% overall but **0% null among images that require
attribution**, so render it whenever the license demands BY.

---

## Facts worth designing against

### Tree shape (computed directly — published nowhere)

- **2,725,682 nodes**: 2,385,875 tips + 339,807 internal.
- **2,295,972 are `rank='species'`**; **2,599,664 carry a name** (the searchable set —
  the FTS index filters on neither tip-ness nor rank). **A tip is not a species:** 171,623
  nodes are genera, 8,841 families, and tips include subspecies, varieties, cultivars and
  1,615 group-rank terminals.
- **Root-to-tip depth**: min 2, **mean 41.32 over tips**, max 111. (Mean over internal
  nodes is 44.14, over everything 41.67 — say which population before quoting one.)
- **Branching factor**: mean 8.02, **max 12,964**. A node with ~13,000 children breaks
  any UI assuming small fanout.
- **24.5% of internal nodes are unary** (one child); 31.2% polytomous; 44.3% bifurcating.

### Only 6.7% of the tree is phylogenetically placed

159,925 of 2,385,875 tips come from phylogeny; ~2.23M from taxonomy alone. Any dated
version is overwhelmingly interpolating ages onto taxonomy-derived structure. **The UI
must be honest about this** — see the architecture doc's provenance tiers.

### Broken taxa

**9,839 taxa are non-monophyletic** in v16.1. The API substitutes a synth node for them
**silently in `mrca`** (no `broken` field) and explicitly in `induced_subtree` (a
`broken` map). Full list in `broken_taxa.json` under `non_monophyletic_taxa`. If someone
searches a broken taxon, explain it rather than quietly answering a different question.

### PBDB appearance intervals are two brackets, not a range

```json
{"firstapp_max_ma":83.6,"firstapp_min_ma":72.2,"lastapp_max_ma":72.2,"lastapp_min_ma":66}
```

First appearance is *somewhere* in `fea`–`fla`; last in `lea`–`lla`. Render `fea→lla` as
a faded envelope (maximal possible extent) and `fla→lea` solid (minimal certain extent).
These are database-derived, not true fossil-record ranges.

**Coverage: 411,039 / 523,112 = 78.6% of PBDB names have appearance intervals.** The
missing set is essentially those with `n_occs = 0`. `is_extant` is not binary: extinct
80.4%, extant 17.9%, **blank 1.7%**.

### PBDB identity has three ids

- `orig_no` — stable concept id, constant across spellings and ranks
- `taxon_no` — the specific variant (spelling/rank) selected
- `accepted_no` — where the name should redirect

**10.1% of records have `accepted_no != orig_no`.** `accepted_rank` can differ from
`taxon_rank` — *Aublysodon* is a genus whose accepted name is a family
(Tyrannosauridae), which breaks naive rank-based grouping. Always display
`accepted_name`, key on `accepted_no`, check `difference` for the reason.

Bulk snapshot: `taxa/list.csv?all_records&show=app,attr,parent,size&limit=all` → 110 MB,
523,113 rows, 64 s. `show=seq` adds `lft`/`rgt` nested-set bounds. The compact field
`ext` is `is_extant`, not "external".

### Geologic timescale: use `chart.ttl`

`github.com/i-c-stratigraphy/chart` → `chart.ttl`, 642 KB, **CC-BY-4.0**, version
`2026-06`. 178 concepts; 100% have color, numeric age and rank; 176 have `skos:broader`.
Includes `sh:order` for draw order. Parse once at build into ~40 KB JSON — do not ship an
RDF parser to the browser or fetch from `raw.githubusercontent.com` at runtime. ICS
updates roughly annually, so a pinned snapshot beats a live API.

---

## Operational cautions

- `files.opentreeoflife.org/synthesis/current/` **is frozen at 2016** (serves
  `current_tree.tgz` dated 2016-11-28). Never pin to it — resolve the version from the
  API's `synth_id` and pin `opentree16.1` explicitly.
- **OTT id forwarding is silent** — `forwards.tsv` has 297,070 entries and the API
  follows them with no indication. Always compare the returned `ott_id` against what you
  sent, and chase forwards **transitively** (they can chain).
- **Broken-taxon substitution is silent in `mrca`** — a broken taxon returns an MRCA for
  a different query with no `broken` field.
- **The Open Tree API has no rate limiting because nobody implemented it.** It is one
  `waitress` process behind a small academic project. Pace requests; it is a build-time
  oracle only, never a runtime dependency.
- **GBIF caps paging at offset 100,000.** For bulk work, shard and prove coverage by
  counting distinct keys. (The PBDB fossil path uses per-taxon point lookups, which avoid
  the cap entirely.)
- **Never point treePL or `ape::chronos` at a branch-length-free topology.** treePL does
  not error — it floors every branch at `1/numsites`, giving every branch one
  substitution, and emits a confident dated tree containing zero rate information.
- PhyloPic URLs *with* the current build are `immutable`, 1-year cacheable; the build-less
  307 is `max-age=300`. Cache keyed by build; on 410 read the new build from the error
  body.
- Wikimedia: **10 req/min unidentified, 200 with a real User-Agent**, 50 titles per
  batch; thumbnails render only at widths {120, 250, 330, 500, 960, 1280, 1920}.

## Licensing summary

| Source | License | Notes |
|---|---|---|
| Open Tree (synthesis + taxonomy) | **CC0** | Does not relicense upstream sources |
| Duke et al. dated trees | **CC-BY** | Zenodo deposit |
| PBDB | **CC0** per API `&datainfo` | Site contradicts itself; confirm if commercial |
| ICS `chart.ttl` | **CC-BY 4.0** | Cite Cohen et al., *Episodes* 2025;48:105-115 |
| PhyloPic | **mixed** | 5.8% NonCommercial, 11.8% ShareAlike. Filterable |
| TimeTree | **redistribution prohibited** | Excluded |
| Wikimedia Commons | mixed, all commercial-OK | ~75% require attribution |
| GBIF media | per-record enum | Filter on record-level `license`, never `media[].license` |

PBDB's license is genuinely contradictory across its own surfaces; the API declaration
(CC0) is most authoritative but worth a confirming email to `admin@paleobiodb.org` before
any commercial launch.
