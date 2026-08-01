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
  common names at all, so on the raw taxonomy "Tyrannosaurus" resolves and
  "T. rex" and "dog" do not. An app premised on inviting exploration cannot
  ship with a search box that only accepts binomials. Both now work, via
  Wikidata P9157 plus an abbreviation index; coverage is still thin (§7).

**This is not a commercial project.** Drop the commercial-safety machinery — no
`--commercial-safe` flag, no NonCommercial filtering, and ignore the PBDB licence
question. That is a straight win: the unfiltered corpus reaches every node
against 93.7% for the licence-filtered path — though see §5 on why coverage is
the wrong thing to count. Attribution
still applies — CC-BY requires it for any redistribution and the artists deserve
credit — and it is a two-field problem, since `attribution` (creator) and
`_links.contributor.title` (uploader) differ **50%** of the time (measured
across the whole corpus; the 31% in the design docs is wrong — see §4).
TimeTree stays excluded; its redistribution ban is unconditional.

---

## 1a. The design language, and where it collided with the architecture

**[design-reference.md](design-reference.md) is authoritative** on visual
language, command surface, motion and stack. A dark instrument where the graph is
the only light source, operated from a `⌘K` command palette, phosphor-persistence
metaphor, React Flow / xyflow v12. Read it before writing any frontend code.

It sharpens the priorities rather than changing them. Its **signature interaction
is the add** — draw originates at the *MRCA* and extends outward to the new leaf,
with the MRCA flaring at `t=80` — and it says outright that this is the product
and everything else is plumbing. That is priority 1 and 2 restated as one motion,
and the data side already supports it: the MRCA is the last common element of two
ancestor paths, already in memory, no query and no round trip.

Four collisions with `architecture.md`, all now resolved there:

**Layout must not use dagre or ELK.** The design reference suggests
`d3-hierarchy / ELK / dagre`. A graph-layout engine assigns `x` by *depth*; here
`x` is *time*. Running one would silently destroy the axis it exists for. Every
other layout principle holds — deterministic, computed, never simulated, not
draggable — and our layout already is all of those. See architecture §7.

**Luminance is spoken for.** The design reserves brightness for recency and
selection, "never data value". But age provenance *is* a data value we are
obliged to render. Resolution: provenance gets dash pattern and desaturation, and
`structural` nodes get **no numeric age at all** — which was always the hard
requirement. Luminance stays with selection.

That channel shipped undocumented on screen for a while, which made it a code
nobody could read: the only place "dashed means nobody has estimated this" was
written down was these docs. `web/src/canvas/Legend.tsx` now says it on the
canvas, deriving its rows from the edges actually drawn so it can never caption
a pattern that is not there — and rendering its swatches with the real
`.trace-core` classes so the legend and the traces cannot drift apart.

**Where it went is the part worth keeping.** It took two wrong answers first, a
titled card and then a bordered pill, and both were the same mistake: adding a
third floating object to a bottom edge that already had the axis and the hint
bar. The fix was not a smaller panel. The key, the units and the scale mode all
answer one question — how do I read a position here? — so they share one flat
line in the axis footer, and the hint bar, which answers a different question,
moved to the top edge. If something else earns standing chrome later, the test
is which of those two questions it answers, not where there is room.

**The ICS geologic palette is warm; the design language forbids warm.** Keep the
official hue *relationships*, drop the official saturation and luminance, and let
the band recede. The original argument for exact CGMW colour was that it reads as
authoritative to specialists — not our audience.

**Tabular mono numerics supersede old-style figures.** Scientific italics for
species and genus names survive unchanged, so the UI sans needs a real italic
rather than a synthesised oblique.

One knock-on worth stating plainly: **a command palette makes vernacular names
load-bearing at first contact.** If typing "dog" or "T. rex" returns nothing, the
product is broken at its front door, not merely incomplete.

---

## 2. State

| Phase | Status |
|---|---|
| 0 — snapshot | done, 7/7 gates |
| 1 — topology | done, **25/25 gates**, incl. 200/200 live-oracle agreement |
| 2 — dates | **ACCEPTED and implemented**, 32/32 gates. Tiers are baked (§3) |
| 3 — resolution | built — `resolve.py`, `xref` populated |
| 4 — fossils | built — `fossils.py`, `fossil` table populated |
| 5a — images | built — `images.py`, **28/28 gates**. Coverage is 100% and says nothing; the gate is the size of the clade a picture speaks for (§5) |
| 5b — timescale | built — `timescale.py`, 26/26 gates, `build/timescale.json` |
| 6 — vernaculars | built — `vernaculars.py` + `search.py`, `node_fts` live |
| walking-skeleton renderer | done, throwaway, superseded |
| serving binary | **built, in Go** — `server/`, every endpoint live. [serving-binary.md](serving-binary.md) |
| real UI | **built** — `web/`, React + xyflow v12. The signature interaction works end to end |

Everything in `ingest.md` is now implemented. What remains is depth and polish,
not new machinery — see §7 for the honest list of what is thin.

**The MRCA and tree-drawing primitive already works and is proven.** Everything
rests on `path(node) → [root, …, node]`; induced subtrees are the union of
ancestor paths with degree-2 nodes suppressed, which makes MRCA queries,
incremental reflow and the branch drill-down fall out of one computation. Mean
path length is 41. The renderer hits the `2|L|−1` bound exactly. Priority 1 is
largely de-risked; what remains is making it good, not making it work.

The pipeline is Python 3.14 under `uv`, in `pipeline/`. The serving binary is
Go, in `server/`, and shares only *files* with the pipeline — no runtime, no
FFI. Reasoning in [serving-binary.md](serving-binary.md).

```bash
cd server && go test ./... && go run . -addr :8080 -build ../build
```

It feature-detects every optional table and array, so it starts and serves
correctly against a partially-built dataset and reports exactly what it found
at `GET /v1/about`. The Go port of `render.py`'s `induced_subtree` is pinned
against the Python reference node-for-node by
`TestInducedSubtreeMatchesReference`; that test is the contract between the two
halves of the system.

The real UI is `web/` — Vite + React 19 + TypeScript + `@xyflow/react` v12.

```bash
scripts/serve.sh    # API + built frontend, one process, :8080
```

That is the `concestor` configuration in `.claude/launch.json`, so the preview
browser and any agent start the app the same way. It verifies the artifacts
exist first and builds `web/dist` if it is missing, rather than serving a blank
canvas that looks identical to a broken one. `scripts/dev.sh` is the
`concestor-web-dev` configuration: Vite on :5173 with hot reload, backed by an
API it starts itself on a private port.

Both configurations set `autoPort`, and both scripts run unchanged inside a
git worktree — see [worktrees.md](worktrees.md). That matters because every
parallel Claude Code session gets its own worktree, and a worktree has the
source but none of `build/`, `snapshot/` or `node_modules`.

**Restart it after any pipeline run** — the arrays are mmap'd and SQLite is
opened at startup, so a running server serves the previous build and the only
symptom is quietly stale answers.

```bash
cd web && npm install && npm run build   # the server picks up web/dist
npm test                                 # 45 tests
```

