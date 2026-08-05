# Ingest plan

Six phases producing the immutable artifact set described in
[architecture.md](architecture.md). Every phase has explicit validation gates; a failed
gate fails the build rather than degrading the output silently.

Two ordering principles drive the sequence:

**Snapshot decaying sources first.** Phase 0 captures GBIF's legacy backbone and the
PhyloPic corpus before anything else, because both can disappear and neither is needed
by the phases that follow. The GBIF legacy backbone was frozen 2023-08-28, GBIF has
moved on to Catalogue of Life Extended Release, and it is the *only* identifier path
from PBDB to OTT. Losing it means losing the fossil layer.

**Resolve the biggest unknown early.** Phase 2 either validates the Duke et al. dated
tree or it doesn't, and that answer determines whether there is a week of work left or
two months. Get to it before building anything downstream.

Recommended path: **finish phases 0–2, then build a deliberately ugly renderer** that
draws one induced subtree against a time axis. That walking skeleton proves the whole
premise end to end and de-risks the only genuinely uncertain dependency. Phases 3–5 are
comparatively routine.

---

## Phase 0 — Pin and snapshot

**Output:** `snapshot/` — raw, checksummed, never modified after write.

| Artifact | Source | Size |
|---|---|---|
| `opentree16.1_tree.tgz` | `files.opentreeoflife.org/synthesis/opentree16.1/` | 41,608,973 B |
| `ott3.7.3.tgz` | `files.opentreeoflife.org/ott/ott3.7.3/` | 111,278,327 B |
| `equal_splits_median_tree.tre` | Zenodo `10.5281/zenodo.19049120` | 145.8 MB |
| `birth_model_median_tree.tre` | same | 146.2 MB |
| `pbdb_taxa.csv` | `taxa/list.csv?all_records&show=app,attr,parent,size,seq&limit=all` | ~110 MB, ~64 s |
| `gbif_pbdb_checklist/` | GBIF checklist `c33ce2f2-c3cc-43a5-a380-fe4526d63650` | 461,889 names |
| `gbif_legacy_backbone/` | GBIF legacy backbone dump | large — **capture first** |
| `phylopic/` | 12,863 SVG + metadata via API | ~136 MB |
| `chart.ttl` | `github.com/i-c-stratigraphy/chart` | 642 KB |

Record for every download: URL, `Content-Length`, SHA-256, fetch timestamp. For PBDB
also persist the `&datainfo` block, which embeds the access timestamp and a re-runnable
`data_url` — that *is* the citation their recommended format asks for.

**Do not use** `files.opentreeoflife.org/synthesis/current/`. It is frozen at 2016 and
still serves `current_tree.tgz` dated 2016-11-28. Pin the explicit version, resolved
from the live API's `synth_id`.

### Gates

- Every SHA-256 recorded; sizes match `Content-Length`.
- `POST /v3/tree_of_life/about` returns `synth_id: "opentree16.1"`,
  `taxonomy_version: "3.7draft3"`. If the live API has moved on, **stop** — the pinned
  files are still correct, but validation in later phases compares against a live
  service and that comparison is now invalid.
- PhyloPic: all 12,863 images fetched, license recorded for each, zero unresolved.

---

## Phase 1 — Topology

**Input:** `labelled_supertree.tre` (31,386,015 B), `taxonomy.tsv`, `forwards.tsv`
**Output:** ~~`topology.bin`, `meta.bin`~~ **`build/topology/*.npy`** (partial — ages
land in phase 2), `node` table. **There is no `topology.bin` and no `meta.bin`, on
purpose.** A `.npy` file is a 128-byte ASCII header followed by exactly the raw
little-endian array architecture §3.2 describes, so this phase's output already *is*
that format and the Go server reads it directly. Writing a concatenated second copy
would double the disk cost and give the most load-bearing array in the system two
candidate sources of truth. Read those two names as describing a format rather than
demanding a file; `package.py`'s docstring records the reasoning.

1. Stream-parse the Newick. It is 30 MB of text with 2.7M nodes; a recursive-descent
   parser building an explicit stack, not recursion, since max depth is 111 but
   pathological inputs shouldn't blow the stack.
2. Assign `idx` by **preorder traversal**. This is the load-bearing decision — it gives
   `parent[i] < i`, interval-based subtree containment, and stable tip ordering for free
   (architecture §3.1).
