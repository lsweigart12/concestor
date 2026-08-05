# Phase 3: can the frozen backbone replace the GBIF checklist API?

**Status: no. The offline path covers 38.6% of PBDB taxa but 0 of the 100 that
matter most, and the reason is structural rather than fixable.**

**Recommendation: build `gbif_pbdb_chain` on the API — using a point lookup that
makes the 450-shard export unnecessary — and keep the offline map as a free,
non-decaying second method behind it.**

Measured 2026-07-31 against `snapshot/gbif_legacy_backbone/simple.txt.gz`
(SHA-256 `fde017e1…`, frozen 2023-08-28), OTT 3.7.3, `snapshot/pbdb/pbdb_taxa.csv`
(523,112 rows), and 458 live GBIF lookups.

---

## 1. The lead was real, and it is not enough

The frozen backbone does carry per-row source provenance, and **212,054 rows
cite the PBDB checklist UUID** `c33ce2f2-c3cc-43a5-a380-fe4526d63650` — exactly
the handoff's figure. From a local file, with no API call, that is a
`nubKey → GBIF checklist key` map for the PBDB-sourced part of the backbone.

Then the coverage arrives.

| Offline path | Reached | % of 523,112 |
|---|---:|---:|
| PBDB taxa mapped to a backbone row | 201,744 | **38.6%** |
| ...whose backbone row is in OTT via `gbif:` | 93,672 | **17.9%** |
| ...allowing the accepted-key fallback (§5) | ~~139,740~~ **138,180** | ~~26.7%~~ **26.41%** |
| ...landing on a node in the synthetic tree | 5,800 | 1.1% |

**That one row does not reproduce, and it is the only row in §1–§4 that does not** —
everything else here was rebuilt from the real files and matched to the row. The problem
is that this memo gives the figure without stating the rule that produced it, and no
rule recovers it: reading column 2 on synonym rows gives **138,180 (26.41%)**, "any
non-`ACCEPTED` status" gives 144,884 (27.70%), and "always" gives 168,781 (32.26%). The
build uses the first, which is the narrowest, and phase 3's gate carries 26.7% as its
expected value with the measured 26.41% beside it — deliberately, so the discrepancy
stays visible rather than being tuned away. If you change the fallback rule, this is the
row to re-measure and the gate to re-state.

Coverage is **inversely correlated with how much a taxon matters**:

| Slice | Reaches the backbone | Reaches OTT |
|---|---:|---:|
| **Top 100 PBDB taxa by `n_occs`** | **0 (0.0%)** | **0** |
| Top 1,000 | 12 (1.2%) | 5 (0.5%) |
| Top 10,000 | 693 (6.9%) | 105 (1.1%) |
| Genus rank (113,814 taxa / 3,077,328 occ. records) | 7.9% of taxa, 8.0% of occurrences | 1.8% / 0.8% |
| Species rank (349,184 / 2,484,788) | 53.5% / 52.0% | 25.8% / 17.5% |
| Family rank (17,355 / 2,617,487) | 18.5% / 20.8% | 8.6% / 8.0% |

Weighting is done **within a rank**. Summing `n_occs` across all ranks
double-counts heavily — the column is a subtree total, so PBDB's 523,112 rows
sum to 72.1M against ~2.0M real occurrences, and 67% of that sum sits on 32,629
high-rank taxa. A global occurrence-weighted percentage would be meaningless;
per-rank weighting is the honest version, and it says the same thing.

One number in the offline path's favour: it identifies **69,260 of the 175,419
OTT taxa flagged `extinct` that carry a `gbif:` id at all — 39.5% of the
reachable extinct set** — for zero requests and with no decay risk. That is
worth keeping. It is just not worth *depending* on.

## 2. Column layout of `simple.txt.gz`, confirmed rather than assumed

Headerless TSV, `\N` for null, **7,746,724 rows, every one exactly 30 fields**.

