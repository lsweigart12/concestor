# Ingest plan

Six phases producing the immutable artifact set described in
[architecture.md](architecture.md). Every phase collects **validation gates**: `require`
gates fail the build, `observe` gates are recorded but never fail it. A failed `require`
gate fails the build rather than degrading the output silently. Results land in
`build/phase{N}_gates.json`.

Ordering is a dependency order, not a priority order. Phase 0 snapshots decaying sources
first (GBIF's legacy backbone and the PhyloPic corpus can disappear and are the only
path from PBDB to OTT). Phase 2 validates the Duke et al. dated tree, the biggest unknown,
before anything downstream depends on it.

---

## Phase 0 — Pin and snapshot

**Output:** `snapshot/` — raw, checksummed, never modified after write.

| Artifact | Source | Size |
|---|---|---|
| `opentree16.1_tree.tgz` | `files.opentreeoflife.org/synthesis/opentree16.1/` | 41,608,973 B |
| `ott3.7.3.tgz` | `files.opentreeoflife.org/ott/ott3.7.3/` | 111,278,327 B |
| `equal_splits_median_tree.tre` | Zenodo `10.5281/zenodo.19049120` | 145.8 MB |
| `birth_model_median_tree.tre` | same | 146.2 MB |
| `pbdb_taxa.csv` | `taxa/list.csv?all_records&show=app,attr,parent,size,seq&limit=all` | ~110 MB |
| `gbif_pbdb_checklist/` | GBIF checklist `c33ce2f2-c3cc-43a5-a380-fe4526d63650` | 461,889 names |
| `gbif_legacy_backbone/` | GBIF legacy backbone dump | large — **capture first** |
| `phylopic/` | 12,863 SVG + metadata via API | ~150 MB |
| `chart.ttl` | `github.com/i-c-stratigraphy/chart` | 642 KB |

Record for every download: URL, `Content-Length`, SHA-256, fetch timestamp. For PBDB also
persist the `&datainfo` block (embeds the access timestamp and a re-runnable `data_url` —
that is the citation PBDB asks for). **Do not use**
`files.opentreeoflife.org/synthesis/current/` — it is frozen at 2016. Pin the explicit
version resolved from the live API's `synth_id`.

### Gates

- Every SHA-256 recorded; sizes match `Content-Length`.
- `POST /v3/tree_of_life/about` returns `synth_id: "opentree16.1"`,
  `taxonomy_version: "3.7draft3"`. If the live API has moved on, **stop** — the pinned
  files are still correct, but later phases validate against the live service and that
  comparison is now invalid.
- PhyloPic: all 12,863 images fetched, license recorded for each, zero unresolved.

---

## Phase 1 — Topology

**Input:** `labelled_supertree.tre`, `taxonomy.tsv`, `forwards.tsv`
**Output:** `build/topology/*.npy` (ages land in phase 2), `node` table.

There is no `topology.bin` or `meta.bin`, on purpose: a `.npy` file is a 128-byte header
followed by the raw little-endian array, so this phase's output already is the format the
Go server reads directly. A concatenated second copy would double disk cost and give the
most load-bearing array two sources of truth.

1. Stream-parse the Newick (30 MB, 2.7M nodes) with an explicit stack, not recursion.
2. Assign `idx` by **preorder traversal** — this gives `parent[i] < i`, interval-based
   subtree containment, and stable tip ordering for free (architecture §3.1).
3. Emit `parent`, `depth`, `subtree_out`, `tip_count` arrays.
4. Parse node labels into `ott_id` (`ott123`, `Name_ott123`) or `NULL`
   (`mrcaott83926ott3607676`). Keep the raw label as `node_key`.
5. Join `taxonomy.tsv` for name, rank, flags. It is `\t|\t`-separated, and `sourceinfo`
   contains three malformed prefixes (`https`, `addition`, and one leading-space) — parse
   defensively.
6. Load `forwards.tsv` (297,070 entries) into a resolution map. **Chase transitively** —
   forwards can chain and can point "backwards" relative to release order.
7. Mark the 9,839 broken taxa from `broken_taxa.json`, retaining `attachment_points`.

The FTS index is **not** built here — a separate `search` phase builds it after
`vernaculars`, because it indexes common names too. It is one row per *name*, and
`node_fts.rowid` is a `search_name.id`, never a `node.idx` — joining it as if it were a
node index joins cleanly to unrelated nodes and returns confident nonsense.

### Gates