The client owns the topology after first paint (architecture §4): it fetches
one ~450-byte ancestor path per selection and recomputes the induced subtree,
MRCA and layout locally, so **the MRCA flare fires in the same frame as the
click** with no round trip. `web/src/tree/induced.ts` is a deliberate port of
`render.py`'s `induced_subtree` and is pinned to it by a fixture generated from
the real baked arrays — `web/src/tree/induced.test.ts` asserts the same MRCA,
the same rendered set, the same segments *and* the same suppressed runs for the
skeleton renderer's eleven species. Three independent implementations of the
same primitive now exist (Python, Go, TypeScript) and two of them are tested
against the first.

### Reproduce from a clean checkout

```bash
cd pipeline && uv sync
uv run concestor-build snapshot    # ~1.4 GB, ~4 min on a fast link
uv run concestor-build topology    # ~3 min incl. the oracle
uv run concestor-build dates       # phase 2; writes age_ma / age_tier / age_layout
uv run concestor-build resolve     # phase 3
uv run concestor-build fossils     # phase 4; also REWRITES age_tier + age_layout
uv run concestor-build images      # phase 5a; long, resumable, paced
uv run concestor-build timescale   # phase 5b
uv run concestor-build vernaculars # phase 6
uv run concestor-build search      # FTS index; must run AFTER vernaculars
uv run concestor-build render      # throwaway skeleton, still useful as an oracle
```

Order matters in three places. `search` reads the `vernacular` table;
`fossils` reads `xref`; and **`fossils` must run after `dates`, because it
rewrites `age_tier` and `age_layout` with the fossil record** — the fourth age
tier and the layout bound are both its output, not phase 2's. Re-running
`dates` therefore undoes both and phase 4 has to run again; `dates` deletes the
baselines phase 4 keeps so that this cannot happen silently. Everything else is
independent.

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

**Accepted, and now implemented — `phase2-dates[equal_splits]: 32/32`.** The
criterion is restated as two gates that mean something (`MIN_CLADE_COMPATIBILITY
= 0.995`, measured 99.6036%; `MIN_BRANCHING_CORRESPONDENCE = 0.98`, measured
98.64% with unary nodes excluded), and the 947 contradicted nodes are demoted to
`structural` by construction rather than by hand. `age_provenance.json` now says
`phase2_accepted: true`.

**The fallback congruification pipeline is not to be built.** 4–6 weeks for a
less defensible time axis, on a secondary feature. Background in
[phase2-decision.md](phase2-decision.md).

The **comparison tree passes the restated criteria too** — `birth_model` scores
32/32 at 99.6237% compatible with 899 conflicts — which is worth knowing,
because it means the reframing is not tuned to the tree it was written for.

#### Three age arrays, not one, and why

`ingest.md` phase 2 step 4 planned to take tiers from Duke et al.'s cached
`node_ages.json`. **That file is not in the Zenodo record we snapshotted** —
only the two median trees are — so the tier is measured from our own clade
comparison instead. It turns out to describe *our* nodes better than a
transcription of theirs would have:

| Tier | Meaning | Count | Rendering |
|---|---|---:|---|
| `measured` | our clade is exactly Duke's clade over shared tips (148,867 internal), or the node sits at the present — being extant is an observation, not an estimate | 2,441,927 | solid, age shown |
| `interpolated` | our clade is a strict **subset** of the dated one | 95,310 | fine dash, age shown as **`≤ N Ma`** |
| `structural` | no match, or Duke contradicts our clade | 186,312 | dashed, **no number at all** |
| `occurrence` | extinct, and PBDB has a range for it — written by phase 4, not phase 2 | 2,133 | the double bracket, **no number at all** |

The middle tier gained a stronger claim than the design anticipated. If our
clade is a strict subset of Duke's, their node is the MRCA of a *superset* of
tips, so its age is a genuine **upper bound** on ours — not an estimate with
unknown error, a bound. The UI writes `≤ 652 Ma`, which is both more honest and
more useful than a bare figure.

Three arrays ship, and keeping them separate is load-bearing:

- `age_ma.npy` — what may be *shown*. NaN wherever nothing may be.
- `age_tier.npy` — how to show it.
- `age_layout.npy` — where to *draw* it. Finite everywhere and monotone
  root-to-tip, filled for undated runs by spreading them between the nearest
  dated ancestor and the deepest dated descendant.

Collapsing `age_ma` and `age_layout` to save 10 MB would put a confident number
on every dashed node. `tests/test_dates_tiers.py` guards that specifically.

**What the three tiers do not cover, and it is a whole kingdom of taxa.** All
three describe *divergence times*, and all three derive from a single source
that contains only **extant** species. So the first three tiers say nothing
about anything extinct — not "we are unsure", but "this question was never
asked". 1,742 of the 1,743 extinct-flagged nodes are `structural`, by
construction rather than by measurement.

**The fourth tier is built.** `occurrence` is a different and weaker claim in
the same units: not when lineages parted, but when the taxon is observed in the
rock. 2,133 nodes carry one, *T. rex* and *Homo erectus* among them, and the
rule it respects is unchanged — **a stratigraphic range is not a divergence age
and is never written into `age_ma`.** A gate checks that on the array rather
than trusting the code that wrote it.

It lives in its own **table**, not its own array. handoff said array; the
constraint is that it is not `age_ma` and cannot be reached by anything reading
`age_ma`, and a table meets that identically. A dense `(n, 4)` float32 array
would have been 43.6 MB to carry 2,133 useful rows, against an artifact set
already 2 GB over its estimate, and the Go reader is 1-D so it would have been
four files. The dense array is still built in memory and every gate runs
against *it*, because that is where a transposed column would show.

**Watch this one:** the headline tier counts flatter us badly. 89.6% `measured`
sounds like a well-dated tree, but 2,271,190 of those are extant tips sitting at
the present, which is true and says nothing about any divergence. The figure
that describes the chronogram is **170,737 of 339,807 internal nodes (50.2%)**,
and that is what `age_provenance.json.headline` and `/v1/about` report.

**Two traps found while implementing it**, both now guarded:

- `--tree birth_model` used to overwrite the accepted tree's age arrays and the
  canonical gate file. Both trees pass identically, so the only symptom was a
  few nodes shifting by a fraction of a Ma. `PRIMARY_TREE` now gates every
  shared write; the comparison tree writes only its own suffixed files.
- **Phase 4 keeps a copy of what phase 2 wrote** — `age_layout_phase2.npy`
  and `age_tier_phase2.npy` — so re-running phase 4 clamps the original rather
  than compounding its own output. A phase 2 re-run invalidates both, and a
  phase 4 run against a stale copy would apply the fossil bound to a layout
  that no longer exists, *quietly*, because both arrays would be internally
  consistent and nothing would error. Phase 2 deletes them when it writes.
  Same shape as the two below and found by looking for it rather than by
  hitting it.
- `build/phase2_gates.json` and `date_validation.json` predate the `--tree`
  flag and had been left behind as stale copies of a *failing* run. Anything
  globbing `phase*_gates.json` — `/v1/about` did — kept reporting a verdict
  that no longer existed. Phase 2 now rewrites both canonical names on every
  primary run.

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