| Col | Field | How it was confirmed |
|---:|---|---|
| 1 | **backbone (nub) key** | unique across all 7,746,724 rows; a `UNIQUE` index builds |
| 2 | **parent key — and the accepted key for synonyms** | 0 dangling references; **0 synonyms whose parent is itself a synonym**; 0 synonyms whose parent is neither ACCEPTED nor DOUBTFUL |
| 3 | basionym key | 1,350,016 non-null, every one resolving to a real row |
| 4 | `is_synonym` (`t`/`f`) | agrees with col 5 on every row |
| 5 | **status** | ACCEPTED 4,152,023 · SYNONYM 2,933,225 · DOUBTFUL 300,247 · HOMOTYPIC 190,684 · HETEROTYPIC 151,999 · PROPARTE 18,546 |
| 6 | **rank** | 11 values only: SPECIES 4,994,322 · UNRANKED 1,275,874 · GENUS 547,518 · VARIETY · SUBSPECIES · FORM · FAMILY · ORDER · CLASS · PHYLUM · KINGDOM 19 |
| 7 | nomenclatural status array | `{}` or e.g. `{NO_SPECIES}` |
| 8 | **contributing dataset UUID** | resolves through `/v1/dataset/{uuid}` |
| 9 | origin | SOURCE 7,574,191 · EX_AUTHOR_SYNONYM · BASIONYM_PLACEHOLDER · AUTONYM · PROPARTE · IMPLICIT_NAME |
| 10 | **source usage key within that dataset** | round-tripped through the API, below |
| 11–17 | kingdom / phylum / class / order / family / genus / species key | col 11 is 0–8 on every row; **zero** accepted GENUS/SPECIES/FAMILY rows whose own-rank key differs from their key |
| 18 | name key | |
| 19 | scientific name with authorship | |
| 20 | **canonical name** | |
| 21–23 | uninomial / specific / infraspecific epithet | 99.6% / 93.4% / 8.7% non-null |
| 24 | notho type | `SPECIFIC`, `INFRASPECIFIC`; 0.1% non-null |
| 25–26 | authorship, year | 73.3% / 55.6% non-null |
| 27–28 | basionym authorship, year | |
| 29 | published-in | |
| 30 | issues array | 100% non-null |

The nine rows with a null parent are the eight GBIF kingdoms plus
`0 incertae sedis`, which confirms columns 1, 2, 5, 6, 11 and 20 in one shot.

**Column 10 is GBIF's ChecklistBank usage key, not the source dataset's own
identifier.** Verified by round-trip — `GET /v1/species/{col10}` returns a record
whose `nubKey` equals column 1 and whose `datasetKey` equals column 8:

```
nub 7827721 "Hypotrichina"     col10 100988542 → nubKey 7827721, taxonID "732"
nub 8476796 "Apatorthis tenui…" col10 121269187 → nubKey 8476796, taxonID "325272"
```

**PBDB's own `taxon_no` is not in the file.**

## 3. Why the coverage is shaped the way it is

A backbone row records **one** contributing dataset — whichever source won the
provenance slot for that name. PBDB wins it only where no higher-priority source
has the name at all, which is precisely the obscure tail. For PBDB's 500
highest-occurrence genera the slot goes to Catalogue of Life 359 times, IRMNG
225, PBDB **39**, ZooBank 38, WoRMS 38.

*Tyrannosaurus* **is** in GBIF's PBDB checklist with exactly the chain
data-sources.md records (`taxonID 38613` → key 121494660 → `nubKey 4822631`).
GBIF matched it. The backbone simply does not say so, because ZooBank got there
first — so the offline map cannot see a match that exists.

| Rank | PBDB-cited backbone rows | PBDB has | Share |
|---|---:|---:|---:|
| SPECIES | 196,116 | 349,184 | 56.2% |
| GENUS | **9,587** | 113,814 | **8.4%** |
| FAMILY | 3,225 | 17,355 | 18.6% |
| SUBSPECIES | 3,126 | 6,433 | 48.6% |

PBDB's occurrence mass is at genus rank — the top 1,000 genera alone hold 36.7%
of all genus-level occurrences — and the offline map reaches 8.4% of genera.
That is the whole story.

### A ceiling that binds both paths

