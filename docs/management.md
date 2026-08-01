# Management brief

The standing brief for whoever owns and runs this project. Hand it over verbatim.
Keep it current alongside [handoff.md](handoff.md) — that one carries *state*,
this one carries *mandate*.

---

You are taking over as the owner of **concestor** (`/Users/lukesweigart/Projects/concestor`, working on `main`), and running it to completion. I am away and will not be available to answer questions for a while, so proceed autonomously and queue anything that genuinely needs me rather than blocking on it.

Concestor is an interactive tree-of-life visualiser: pick species, see the minimal subtree connecting them through their common ancestors, drill into the fossil record along any branch, laid out against deep time.

## What this project is, and who it is for

**It is for curious people interested in evolution. It is not for evolutionary biologists.** That single fact decides most of the judgement calls you will face, and it overrides the emphasis in `architecture.md` and `ingest.md`, both written before it was stated.

My focus, in order:

1. **Identify any MRCA** between chosen species and get it right
2. **Draw the tree** — the induced subtree, beautifully, reflowing rather than jump-cutting
3. **Show useful species silhouettes**

The time axis is secondary; rough dating is fine. The fossil layer is secondary. Neither should ever delay the three above.

**The design team has settled the product's shape — `docs/design-reference.md` is authoritative** on visual language, command surface, motion and stack. A dark instrument where the graph is the only light source, operated from a `⌘K` palette, phosphor-persistence metaphor, React Flow / xyflow v12. Read it before any frontend work.

It names the same thing I did, more sharply. **The signature interaction is adding a node**: the draw originates at the *MRCA* and extends outward to the new leaf, MRCA flaring at `t=80`, reflow and draw overlapping. It says outright that this is the product and everything else is plumbing. Believe it. Priorities 1 and 2 are that one motion, and the data side already delivers it — the MRCA is the last common element of two ancestor paths that are already in memory, so the flare can fire in the same frame as the click, with no query and no round trip.

Two consequences reorder `ingest.md`, whose numbering is a **dependency** order and not a priority order:

**Silhouettes (phase 5) are priority-one work.** For this audience an image is what makes a clade mean anything. A silhouette also legitimately represents a *clade*, where a photograph can only represent one member — rendering a mole for "Mammalia" is worse than rendering nothing. `fill: currentColor` drops them straight into the dark instrument and lets them take the trace colour, bloom included.

**Vernacular names (phase 6) are essential, not deferred — and the command palette makes them load-bearing at first contact.** OTT carries no common names, so "Tyrannosaurus" resolves and **"T. rex" and "dog" do not**. When the palette *is* the interface, a search box that only accepts binomials is broken at the front door, not merely incomplete. Wikidata property **P9157** is the clean path (~2.03M items, direct OTT linkage, no name matching). GBIF vernaculars come free via `ott_sourceinfo`, and the PBDB archive already on disk ships `VernacularName.tsv` — 9,245 English names keyed by PBDB `taxon_no`, covering *fossil* groups, which is the hard case.

## Read these, in this order

They are the spec. They contain figures verified against live APIs and data files, most on 2026-07-31. **Do not re-research them.** Several widely-repeated public numbers are wrong and these docs record the corrections.

1. `docs/handoff.md` — current state, priorities, decisions taken, corrections the build forced
2. `docs/design-reference.md` — the product's visual and interaction language
3. `docs/data-sources.md` — verified facts per upstream dataset
4. `docs/architecture.md` — data model, storage, backend, rendering
5. `docs/ingest.md` — the six build phases and their gates
6. `docs/phase2-decision.md` and `docs/phase3-pbdb-path.md` — two settled decisions and their evidence
7. `CLAUDE.md` and `pipeline/README.md` — conventions and how to run things

`handoff.md` is the living state document. **Keeping it current is part of the work** — if it drifts, whoever you delegate to re-derives things already settled.

## Where things stand

Ingest phases 0, 1 and 2 are implemented. Phase 0 pinned ~1.4 GB of checksummed sources. Phase 1 parses the Open Tree v16.1 Newick into preorder-indexed topology arrays and reproduces every structural figure in `data-sources.md` exactly — 25/25 gates, including 200/200 agreement with the live Open Tree API on random induced subtrees. Phase 3 is **measured and designed but not built**. Phases 4, 5 and 6 are not started. A deliberately ugly throwaway renderer proves the premise end to end.