### Broken taxa: an answer to a whole name, never a candidate in the list

"Broken taxa must be searchable" was read as "must be *results*", and it made
the palette worse the more of a name you typed. `searchBroken` matched on
prefix, so 9,839 taxa chased every keystroke: typing towards *Homo sapiens
neanderthalensis* put *Neanastatinae* and *Neanuridae* on the page, and two
things then compounded it. They carry `idx: null` by construction — they are
not nodes — so every one of them hashed to the same session-ranking key
`n:null` and to the same React key; one accidental click taught the ranking to
pin all of them, and duplicate keys left rows stranded on screen through every
later query. Picking one put a key in the URL that resolved to nothing, and
since nothing was drawn there was no node to select and remove, so the warning
returned on every subsequent add with no way to clear it.

Settled as: **the query has to be the whole name.** A broken taxon is an
explanation for a name, not a candidate answer competing with real nodes — it
is only ever useful to someone who meant that name, and *only* they type it in
full. `data-sources.md`'s requirement is met exactly where it bites (ask for
*Dinosauria* and we say why it is not there, rather than silently answering
about *Sauria* the way the live API does) and the noise is gone, which was all
of it. In the UI it renders as `BrokenNote` below the results — not a row,
because everything in that list is something Enter will act on. The union in
`api.ts` makes `idx: null` unrepresentable on a hit that can be added, which is
what stops the two identity bugs coming back. A broken key arriving from an
older shared link is reported once and dropped from the selection.

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

**GBIF vernaculars are not free, contrary to three documents.** `ingest.md`
phase 6, `management.md` and `architecture.md` §4 all say they arrive via
`ott_sourceinfo`. `topology.py` never parses `sourceinfo` into the database,
and the snapshotted `simple.txt.gz` carries no vernacular names at all.
Getting them means a fresh GBIF crawl. Not implemented, and lowest priority
now that P9157 covers the notable end.

**Wikidata P9157 is not a complete map of OTT, and the hole is at the top.**
Wikidata's `animal` item (Q729) carries **no P9157 statement**, nor do Metazoa,
Bilateria or `cellular organisms`. An id-only join therefore answers "dog" and
returns nothing for "animal" — the opposite of the failure you would predict.
Closed by a bounded second pass on `wdt:P225` (scientific name), exact-and-
unique-only per architecture §5, 25 queries.

**The 9,839 broken taxa were completely unsearchable and nobody had recorded
it.** They are rejected from synthesis so they have no `node.name`, and the
palette simply returned nothing for *Escherichia coli* or *Dinosauria* — two
names a curious person is entirely likely to type. They are now a fifth FTS
column flagged `kind = broken`.

**WDQS rate-limits** (429 with `Retry-After`, plus 502/503 and a hard 60 s
query timeout), and a GET with a large `VALUES` clause returns `503 VCL
failed` — it must be POSTed. The endpoint is free and shared; pace it.

**architecture.md §3.3's `node_fts(name, synonyms)` is two columns short**, and
`ingest.md` phase 1 step 8 claims phase 1 builds the FTS index. It never did —
the index is built by a separate `search` phase that must run *after*
`vernaculars`. architecture.md §4 and §10 also call vernaculars "phase 5"; they
are phase 6.

**architecture.md §3.4 — `fossil.pbdb_orig_no INTEGER PRIMARY KEY` cannot
work.** `orig_no` is not unique: 407,634 distinct values over 523,112 rows, with
86,302 repeated (*Dinosauria* has ten rank-variant records sharing 52775).
`taxon_no` *is* unique and is what `parent_no`, `accepted_no` and GBIF's
`sourceId` all reference. The table is keyed on it, with `orig_no` kept as a
column.

**ingest.md phase 4 — "the missing set is exactly those with `n_occs = 0`" is
containment, not equality.** All 111,864 zero-occurrence rows lack an interval,
but 112,073 rows do: 209 have occurrences and no bounds. Sixteen rows carry an
*empty* `n_occs` rather than a zero, and the 411,039 baseline counts a *first*
appearance bound — only 410,615 carry all four.

**ingest.md phase 4 — "attaching at or below Dinosauria" is untestable as
written.** Dinosauria is ott 90215 in the taxonomy but **is not a node in the
synthesis tree**; the lineage runs Sauria → unnamed `mrca*` nodes →
Tyrannosauridae. The gate uses Tyrannosauridae, which is a strictly stronger
claim.

**ingest.md phase 3 — the IRMNG figure is the naive parse's.** Distinct OTT
taxa carrying an IRMNG id is **1,480,678**, not 1,480,677. The extra one is ott
7494610 *Ficus variegata*, whose only IRMNG id is the space-prefixed
`" irmng:11258800"` — so the doc's own figure is evidence for the
malformed-prefix warning the same doc gives.

