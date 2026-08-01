# Handoff — end of the phases 0–2 session

Written 2026-07-31, branch `ingest-phases-0-2`. Everything below was measured
on this machine on that date, not carried over from the design docs.

**If you read one thing: [phase2-decision.md](phase2-decision.md).** Phase 2
did not accept the Duke et al. dated tree, and whether to accept it anyway is a
judgement call waiting on a human. Nothing downstream should be built until
that is settled, because the answer decides whether the project has a week of
work left or two months.

---

## 1. State

| Phase | Status | Gates |
|---|---|---|
| 0 — snapshot | done, except one deferred export (§5) | 7/7 |
| 1 — topology | done | **25/25**, incl. 200/200 live-oracle agreement |
| 2 — dates | **run, NOT ACCEPTED** | 21/25 |
| 3 — resolution | not started | — |
| 4 — fossils | not started | — |
| 5 — images and timescale | not started | — |
| walking-skeleton renderer | done | — |

The pipeline is Python 3.14 under `uv`, in `pipeline/`. The serving binary
(architecture §4) is still an open choice and is not constrained by this — the
two share only files.

### Reproduce from a clean checkout

```bash
cd pipeline && uv sync
uv run concestor-build snapshot    # ~1.4 GB, ~4 min on a fast link
uv run concestor-build topology    # ~3 min incl. the oracle
uv run concestor-build dates       # exits 2 — this is expected, see §2
uv run concestor-build dates --provisional && uv run concestor-build render
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

## 2. The open decision

Phase 2 fails **one** criterion and passes everything else comfortably.

- Root age 4246.67 Ma against an expected 4247 — 0.008% off.
- Ultrametric to 2.7 × 10⁻⁵ Ma; **zero** negative branch lengths in 4.59M nodes.
- OTT join 99.93%, needing no forward-chasing at all.
- Mammalia 183.2, Aves 96.1, Metazoa 784.6, Eukaryota 1781.1 Ma — all in range.
- **Clade compatibility 99.6036%, against a 99.9% threshold. 947 nodes (0.40%)
  are genuinely contradicted.**

The recommendation in phase2-decision.md is to accept, restate the criterion as
*compatibility* rather than *identity*, and demote the 947 conflicting nodes to
the `structural` tier the architecture already specifies. The fallback
congruification pipeline is documented in ingest.md and **deliberately not
started**.

`concestor-build dates --provisional` writes ages tagged
`phase2_accepted: false` into `build/topology/age_provenance.json` so the
renderer has something to draw. **Those ages must not ship.**

---

## 3. Corrections to the design docs

The docs held up extremely well — every structural figure in data-sources.md
reproduced exactly. Four things need amending.

**architecture.md §3.3 — `node.is_broken` cannot work.** A non-monophyletic
taxon is *rejected* from synthesis (`input_output_stats.json` calls it
`num_taxa_rejected: 9839`), so none of the 9,839 appears as a node and the flag
is permanently zero. Broken taxa now live in their own `broken_taxon` table
carrying the substituted MRCA, its resolved `idx`, the attachment points and
the intruding taxa — which is what the UI needs in order to explain rather than
silently answer a different question.

**ingest.md phase 2 — the accept criterion assumes an impossible thing.**
"≥99.9% of internal nodes correspond" presumes node-for-node identity, which no
bifurcating chronogram can have against a tree with a 12,964-way polytomy. See
phase2-decision.md for the two gates proposed in its place.

**data-sources.md "Tree shape" — "mean 41.3" is over tips, and should say so.**
Scoring it over all nodes gives 41.67, because internal nodes sit deeper on
average (44.14). The doc is correct; it is just easy to misread, and one gate
did misread it.

**ingest.md phase 0 — GBIF caps paging at offset 100,000.** The PBDB checklist
has 461,889 records and no single field partitions it under that cap. This is
not mentioned anywhere and it is the reason for §5.

---

## 4. Things discovered while building

- **`label_format: "id"`** on `/v3/tree_of_life/induced_subtree` returns bare
  `ott770315` / `mrcaott…` labels, matching our `node_key` convention exactly.
  The default interpolates names, which can contain apostrophes and so arrive
  Newick-quoted. The parser refuses quoted input rather than mis-splitting.
- **OTT ships its own corroboration** for several doc figures, in
  `opentree16.1_output.tgz`: `labelled_supertree_out_degree_distribution.txt`
  independently confirms 2,385,875 tips, 83,305 unary nodes and a 12,964 max
  fanout, and `input_output_stats.json` confirms the 9,839 rejected taxa. Worth
  checking against on every release.
- **Duke's tree carries two label families of its own** — `mrcaimp` (1,084,177)
  and `mrcapoly` (965,471) — which are their interpolation and
  polytomy-resolution nodes, not OTT nodes. Together they are 89% of their
  internal nodes.
- **Nothing needed a forward.** All 297,070 entries in `forwards.tsv` loaded and
  chased transitively; zero were load-bearing for the Duke join. Keep the
  machinery — it is cheap and the next release will differ — but do not assume
  it is exercised.
- **GBIF's `backbone/2023-08-28/config.yaml` contains a plaintext database
  password.** It is deliberately not snapshotted and was not used. Flagging it
  only so nobody adds it to the download list later; it is GBIF's exposure to
  handle, not ours.

---

## 5. Known gap

The **GBIF checklist `nubKey` export did not complete.** It is the operative
half of the only identifier path from PBDB to OTT, and it is phase-3 material
rather than phase-0, so nothing is blocked today.

Nothing decaying was lost. The two irreplaceable artifacts are both captured
and checksummed: the **frozen legacy backbone** (`simple.txt.gz`, 466 MB, dated
2023-08-28 and never to be updated) and the **PBDB Darwin Core archive**
(`pbdb.zip`, all 461,889 records with PBDB's `taxonID` verbatim).

The blocker is that GBIF rejects `offset >= 100_000` on both `/species/search`
and `/species`, and no single field partitions the checklist below that. A
rank × status × phylum covering shard plan is implemented in
`gbif_checklist.py` but is ~450 shards of up to 99 pages and was not run to
completion. An earlier hierarchy-descending version was worse and is documented
in that module so nobody rebuilds it.

**There is a promising offline alternative, and it should be tried first.**
The frozen backbone's `simple.txt.gz` records source provenance per row: column
8 is the contributing dataset UUID, column 10 the source record key.
**212,054 backbone taxa cite the PBDB checklist UUID
`c33ce2f2-c3cc-43a5-a380-fe4526d63650` directly.** That is a `nubKey → GBIF
checklist key` map for the PBDB-sourced portion of the backbone, from a file we
already hold, with no API and no decay risk.

It is not a complete substitute. Well-known fossil genera often reach the
backbone via Catalogue of Life instead — *Tyrannosaurus* resolves to nubKey
4822631 whose nub entry cites CoL, not PBDB — and the chain still needs
`checklist key → PBDB taxon_no`, which the DwC-A does not carry because it
holds PBDB's own ids rather than GBIF's. Measuring its real coverage against
the verified `taxonID 38613 → nubKey 4822631 → ott:664348` chain is the first
task of phase 3.

> **Done, 2026-07-31 — [phase3-pbdb-path.md](phase3-pbdb-path.md).** The offline
> map reaches 38.6% of PBDB taxa but **0 of the top 100 by `n_occs`**, so it is a
> second method, not a substitute. Two corrections to the paragraph above:
> *Tyrannosaurus*'s nub entry cites **ZooBank**, not CoL, and `pbdb.zip` is a
> **ColDP archive dated 2026-07-26 with 518,442 rows**, not a Darwin Core archive
> of 461,889. More usefully, the export was never actually blocked:
> `GET /v1/species?datasetKey={PBDB}&sourceId={taxon_no}` is a point lookup, so
> the offset cap does not apply and the ~450 shards are unnecessary.

---

## 6. Conventions

In [../CLAUDE.md](../CLAUDE.md). The two that cost real time:

**Gates collect rather than raise**, so a phase reports every failure at once
and then refuses to write output. `require` blocks; `observe` records. Expected
values are measured, not estimated — but check what a gate is *measuring*
before changing either side of it.

**Do not apply a lint or type fix without reading the surrounding code.** Two
bugs in this repo came from exactly that, including one where silencing an
unused-variable warning left a database column permanently `NULL` while every
gate still passed. Counting rows is not checking them; `tests/test_db_contents.py`
exists because of it.