3. Emit `parent`, `depth`, `subtree_out`, `tip_count` arrays.
4. Parse node labels into `ott_id` (for `ott123` and `Name_ott123` forms) or `NULL`
   (for `mrcaott83926ott3607676`). Keep the raw label as `node_key`.
5. Join `taxonomy.tsv` for name, rank, flags. Note it is `\t|\t`-separated, and
   `sourceinfo` contains three malformed prefixes (`https`, `addition`, and one with a
   leading space) — parse defensively.
6. Load `forwards.tsv` (297,070 entries) into a resolution map. **Chase transitively** —
   forwards can chain, and can point "backwards" relative to release order because the
   project has restored previously-changed ids.
7. Mark the 9,839 broken taxa from `broken_taxa.json` (259 MB, key
   `non_monophyletic_taxa`), retaining `attachment_points` for the UI.
8. ~~Build the FTS5 index over 2,599,664 names plus 2,226,375 synonyms.~~ **Phase 1
   does not do this and never did.** The index is built by a separate `search` phase
   that must run *after* `vernaculars`, because it indexes common names too. It is one
   row per *name* — 6,834,727 against 2,725,682 nodes — and `node_fts.rowid` is a
   `search_name.id`, never a `node.idx`. Joining it as though it were does not error: it
   joins cleanly to unrelated nodes and returns confident nonsense.

### Gates

- **Tip count is exactly 2,385,875.** This is the single best structural check — it
  validates the whole parse in one number.
- Internal node count 339,807; total 2,725,682.
- Max depth 111, mean 41.32 (±0.01).
- Max branching factor 12,964.
- Unary internal nodes 83,305 (24.5%).
- `parent[i] < i` for all `i > 0`.
- **Oracle check:** 200 random tip sets of size 2–20 through
  `POST /v3/tree_of_life/induced_subtree`; the returned topology must match ours after
  normalizing for unnamed-node labelling. This is the strongest correctness test
  available and it should run on every build.

Every one of these numbers was measured during research (data-sources §"Tree shape") —
they are not estimates, and a mismatch means a real parse bug.

---

## Phase 2 — Dates, and the decision gate

**Input:** Duke et al. `equal_splits_median_tree.tre`
**Output:** `age_ma`, `age_tier`, `age_layout` arrays; `build/date_validation.json`

This phase decides the shape of the rest of the project.

`age_layout` is not in the original plan below; handoff.md §3 records why there are three
arrays rather than two. Note what it means for ordering: **the layout is fixed here, four
phases before the fossil record exists**, so the only bounds available to it are the
chronogram's own — and the chronogram has no extinct taxa. Phase 4 revisits it.

1. Parse the dated Newick. Tips and internal nodes are labelled with OTT ids against
   OTT 3.7.3 / synthesis v16.1 — the same release phase 1 consumed.
2. Join to `idx` by OTT id, chasing forwards.
3. Convert branch lengths to node ages (root at 4247 Ma per their construction).
4. Assign `age_tier` from Duke et al.'s cached `node_ages.json`, which records which
   nodes got ages from matched published chronograms (`measured`) versus interpolation.
   Everything inside a taxonomy-only region is `structural`.
5. Verify monotonicity: every node's age ≥ every child's age.

### Accept criteria — all must hold

| Check | Threshold |
|---|---|
| ~~Topology congruence with phase 1~~ **Clade *compatibility* with phase 1** | ~~≥ 99.9% of internal nodes correspond~~ **≥ 99.5% of matched nodes** |
| OTT ids joining to an `idx` | ≥ 99% |
| Monotonicity violations | 0 in `measured` regions; < 0.1% overall |
| Root age | 4247 Ma ± 1% |
| Spot-check vs. literature | Mammalia crown ~180 Ma, Aves crown ~110 Ma, Metazoa ~750 Ma, all within published ranges |

**The congruence criterion as first written assumed a thing no bifurcating chronogram can
do**, and phase 2 was accepted on the criterion being restated rather than on the data
changing. Duke et al.'s tree is strictly binary; ours has a 12,964-way polytomy in it, so
"internal nodes correspond" cannot reach 99.9% however good the tree is. The gate now
asks whether our clade is *contained* in theirs — Duke commits incertae sedis taxa our
tree leaves unplaced, which grows a clade without contradicting it — and measures
**99.6036%** (237,953 / 238,900). The 947 genuinely contradicted nodes are demoted to the
`structural` tier and render without a number, which is the honest disposal.
[phase2-decision.md](phase2-decision.md) is the full argument and is what to read before
touching anything that depends on ages.

