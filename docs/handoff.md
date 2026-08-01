# Handoff — current state

Last updated 2026-07-31. This is the living state document: it should read as
*where things stand*, not as a log of how they got here. Keep it current as part
of the work — if it drifts, whoever comes next re-derives things already settled.

---

## 1. What this project is for

**It is for curious people interested in evolution. It is not for evolutionary
biologists.** That decides most judgement calls, and it overrides the emphasis
in `architecture.md` and `ingest.md`, both written before it was stated.

Priority order:

1. **Identify any MRCA** between chosen species, correctly
2. **Draw the tree** — the induced subtree, beautifully, reflowing rather than jump-cutting
3. **Show useful species silhouettes**

The time axis is secondary; rough dating is fine and the project should never be
delayed for precision. The fossil layer is secondary too.

Two consequences that reorder `ingest.md`, whose numbering is a **dependency**
order and not a priority order:

- **Silhouettes (phase 5) are priority-one work.** For this audience an image is
  what makes a clade mean anything, and a silhouette legitimately represents a
  *clade* where a photograph can only represent one member.
- **Vernacular names (phase 6) are essential, not deferred.** OTT carries no
  common names, so "Tyrannosaurus" resolves and **"T. rex" and "dog" do not**.
  An app premised on inviting exploration cannot ship with a search box that
  only accepts binomials.

**This is not a commercial project.** Drop the commercial-safety machinery — no
`--commercial-safe` flag, no NonCommercial filtering, and ignore the PBDB licence
question. That is a straight win: PhyloPic's `primaryImage` gives effective
**~100% node coverage** against 93.7% for the licence-filtered path. Attribution
still applies — CC-BY requires it for any redistribution and the artists deserve
credit — and it is a two-field problem, since `attribution` (creator) and
`_links.contributor.title` (uploader) differ 31% of the time. TimeTree stays
excluded; its redistribution ban is unconditional.

---

## 2. State

| Phase | Status |
|---|---|
| 0 — snapshot | done, 7/7 gates |
| 1 — topology | done, **25/25 gates**, incl. 200/200 live-oracle agreement |
| 2 — dates | **run and ACCEPTED** (§3) |
| 3 — resolution | **measured and designed, not built** — [phase3-pbdb-path.md](phase3-pbdb-path.md) |
| 4 — fossils | not started |
| 5 — images and timescale | not started — **priority one** |
| 6 — vernaculars | not started — **priority one** |
| walking-skeleton renderer | done, throwaway |
| serving binary | not started; Go or Rust still open |
| real UI | not started — the largest remaining piece |

**The MRCA and tree-drawing primitive already works and is proven.** Everything
rests on `path(node) → [root, …, node]`; induced subtrees are the union of
ancestor paths with degree-2 nodes suppressed, which makes MRCA queries,
incremental reflow and the branch drill-down fall out of one computation. Mean
path length is 41. The renderer hits the `2|L|−1` bound exactly. Priority 1 is
largely de-risked; what remains is making it good, not making it work.

The pipeline is Python 3.14 under `uv`, in `pipeline/`. The serving binary shares
only *files* with it — no runtime, no FFI — so decide it independently.

### Reproduce from a clean checkout

```bash
cd pipeline && uv sync
uv run concestor-build snapshot    # ~1.4 GB, ~4 min on a fast link
uv run concestor-build topology    # ~3 min incl. the oracle
uv run concestor-build dates
uv run concestor-build render
```

Phase 1 needs the tarballs unpacked into `build/extracted/` first:

```bash
mkdir -p build/extracted && cd build/extracted
tar xzf ../../snapshot/opentree/opentree16.1_tree.tgz opentree16.1_tree/labelled_supertree/labelled_supertree.tre
tar xzf ../../snapshot/opentree/ott3.7.3.tgz
tar xzf ../../snapshot/opentree/opentree16.1_output.tgz opentree16.1/labelled_supertree/broken_taxa.json
```

Every change must pass all four:

```bash
uv run ruff format src tests && uv run ruff check src tests && uv run ty check && uv run pytest
```