**Priorities 1 and 2 are already de-risked at the data layer.** Everything rests on `path(node) → [root, …, node]`; induced subtrees are the union of ancestor paths with degree-2 nodes suppressed, so MRCA, incremental reflow and drill-down all fall out of one computation. Mean path length is 41. The skeleton renderer hits the `2|L|−1` bound exactly and already draws orthogonal edges and undated nodes without numbers. What remains is making it *good* — which is now a design problem with a settled brief, not an open question.

The build pipeline is Python 3.14 under `uv`, in `pipeline/`. **The serving binary is an open choice** — architecture §4 proposes Go or Rust; it shares only *files* with the pipeline, no runtime and no FFI, so decide it independently. The real UI is unbuilt and is the largest remaining piece.

## Decisions already taken — implement, don't relitigate

**Dating: the Duke et al. tree is accepted.** It failed the gate as written (99.6036% clade compatibility against 99.9%, 947 nodes contradicted) and passed everything else comfortably — root age 4246.67 Ma against 4247, ultrametric to 3×10⁻⁵, zero monotonicity violations, all four literature spot checks in range. Implement the accept: restate the criterion as *compatibility* rather than *identity* (the original assumed a node-for-node identity no bifurcating chronogram can have against a 12,964-way polytomy), and demote the 947 nodes to the `structural` tier. **Do not build the fallback congruification pipeline** — 4–6 weeks for a less defensible time axis, on a secondary feature.

**Fossil resolution: API point lookup first, offline map behind it.** `GET /v1/species?datasetKey={PBDB}&sourceId={taxon_no}` is a point lookup returning the checklist record with its `nubKey` in ~0.5 s, so GBIF's offset cap never applies and the ~450 covering shards in `gbif_checklist.py` are unnecessary. The offline map from the frozen backbone is accurate but shaped exactly wrong — 38.6% of PBDB taxa, but 8% of genera and **0 of the top 100 by occurrence count** — so keep it as a distinct second method for the free non-decaying floor, ranked below the API. Full measurement in `docs/phase3-pbdb-path.md`.

**Crawl budget: prioritised, not exhaustive.** Crawl ordered by `n_occs` descending, resumable, stopping when the curve flattens. The top 25,000 genera hold 93.3% of genus occurrences. Do not spend 73 hours on a secondary feature before silhouettes and vernaculars exist.

**Four design collisions, resolved in `architecture.md`.** Do not re-open them:

- **No dagre, no ELK, no force-direction.** The design reference suggests `d3-hierarchy / ELK / dagre`, but a graph-layout engine assigns `x` by *depth* and here `x` is *time*. It would silently destroy the axis it exists for. Every other layout principle holds; our layout is already deterministic and computed.
- **Provenance cannot use luminance**, which the design reserves for recency and selection. It gets dash pattern and desaturation, and `structural` nodes get **no numeric age at all** — always the hard requirement.
- **The ICS geologic palette is warm and the design forbids warm.** Keep the official hue relationships, drop the saturation and luminance, let the band recede. It is a reference scale, not data; nothing in it should glow.
- **Tabular mono numerics supersede old-style figures.** Scientific italics for species and genus names survive, so the UI sans needs a genuine italic rather than a synthesised oblique.

## Licensing: simpler than the docs assume

**Not a commercial project.** Drop the commercial-safety machinery: no `--commercial-safe` flag, no NonCommercial filtering, ignore the PBDB licence question. Straight win — PhyloPic's `primaryImage` gives effective **~100% node coverage** against 93.7% for the licence-filtered path.

**Attribution still applies.** CC-BY requires it for any redistribution and the artists deserve credit. Creator and licence in the node detail card, plus a credits view — which per the design reference is a **command**, not a settings panel. Two-field problem: `attribution` is the creator, `_links.contributor.title` the uploader, differing 31% of the time. TimeTree stays excluded; its redistribution ban is unconditional.

## Suggested sequencing

Strategy is yours; delegate freely. A shape that fits the priorities:

- **The signature interaction, end to end** — palette → resolve → MRCA → draw. It is the product, it is already de-risked at the data layer, and it is the thing worth getting right before anything is polished.
- **Silhouettes and vernacular names** — priority one, independent of everything else and of each other, both startable immediately.
- **Serving binary** — artifact formats are stable now, so it can be designed alongside the above.
- **Phase 3 resolution, then phase 4 fossils** — designed already; 3 blocks 4. Secondary.
- **ICS geologic timescale** — small, self-contained, makes the axis legible. Cheap win whenever convenient.

Verify the bloom cost early, as the design reference says. Frame budget beats glow, and dropping to flat strokes at low zoom is an acceptable answer.

## The culture of this codebase, which matters more than the schedule

**Figures are measured, not estimated.** When a gate fails, assume a real bug — but check what the gate is *measuring* before changing either side. One gate failed at 41.67 against an expected 41.32 because the doc said *root-to-tip* depth and the gate was averaging over all nodes. The doc was right.

**Gates collect rather than raise**, so a phase reports every failure at once then refuses to write its output. `require` blocks the build, `observe` records. Add a content gate whenever a column starts carrying something downstream depends on — counting rows is not checking them.

**Never apply a lint or type fix without reading the surrounding code.** Two real bugs came from exactly that. Silencing an unused-variable warning by renaming `rank` to `_rank` left a database column permanently `NULL`; every gate passed and the only symptom was a 19 MB smaller file. Separately, `node.is_broken` was always zero, because broken taxa are *rejected* from synthesis and so are not nodes at all.

**Everything must pass all four:** `uv run ruff format src tests && uv run ruff check src tests && uv run ty check && uv run pytest`. The project is fully annotated and `ty` runs clean; keep it that way, and use the array aliases in `concestor_build/typing_.py` rather than bare `np.ndarray` — the dtypes are load-bearing.

**Be honest about uncertainty visually, and never numerically.** Only 6.7% of the synthesis tree is phylogenetically placed, so any dated version is overwhelmingly interpolating onto taxonomy-derived structure. This matters *more* for a lay audience, not less — they cannot tell a confident wrong number from a right one. But the answer is a dashed trace and no figure, not a wall of caveats. The skeleton renderer already does this; the real UI must not regress. Same for the 9,839 broken taxa: if someone searches one, explain it rather than silently answering a different question the way the live API does.

## Traps that will cost hours

Detailed in `docs/data-sources.md` and `docs/phase3-pbdb-path.md`:

- `files.opentreeoflife.org/synthesis/current/` is **frozen at 2016**. Pin `opentree16.1`, resolved from the live API's `synth_id`.
- **OTT id forwarding is silent** — 297,070 entries. Always compare the returned `ott_id` against what you sent, and chase forwards transitively.
- `taxon_info`'s `is_suppressed_from_synth` field is **wrong**. Do not trust it.
- **Never** point treePL or `ape::chronos` at a branch-length-free topology. treePL does not error — it emits a confident dated tree containing zero information.
- The Open Tree API has **no rate limiting because nobody implemented it**, and is one `waitress` process behind a small academic project. Build-time oracle only, never a runtime dependency, and pace requests. GBIF is the same situation.
- **PhyloPic stale `build` values return `410 Gone`, not a redirect** — the current build is in the error body. Mirroring the corpus (12,863 SVGs, ~136 MB) removes both the runtime dependency and the build churn. ~12,863 API calls to a small service; pace it.
- **GBIF's backbone has 11 ranks against PBDB's 25**, so 32,629 PBDB taxa (6.2%) are *unmatchable* rather than unmatched, and they skew notable. Phase 4's parent-walk handles it; it just walks further than expected.
- **Join the offline backbone map against `pbdb_taxa.csv`, never the ColDP archive** — ColDP gives synonym names a compound id of the form `txn:{accepted}#{name}`, so extracting a `taxon_no` from it silently maps a synonym onto the *accepted* taxon's number. That produced an 11% error rate in testing.
- **A single node has 12,964 children.** Suppression means it is never rendered in full, but any drill-down lane needs a cap and an explicit "showing N of M".

Take it from here.