GBIF's backbone has **11 ranks**. PBDB uses 25. **32,629 PBDB taxa (6.2%) sit at
ranks the backbone cannot express**: subgenus 9,964, subfamily 9,299,
superfamily 3,098, tribe 3,500, suborder 2,110, subtribe 577, and so on. These
are not *unmatched*; they are *unmatchable*, and they skew heavily toward the
notable end. In the `n_occs ≥ 100` sample, 55 of 142 checklist records carried
no `nubKey` at all, and **41 of those 55 were at an inexpressible rank** —
`Notidanus (Hexanchus)`, `Arietitacea`, `Haploceras (Neolissoceras)`.

Any design that assumes GBIF can carry every PBDB taxon is wrong before it
starts. Phase 4's parent-walk already handles this correctly; it just has to
walk further than expected.

## 4. The `checklist key → taxon_no` gap

There is **no offline route**, and I looked rather than assumed:

- The frozen backbone carries GBIF's key only (§2).
- `snapshot/gbif_pbdb_checklist/pbdb.zip` is a **ColDP archive, not a Darwin
  Core archive** — `NameUsage.tsv` / `NameRelation.tsv` / `TaxonProperty.tsv`,
  dated **2026-07-26**, 518,442 rows. `col:ID` is `txn:38613`, so PBDB's
  `taxon_no` is there verbatim (GBIF strips `txn:` to make `taxonID`), but **no
  GBIF key appears anywhere in the archive**.
- The rest of `hosted-datasets.gbif.org/datasets/backbone/2023-08-28/` is
  `backbone.zip`, `build.log.gz`, `created` / `deleted` / `resurrected`, and
  `simple-deleted.txt.gz`. None maps source keys to source identifiers.
  (`config.yaml` stays excluded; it carries a plaintext credential.)

The offline substitute is a **name join inside PBDB's own namespace** — the
backbone row's canonical name and rank against `pbdb_taxa.csv`. That is a much
narrower operation than architecture §5's `name_exact`, since both sides are
PBDB's own names, and it measures well:

| Join target | Unique | Ambiguous | No match |
|---|---:|---:|---:|
| `pbdb_taxa.csv` | **202,042 (95.4%)** | 1,557 | 8,455 |
| GBIF's ColDP input | 181,248 (85.6%) | 1,359 | 29,447 |

Against the API's ground truth it was **exactly right every time it fired** —
96/96 on the uniform sample and 14/14 on the notable one.

**Join against `pbdb_taxa.csv`, not the ColDP.** ColDP gives synonym names a
compound `col:ID` of the form `txn:{accepted}#{name}`, so extracting a
`taxon_no` from it silently maps a synonym onto the *accepted* taxon's number.
That produced 9 wrong nub keys out of 79 in an earlier pass here — an 11% error
rate that vanishes entirely with the PBDB export, which gives every synonym name
its own `taxon_no`.

## 5. The API path, and the finding that actually decides this

The export was blocked because GBIF rejects `offset >= 100_000` while the
checklist holds 461,889 records, so `gbif_checklist.py` builds ~450 covering
shards. **That is unnecessary. There is a point lookup:**

```
GET /v1/species?datasetKey={PBDB_UUID}&sourceId={pbdb_taxon_no}
  → the checklist record carrying nubKey, in one request, 0.47–0.49 s
```

```
sourceId=38613 → {key 121494660, nubKey 4822631, taxonID "38613",
                  "Tyrannosaurus Osborn, 1905", GENUS, ACCEPTED}
```

The reverse direction exists too, and it closes §4's gap exactly, without any
name matching:

```
GET /v1/species/{nubKey}/related?datasetKey={PBDB_UUID}
  → the PBDB checklist record for that backbone key, taxonID included   (0.47 s)
```

Neither is subject to the offset cap, because neither pages. The shard plan was
solving a bulk-export problem the build does not have: phase 3 needs a lookup
per PBDB taxon, not a dump.

### Measured on the same sample

458 live lookups, seeded random, one request per PBDB `taxon_no`.