**ingest.md phase 3 — the 48.2% chain gate is calibrated on a *uniform*
sample, and the settled crawl is `n_occs`-ordered.** Those are different
populations and scoring the gate on the prioritised cohort fails for a reason
that is not a bug (37.8% end to end, because coverage is inversely correlated
with how much a taxon matters — the memo's own §5 says so). Phase 3 crawls a
1,000-taxon seeded uniform control alongside the real crawl and gates on that,
reporting the prioritised cohort separately.

**management.md — "the top 25,000 genera hold 93.3% of genus occurrences" is
not what `--budget 25000` buys.** `n_occs` is a subtree total, so higher taxa
dominate the ordering: the first 25,000 all-rank taxa contain only 7,946
genera and reach **75.3%** of genus occurrences, and the 25,000th *genus* sits
at all-rank position 87,126. The all-rank ordering is still the right one —
those higher taxa are exactly the attachment points the parent-walk lands on,
and 2,574 chain rows produce 239,253 attachments — but the two figures are not
interchangeable.

**phase3-pbdb-path.md §1 — the accepted-key fallback does not reproduce.** The
memo gives 139,740 (26.7%) but does not state its rule; col 2 on synonym rows
only gives 138,180 (26.41%), "any non-ACCEPTED" gives 144,884 (27.70%),
"always" gives 168,781 (32.26%). Everything else in §1–§4 reproduced to the row.

**architecture.md §5 and ingest.md phase 3 disagree on where
`phylopic_resolve` ranks** — 3rd at confidence 0.98 versus 5th. Moot in
practice, since the source namespaces are disjoint. The build follows
ingest.md's order and architecture's confidences.

**architecture.md §11 — the artifact set is 2,004 MB, not "under 700 MB".** The
estimate predates the resolution layer and the silhouette map. `dbstat` on the
built database: `xref` 270 MB, `search_name` 225 MB, `broken_taxon` 189 MB,
`node_image` 163 MB, `node` 160 MB, `node_image_phylopic` 124 MB, `xref_idx`
101 MB, plus the FTS index. This does not change the architecture — everything
is still immutable, still baked, still deployable as an image — but "fits in a
container image and stays resident in page cache on a small instance" now needs
a bigger small instance, and §11's cost paragraph should be re-derived before
anyone sizes a machine from it. `concestor-build package` reports the number
every build; **it is an `observe` gate deliberately**, because the right
response is to decide what to trim, not to fail the build.

**ingest.md — there is no `topology.bin` or `meta.bin`, on purpose.** A `.npy`
file is a 128-byte ASCII header followed by exactly the raw little-endian array
architecture §3.2 describes, so the phase-1 output already *is* the format. The
Go server reads it directly. Writing a concatenated second copy would double
the disk cost and give the most load-bearing array in the system two candidate
sources of truth. Read those names as describing a format, not demanding a
file; `package.py`'s docstring records the reasoning.

**data-sources.md — PhyloPic's creator and uploader differ 50% of the time, not
31%.** Measured across the whole 12,863-image corpus. Related: the doc's 47.2%
attribution-required figure is of `primaryImage` *results*; across the corpus it
is 5,432 images, 42.2%. Both numbers are right and the denominators differ,
which is worth stating because they get compared.

**phase 3's `xref` resolves PBDB to OTT across kingdom homonyms, and nothing
had recorded it.** OTT carries the same genus name in unrelated kingdoms and
`xref` matches on the name, so a Cambrian fossil lands on a living plant. Found
while bounding the layout by the fossil record, which is the only reason it
surfaced at all — nothing else was comparing a resolution against time.

A cheap decisive test, because a taxon last seen before the Permian cannot be a
living genus: of the **1,048 nodes** carrying an exact attachment with
`lla > 250 Ma` and not flagged extant, **1,019 have living descendants**. Phase
4 reports it every build, as an `observe` — that phase cannot repair it, and
the baseline has to be on the record before phase 3 tries. Counted per *node*;
per fossil *row* it is 1,380 of 1,416, and the two figures are the same finding
seen at different grain.

| PBDB taxon | last seen | resolved onto |
|---|---:|---|
| *Sadleria* | 372 Ma | *Sadleria*, a living Hawaiian fern genus |
| *Streptosolen* | 457 Ma | *Streptosolen*, a living South American shrub |
| *Lewinia* | 443 Ma | *Lewinia*, a living genus of rails |
| *Ivesia* | 539 Ma | *Ivesia*, a rose-family plant |

**It is not confined to the naive path.** By method: `name_exact` 991,
`gbif_backbone_provenance` 221, `gbif_pbdb_chain` 168 — so 389 of them survived
a route that was supposed to be evidence-based, and "only trust the backbone"
is not the fix.

*Decided, scoped, not started.* The fix belongs in phase 3 and it is a lineage
comparison: PBDB carries its own hierarchy in `parent_no` and OTT carries the
tree, so a resolution can be refused when the two disagree above family level.
`images.py` already refuses an ambiguous name outright, but that machinery does
*not* help here — these names resolve to exactly one OTT node; it is simply the
wrong taxon. The test above is a ready-made `observe` gate: it needs no new
data and it should go in before the fix so the baseline is on the record.
Phase 4 currently guards itself by refusing any fossil bound on a node with a
living descendant, which is correct for phase 4 and does nothing for the other
`xref` consumers.

**architecture.md §7 — the double bracket's "solid bar" does not exist for most
taxa.** §7 says "faded envelope `fea→lla`, solid bar `fla→lea`", and the obvious
reading is that the four bounds form a chain `fea ≥ fla ≥ lea ≥ lla`. **The
middle link is false.** Measured over all 410,615 rows carrying four bounds,
`fea ≥ fla`, `lea ≥ lla`, `fea ≥ lea` and `fla ≥ lla` each hold for 100% — and
`fla ≥ lea` holds for **39.6%**. It is not a data defect: a taxon known from one
stratigraphic interval has both appearances inside it, so `fla` sits at that
interval's young end and `lea` at its old end and the two cross. So for **60.4%
of PBDB taxa there is no certain extent at all**, and the solid bar must be left
undrawn rather than drawn zero-width — a hairline at a single date reads as
precision, which is the opposite of what it means.

**architecture.md §6 — "keep the official hue relationships" cannot fully hold,
and the doc should say so.** ICS separates the four Paleoproterozoic periods
almost entirely by a *lightness* ramp, which is the exact channel §6 instructs
us to drop; their official minimum pairwise distance is already at the edge of a
just-noticeable difference. §6's own next sentence — wayfinding comes from
labels and hairline dividers first, hue second — is the resolution, but the two
claims are in tension and a reader should not have to discover that. The
timescale phase gates the contraction as *faithful* (every pairwise distance
scaled by exactly 0.22, hue bit-preserved) rather than gating distinguishability
it cannot deliver.

---

## 5. Things discovered while building

- **`node_fts.rowid` is a `search_name.id`, never a `node.idx`.** The FTS index
  holds one row per *name* — 6.8M rows against 2.7M nodes — because a taxon has
  a scientific name, an abbreviation, synonyms and vernaculars. Architecture
  §3.3 sketched `content=''` with an implied rowid of `node.idx`, and joining on
  that assumption **does not error**: it joins cleanly to unrelated nodes and
  returns confident nonsense. `q=dog` came back as three unnamed `mrcaott…`
  internal nodes. Always go through `search_name`; `kind` is `0 sci, 1 abbr,
  2 syn, 3 vern` and is worth surfacing as *why* a row matched. The server now
  refuses to use an FTS index it cannot find a rowid mapping for, and
  `server/internal/store/fts_test.go` asserts that results actually carry a name
  containing the query — a test that only checks "some rows came back" passes
  against this bug.
- **FTS5 prefix cost is superlinear in how short the prefix is.** Measured on
  this corpus: `'"homo"*'` is 0.4 ms, `'"can"*'` 2 ms, `'"a"*'` **90 ms**,
  because FTS5 enumerates every indexed term with that prefix. A command palette
  fires on the first keystroke, so the server answers tokens shorter than three
  characters from an in-memory cache of the largest subtrees instead.
- **Ranking needs a whole-word band, not just "exact vs not".** `dog` is a whole
  word in Canidae's "dog family" and a mid-word prefix in Apocynaceae's "dogbane
  family"; with only `tip_count` to separate them the 7,050-tip plant family
  beats the dogs. Precedence is now: exact string, whole-word, prefix-of-word,
  then current-name-before-synonym, then the baked `rank_score`, then
  `tip_count`.
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
- **Silhouettes resolve from an index crawl, not per node.** ingest.md phase 5
  step 2 reads as one `primaryImage` call per node, which is 2,725,682 requests
  against a small volunteer service. Crawling the *image index* instead is 269
  requests: `embed_items=true&embed_specificNode=true` carries licence,
  attribution, contributor and the node's OTT id inline, and propagating to
  every node by nearest-ancestor is a single forward sweep taking **0.2 s**.
  Coverage is **100%**, better than the 88/94% baseline, which described a
  different mechanism and is no longer the thing to measure.
- **The number that matters for silhouettes is the size of the clade a picture
  speaks for.** Not coverage, which is 100% and always was; and not `climb`,
  which counts our search rather than their answer.

  Resolution originally gave a node the image of its nearest ancestor that was
  *itself* seeded. With 7,470 seeds over 2.7M nodes that ancestor is usually
  enormous: mean climb 27.2 hops, **65.3% of the tree borrowing from a clade of
  over a million tips**, and three sources — Ecdysozoa, `cellular organisms`,
  Opisthokonta — serving 1.79M nodes between them. A screen of arthropods drew
  one shape repeated. Both 100% coverage and 27.2 hops were true and neither
  told anyone that.

  It now gives a node the picture of its **closest drawn relative**, and records
  `clade_idx`: the smallest clade containing both the node and the drawing.
  That clade is the whole of what the picture claims — *something in here looks
  like this* — so its `tip_count` is the size of the claim, and it is what the
  gates measure and the UI renders. Measured before → after:

  | | nearest seeded ancestor | closest drawn relative |
  |---|---:|---:|
  | median clade a picture speaks for | 1,208,417 tips | **3,153** |
  | nodes speaking for over 1M tips | 65.3% | **0.00%** |
  | clade ≤ 10,000 tips (leaves) | 13.4% | **71.2%** |
  | mean climb | 27.2 | 4.24 |

  Selachii drew Opisthokonta and now draws a shark; Coccinellidae drew
  Ecdysozoa and now draws a ladybird; a riffle beetle drew all 1.2M arthropods
  and now draws Elminae's 987. **Exactness still wins** — a seeded node keeps
  its own image, so Mammalia is drawn as Mammalia and never as one mole inside
  it, and architecture §7's warning survives intact. §7 is about a *specific*
  node wearing a clade's picture; `clade_idx` is precisely the number that says
  how big a claim that is, which is why drawing every silhouette is now
  defensible where it was once a nerve-holding experiment.

  `method` gained a fourth value, `relative` — a cousin, neither ancestor nor
  descendant — and it is 2,448,650 of the 2,725,682 nodes.
- **PhyloPic attaches human images to `Homo sapiens sapiens`**, a subspecies the
  synthesis does not carry, so the seed was silently dropped and *Homo sapiens*
  climbed 35 hops to Mammalia. 2,485 of 9,461 cited OTT ids are like this. The
  fix is a **bounded** one-hop lift onto a target of ≤100 tips — an unbounded
  parent walk seeds Amphibia with a Devonian stem tetrapod, which is the same
  failure in the other direction.
- **1,783 images cite no OTT id at all**, because their specific node resolves
  only in GBIF or PBDB namespaces. No amount of id chasing reaches them, so
  seeding has two further passes that go through the *name*: match the image's
  `node_title` against `taxonomy.tsv`, then, failing that, against the title
  truncated to species and genus (`Equus quagga chapmani → Equus quagga →
  Equus`). Exact name matches carry no tip bound — the image really is of that
  taxon — while truncated ones reuse the lift's ≤100 tips. A name resolving to
  two nodes is refused outright; OTT carries homonyms across kingdoms and
  nothing in the title says which `Prunella` was drawn. Worth 337 nodes (125
  exact, 212 truncated) and 13,477 nodes given a closer image. The gate reports
  those, not the 2,958 matches the passes make — most land where an OTT id
  already reached, and crediting them would be counting work, not result.
- **Seeding is at the corpus ceiling, and the ceiling is low.** 12,863 images
  → 11,080 with an OTT id → 9,461 distinct ids → 6,976 in the tree → 7,470
  seeded nodes against 2,725,682. Every remaining idea (deeper lifts, fuzzy
  names, synonym tables) is worth tens of nodes, not thousands. More
  silhouettes on screen is now a threshold and rendering question, or a
  second-corpus project — not a resolution one.
- **Mirrored PhyloPic SVGs hardcode `fill="#000000"`.** Architecture §7's
  `fill: currentColor` is true of the shape and false of the file: through
  `<img src>` or `background-image` an SVG is an opaque image and nothing in the
  page can recolour it, so the intended behaviour renders black on near-black.
  The client fetches and inlines the markup with the baked fill stripped
  (`web/src/canvas/Silhouette.tsx`). Only then does the silhouette take the lane
  hue and the selection bloom.
- **`chart.ttl` hides 36 of its 356 age bounds behind a `skos:note "uncertain"`
  *inside* the blank node**, ahead of `gtsd:inMYA` — undocumented anywhere. A
  `hasBeginning\s*\[\s*gtsd:inMYA` regex misses all 36 silently. That is what
  forced a real Turtle parser rather than a pattern match. Also: **21 of 178
  concepts have no `skos:prefLabel` in any language** (the informal
  Lower/Middle/Upper subdivisions), and the rank set includes `Sub-Period`, so
  band rows must key on rank rather than depth.
- **`timescale.json` is 52.6 KB, not the ~40 KB architecture §6 estimates**
  (8.7 KB gzipped, served immutable, so this is immaterial — but the figure is
  quoted in two places).
- **`node_fts` is one row per *name*, not per node.** 6,834,727 rows against
  2,725,682 nodes, with `search_name` carrying `id → idx` and a `kind`.
  Architecture §3.3's sketch implies `rowid == node.idx`, and joining that way
  **does not error** — it joins cleanly to unrelated nodes and returns confident
  nonsense. Searching "dog" returned three unnamed `mrcaott…` internal nodes.
  Anything reading the index must go through the mapping table.

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
renderer already does this; the real UI must not regress on it. It does not:
`structural` nodes carry NaN in `age_ma` by construction, a gate checks the
array rather than the code that wrote it, and the client re-checks at the API
boundary.

---

## 7. What is thin

Everything in `ingest.md` is implemented, so this is the honest list of where
the depth is not yet there. Roughly in priority order.

**Vernacular names are not merely thin — some of them are false.** An outside
design review of the running app found this and it is the most serious open
defect in the product. Measured:

- **4,262 nodes have their Wikidata vernaculars claimed by two or more distinct
  QIDs.** One taxon has one Wikidata item, so every one of those is a conflict.
  *Homo sapiens* is claimed by Q15978631 (`Human`, `man`, `men`, `humans`, …)
  **and by Q186266, *Homo floresiensis***, which contributes `Homo floresiensis`
  and `Flores Man`. So the card reads *"Also known as Human, Homo floresiensis,
  man, men, humans, Flores Man."*
- It reaches search. **Typing `frog` returns Archaea — "Giant Bullfrog" — as
  the second result**, above Hylidae and Ranidae, because Q387319
  (*Pyxicephalus adspersus*) claims Archaea's OTT id. A curious person can add
  a domain of 2,080 archaea to the canvas believing they added a bullfrog.
- **`is_primary` picks the wrong name**, apparently favouring the highest QID —
  the most recently created and most obscure item. Archaea headlines "Giant
  Bullfrog"; Bacteria headlines "Actinoplanaceae".
- **527 of the 2,074 clades with ≥ 100 tips (25%) have a "common name" that is
  the Latin name in English clothing** — *Hylidae* → "hylid", *Canidae* →
  "canid", *Neoteleostei* → "Neoteleost". Worse, the good name is often present
  and not chosen: Lepidoptera shows "lepidopteran" when "Butterflies and Moths"
  is in the same row set.

`test_no_wikidata_name_shadows_another_taxons_scientific_name` was meant to
catch the first of these and cannot: it only refuses a name that is *in the
tree*, and *Homo floresiensis* is extinct and so is not a node.

*The fix is implemented and the crawl that activates it is running.* The P9157
pass now fetches each item's own `wdt:P225`, and `load` refuses any contribution
whose taxon name disagrees with OTT's — no arbitration, no heuristic, one
OPTIONAL triple on a query that was already being made. A row with no P225 is
kept rather than refused: not every item has one, and absent evidence of a bad
claim is not evidence of one.

**It is inert against the pages crawled before it existed**, which carry no `s`
field, so it drops 0 until the re-crawl lands. The pre-P225 pages are kept at
`build/vernaculars/wikidata_pre_p225/` and the phase only rewrites the database
on a *completed* crawl, so an interruption leaves the current names in place
rather than a partial harvest.

**Three cheaper rules were tried first and all three fail.** Recorded so nobody
re-derives them:

| rule | why it fails |
|---|---|
| refuse a name that is another taxon's scientific name | already present; reaches only names *in the tree*, and *Homo floresiensis* is extinct, so it shipped |
| keep the QID contributing the most names | fits *Homo sapiens* (6 against 2) and **fails on Archaea**, where the bullfrog item carries four English names and the real one carries four — handing the domain to the frog and deleting "archaeans" |
| drop every claimant | correct in principle, too expensive in fact: it takes "Dog" off *Canis lupus familiaris* and fails the `dog` spot check |

That last one is worth dwelling on. The conservative rule — a false name is worse
than a missing one — is the rule this project applies everywhere else, and here
it breaks the single most important query in the product. The gate caught it,
which is what the `dog` spot check is for.

**Vernacular coverage: the front door works, the tail is missing.** 148,515
names, of which 142,071 come from Wikidata P9157 (OTT id join, no name
matching), 5,884 from the PBDB ColDP archive and 560 from a bounded `wdt:P225`
name pass. `dog` → *Canis lupus familiaris*, `cat` → *Felidae*, `whale` →
*Cetacea*, `human` → *Homo*, `shark` → *Selachii*, `T. rex` →
*Tyrannosaurus rex*. `test_vernaculars.py` asserts the words a person actually
types and is green.

Two numbers, and the gap between them is the whole story: **3.71% of named
nodes** have an English common name, but **56.74% weighted by `tip_count`** —
which is the number a palette experiences, because people search for inclusive
clades. Of the 100 largest clades, 61% have a name; the 39% that do not mostly
genuinely have none in English (Opisthokonta, Holozoa, Panarthropoda).

A concrete miss: `oak` returns *Usnea* ("Oak moss") and *Enaphalodes* ("Oak
Borer") because **no node carries the vernacular "oak" or "oaks"** — a coverage
problem, not a search one.

**The crawl is 75 of 287 pages done and resumes cleanly.** It is ordered
clades-first then tips by ascending OTT id, a notability proxy that puts
*Canis lupus familiaris* 82,865th of 2.46M — so the notable end is complete and
the remainder is genuinely tail. WDQS runs at ~50 s/page, so finishing is ~3.5
unattended hours: `uv run concestor-build vernaculars` re-fetches nothing.

**The two server ranking divergences are fixed**, and each turned out to be
worse than recorded.

- `animal` returned *Arthropoda*, and *Metazoa* was not on the page at all —
  it had fallen below five-tip bacteria, so this was retrieval, not ranking.
  Two defects compounded. One: `matched_on` reports the *strongest* name that
  matched and `matchTier` demotes exactly one thing, a deprecated synonym, and
  those two shared a value — Metazoa matched through the synonym *Animalia*
  and the vernacular *animals*, so reporting the synonym cost it the ranking.
  One row was answering three questions (how well did it match, which name
  should be reported, is any name current) and now answers them separately.
  Two: **a plural counted only as a prefix**, one band below a whole word.
  Vernaculars are stored plural and people type singular, so "animal" was a
  whole word in a Wikidata alias reading "arthropod animal" and merely a
  prefix of "animals". `samePlural` handles `s`/`es` on tokens of three
  characters or more; anything English does irregularly (mouse, genus, larva)
  was never reachable through this path anyway and needs a stemmer.

- `E. coli` returned *Entamoeba coli*, and the cause was not that `kind = 4`
  went unreported. It is that **those rows were leaking into the node path**.
  A broken taxon's name is filed in `search_name` against the MRCA that
  swallowed it, so FTS matching one returned that MRCA as an ordinary node
  hit: searching *Dinosauria* returned a node called **Sauria**, ranked above
  the explanation. That is the live Open Tree behaviour §3 exists to refuse,
  reproduced exactly. `searchFTS` now skips `kind = 4` outright — those names
  are indexed to be findable, and finding them is `searchBroken`'s job.

  Separately, *Escherichia coli* had no abbreviation at all: the abbreviation
  corpus is generated from `node`, and a broken taxon is precisely what is not
  in there. Rather than add a row that would have to be filed against some
  node's idx — the mistake above — the abbreviated form is computed in Go when
  the broken table loads, so an abbreviation can only ever produce an
  explanation. The whole-name rule holds: an abbreviated binomial typed in
  full is a complete name, not a prefix, so it carries the same evidence that
  the person meant that taxon.

  *Escherichia coli* still ranks below *Entamoeba coli*, which is a real node
  with an exact abbreviation match, and that is left alone deliberately —
  §3 makes a broken taxon an explanation rather than a candidate competing
  with real nodes, and the UI renders it as `BrokenNote` rather than a row.

**Search ranking is now banded and behaves**, so this is a note rather than a
gap: precedence runs band (exact string → exact token → prefix) → current-name
vs synonym → node vs broken → baked `rank_score` → `tip_count`. Two subtle
bugs were found and fixed while getting there, both worth knowing about because
they will come back if the ranking is refactored: candidates were being cut by
raw `tip_count` *before* the band was known, and synonym hits were outranking
current names (`Can` reached Elateroidea via "Cantharoidea").

**The fossil layer is served but not drawn.** All 523,112 rows are attached and
`/v1/segment` returns them ranked, with both uncollapsed brackets and a
`fossils_total` for the "showing N of M" cap — but the drill-down lane
(architecture §7 "Drill-down") is not built, so nothing renders the double
bracket (faded envelope `fea→lla`, solid bar `fla→lea`) that PBDB's uncertainty
model requires. **This is the largest single piece of unbuilt product**, and
the data behind it is ready. ~21% of taxa have no appearance interval at all
and need an explicit "no range recorded" treatment, not a zero-width bar.

Read this together with the entry below. Both are the same unbuilt thing — the
fossil record as a *time* layer rather than a list — and both turn on how much
of a PBDB bracket is trustworthy. Doing them separately means answering that
question twice.

**Extinct taxa have no place in time.** Do this with the fossil lane above, not
after it — they share a data source, an uncertainty model and a caveat, and
splitting them is how the caveat gets solved twice and differently.

*The cause is categorical, not a coverage gap.* Every age in the artifact set
comes from Duke et al.'s chronogram, which is a tree of **extant** species. An
extinct taxon has no counterpart to join to, `assign_tiers` drops it to
`structural`, and `age_ma` is NaN by the rule in §3. **No extinct taxon anywhere
in the tree can carry a number under the present design.** *Homo erectus* reads
"not estimated" for exactly this reason, and so does *T. rex*. The genus *Homo*
is structural for a second reason worth knowing: in Duke's tree only
*H. sapiens* is extant, so *Homo* is unary there and their pipeline suppresses
unary nodes — there is nothing to join to even in principle.

*The layout error is the worse half.* `layout_ages` spreads an undated run
between its nearest dated ancestor and its **deepest dated descendant**. An
extinct lineage has no dated descendant, so the fill drags it toward the
present, and the axis underneath is still geological time:

| Taxon | drawn at | PBDB bracket | occurrences |
|---|---:|---:|---:|
| *Gorgosaurus libratus* | 25.9 Ma | 83.6 – 72.2 | 255 |
| *Tyrannosaurus rex* | 25.9 Ma | 83.6 – 66.0 | 70 |
| *Troodon formosus* | 19.9 Ma | 83.6 – 66.0 | 55 |
| *Allosaurus fragilis* | 18.5 Ma | 154.8 – 143.1 | 58 |
| *Villania* | 24.2 Ma | 199.5 – 184.2 | 304 |

Cambrian trilobites land in the Neogene. The dashed spine says the position is
ordinal; it does not say the position is *wrong by 450 Ma*, and a reader who
trusts the axis has no way to tell the two apart.

Measured against the brackets phase 4 already holds, restricted to nodes where
PBDB attaches at the node itself (`attach_walk = 0`):

| Node set | nodes | structural | with a bracket | drawn younger than their own last fossil | median error |
|---|---:|---:|---:|---:|---:|
| `extinct` own flag | 1,129 | 1,128 | 934 | 720 | 32.7 Ma |
| `extinct_inherited` | 614 | 614 | 395 | 358 | 79.0 Ma |

`extinct_inherited` is worse because those are the internal nodes *above*
extinct tips, which the fill drags further. Widen past the extinct flags and
**5,640 structural nodes have an exact-attach bracket available**, 2,021 of them
with ≥ 5 occurrences. On the strictest set that admits no argument — 339 extinct
tips with an exact PBDB name match and `is_extant = 0` — 55% are drawn younger
than their own last fossil and only 28 land inside their own bracket.

*The phase order is the constraint that shapes the work.* `age_layout.npy` is
written by phase 2; the `fossil` table does not exist until phase 4. This
therefore **cannot** be an edit to `layout_ages` in place. It needs a pass that
runs after phase 4 and rewrites `age_layout.npy`, which also leaves phase 2's
output as the un-fossil-informed baseline to diff against. See ingest.md
phase 4.

*Two changes, separable, in this order:*

1. ~~**Bound `age_layout` by the fossil record.**~~ **Done.** *T. rex* is drawn
   at 66.0 Ma, *Gorgosaurus* at 72.2, *Allosaurus fragilis* at 129.6, and
   `age_ma` is still NaN on all three — nothing gained a number. 1,920 undated
   nodes moved back. The pass lives in `fossils.py` because phase 4 is the
   first point in the build where a fossil bound exists; phase 2's output is
   kept as `age_layout_phase2.npy` so the two can be diffed and so re-running
   the phase clamps the original rather than compounding its own output.

   Three things it turned up that the plan did not anticipate:

   - **The `fea` prerequisite is not the one the docs specify.** An
     occurrence-count floor does *not* work: measured, the first-appearance
     bracket **widens** as occurrences accumulate, from a median 5.24 Ma at one
     occurrence to 6.20 Ma at fifty or more. The "one badly-dated record"
     theory is wrong; `fea` is wide because it is a conservative earliest
     bound. What discriminates is *which end* of the bracket is read — the
     latest end is trustworthy throughout (*Homo erectus* `fea` 5.33 vs `fla`
     1.80 against a true ~2 Ma; Trilobita 538.8 vs 521.0; *Dimetrodon* 298.9 vs
     293.5). The layout uses `lla` alone and never reads `fea`, and `lla`'s
     error direction is what makes it safe: a spuriously young occurrence only
     weakens the bound.

   - **A last appearance is only evidence about a lineage that ended**, so a
     bound is refused where the node has a dated descendant. This is not a
     plausibility threshold — there is no defensible one — but it is what makes
     the bound mean anything, and it removed 1,617 bogus bounds and cut the
     apparent chronogram-versus-rock conflicts from 24,415 to **452**.

   - **Phase 3's `xref` resolves PBDB to OTT by name, and OTT carries homonyms
     across kingdoms.** PBDB's *Ivesia* is an Ediacaran rangeomorph and OTT's is
     a rose-family plant, so a 538.8 Ma bound reached a living genus; PBDB's
     *Heraultia* is the Cambrian mollusc *Watsonella*. `images.py` refuses an
     ambiguous name outright and phase 3 does not. **This is an unfixed phase 3
     defect**, found only because the layout pass surfaced it, and it will be
     affecting `xref` consumers other than this one.

   *What is still wrong.* 393 undated nodes remain younger than their own last
   fossil, median gap 20.0 Ma, every one capped by a dated ancestor.
   *Allosaurus fragilis* is the shape of them: 18.5 Ma before, 129.6 after,
   against a last fossil at 143.1 — the remainder is its nearest dated ancestor
   refusing to be older. Reaching those means either inverting the tree or
   moving a dated node away from its own printed figure, so the fix is upstream
   in whatever attaches a stem fossil to a crown node.
2. ~~**Add the fourth tier, `occurrence`.**~~ **Built in the pipeline and the
   server.** 2,133 nodes carry a range; *T. rex* reports 83.6–66 and *Homo
   erectus* 5.33–0.012, and both still report no age. Written by phase 4
   alongside the layout bound, because they read the same table under the same
   rule and answering the uncertainty question twice is how the two ship
   disagreeing.

   All four constraints hold and three of them are gated on the arrays rather
   than trusted to the code: it **never enters `age_ma`** (0 violations of
   2,133); every tiered node **carries at least one bound**; and no node outside
   the tier carries a range. It is a **range and never a point** structurally —
   the array carries four bounds and no midpoint is computed anywhere, so there
   is no single number for a caller to reach for. **Exact attachments only.**

   Two choices worth knowing. The range for a node is the **best-attested
   single PBDB taxon** attaching there, never a union across several: the
   envelope of two taxa is not a taxon's envelope, and inventing a range is the
   one thing this tier exists not to do. Where PBDB aggregates itself, as it
   does for a genus, its own aggregate row wins on occurrence count anyway. And
   only `structural` nodes are eligible, so a real divergence estimate is never
   overwritten with a stratigraphic range.

   *The number that matters is not 2,133.* **1,274 of the 1,743
   extinct-flagged nodes (73%) now report a range**, which is what "does
   *T. rex* stop reading not estimated" actually asks. The remainder have no
   PBDB taxon attaching at the node itself — the Neanderthal case below. And
   **12,785 structural nodes with a bracket were refused because their clade
   still contains living species**, which is the largest exclusion by far and
   deliberate: "fossils of this group are known from 60–50 Ma" is true of them,
   but a range *ending* at 50 Ma reads as an extinction and no caption inside a
   bracket undoes that.

   **The UI is built.** *T. rex* reads `fossils 84–66 Ma` on the canvas where
   it read nothing, and the card carries `age — not estimated` above a separate
   `fossils — 84–66 Ma` row, with a note saying why in the reader's language.

   Three decisions inside it. The canvas figure is **prefixed with the word
   "fossils"**, because in the slot an age occupies a bare "84–66 Ma" beside a
   node drawn at 66 Ma is indistinguishable from that node's age — one word
   costs a little label width and removes the ambiguity entirely. The card puts
   the range in **its own row rather than in the `age` slot**, for the same
   reason at more length. And the trace keeps the **structural dash**, not a
   fourth density: the dash channel answers one question, *has anyone estimated
   an age*, and the answer here is still no. Four dash patterns is more than the
   channel can carry and more than a reader can tell apart, so the difference
   shows as a figure on the node instead. The legend reads
   `no age · fossils dated`.

   *A visible artefact worth knowing about.* The 393 nodes the layout bound
   could not fully reach now show it: *Allosaurus fragilis* is drawn at 129.6 Ma
   and labelled `fossils 155–143 Ma`, so the node sits slightly to the *right*
   of the range it claims. It is honest — the trace is dashed and the position
   is ordinal — but it reads as a contradiction, and it did not exist before the
   figure was on screen to contradict. Roughly 18% of the tier. The fix is the
   same one as for the residual itself: upstream, in whatever attaches a stem
   fossil to a crown node younger than it.

*The caveat that constrains both:* **PBDB's `fea` is frequently junk-wide.**
*Homo erectus* carries `fea = 5.333` — the base of the Zanclean — off a single
badly-dated occurrence, against a true first appearance near 2 Ma. The
`lea`/`lla` last-appearance end is the trustworthy one. Any use of `fea` needs
an occurrence-count floor or an outlier rule, or the work trades a missing
number for a confident wrong one. This is the same uncertainty model the
drill-down lane needs, which is the second reason to do them together.

*Gate to add when it is built:* no undated node may be laid out younger than its
own exact-attach last fossil occurrence. Currently violated 1,078 times.

**Unnamed divergences are described rather than blank, and the description has
limits.** Most synthesis internal nodes carry no name — `mrcaott83926ott84217`
is the human/chimp split — and every one of them used to render as the literal
string "unnamed divergence", so the four-species hominin view
(`/?n=770315,83926,417950,3607671`) showed two identical grey labels over its
two most interesting events. `web/src/tree/naming.ts` now derives a name from
what the node separates: the nearest named clade down each branch, which for
that node is **Homo / Pan**. The names are usually already in memory and were
being discarded — `Homo` and `Pan` are both degree-2 nodes on the *suppressed*
runs either side of it.

The label declares itself as derived (`DIVERGENCE` in the rank row, an explicit
note on the card) because it is a description, not a name. What is still thin:
a divergence whose branches have no named clade nearby pairs two names a reader
may not recognise, and nothing tries to pick the *recognisable* name over the
*nearest* one — "Homo / Pan" is lucky, and a deep node in an unnamed region
will read worse. Vernaculars are not used at all here; "human / chimpanzee"
would serve this audience better and the data is present.

**A selection nested inside another selection gets its own row.** OTT files
*Homo sapiens neanderthalensis* as a child of *Homo sapiens*, so choosing both
makes the human node the divergence between them — and since both sit at
`age_layout` 0 they shared an x as well as a y, drawing two chosen species on
one pixel joined by a zero-length trace. The layout now gives every selection a
row of its own, so the nesting is visible as a vertical drop at the true shared
age. It is a fix in y and deliberately not in x: nudging x would buy the
picture with the axis. The underlying honesty problem is untouched and is the
same one as the extinct taxa above — the Neanderthal branch leaves at 0 Ma
because that is where the ordinal fill puts it, and the fading unbounded trace
is all that says so.

**And it is the case that shows where the layout fix stops.** PBDB does hold a
Neanderthal range (0.774–0.0117 over 6 occurrences), but OTT files the taxon as
*Homo sapiens neanderthalensis* while PBDB calls it *Homo neanderthalensis*, so
it attaches one hop up at the genus and **nothing attaches at the Neanderthal
node itself**. A strict `attach_walk = 0` rule therefore leaves this branch
exactly where it is.

**Do not relax the walk to fix it.** A bracket attached at a parent belongs to
some fossil taxon below that parent, and nothing records *which child* — so it
constrains no particular child, and borrowing it would put a Neanderthal range
on any sibling that happened to be undated. The apparent walk problem is really
an identifier-resolution gap: PBDB carries *Homo neanderthalensis* at **species**
rank, OTT carries *Homo sapiens neanderthalensis* at **subspecies** rank, and
the two never matched. That belongs in phase 3's `xref`, where rank not
surviving resolution is already a known shape (ingest.md phase 4 step 2). Fix it
there and the bracket lands at walk 0 by itself, which is the correct fix in
every other case of the same kind too.

**The silhouette mirror is complete and the pictures now mean something.** All
12,863 SVGs are on disk, 149.8 MB, each checksummed into the `silhouette`
table, resumable by checksum — `uv run concestor-build images` re-verifies what
is there and fetches only what is missing.

Resolution was rewritten to find a node's *closest drawn relative* rather than
its nearest drawn ancestor, which is what took the median picture from speaking
for 1,208,417 species to 3,153; §5 has the before/after and the reasoning. The
blocking gate is now that share rather than node coverage, and the canvas and
the detail card both name the clade a borrowed picture speaks for and how many
species are in it.

*What is still thin here.* The corpus remains the ceiling: 12,863 drawings for
2.7M nodes, so 71.2% of leaves get a picture from a group of ≤ 10,000 species
and the rest get something broader. Nothing has been done for the top of the
tree — Eukaryota's picture still speaks for 2,267,368 species, which is honest
and useless, and a deliberate "no useful drawing exists for this" treatment
would serve a reader better than a caption admitting it. **No non-specialist
has looked at any of this**; the threshold at 10,000 tips is a stated product
judgement, not a validated one, and it is the first thing user testing should
attack.

**Bloom cost is unverified under load.** design-reference.md asks for this
early. The current implementation is two stacked strokes plus a CSS blur rather
than a post-process pass, and it drops the halo below 0.5 zoom — but that was
chosen on principle, not measured. Nothing has been profiled with a large
selection on a slow machine.

**No accessibility pass.** Full keyboard operation exists and is real, but
focus management, screen-reader semantics for the canvas, and a
non-colour-dependent reading of the provenance tiers have not been examined.
The dash-pattern channel was chosen partly because it survives without colour;
that has not been tested with anyone.

**The artifact set is 2,004 MB** against architecture §11's 700 MB estimate
(§4). Nothing is wrong, but the deployment story in §11 needs re-deriving, and
there is obvious fat: `xref` is 270 MB and `search_name` 225 MB.