- **Tip count is exactly 2,385,875** — the single best structural check.
- Internal node count 339,807; total 2,725,682.
- Max depth 111, mean 41.32 (±0.01, over tips).
- Max branching factor 12,964. Unary internal nodes 83,305 (24.5%).
- `parent[i] < i` for all `i > 0`.
- **Oracle check:** 200 random tip sets of size 2–20 through
  `POST /v3/tree_of_life/induced_subtree`; the returned topology must match ours after
  normalizing for unnamed-node labelling. Runs on every build.

---

## Phase 2 — Dates (the decision gate)

**Input:** Duke et al. `equal_splits_median_tree.tre`
**Output:** `age_ma`, `age_tier`, `age_layout` arrays; `build/date_validation.json`

Three age arrays ship and stay separate: `age_ma` (what may be shown, NaN where nothing
may be), `age_tier` (how), `age_layout` (where to draw, finite everywhere). The layout is
fixed here, four phases before the fossil record exists, so its only bounds are the
chronogram's own — and the chronogram has no extinct taxa. Phase 4 revisits it.

1. Parse the dated Newick (OTT-labelled against the same release phase 1 consumed).
2. Join to `idx` by OTT id, chasing forwards.
3. Convert branch lengths to node ages (root at 4247 Ma).
4. Assign `age_tier` from Duke et al.'s `node_ages.json`: `measured` where a node got an
   age from a matched published chronogram, `interpolated` otherwise, `structural` inside
   a taxonomy-only region.
5. Verify monotonicity: every node's age ≥ every child's age.

### Accept criteria — all must hold

| Check | Threshold |
|---|---|
| Clade compatibility with phase 1 | ≥ 99.5% of matched nodes |
| OTT ids joining to an `idx` | ≥ 99% |
| Monotonicity violations | 0 in `measured` regions; < 0.1% overall |
| Root age | 4247 Ma ± 1% |
| Spot-check vs literature | Mammalia crown ~180 Ma, Aves crown ~110 Ma, Metazoa ~750 Ma |

The compatibility gate asks whether our clade is *contained* in Duke's, not whether every
internal node corresponds — no bifurcating chronogram can match our 12,964-way polytomy
node-for-node. Measured 99.6036% (237,953 / 238,900). The 947 genuinely contradicted
nodes are demoted to the `structural` tier and render without a number. **Do not start the
fallback congruification pipeline** — it is 4–6 weeks for a less defensible time axis.

---

## Phase 3 — Resolution layer

**Output:** `xref` table, `build/reconciliation.json`

Runs in strict precedence order (architecture §5). Later methods never overwrite earlier.

1. **`manual`** — load `data/overrides.tsv` first so everything downstream can check it.
2. **`ott_sourceinfo`** — parse OTT's `sourceinfo` into `(source, source_id) → idx`.
   Covers `ncbi`, `gbif`, `irmng`, `worms`, `if`, `silva`. **Many-to-one** (store lists).
   Watch the malformed prefixes noted in phase 1.
3. **`gbif_pbdb_chain`** — the fossil path
   `PBDB taxon_no → GBIF checklist taxonID → nubKey → OTT gbif: source id`. Drive it from
   the API point lookup `GET /v1/species?datasetKey={PBDB}&sourceId={taxon_no}` — one
   request per taxon, so GBIF's offset cap never applies. Order the crawl by `n_occs`
   descending and snapshot. Uniform-sample yield: 92.9% reach a `nubKey`, 51.9% of those
   reach OTT → 48.2% end to end.