| | Uniform random PBDB taxa (n=300) | `n_occs ≥ 100` (n=150) |
|---|---:|---:|
| API — record exists in the checklist | 84.3% | 94.7% |
| API — reaches a `nubKey` | **78.3%** | **58.0%** |
| API — reaches an OTT taxon | **40.7%** | **32.0%** |
| API — reaches a synth node | 7.7% | 10.0% |
| Offline — reaches a `nubKey` | 32.0% | 10.0% |
| Offline — reaches an OTT taxon | 13.3% | **0.0%** |
| Offline — reaches a synth node | 0.7% | 0.0% |

The API resolves **3× more** taxa overall and is the only path that resolves
notable ones at all. Offline found nothing the API missed on the uniform sample;
on the notable sample it found **one** taxon the live checklist has since
dropped, which is the frozen file's real but narrow advantage.

**data-sources.md finding 4 needs an update.** Conditioned the same way it was —
on records that are in the checklist — this sample (n=253, against the doc's
n=120) gives:

| | Doc | Measured here |
|---|---:|---:|
| Checklist record → `nubKey` | 88% | **92.9%** |
| ...→ resolves in OTT | 68% | **51.9%** |
| End to end | ~59% | **48.2%** |

The first hop is better than recorded and **the second is meaningfully worse**.
Phase 3's gate should be set against 48%, not 59%.

## 6. Spot checks

`offline` is the nub key the offline map produces, or `no`.

| taxon | `txn` | `n_occs` | API `nubKey` | nub row cites | OTT | in synth | offline |
|---|---:|---:|---:|---|---:|---|---|
| *Tyrannosaurus* | 38613 | 87 | 4822631 | ZooBank | 664348 | yes | **no** |
| *Triceratops* | 38862 | 166 | 4823146 | ZooBank | 4947055 | no | **no** |
| *Mammuthus* | 43266 | 692 | 8411230 | SMNS German names | 106255 | yes | **no** |
| *Diplodocus* | 38669 | 66 | 4822550 | IRMNG | 4946869 | yes | **no** |
| *Anomalocaris* | 7370 | 34 | 3255691 | ZooBank | 5129529 | no | **no** |
| *Hallucigenia* | 18884 | 26 | 4884716 | WoRMS | 4720500 | yes | **no** |
| *Aublysodon* | 38614 | 24 | 4821751 | IRMNG | 4126365 | no | **no** |
| *Archaeopteryx* | 39240 | 10 | 8276153 | Official Lists (Zoology) | **—** | no | **no** |
| *Absarokius gazini* | 43689 | 3 | **—** | — | — | no | **6142179** |
| *Astrophacus* | 34 | 2 | — | — | — | no | no |

Every well-known genus resolves through the API and none of them through the
backbone's provenance column. The obscure *Absarokius gazini* inverts it: the
frozen file holds a PBDB-sourced row for it (nub 6142179, checklist key
121539591) that the live checklist no longer returns.