---

## 3. Decisions taken

### Dating: the Duke et al. tree is accepted

Phase 2 failed the gate **as written** — clade compatibility 99.6036% against a
99.9% threshold, with 947 nodes genuinely contradicted. Everything else passed
comfortably: root age 4246.67 Ma against an expected 4247, ultrametric to
2.7 × 10⁻⁵, zero negative branch lengths in 4.59M nodes, OTT join 99.93% needing
no forward-chasing, and Mammalia 183.2 / Aves 96.1 / Metazoa 784.6 / Eukaryota
1781.1 Ma all in published range.

**Accepted.** Implement it: restate the criterion as *compatibility* rather than
*identity* — the original threshold assumed a node-for-node identity no
bifurcating chronogram can have against a 12,964-way polytomy — and demote the
947 conflicting nodes to the `structural` tier architecture §3.5 already
specifies. `--provisional` currently tags ages `phase2_accepted: false`; that
should become an honest accept.

**The fallback congruification pipeline is not to be built.** 4–6 weeks for a
less defensible time axis, on a secondary feature. Background in
[phase2-decision.md](phase2-decision.md).

### Fossil resolution: API point lookup first, offline map behind it

Settled by measurement — [phase3-pbdb-path.md](phase3-pbdb-path.md).

The offline map from the frozen backbone is real and accurate, and **shaped
exactly wrong**: 38.6% of PBDB taxa, 17.9% into OTT, but only 8% of genera and
**0 of the top 100 by `n_occs`**. A backbone row records only the source that
*won* the provenance slot, and PBDB wins it only where no higher-priority source
has the name — the obscure tail. Keep it as a second method for the free,
non-decaying floor it guarantees; never rely on it alone.

The blocking problem turned out not to exist. `GET /v1/species?datasetKey={PBDB}
&sourceId={taxon_no}` is a **point lookup** returning the checklist record with
its `nubKey` in ~0.5 s. It does not page, so the offset cap never applies and the
~450 covering shards in `gbif_checklist.py` are unnecessary. Independently
re-verified: `sourceId=38613` → `nubKey 4822631` in 0.43 s, and the inverse
`/species/{nubKey}/related?datasetKey=` works too.

**Crawl budget — decided by the reprioritisation.** The memo escalates whether to
crawl all 523,112 taxa (~73 h) or a prioritised 50,000 (~7 h). Fossils are
secondary and the audience clicks famous animals, so: **crawl ordered by `n_occs`
descending, resumable, and stop when the curve flattens.** The memo's own numbers
make the case — the top 25,000 genera hold 93.3% of genus occurrences and the top
50,000 species hold 76.5% of species occurrences. Do not commit 73 hours to a
secondary feature before silhouettes and vernaculars exist. Revisit only if the
tail turns out to matter.

---

## 4. Corrections to the design docs

The docs held up extremely well — every structural figure in `data-sources.md`
reproduced exactly from the real files. These need amending, and most already
carry an inline note.

**architecture.md §3.3 — `node.is_broken` cannot work.** A non-monophyletic taxon
is *rejected* from synthesis (`input_output_stats.json` calls it
`num_taxa_rejected: 9839`), so none of the 9,839 appears as a node and the flag is
permanently zero. They now live in a `broken_taxon` table carrying the substituted
MRCA, its resolved `idx`, the attachment points and the intruding taxa — which is
what the UI needs to explain rather than silently answer a different question.

**ingest.md phase 2 — the accept criterion assumed an impossible thing.** See §3.

**data-sources.md "Tree shape" — "mean 41.3" is over tips.** Over all nodes it is
41.67, because internal nodes sit deeper on average (44.14). The doc is right; it
is easy to misread, and one gate did.

**data-sources.md finding 4 — the chain yield is worse than recorded.** On 253
checklist records rather than 120: first hop 92.9% (better), second hop 51.9%
(materially worse), **48.2% end to end** rather than ~59%. Phase 3's gate scores
the two hops separately, because a drop in each implicates a different upstream.