4. **`gbif_backbone_provenance`** — offline half of the same chain, ranked below it.
   `simple.txt.gz` column 8 is the contributing dataset UUID; 212,054 rows cite the PBDB
   checklist, giving a `nubKey → checklist key` map with no API call. Join back to
   `taxon_no` by name and rank against `pbdb_taxa.csv` — **not** the ColDP (its compound
   synonym ids silently map a synonym onto the accepted taxon's number). Keep it for the
   offline floor and as a regression source immune to upstream change.
5. **`phylopic_resolve`** — `/resolve/opentreeoflife.org/taxonomy/{ott_id}`, following the
   308. (`/ott/` 404s; the namespace is `taxonomy`.)
6. **`name_exact`** — exact string, **unique candidate only**. Multiple candidates →
   `idx = NULL` with the candidate list recorded. 16% of PBDB genus names land here,
   including cross-kingdom homonyms.

### Gates

- Zero rows where `idx` is set and `method` is absent.
- **Regressions** (previously-resolved `(source, source_id)` now failing) **must be 0** or
  explicitly acknowledged in the build config — catches a broken upstream snapshot before
  it guts the fossil layer.
- `gbif_pbdb_chain` yield within 5 points of the **48.2%** baseline, scored on a
  1,000-taxon seeded **uniform** control (never on the real `n_occs`-ordered crawl, which
  is a different population). Score the two hops separately: a drop in the first means
  GBIF's checklist moved, a drop in the second means OTT's snapshot did.
- **`refuse_disagreements`** — three refusals, on the two facts a shared spelling cannot
  fake and then on what is still in doubt.
  - **Extancy**: PBDB calls a taxon extinct, the OTT taxon of that name carries no extinct
    flag, and the node still has a chronogram-dated descendant (`xref` matches on name, and
    OTT carries the same genus name in unrelated kingdoms — PBDB's *Ivesia* is an Ediacaran
    rangeomorph, OTT's a rose-family plant).
  - **Rank**: PBDB ranks the taxon above the genus and the node it reached is a genus or
    below — nomenclaturally impossible, and the class extancy cannot see, because a clade
    holding living species is flagged extant. PBDB's *Eutheria* passed extancy on its way
    onto a leaf-beetle genus; 103 nodes held 9,247 fossils that way. One direction only,
    and OTT's `section` reads as suprageneric (zoological here — *Schizophora*, 56,619
    tips). Ranks in neither set (`informal`, one blank) never refuse.
  - **Ambiguity**: `name_exact` only, a name two accepted PBDB taxa both matched.

  Load-bearing order: extancy and rank run **before** the ambiguity sweep, so one claimant
  survives rather than none (`Scopus` keeps the hamerkop, *Cytherelloidea* its ostracod
  genus); extancy needs phase 2's `age_ma` as a living-lineage guard (without it 1,162
  correct attachments go); `manual` overrides are exempt.
- `gbif_backbone_provenance` yield within 2 points of 38.6% of PBDB taxa. This reads a
  frozen file, so any movement is a bug in our code, not upstream.
- Every `manual` override still applies — an override whose target `idx` no longer exists
  is a hard failure.

---

## Phase 4 — Fossils

**Input:** `pbdb_taxa.csv` (523,112 rows), `xref`
**Output:** `fossil` table, `occurrence` table; rewrites `age_layout`.

1. Key on `accepted_no`, display `accepted_name` (10.1% of records have
   `accepted_no != orig_no`). Retain `difference` for the detail panel.
2. Watch rank changes across the accepted mapping — never group by `taxon_rank` on the
   assumption it survives resolution.
3. Compute the **attachment point**: walk PBDB's `parent_no` hierarchy upward until a
   taxon resolves via `xref` to an in-tree `idx`. Record `attach_idx` and `attach_method`.
   Every fossil attaches somewhere (root is the terminal fallback); the attachment-depth
   distribution is a quality signal — everything landing at Eukaryota means the chain is
   broken. **Before walking, look for a row that spells out the accepted name**
   (`under_accepted_name`, 37,720 accepted taxa): PBDB files a recombination on a
   `taxon_no` of its own and leaves the accepted record under the original combination,
   and phase 3 matches `taxon_name` — so *Homo erectus* the node was found by taxon
   376854 while accepted record 83084 (*Pithecanthropus erectus*) walked to the genus and
   was served as a fossil beside its own node. Reaching such a row is **walk 0**, not a
   hop: it is the same taxon, not an ancestor. Only a row whose own name *is* the accepted
   name qualifies — see fossil-grafts.md §9 for the *Radiolaria* trap that rules out
   grouping on `accepted_no` alone.
4. Carry all four appearance bounds (`fea`, `fla`, `lea`, `lla`) — two uncertainty
   brackets, not one range.
5. Carry `n_occs` as the notability signal, and `is_extant` as **nullable** (1.7% are
   genuinely unknown, not false).
6. **Rewrite `age_layout`** with the brackets — the first point in the build where a
   fossil bound exists. Clamp each undated node into the bracket of a fossil attaching at
   the node itself (`attach_walk = 0`), propagate to ancestors, re-run phase 2's
   monotonicity sweep. Write over `age_layout.npy` and leave phase 2's version recoverable
   (`age_layout_phase2.npy`) so re-running phase 4 clamps the original rather than
   compounding. **`age_ma` is not touched and no node gains a number** — this is a
   position. Use the `lla` end and **never read `fea`**: it is frequently junk-wide (*Homo
   erectus* carries `fea = 5.333` against a true ~2 Ma), and a count floor does not fix it
   (the bracket *widens* with occurrence count). **Also refuse a bound where the node has a
   dated descendant** — a last appearance is evidence about a lineage that ended (removed
   1,617 bogus bounds from cross-kingdom homonyms).