### If it fails

The fallback is the pipeline this design was originally going to need, and it is
substantially more work. Documented here so the decision is informed, not built:

1. Ingest dated trees per clade — VertLife (mammals 5,911 / birds 9,993 / squamates
   9,755 / amphibians 7,238 / sharks 1,192), Fish Tree of Life (**11,638-tip
   chronogram**, not the 31,516-tip ATA set), Smith & Brown **GBMB/GBOTB** (79,874 /
   79,881 — *not* ALLMB, whose ~78% polytomy-child fraction means three-quarters of its
   ages are one number repeated), Álvarez-Carretero 2022 mammals (4,705, CC-BY).
2. Reconcile tip labels to OTT. Every source has its own convention and its own
   landmines: VertLife mammals are `Genus_species_FAMILY_ORDER` with Title-case families
   for recently-extinct tips and 76 `X_`-prefixed fossil tips in the FBD trees; every
   VertLife tree carries an outgroup (`_Anolis_carolinensis`, `Homo_sapiens`); fish have
   133 trinomials; plants have 12,699 tips with three underscores plus `×` and `&`
   characters. A naive `split("_")` corrupts all of these silently.
3. **Congruify** each source against our topology — `geiger::congruify.phylo(reference,
   target, scale = NA)`, which matches nodes by MD5 hash of the descendant-tip bit
   vector restricted to the shared taxon set. Exact set equality, no threshold;
   non-matching nodes are silently dropped, which is how it tolerates topological
   conflict. Output is `(MRCA, MaxAge, MinAge, taxonA, taxonB)` — calibrations encoded
   as *taxon pairs*, which is what makes them portable across topologies.
   Alternatively use OpenTree's `conflict/conflict-status` endpoint, which returns a
   `witness` OTT id per node and labels conflict explicitly rather than dropping it —
   OTT-native and the better fit here.
4. **Interpolate with `interpolate_newick.py`** from `jdduke24/dated-complete-tree`
   (BSD-3, linear time). Not `phylocom bladj` — it is quadratic and needs roughly 50 TB
   for 2.3M species.
5. **Never** treePL or `ape::chronos`. Neither can date a branch-length-free topology,
   and treePL is the dangerous one: it does not error, it floors every branch at
   `1/numsites`, gives every branch exactly 1 substitution, and emits a confident dated
   tree containing zero rate information. With `collapse` set it flattens the entire
   internal topology to a star.

Add roughly 4–6 weeks and a permanent honesty problem, since congruification emits point
calibrations (`MinAge == MaxAge`) that discard the source studies' uncertainty. Schenk
2016 found secondary calibrations produce estimates that are systematically biased *and
wrongly precise* — differing significantly from primary estimates in 97% of replicates.

---

## Phase 3 — Resolution layer

**Output:** `xref` table, `build/reconciliation.json`

Runs in strict precedence order (architecture §5). Later methods never overwrite
earlier ones.

1. **`manual`** — load `data/overrides.tsv` first so everything downstream can check
   against it.