**data-sources.md / manifest — `pbdb.zip` is a ColDP archive**, dated 2026-07-26
with 518,442 rows, not a Darwin Core archive of 461,889. Confirmed directly:
`NameUsage.tsv`, `NameRelation.tsv`, `TaxonProperty.tsv`, `metadata.yaml` against
the ColDP schema. 461,889 is the record count of GBIF's *ingested* checklist,
which is a different thing.

**ingest.md phase 0 — GBIF's offset cap is a red herring** for this build. True of
a bulk export, irrelevant to a point lookup.

**A ceiling nothing had recorded:** GBIF's backbone has **11 ranks** against
PBDB's 25, so **32,629 PBDB taxa (6.2%)** — subgenus, subfamily, superfamily,
suborder, tribe — are *unmatchable* rather than unmatched, and they skew toward
the notable end. Phase 4's parent-walk handles this correctly; it just walks
further than expected.

---

## 5. Things discovered while building

- **`label_format: "id"`** on `/v3/tree_of_life/induced_subtree` returns bare
  `ott770315` / `mrcaott…` labels, matching our `node_key` convention exactly. The
  default interpolates names, which can contain apostrophes and so arrive
  Newick-quoted. The parser refuses quoted input rather than mis-splitting.
- **OTT ships its own corroboration** in `opentree16.1_output.tgz`:
  `labelled_supertree_out_degree_distribution.txt` independently confirms
  2,385,875 tips, 83,305 unary nodes and a 12,964 max fanout;
  `input_output_stats.json` confirms the 9,839 rejected taxa. Check against these
  on every release.
- **The PBDB ColDP archive ships `VernacularName.tsv` — 9,245 English common
  names keyed by PBDB `taxon_no`** ("sponge", "jellyfish", "fire coral"). Small,
  already snapshotted, free, and it covers *fossil* groups, which is the hard case
  for the priority-one vernacular work. Not a substitute for Wikidata P9157
  (~2.03M items, direct OTT linkage, no name matching) but worth folding in.
- **Duke's tree carries two label families of its own** — `mrcaimp` (1,084,177)
  and `mrcapoly` (965,471), their interpolation and polytomy-resolution nodes.
  Together 89% of their internal nodes.
- **Nothing needed a forward.** All 297,070 `forwards.tsv` entries loaded and
  chased transitively; zero were load-bearing for the Duke join. Keep the
  machinery — the next release will differ — but do not assume it is exercised.
- **`simple.txt.gz` is 7,746,724 rows of exactly 30 fields**, headerless, `\N` for
  null. Full confirmed column layout in
  [phase3-pbdb-path.md](phase3-pbdb-path.md) §2. Column 10 is GBIF's ChecklistBank
  usage key, **not** PBDB's `taxon_no`; PBDB's own id is not in the file.
- **GBIF's `backbone/2023-08-28/config.yaml` contains a plaintext database
  password.** Deliberately not snapshotted and not used. Flagged only so nobody
  adds it to the download list; it is GBIF's exposure, not ours.

---

## 6. Conventions

In [../CLAUDE.md](../CLAUDE.md). The ones that cost real time:

**Gates collect rather than raise**, so a phase reports every failure at once then
refuses to write output. `require` blocks; `observe` records. Expected values are
measured, not estimated — but check what a gate is *measuring* before changing
either side of it.

**Do not apply a lint or type fix without reading the surrounding code.** Two bugs
came from exactly that, including one where silencing an unused-variable warning
left a database column permanently `NULL` while every gate passed. Counting rows
is not checking them; `tests/test_db_contents.py` exists because of it.

**Be honest about uncertainty visually, never numerically.** Only 6.7% of the
synthesis tree is phylogenetically placed, so any dated version is overwhelmingly
interpolating onto taxonomy-derived structure. This matters *more* for a lay
audience, not less — they cannot tell a confident wrong number from a right one.
But the answer is a dashed spine and no figure, not a wall of caveats. The
renderer already does this; the real UI must not regress on it.