7. **Emit the `occurrence` age tier** (tier value 3). Same brackets, same exact-attach
   rule, but *displayed* rather than only drawn — so it lives in its **own table** (never
   `age_ma`), renders as a **range and never a point** (no midpoint computed anywhere),
   and the label says fossil occurrences, not age. `/v1` emits `tier: "occurrence"` and an
   `occurrence` object.

`lla` is not always where a taxon may be drawn: PBDB's `lastapp_min_ma` aggregates a
taxon's whole subtree, so a young end younger than every descendant's rests on material
catalogued no finer than the taxon itself. That test is exact and fires on 10,655 taxa
(*Stegosaurus* stopped at 93.9 Ma on one `sp.` occurrence, drawn 50 Myr after it lived).
`lla` is never overwritten — `lla_drawn`/`lea_drawn` carry the reading, `lla_drawn` is the
only column a mark's x may read, and all three surfaces that print the range (graft, card,
`occurrence` table) must read the corrected pair. Enforce `lla ≤ lla_drawn ≤ fea` per row.
Ichno- and form taxa are exempt (PBDB's `I`/`F` flags). Note PBDB's aggregate is not
monotone (440 taxa). `fla ≥ lea` holds for only 39.6% of taxa, so for the other 60.4%
leave the solid bar undrawn — not zero-width, which reads as precision.

### Gates

- ≥ 78% of rows have appearance intervals (baseline 411,039 / 523,112 = 78.6%). Test
  **containment, not equality**: 112,073 rows lack an interval (111,864 zero-occurrence
  plus 209 with occurrences and no bounds); 410,615 rows carry all four bounds.
- Attachment depth distribution reported; a median materially shallower than the previous
  build fails.
- Spot check: *Tyrannosaurus* `fea=83.6, fla=72.2, lea=72.2, lla=66`, attaching at or
  below **Tyrannosauridae** (Dinosauria is not a node in the synthesis tree).
- Step 6: every undated node is pushed back as far as its fossil bound allows (phrased
  against what the pass can reach, since a node cannot be drawn older than a dated parent).
  1,920 undated nodes moved; 393 remain younger than their own last fossil, all capped;
  both reported. *T. rex* is drawn at 66.0 Ma rather than 25.9.
- `occurrence` tier: 2,128 nodes carry one — a **blocking floor** (held to
  `build/manifest.json` by `pipeline/tests/test_doc_figures.py`).

---

## Phase 5 — Images and timescale

**Output:** `silhouettes/`, `silhouette` table, `node.phylopic_id`, `timescale.json`

1. Mirror the PhyloPic corpus — 12,863 SVGs, ~150 MB. Vectors only (the client inlines the
   markup to strip PhyloPic's baked `fill`). Mirroring removes the runtime dependency and
   the build-number churn (stale `build` values return 410 Gone with the current build in
   the error body).
2. Resolve each node to an image at build time. **Do not call `primaryImage` per node** —
   that is 2.7M requests against a volunteer service. Instead crawl the image *index* in
   ~269 requests, seed the nodes the corpus names, and propagate in a single sweep to each
   node's **closest drawn relative** (not its nearest drawn ancestor — the ancestor rule
   resolves a riffle beetle to a picture of all arthropods). Seeding is five passes in
   decreasing strength: OTT id, forwarded OTT id, one-hop lift, node name, truncated node
   name. The two name passes test ambiguity against **OTT, not against the tree** — see
   data-sources.md; the tree cannot see a homonym whose other kingdom it does not carry,
   which is how a wheatear reached the celery genus *Oenanthe*. Where OTT holds a name
   twice, the image's own cited OTT id says which taxon was drawn.
   `node_image.clade_idx` (the smallest clade holding both node and drawing) is the
   size of the claim the picture makes — the UI must render it. The `images.py` module
   docstring is the reference; read it before changing anything here.
3. Store license URL, `attribution` (creator) **and** `contributor` (uploader)
   separately — they differ 50.0% of the time. `attribution` is null 19.3% overall but 0%
   null among images that require attribution.
4. Parse `chart.ttl` once into ~40 KB JSON: name, rank, `skos:broader`, `inMYA` begin/end
   with `marginOfError`, `schema:color`, `sh:order`. Do not ship an RDF parser to the
   browser.

### Gates

- Node coverage ≥ 88% internal, ≥ 94% leaf.
- Five cross-kingdom homonyms (`HOMONYM_ANCHORS`) each drawn as a taxon inside the right
  clade. Asked of the **drawing's** OTT citation, not of the node it landed on: an exact
  seed is its own `source_idx`, so a gate phrased against the source asks whether
  *Oenanthe* is inside Apiaceae — which it is — and passes on the broken build.
- Zero images stored without a license URL.
- Zero attribution-required images with a null `attribution`.
- Timescale: 178 concepts, 100% with color/age/rank, 176 with `skos:broader`, root ages
  matching ICS v2026/06 (Cambrian base 538.8 ± 0.6 Ma).

---

## Phase 6 — Vernacular names

**OTT carries no common names** — "Tyrannosaurus" resolves, "T. rex" and "dog" do not.
Not required for launch but the search experience is meaningfully worse without it.

Sources: Wikidata labels via OTT property **P9157** (~2.03M items — direct OTT linkage, no
name matching), a bounded `wdt:P225` name pass for the top of the tree that P9157 does not
reach, and the PBDB ColDP archive's `VernacularName.tsv` (small, already snapshotted,
covers fossil groups). Feeds the FTS index as a column weighted below scientific names so
exact binomials always win.