2. **`ott_sourceinfo`** — parse OTT's `sourceinfo` column into `(source, source_id) →
   idx`. Nearly free, and covers `ncbi` (1,955,883 taxa), `gbif` (2,562,021), `irmng`
   (~~1,480,677~~ **1,480,678**), `worms` (406,365), `if` (276,248), `silva` (74,255).
   The IRMNG figure is the naive parse's, and the extra one is ott 7494610 *Ficus
   variegata*, whose only IRMNG id is the space-prefixed `" irmng:11258800"` — so this
   document's own figure was evidence for the malformed-prefix warning it gives below.
   **Many-to-one** —
   *Amanita muscaria* carries six NCBI ids, *Homo sapiens* two IRMNG ids — so store
   lists.
3. **`gbif_pbdb_chain`** — the fossil path:
   `PBDB taxon_no → GBIF legacy checklist taxonID → nubKey → OTT gbif: source id`.
   **Decided 2026-07-31, see [phase3-pbdb-path.md](phase3-pbdb-path.md).** Drive
   it from the API point lookup
   `GET /v1/species?datasetKey={PBDB}&sourceId={taxon_no}` — one request per
   taxon, 0.5 s, no paging, so **GBIF's offset cap never applies and the ~450
   covering shards in `gbif_checklist.py` are unnecessary**. Order the crawl by
   `n_occs` descending and snapshot the results; this captures the decaying half
   of the chain and is phase-0 work in spirit.
   Measured yield on 300 random PBDB taxa: 84.3% are in the checklist, **92.9%
   of those reach a `nubKey`, 51.9% of those resolve in OTT — 48.2% end to
   end**, not the ~59% carried in data-sources.md. Second-hop loss is version
   skew: OTT's GBIF snapshot is Sept 2019, the legacy backbone is 2023.
4. **`gbif_backbone_provenance`** — the offline half of the same chain, ranked
   below it. `simple.txt.gz` column 8 is the contributing dataset UUID and
   column 10 that dataset's usage key, and 212,054 rows cite the PBDB checklist,
   giving a `nubKey → checklist key` map with no API call and no decay. Join back
   to `taxon_no` by name and rank against `pbdb_taxa.csv` — **not** the ColDP,
   whose compound synonym ids silently map a synonym onto the accepted taxon's
   number. Yield **38.6% of PBDB taxa, 17.9% reaching OTT**, but only 8% of
   genera and **0 of the top 100 taxa by `n_occs`**: PBDB wins GBIF's provenance
   slot only where no higher-priority source has the name. Keep it for the floor
   it guarantees offline and as a regression source immune to upstream change;
   never rely on it alone.

   Note a ceiling that binds both: GBIF's backbone has 11 ranks against PBDB's
   25, so **32,629 PBDB taxa (6.2%) — subgenus, subfamily, superfamily, suborder,
   tribe — are unmatchable rather than unmatched**, and they skew notable.
5. **`phylopic_resolve`** — `/resolve/opentreeoflife.org/taxonomy/{ott_id}`, following
   the 308. Note `/ott/` 404s; the namespace is `taxonomy`.
6. **`name_exact`** — exact string, **unique candidate only**. Multiple candidates →
   `idx = NULL` with the candidate list recorded. 16% of PBDB genus names land here,
   including cross-kingdom homonyms.

### Gates

- Zero rows where `idx` is set and `method` is absent.
- **Regressions** (previously-resolved `(source, source_id)` now failing) **must be 0**
  or explicitly acknowledged in the build config. This is the gate that catches a broken
  upstream snapshot before it silently guts the fossil layer.
- `gbif_pbdb_chain` yield within 5 points of the **48.2%** baseline — measured
  2026-07-31 on 253 PBDB taxa that are checklist records, superseding the ~59%
  estimate in data-sources.md. Score the two hops separately (92.9% to a
  `nubKey`, 51.9% of those to OTT); a drop in the first means GBIF's checklist
  moved, a drop in the second means OTT's snapshot did, and the fixes differ.
  **Score it on a uniform sample and never on the real crawl.** That baseline is
  calibrated on a *uniform* draw and the settled crawl is `n_occs`-ordered, which is a
  different population: on the prioritised cohort the chain reaches **37.8%** end to
  end, and it fails there for a reason that is not a bug — coverage is inversely
  correlated with how much a taxon matters, and phase3-pbdb-path.md §5 says so. Phase 3
  therefore crawls a 1,000-taxon seeded uniform control alongside the real crawl, gates
  on that, and reports the prioritised cohort beside it as an `observe`.
- **Resolutions are withdrawn where PBDB and OTT disagree about extancy**, because
  `xref` matches on the *name* and OTT carries the same genus name in unrelated
  kingdoms — PBDB's *Ivesia* is an Ediacaran rangeomorph and OTT's is a rose-family
  plant. `refuse_disagreements` drops a resolution where PBDB calls a taxon extinct, the
  OTT taxon of that name carries no extinct flag, and the node still has a
  chronogram-dated descendant: **16,833 rows over every method** — `name_exact` was the
  bulk of it but 389 survived routes that were supposed to be evidence-based — plus 235
  where a name is still claimed by two accepted PBDB taxa. Three things are load-bearing
  and are not to be reordered: the extancy sweep runs **before** the ambiguity one, so
  *Scopus* keeps the hamerkop instead of losing both; it needs phase 2's `age_ma` as a
  living-lineage guard, without which 1,162 correct fossil attachments go; and `manual`
  overrides are exempt. Phase 4's independent check went from 1,019 of 1,048 to 31 of 60.
- `gbif_backbone_provenance` yield within 2 points of 38.6% of PBDB taxa. This
  one reads a frozen file, so **any** movement is a bug in our code, not
  upstream.
- Every `manual` override still applies — an override whose target `idx` no longer
  exists is a hard failure, since it means someone's reviewed judgement was silently
  dropped.

---

## Phase 4 — Fossils

**Input:** `pbdb_taxa.csv` (523,112 rows), `xref`
**Output:** `fossil` table

1. Key on `accepted_no`, display `accepted_name`. **10.1% of records have
   `accepted_no != orig_no`.** Retain `difference` (`misspelling of`, `nomen dubium`,
   `subjective synonym of`) for the detail panel.
2. Watch for rank changes across the accepted mapping — *Aublysodon* is a **genus**
   whose accepted name is a **family** (Tyrannosauridae). Never group by
   `taxon_rank` on the assumption it survives resolution.
3. Compute the **attachment point**: walk PBDB's own `parent_no` hierarchy upward until
   a taxon resolves via `xref` to an `idx` that is in the synthetic tree. Record
   `attach_idx` and `attach_method`.
   - This is necessary because **only 0.5% of `extinct`-flagged OTT taxa appear in the
     synthetic tree**. *T. rex* attaches to itself; *Triceratops* has an identical flag
     set and is pruned, so it attaches to its nearest in-synth ancestor.
   - Every fossil must attach *somewhere* — the root is the terminal fallback — but the
     depth distribution of attachments is a quality signal worth reporting. Everything
     landing at Eukaryota means the chain is broken.
4. Carry all four appearance bounds (`fea`, `fla`, `lea`, `lla`). Do not collapse them
   into a single range; they are two uncertainty brackets and the UI renders both.
5. Carry `n_occs` as the notability ranking signal, and `is_extant` as **nullable** —
   1.7% (9,059 records) are genuinely unknown, not false.
6. **Built. Rewrites `age_layout` with the brackets this phase just produced.** This
   is the phase that owns it, because it is the first point in the build where a fossil
   bound exists at all — phase 2 fixed the layout before the `fossil` table did. Clamp
   each undated node into the bracket of a fossil attaching at the node itself
   (`attach_walk = 0`), propagate the bound to ancestors, then re-run phase 2's
   monotonicity sweep. Write the result over `age_layout.npy` and leave phase 2's
   version recoverable, so the two can be diffed. **`age_ma` is not touched and no node
   gains a number** — this is a position, and the three arrays are separate exactly so
   that a position and a displayable age can disagree. Scope: 5,640 structural nodes have
   a bracket available. Rationale and the numbers in handoff.md §7.
   - Use the `lea`/`lla` end. **`fea` is frequently junk-wide** — *Homo erectus* carries
     `fea = 5.333`, the base of the Zanclean, against a true first appearance near 2 Ma.
     ~~An occurrence-count floor or an outlier rule is a prerequisite.~~ **Measured, a
     count floor does not work**: the first-appearance bracket *widens* with occurrence
     count, 5.24 Ma median at one occurrence against 6.20 at fifty or more. The
     discriminator is which end of the bracket is read, not how many occurrences back
     it. The implementation uses `lla` alone and never reads `fea`; see
     `_pick_bracket_end` in `fossils.py`. A second rule was needed and is not in this
     doc: **refuse a bound where the node has a dated descendant**, because a last
     appearance is evidence about a lineage that ended. That removed 1,617 bogus bounds
     arising from cross-kingdom homonyms in phase 3's `xref`.
7. **Built. Emits the `occurrence` age tier.** See handoff.md §7. Same
   brackets, same exact-attach rule, but this one is *displayed* rather than only drawn,
   so it carries the constraints that make it safe: the interval goes in its **own
   table** — handoff.md §7 says why a table rather than the array this doc specified —
   never `age_ma`; it renders as a **range and never a point**, with no midpoint computed
   anywhere; and the label says fossil occurrences, not age. Tier value 3, declared in
   `dates.py` and written by this phase. 2,133 nodes carry one. `/v1` emits `tier:
   "occurrence"` and an `occurrence` object; **the legend and the renderer are still to
   do.** This is the step that makes *Homo erectus* and *T. rex* stop reading "not
   estimated", which is the reason the fourth tier exists at all.

### Gates

- ≥ 78% of rows have appearance intervals (measured baseline: 411,039 / 523,112 =
  78.6%). ~~The missing set is exactly those with `n_occs = 0`.~~ **Containment, not
  equality**, and the difference is what a gate written on the equality would miss. All
  111,864 zero-occurrence rows do lack an interval, but **112,073** rows lack one: 209
  have occurrences and no bounds. Sixteen rows carry an *empty* `n_occs` rather than a
  zero. And the 411,039 baseline counts a *first*-appearance bound only — **410,615**
  rows carry all four, which is the population every statement below about the double
  bracket is measured over.
- Attachment depth distribution reported; median attachment materially shallower than
  the previous build fails.
- Spot checks: *Tyrannosaurus* `fea=83.6, fla=72.2, lea=72.2, lla=66`, attaching at or
  below ~~Dinosauria~~ **Tyrannosauridae**. Dinosauria is ott 90215 in the taxonomy but
  is **not a node in the synthesis tree** — the lineage runs Sauria → unnamed `mrca*`
  nodes → Tyrannosauridae — so the check as written is untestable. Tyrannosauridae is a
  strictly stronger claim anyway.
- **Step 6's gate, as built:** every undated node is pushed back as far as its fossil
  bound allows. It is phrased against what the pass can reach rather than against the raw
  bound, because a node cannot be drawn older than a *dated* parent without either
  inverting the tree or moving that parent away from the figure printed on its card.
  1,920 undated nodes moved; 393 remain younger than their own last fossil, all capped
  that way, and both are reported. *T. rex* is drawn at 66.0 Ma rather than 25.9.

---

## Phase 5 — Images and timescale

**Output:** `silhouettes/`, `silhouette` table, `node.phylopic_id`, `timescale.json`

1. Mirror the PhyloPic corpus — 12,863 SVGs, 149.8 MB. Vectors only: the client inlines
   the markup to strip PhyloPic's baked `fill`, so a raster tier would be a fallback
   nothing can fall back to. Mirroring removes the runtime dependency and the
   build-number churn: stale `build` values return **410 Gone**, not a redirect, with
   the current build in the error body.
2. Resolve each node to an image at build time. **This step as originally written — one
   `primaryImage` call per node — is 2.7M requests against a small volunteer service,
   and `images.py` deliberately does not do it.** What it does instead: crawl the image
   *index* in ~269 requests, seed the nodes the corpus names, and propagate to the rest
   in a single sweep — to each node's **closest drawn relative**, not its nearest drawn
   ancestor. The ancestor rule was what shipped first and it resolved a riffle beetle to
   a picture of all 1.2M arthropods; handoff.md §5 has the before and after. Seeding is
   five passes, in decreasing
   strength — OTT id, forwarded OTT id, one-hop lift, node name, truncated node name —
   and the module docstring is the reference for all of it. Read that before changing
   anything here.
   - The licence filters (`filter_license_nc=false`) are a **query-time** concern that
     the index crawl sidesteps: it carries every image's licence inline, so filtering is
     local. Note that `primaryImage` **ignores license filters entirely**, yielding
     47.2% attribution-required, 12.8% ShareAlike, 5.5% NonCommercial — which is why
     nothing in this build asks it for one. **That 47.2% is of `primaryImage`
     *results*.** Across the mirrored corpus it is 5,432 of 12,863, **42.2%**. Both
     numbers are right, the denominators differ, and they get compared.
3. Store license URL, `attribution` (original creator) **and** `contributor` (uploader)
   separately — they differ ~~31%~~ **50.0%** of the time, measured across the whole
   corpus rather than sampled: 6,437 of 12,863. `attribution` is null 19.3% overall but
   **0% null among the 5,432 images that require attribution**, so the field is always
   present when it matters.
4. Parse `chart.ttl` once into ~40 KB JSON: name, rank, `skos:broader`, `inMYA` begin
   and end with `marginOfError`, `schema:color`, `sh:order`. Do not ship an RDF parser
   to the browser.

### Gates

- Node coverage ≥ 88% internal, ≥ 94% leaf (measured PhyloPic baselines).
- Zero images stored without a license URL.
- Zero attribution-required images with a null `attribution`.
- Timescale: 178 concepts, 100% with color/age/rank, 176 with `skos:broader`, root
  ages matching ICS v2026/06 (Cambrian base 538.8 ± 0.6 Ma).

---

## Phase 6 — Vernacular names ~~(deferred)~~ **shipped**

Not required for launch, but the search experience is meaningfully worse without it.
**OTT carries no common names**: "Tyrannosaurus" resolves, "T. rex" and "dog" do not.

Options, in preference order. ~~GBIF vernacular names (already joined via
`ott_sourceinfo`, no new resolution work)~~ — **they are not free and this claim appears
in three documents.** `topology.py` never parses `sourceinfo` into the database and the
snapshotted `simple.txt.gz` carries no vernacular names at all; getting them means a
fresh GBIF crawl. What shipped: Wikidata labels via OTT property **P9157** (~2.03M items
— direct OTT linkage, no name matching), a bounded `wdt:P225` name pass for the top of
the tree that P9157 does not reach, and the PBDB ColDP archive's `VernacularName.tsv`,
which is small, already snapshotted, and covers *fossil* groups.

Feeds the FTS index as an additional column, weighted below scientific names so exact
binomials always win.

**P9157 is not a complete map of OTT, and the hole is at the top rather than the
bottom.** Wikidata's `animal` item (Q729) carries no P9157 statement, and neither do
Metazoa, Bilateria or `cellular organisms`. An id-only join therefore answers "dog" and
returns nothing at all for "animal" — the opposite of the failure anyone would predict,
and the reason the bounded `wdt:P225` name pass above exists: exact-and-unique only, per
architecture §5, 25 queries.

**Pace the endpoint.** WDQS rate-limits with `429` and a `Retry-After`, also serves 502
and 503, and enforces a hard 60-second query timeout. A `GET` carrying a large `VALUES`
clause comes back `503 VCL failed` and must be POSTed instead. It is free and shared,
which is the same academic-scale infrastructure `data-sources.md` warns about for Open
Tree.

**A Wikidata item can carry another taxon's OTT id**, because P9157 is a free-text
external identifier and nothing stops one. Until it was fixed the app said *Homo
sapiens* is also known as *Homo floresiensis* and answered `frog` with 2,080 archaea
captioned "Giant Bullfrog". The query now fetches each item's own `wdt:P225` and refuses
any contribution whose taxon name disagrees with OTT's. Three cheaper rules were tried
first and all three fail; `vernaculars.py` records why, and one of them fails by taking
"Dog" off *Canis lupus familiaris*. Do not re-derive them.

**The 9,839 broken taxa needed the index too, and nobody had recorded that they were
missing from it.** Rejected from synthesis means no `node.name`, which meant the palette
returned nothing at all for *Escherichia coli* or *Dinosauria* — two names a curious
person is entirely likely to type. They are a fifth FTS column, flagged `kind = broken`,
and they answer with the substitution explained rather than performed.

---

## Build orchestration

Each phase is a separate command writing to `build/` with a manifest. Phases are
resumable — phase 4 does not re-run phase 1.

```
concestor-build snapshot   # phase 0
concestor-build topology   # phase 1
concestor-build dates      # phase 2  ← decision gate
concestor-build resolve    # phase 3
concestor-build fossils    # phase 4
concestor-build images     # phase 5a
concestor-build timescale  # phase 5b
concestor-build vernaculars # phase 6
concestor-build names      # phase 6b
concestor-build search     # the FTS index, after vernaculars
concestor-build package    # gate the artifact set, write the manifest
```

Two corrections to what this block used to say, both of which cost a reader a failed
command. There is no ~~`assets`~~ subcommand — phase 5 is two of them, `images` and
`timescale`, and `cli.py` is the list. And `package` does not emit
~~`topology.bin`, `meta.bin`~~ — those files do not exist, per phase 1's output note
above; it gates the artifact set and writes `build/manifest.json` beside the `.npy`
files and `concestor.db` that phases 1–6 already wrote.

`manifest.json` records the build id, every source URL with SHA-256 and fetch timestamp,
per-phase gate results, and the reconciliation summary. It ships inside the artifact set
and is served at `/v1/about`, so any running instance can state exactly what it is made
of. For a system whose credibility rests on data provenance, that endpoint is a feature,
not diagnostics.

## Rebuild cadence

Driven by Open Tree synthesis releases — roughly annual (v15.1 July 2024, v16.1
December 2025). PBDB grows continuously and could be refreshed more often, but the
fossil attachment points depend on the topology, so a PBDB-only refresh still re-runs
phases 3–4.

Between releases the artifacts are genuinely immutable, which is what makes the
`Cache-Control: immutable` strategy in architecture §4 honest rather than optimistic.
