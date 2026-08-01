# Data sources: verified facts and corrections

Every figure here was checked against the live API, file server, or the actual data
file during research on 2026-07-31. Where a project's own prose disagrees with its
machine-generated artifacts, the artifact wins and the discrepancy is noted.

Read this before the architecture doc. Five of the corrections below change the
design rather than just the numbers.

---

## The five findings that change the design

### 1. The dating problem is already solved, and the solution is OTT-keyed

**Duke, Guo, Forest, Gumbs, McTavish & Rosindell (2026), "Assembling a fully-dated
complete tree of life."** bioRxiv `doi:10.64898/2026.03.05.709771`, v1 2026-03-05.

- Built directly on **Open Tree synthesis v16.1** (`labelled_supertree_ottnames.tre`)
  and **OTT 3.7.3** — every tip and internal node is already keyed by OTT id.
- Dates harvested from published chronograms via `chronosynth` against a December 2025
  phylesystem snapshot. Root fixed at 4247 Ma.
- Introduces linear-time interpolation ("equal splits least squares" and a "birth
  model") because BLADJ is quadratic and would need roughly 50 TB of RAM at 2.3M
  species. The full tree interpolates in **26 seconds**.
- **Data: Zenodo `doi:10.5281/zenodo.19049120`, CC-BY.**
  `equal_splits_median_tree.tre` (145.8 MB), `birth_model_median_tree.tre` (146.2 MB),
  plus tree distributions up to 65.7 GB.
- **Code:** `github.com/jdduke24/dated-complete-tree`, BSD-3, last push 2026-07-17.
  Ships `interpolate_newick.py` as a drop-in replacement for `phylocom bladj`, plus a
  cached `node_ages.json` so you need not run chronosynth yourself.

This eliminates the entire "graft dates from VertLife/FishTree/ALLMB onto OTT" pipeline,
which was going to be the hardest and least defensible part of the build. That pipeline
required congruification (matching nodes between incongruent topologies by hashing
shared-taxon sets, `geiger::congruify.phylo`) followed by BLADJ interpolation, with
every step introducing silent failure modes. It is now a fallback, not a requirement.

Caveat carried from research: bioRxiv blocks automated fetching, so the preprint
internals came from Zenodo, Europe PMC, and GitHub metadata rather than a direct read.
There is an unresolved source-tree count discrepancy (280 vs 334). **Phase 2 did the
validation this paragraph used to ask for, and the discrepancy is not load-bearing**: it
concerns which published chronograms fed the authors' date harvest, not whether their
tree joins to ours, and the join measured 99.93% with no forward-chasing needed. Settled
in [phase2-decision.md](phase2-decision.md); nothing here needs re-checking.

### 2. TimeTree cannot be shipped

From the TimeTree FAQ and site footer: data are provided *"openly for personal research
and teaching use"*, all other purposes require written permission, and — decisively —
**"redistribution of TimeTree data and its transformations are not permitted."**

A tree carrying grafted TimeTree ages is a transformation. The CC-BY license on the
Kumar et al. 2022 paper does not extend to the data. There is also no public bulk
download: the FAQ says to email `info@timetree.org` for the complete tree.

Additional corrections: the documented API host `timetree.temple.edu/api` **returns 404
on every route** — the published paper's URL is dead. The working host is
`timetree.org/api` with three routes (`/pairwise/`, `/mrca`, `/timeline`), JSON only.
The `timetree` R package was removed from CRAN on 2022-05-30.

**Drop TimeTree from the architecture entirely.** It is the best-identified source
(NCBI taxids, joins to OTT for free) and the one you are least permitted to use.

### 3. Extinct taxa are mostly absent from the synthetic tree, which validates the
    PBDB-as-branch-annotation design

Your instinct to attach fossil taxa to a branch rather than resolve them as siblings
was right, and the numbers are more extreme than "no comprehensive topology exists."

`extinct` is *not* one of OTT's 11 hard suppression flags — it sits in
`additional_regrafting_flags`. So extinct taxa *can* appear, and some do: *Tyrannosaurus
rex* (ott664349), the dodo (ott455687), and *Mammuthus primigenius* (ott106258) are all
present as tips. But across the full taxonomy:

| Flag | Taxa in OTT 3.7.3 | Present in synth tree | % |
|---|---:|---:|---:|
| `extinct` | 221,717 | 1,129 | **0.5%** |
| `extinct_inherited` | 91,584 | 614 | **0.7%** |
| (no flags at all) | 2,123,462 | 2,114,889 | 99.6% |

An OTT id flagged `extinct` has roughly a **1-in-200** chance of resolving in the tree,
and membership is not predictable from flags: *Triceratops* (ott4947055) has an
*identical* flag set to *T. rex* and returns `{"reason": "pruned_ott_id"}`.

So the fossil layer is not a nice-to-have that fills gaps in an otherwise complete
tree. It is the *only* way ~99.5% of the fossil record appears in this application at
all. Design accordingly.

Related trap: `taxonomy/taxon_info` returns `"is_suppressed_from_synth": false` for
*Triceratops*, which is absent from synthesis. **Do not trust that field.**

### 4. A real identifier path exists from PBDB to OTT — not just name strings

You assumed the reconciliation layer would be needed because fuzzy matching at query
time is unacceptable. Correct, but the layer has more to work with than expected.

GBIF's PBDB checklist preserves PBDB's `taxon_no` verbatim in `taxonID`. Verified
end to end:

```
PBDB   txn:38613  "Tyrannosaurus"
GBIF   {"key":121494660, "nubKey":4822631, "taxonID":"38613"}
OTT    {"ott_id":664348, "tax_sources":["ncbi:436494","gbif:4822631","irmng:1206683"]}
```

So the chain is `PBDB taxon_no → GBIF checklist taxonID → nubKey → OTT gbif: source id`.
Measured yield on 120 random PBDB-checklist records: 88% reach a GBIF `nubKey`, 68% of
those resolve in OTT → **~59% end to end** (~90% for well-known taxa).

> **Superseded 2026-07-31 by a larger sample — see
> [phase3-pbdb-path.md](phase3-pbdb-path.md) §5.** On 253 checklist records:
> **92.9%** reach a `nubKey` (better than recorded) but only **51.9%** of those
> resolve in OTT (materially worse) → **48.2% end to end**. Phase 3's gate uses
> 48.2%. Also note a hard ceiling this finding does not mention: GBIF's backbone
> has 11 ranks against PBDB's 25, so 32,629 PBDB taxa (6.2%) — subgenus,
> subfamily, superfamily, suborder, tribe — are unmatchable by construction, and
> they skew toward the notable end.

Two decay warnings. The chain depends on GBIF's **legacy backbone, frozen 2023-08-28
and never to be updated**; GBIF now defaults to Catalogue of Life Extended Release,
where PBDB is reduced to 24,656 names from a Feb 2018 snapshot. And OTT's GBIF snapshot
is from Sept 2019 while the legacy backbone is 2023 — the version skew is most of the
32% loss at the second hop. Both endpoints still resolve today. Treat this as a
snapshot to capture now, not a live service to depend on.

Corrections to related assumptions:
- **OTT does not ingest PBDB.** `{"source_id":"pbdb:38613"}` → *"IDs from source pbdb
  are not known or not indexed."* Census of 60 fossil taxa: `gbif:56, irmng:53, ncbi:4,
  worms:4, pbdb:0`.
- **IRMNG is not the bridge you hoped.** It *is* a source for both GBIF and OTT and does
  cover extinct genera, but it does not cite PBDB or store PBDB ids. What IRMNG-adjacent
  machinery actually provides is the `extinct` *flag*: OTT's flag is PBDB-derived,
  laundered through GBIF (`process_gbif_taxonomy.py` hardcodes the PBDB checklist UUID
  to build `paleo.tsv`). PBDB decides which OTT taxa are extinct; no PBDB identifier
  survives the trip.
- **Do not route fossils through NCBI.** Wikidata items carrying both a PBDB/Fossilworks
  id and an NCBI id: 561 out of 118,616 fossil items (0.47%). NCBI is sequence-backed.
- **Wikidata is a viable secondary hub with a catch:** P10907 (PBDB taxon ID, ~23,300
  items) and **P842 (Fossilworks taxon ID, ~108,000)** share one ID namespace. Querying
  only P10907 discards 79% of available linkage; the union is 114,185 items. OTT has
  property P9157 (~2.03M items).

Name fallback is worse than it looks: **16% of tested PBDB genus names resolve to
multiple distinct GBIF backbone keys**, including cross-kingdom homonyms
(`Laminarites` in both Chromista and Plantae). Authorship does not save you — PBDB
ships `Tyranosaurus rex Osborn, 1905` (sic) as its own record with correct authorship
on a misspelled name.

### 5. PhyloPic solves internal-node thumbnails server-side, and speaks OTT natively

Your claim about climbing to parents is right, and better than described.

- **OTT is a supported resolve namespace**: `/resolve/opentreeoflife.org/taxonomy/{ott_id}`
  → `308` to the node. (Note: `/ott/` 404s.) The full namespace list is at `/namespaces`;
  `paleobiodb.org/txn` is also supported, which gives a second, independent PBDB→image path.
- **`primaryImage` is populated even for nodes with zero images of their own.** Sampled
  20 nodes with `filter_node` count of exactly 0 — all 20 returned a primaryImage,
  sourced by climbing to the nearest ancestor whose clade contains images. Across 1,920
  random nodes, zero nulls. `embed_primaryImage=true` returns the image inline and the
  308 preserves it, so **one client call goes external id → node → thumbnail → license.**
- Coverage by node type across 900 random nodes: **internal 88.6%, leaf 94.0%.**
  Internal-node coverage is nearly as good as tips, which is true of no other source.
  Theropoda has *zero* images assigned to that exact node yet still resolves a
  primaryImage via clade fallback.

**Two corrections.** Stale `build` values return **`410 Gone`, not a redirect** — the
error body carries the current build, so retry from that. And **`primaryImage` ignores
license filters entirely**: a naive client rendering default thumbnails gets 47.2%
requiring attribution, 12.8% ShareAlike, and **5.5% NonCommercial**. For anything
commercial, use `/images?filter_clade={uuid}&filter_license_nc=false&page=0&embed_items=true`
and take item 0, which reproduces primaryImage's proximity ordering while staying safe
(93.7% coverage); walk `/lineage` upward for the remainder.

Corpus: 12,863 images, 24,007 nodes, 883 contributors. Mean SVG 10.3 KB → **~136 MB to
mirror the entire corpus**; the real mirror came out at 149.8 MB. Mirroring is cheap and
removes a runtime dependency.

License distribution (full corpus, enumerated not sampled):

| License | Count | % | Commercial OK |
|---|---:|---:|---|
| CC0 1.0 | 6,661 | 51.8% | yes |
| CC-BY 4.0 | 2,432 | 18.9% | yes |
| CC-BY-SA 3.0 | 1,196 | 9.3% | yes, copyleft |
| CC-BY 3.0 | 1,059 | 8.2% | yes |
| Public Domain Mark | 770 | 6.0% | yes |
| CC-BY-NC 3.0 | 420 | 3.3% | **no** |
| CC-BY-NC-SA 3.0 | 325 | 2.5% | **no** |

Attribution is a two-field problem: `attribution` is the **original creator**,
`_links.contributor.title` is the **uploader**. They differ 31% of the time.
`attribution` is null 19.3% overall but **0% null among the 5,432 images that actually
require attribution** — so render `attribution` when the license demands BY and it will
always be there.

---

## Correction table

| Your claim | Verdict | Reality |
|---|---|---|
| OTT synth v16.1 | **confirmed** | Current release, live on the API as `opentree16.1` |
| released June 2025 | **corrected** | **2025-12-20.** API `date_created`, `properties.json` `generated_on`, and all file mtimes agree. Only the hand-written release notes say June — and that same page's body text says "Version 15.1", a copy-paste bug |
| ~2.4M leaves | **confirmed** | Exactly **2,385,875**, triple-checked against API, release notes, and my own parse |
| ~38 MB tarball | **corrected** | **41,608,973 bytes (39.7 MiB).** "38 Mbytes" is stale text carried from v15.1 |
| OTT reconciles NCBI, GBIF, WoRMS, IRMNG | **incomplete** | Those four plus **Index Fungorum** (276,248 taxa), **SILVA** (74,255), Hibbett 2007, Schäferhoff 2010, and curated amendments. All crosswalkable via `sourceinfo` / `tax_sources` |
| OTT ids are the canonical join key | **confirmed, with caveat** | True, but ids are explicitly *not* stable: `forwards.tsv` has **297,070 entries** in this release alone, and the API follows them **silently**. Always compare the returned `ott_id` against what you sent |
| `/mrca` and `/induced_subtree` map onto interactions 1 and 2 | **confirmed as an oracle, rejected as a runtime dep** | Both work; `induced_subtree` handled **89,213 ids in 1.9s** with no documented cap. But there are no rate limits *because nobody implemented them* (issue #1268 open since 2021), no terms-of-use page, and it is one `waitress` server behind a small academic project |
| TimeTree 5: 137k entries | **confirmed** | 137,306 per Kumar et al. 2022. Site now shows 148,876; FAQ says 142,103 for the downloadable tree |
| TimeTree REST API at timetree.temple.edu | **corrected** | That host 404s on every route. Working host is `timetree.org/api`, three routes, JSON only — and it does not matter, see finding 2 |
| Fish Tree of Life ~32k tips | **corrected** | Conflates two objects. The **time-calibrated chronogram is 11,638 tips**; the all-taxon assembled set is 31,516 tips × 100 trees, and its own authors warn it "should generally not be used for analyses of trait evolution" |
| Smith & Brown ALLMB | **confirmed on count, corrected on host** | ALLMB is **356,305 tips**, dated. Not on Dryad — a single GitHub release, `FePhyFoFum/big_seed_plant_trees` v0.1 (2017), **no LICENSE file**. Also: ~78% of ALLMB tips are direct children of a polytomy with identical branch lengths, so three-quarters of its ages are one number copy-pasted. GBMB/GBOTB (79,874 / 79,881 tips) carry the real information |
| PBDB 1.26M occurrences | **corrected** | **2,004,119** live. ~1.78M publicly queryable; the gap is embargoed data |
| PBDB 570k opinions | **corrected** | **1,012,538** |
| PBDB is CC-BY 4.0 | **corrected** | The API's `&datainfo` block declares **CC0 1.0** on every endpoint. PBDB's own site is self-contradictory (classic FAQ says CC BY-NC-ND 3.0; GBIF's listing says CC BY 4.0). The API declaration is the most current and machine-readable. **Confirm by email if this project has a commercial dimension** |
| PhyloPic climbs to parents | **confirmed and better** | Server-side via `primaryImage`, effective ~100% coverage. See finding 5 |
| ICS chart 2023/2024 | **corrected** | Current is **v2026/06**. There was never a v2025 |

---

## Facts worth designing against

### Tree shape (computed directly — these statistics are published nowhere)

- **2,725,682 nodes total**: 2,385,875 tips + 339,807 internal.
- **Root-to-tip depth**: min 2, **mean 41.3**, **max 111**.
- **Branching factor**: mean 8.02, **max 12,964**. A single node with ~13,000 children
  will break any UI assuming small fanout.
- **24.5% of internal nodes are unary** (exactly one child). These inflate depth without
  adding topological information; suppressing them drops effective depth well below 111.
- 31.2% of internal nodes are polytomous (>2 children); 44.3% bifurcating.
- Ten largest polytomies: 12,964 / 12,378 / 9,094 / 8,550 / 6,428 / 4,799 / 4,622 /
  4,390 / 4,373 / 4,345 children.

### Only 6.7% of the tree is phylogenetically placed

159,925 of 2,385,875 tips come from phylogeny; the other ~2.23M come from taxonomy
alone. Internal nodes: 141,868 from phylogeny, 223,630 from taxonomy.

Any dated version of this tree — including Duke et al. — is overwhelmingly interpolating
ages onto taxonomy-derived structure. **The UI has to be honest about this.** See the
architecture doc's provenance tiers.

### Broken taxa

**9,839 taxa are non-monophyletic** in v16.1 (up from 8,123 in v15.1). The API
substitutes a synth node for them **silently in `mrca`** (no `broken` field at all in
that response) and explicitly in `induced_subtree` (a `broken` map). Full list in
`output/labelled_supertree/broken_taxa.json` (259 MB) under `non_monophyletic_taxa`,
each entry giving `attachment_points`, `intruding_taxa`, and `mrca`.

If someone searches a broken taxon, the app must explain it rather than quietly answer
a different question.

### PBDB appearance intervals are two brackets, not a range

```json
{"taxon_name":"Tyrannosaurus","firstapp_max_ma":83.6,"firstapp_min_ma":72.2,
 "lastapp_max_ma":72.2,"lastapp_min_ma":66}
```

First appearance is *somewhere* in 83.6–72.2 Ma; last appearance *somewhere* in
72.2–66 Ma. Render `fea→lla` as a faded envelope (maximal possible extent) and
`fla→lea` solid (minimal certain extent). Anything else misrepresents the data.

These are database-derived, not true fossil-record ranges — the docs are explicit that
they reflect "that portion of the fossil record that has been entered into the database."

**Coverage: 411,039 / 523,112 = 78.6% of PBDB names have appearance intervals.** The
missing 21.4% is exactly the set with `n_occs = 0`. A fifth of taxa will have no bar.
`is_extant` is also not binary: extinct 80.4%, extant 17.9%, **blank 1.7%**.

### PBDB identity has three ids, and they differ

- `orig_no` — stable concept id, constant across spellings and ranks
- `taxon_no` — the specific variant (spelling/rank) selected
- `accepted_no` — where the name should redirect

**10.1% of records have `accepted_no != orig_no`.** And `accepted_rank` can differ from
`taxon_rank` — *Aublysodon* is a genus whose accepted name is a *family*
(Tyrannosauridae), which breaks naive rank-based grouping. Always display
`accepted_name`, key on `accepted_no`, check `difference` for the reason.

`show=` has no external-id block. The complete menu is `full, attr, app, common, parent,
immparent, acconly, size, class, classext, phylo, genus, subgenus, subcounts, ecospace,
ttaph, taphonomy, etbasis, pres, seq, img, ref, refattr, ent, entname, crmod`. The
compact field `ext` is `is_extant`, not "external".

Bulk snapshot is practical despite there being no database dump:
`taxa/list.csv?all_records&show=app,attr,parent,size&limit=all` → **110 MB, 523,113
rows, 64 seconds.** `show=seq` adds `lft`/`rgt` nested-set bounds for local subtree tests.

### Geologic timescale: use `chart.ttl`

`github.com/i-c-stratigraphy/chart` → `chart.ttl`, 642 KB, **CC-BY-4.0**,
`owl:versionInfo "2026-06"`. 178 concepts; **100% have color, numeric age, and rank**;
176 have `skos:broader`. Includes `sh:order` for draw order and labels in 26 languages.

```turtle
gtsd:Cambrian a skos:Concept ;
    gts:rank rank:Period ; skos:broader gtsd:Paleozoic ;
    time:hasBeginning [ gtsd:inMYA 538.8 ; schema:marginOfError 0.6 ] ;
    time:hasEnd       [ gtsd:inMYA 486.85 ; schema:marginOfError 1.5 ] ;
    sh:order 154 ; schema:color "#7FA056"^^gtsd:RGBHex .
```

Parse once at build into ~40 KB of JSON. Do not ship an RDF parser to the browser and
do not fetch from `raw.githubusercontent.com` at runtime. ICS updates roughly annually,
so a pinned snapshot is strictly better than a live API.

Rejected alternatives: **PBDB `/intervals/list`** is a decent fallback (1,909 intervals,
real `parent_no` hierarchy, includes the Hadean) but its ages are **v2024/12, not
v2026/06** and five colors deviate from official CGMW — it flattens all Holocene
sub-units to `#FEF2E0`. **Macrostrat** has *no parent field at all*, forcing you to
reconstruct nesting by age arithmetic. **`resource.geosciml.org`** has a pre-2022
Cambrian base (541.0 Ma), ages only in prose `rdfs:comment`, and no colors.

### Other alternatives evaluated and rejected

- **chronosynth** — 2 stars, no LICENSE file, not on PyPI, `main` untouched since
  2022-02-04, docs self-described as "a work in progress", Travis CI. Do not depend on
  it. (Duke et al. ships its cached output, which is the useful part.)
- **datelife** — good science (Sánchez Reyes et al. 2024, *Syst Biol* 73:470–485) but
  **removed from CRAN 2024-08-25 for repeated policy violation**, very heavy dependency
  chain, and its `get_dated_otol_induced_subtree()` hits a hardcoded IP
  (`141.211.236.35:10999`) that **times out**. Its chronogram corpus is 253 trees /
  99,474 species.
- **treePL / `ape::chronos`** — cannot date a branch-length-free topology. Worse,
  **treePL will not crash**: it floors every branch at `1/numsites`, giving every branch
  exactly 1 substitution, and emits a confident dated tree containing no rate
  information whatsoever. With `collapse` set it destroys the topology entirely. Never
  point these at the OTT synthesis.
- **V.PhyloMaker / TACT / rtrees** — all require an already-dated ultrametric backbone.
  They add taxa to a dated tree; they cannot date an undated one.
- **iNaturalist photos** — 23.1% are all-rights-reserved, only ~22.6% commercially
  usable, 5 GB/hour media cap with permanent-block risk, ToS bars commercial AI training.
- **EOL** — API responds, but **every `eolMediaURL` returns 403** behind Cloudflare
  (plain, browser UA, and with a correct Referer all fail). Not viable.

### Licensing summary

| Source | License | Notes |
|---|---|---|
| Open Tree (synthesis + taxonomy) | **CC0** | `properties.json` `"legal": "cc0"`. Does not relicense upstream sources |
| Duke et al. dated trees | **CC-BY** | Zenodo deposit |
| PBDB | **CC0** per API `&datainfo` | Site contradicts itself; confirm if commercial |
| ICS `chart.ttl` | **CC-BY 4.0** | Cite Cohen et al., *Episodes* 2025;48:105-115 |
| PhyloPic | **mixed** | 5.8% NonCommercial, 11.8% ShareAlike. Filterable |
| TimeTree | **redistribution prohibited** | Excluded |
| VertLife, Fish Tree of Life | **undeclared** | Both `/terms` pages 404. Only "please cite" |
| ALLMB / big_seed_plant_trees | **none** | `license: null`. Default all-rights-reserved |
| Wikimedia Commons | mixed, all commercial-OK | ~75% require attribution; `Artist` is raw HTML |
| GBIF media | per-record enum | Filter on record-level `license`, never `media[].license` (free prose) |

The undeclared and unlicensed ones matter only if the Duke et al. tree turns out to be
unusable and you fall back to grafting. Note that if you do, you inherit their license
ambiguity.

---

## Operational cautions

- `files.opentreeoflife.org/synthesis/current/` **is frozen at 2016** and still serves
  `current_tree.tgz` dated 2016-11-28. Never pin to it. Resolve the version from the
  API's `synth_id` instead.
- OTT id **forwarding is silent**. `taxonomy/taxon_info` on retired `ott5792755` returns
  `"ott_id": 974791` with no indication of substitution. Chase forwards transitively —
  do not assume one hop.
- **Broken-taxon substitution is silent in `mrca`.** Passing a broken taxon returns an
  MRCA for a *different* query with no `broken` field.
- PBDB `robots.txt` sets `Crawl-delay: 30` and `Disallow: /data1.2/`. That governs
  crawlers, not API clients, and there is no documented rate limit — but treat the
  absence as unspecified, not as permission.
- PhyloPic URLs *with* the current build are `immutable`, 1-year cacheable. The
  build-less 307 is `max-age=300`. Cache keyed by build; on 410 read the new build from
  the error body.
- Wikimedia: **10 req/min unidentified, 200 with a real User-Agent**, 50 titles per
  batch, and thumbnails render only at seven bucket widths
  {120, 250, 330, 500, 960, 1280, 1920}.

## Unresolved

- PBDB's license is genuinely contradictory across its own surfaces. The API
  declaration (CC0) is most authoritative but worth a confirming email to
  `admin@paleobiodb.org` before any commercial launch.
- Duke et al.'s source-tree count (280 vs 334) is inconsistent between sources, and the
  preprint could not be read directly. Validate the Zenodo tree against v16.1 in
  ingest phase 2 before building on it.
- iNaturalist's ToS and rate-limit pages 403 to automated fetching; those terms came
  from Wayback snapshots. Only matters if iNat is ever added as a photo source.