***Archaeopteryx* is the version-skew failure made concrete.** Its 2023 nub key
is 8276153; OTT holds `gbif:4847896`, a key that does not exist in the 2023
backbone at all. Both paths fail on it identically, and no amount of offline
cleverness fixes it — the two snapshots disagree about the identifier. (330 of
330 `nubKey`s the live API returned *are* present in the frozen backbone, so the
skew is against OTT's Sept-2019 GBIF snapshot, not against the frozen file.)

## 7. Recommendation

**Both, with the API first.**

1. **`gbif_pbdb_chain` becomes an API crawl**, one `?datasetKey&sourceId=`
   lookup per PBDB `taxon_no`, **ordered by `n_occs` descending** so the build is
   useful long before it finishes, resumable, and written to
   `snapshot/gbif_pbdb_checklist/nubkeys.ndjson` with a manifest entry. This is
   phase-0 work in spirit — it captures the decaying half of the chain — even
   though it runs in phase 3.

   Cost at the measured 0.5 s: 523,112 taxa ≈ 73 h serial. Prioritising is what
   makes that acceptable rather than a blocker: **the top 25,000 genera hold
   93.3% of genus occurrences and the top 50,000 species hold 76.5% of species
   occurrences**, so a 50k-lookup first pass is ~7 h and covers nearly everything
   a user will ever click. Pace it; GBIF still has no rate limit because nobody
   implemented one.

2. **Keep the offline map as a distinct method**, `gbif_backbone_provenance`,
   ranked *below* `gbif_pbdb_chain`. It costs nothing, cannot decay, was exactly
   right whenever it fired, and it gives the build a floor of 17.9% of PBDB taxa
   with no network at all. Record it as its own `method` value so the
   reconciliation report can show what each contributed — and so the phase-3
   regression gate has a source that is immune to upstream change.

3. **Do not run the 450-shard export.** Leave `gbif_checklist.py`'s plan in place
   as documentation of why the bulk route is wrong, the way the module already
   documents the hierarchy-descent dead end.

4. **Use `/species/{nubKey}/related?datasetKey=` for repair, not bulk.** It is
   the exact inverse of the missing step, so it is the right tool for auditing
   the offline name join or filling a specific gap — but it is one request per
   key, so it has no cost advantage over the forward crawl.

The case against offline-only is not that it is inaccurate. It is accurate. It
is that it resolves the fossil record in exactly inverse proportion to what the
application will show, and no post-processing recovers a match the file does not
record.

## 8. Corrections to existing docs

**All four are now applied where they belong** — struck through in place in the target
document rather than deleted, so a reader who half-remembers the old figure finds out
why it changed. They are kept here because this memo is where the measurement was made.

- **handoff.md §5 and `gbif_checklist.py`** say *Tyrannosaurus* reaches the
  backbone via Catalogue of Life. It is **ZooBank**; *Triceratops* likewise. The
  point stands and is stronger than stated.
- **manifest.json and handoff.md §5** call `pbdb.zip` a Darwin Core archive with
  461,889 records. It is a **ColDP archive dated 2026-07-26 with 518,442 rows**.
  461,889 is the record count of GBIF's *ingested* checklist, which is a
  different thing. *Applied: `snapshot.py`'s manifest note and data-sources.md
  finding 4.*
- **data-sources.md finding 4** — the second hop is 51.9%, not 68%; end to end
  48.2%, not ~59% (§5). *Applied there, and in architecture.md §5, which also
  carried the ~59%.*
- **ingest.md phase 0** says GBIF's offset cap is why the checklist export is
  hard. True of a bulk export, irrelevant to a point lookup (§5). *Applied.*

## 9. The crawl budget. Settled by outcome.

This section used to ask for a decision before phase 3 started. Phase 3 ran, so
the question is answered by what happened rather than by argument.

**The prioritised `n_occs`-ordered crawl at a budget of 25,000 is the settled
answer.** It is what ran — `build/reconciliation.json` records `budget: 25000`,
25,950 checkpointed records, 0 regressions and 0 new ambiguities — and phase 3
passed its gates on it. The full 523k crawl is ~73 hours of politely-paced
requests against a service that has no rate limit *because nobody implemented
one*, which is the same academic-scale infrastructure data-sources.md warns
about for Open Tree. The tail beyond the budget buys taxa with fewer than ~10
occurrences each.

**What `--budget 25000` buys is not "the top 25,000 genera", and the two get
confused.** ~~The top 25,000 genera hold 93.3% of genus occurrences~~ is a true
statement about a crawl nobody runs: `n_occs` is a **subtree total**, so higher taxa
dominate the ordering and the first 25,000 all-rank taxa contain only **7,946 genera**
and reach **75.3%** of genus occurrences. The 25,000th *genus* sits at all-rank position
**87,126**. The all-rank ordering is still the right one — those higher taxa are exactly
the attachment points the parent-walk lands on, and the chain's 2,384 `xref` rows produce
**265,468** fossil attachments — but the two figures are not interchangeable, and phase
3's gate deliberately carries the 93.3% as its expected value with the measured 75.3%
beside it so the difference stays legible.

**Do not run the exhaustive crawl.** Raise the budget only if a coverage gate
goes red and the shortfall is traced to crawl depth specifically — and if it
does, raise it in increments and measure, rather than reaching for 523k.