- **P9157's hole is at the top, not the bottom.** Wikidata's `animal` (Q729), Metazoa,
  Bilateria and `cellular organisms` carry no P9157 statement, so an id-only join answers
  "dog" but returns nothing for "animal" — hence the bounded `wdt:P225` pass
  (exact-and-unique only, ~25 queries).
- **Pace WDQS.** It rate-limits with 429 + `Retry-After`, serves 502/503, enforces a hard
  60-second timeout, and a `GET` with a large `VALUES` clause returns `503 VCL failed` and
  must be POSTed.
- **A Wikidata item can carry another taxon's OTT id** (P9157 is free-text). The query
  fetches each item's own `wdt:P225` and refuses any contribution whose taxon name
  disagrees with OTT's — otherwise the app says *Homo sapiens* is "also known as *Homo
  floresiensis*" and answers `frog` with 2,080 archaea.
- **The 9,839 broken taxa need the index too** — rejected from synthesis means no
  `node.name`, so the palette returned nothing for *Escherichia coli* or *Dinosauria*.
  They are a fifth FTS column flagged `kind = broken` and answer with the substitution
  explained rather than performed.
- **So do the fossil record's own spellings.** `notInTree` refuses a PBDB taxon the tree
  holds as a node (fossil-grafts.md §9), and the node then answers under OTT's name — so
  where the two catalogues spell it differently and OTT carries no synonym, **847 names
  reached nothing that is the taxon** (779 of them before this branch). `load_pbdb_names` indexes those 2,584 names as `kind = 5`, in
  the `syn` column (a synonym's weight) with its own kind (`matched_on: "fossil-name"`,
  because "the fossil record calls it this" is not "the taxonomy files it under this").

Phase 6b (`concestor-build names`) writes `vernacular.usage_rank` from English Wikipedia's
title and redirect graph — see [name-ranking.md](name-ranking.md).

---

## Build orchestration

Each phase is a separate command writing to `build/` with a manifest. Phases are
resumable — phase 4 does not re-run phase 1.

```
concestor-build snapshot    # phase 0
concestor-build topology    # phase 1
concestor-build dates       # phase 2  ← decision gate
concestor-build resolve     # phase 3
concestor-build fossils     # phase 4
concestor-build images      # phase 5a
concestor-build timescale   # phase 5b
concestor-build vernaculars # phase 6
concestor-build names       # phase 6b
concestor-build search      # the FTS index, after vernaculars
concestor-build package     # gate the artifact set, write the manifest
```

There is no `assets` subcommand (phase 5 is `images` and `timescale`), and `package` does
not emit `topology.bin`/`meta.bin` (those files do not exist) — it gates the artifact set
and writes `build/manifest.json` beside the `.npy` files and `concestor.db`. It refuses to
package while any phase's gates record a failure.

`manifest.json` records the build id, every source URL with SHA-256 and fetch timestamp,
per-phase gate results, and the reconciliation summary. It ships inside the artifact set
and is served at `/v1/about`.

## Rebuild cadence

Driven by Open Tree synthesis releases — roughly annual (v15.1 July 2024, v16.1 December
2025). PBDB grows continuously, but fossil attachment points depend on the topology, so a
PBDB-only refresh still re-runs phases 3–4. Between releases the artifacts are genuinely
immutable, which is what makes architecture §4's `Cache-Control: immutable` honest.
