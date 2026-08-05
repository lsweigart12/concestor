# Management brief

The standing brief for whoever owns and runs this project. Hand it over verbatim.
Keep it current alongside [handoff.md](handoff.md) — that one carries *state*,
this one carries *mandate*.

Revised 2026-07-31, after the build that took the project from three implemented
phases to a working product.

---

You are taking over as the owner of **concestor**, working on `main`, and running it to completion.

**You hold every decision this project needs.** There is no one to escalate to and nothing is waiting on an absent principal. Where these documents once said "confirm this before proceeding", they now say what was decided and why — every such question has been closed, and the closures are marked. If you hit a genuine fork the docs do not cover, decide it on the principles below, write the reasoning where the next owner will find it, and keep moving. A decision recorded with its evidence is always worth more than a decision deferred.

Concestor is an interactive tree-of-life visualiser: pick species, see the minimal subtree connecting them through their common ancestors, drill into the fossil record along any branch, laid out against deep time.

**It works now.** All six ingest phases are built, the read API is a Go binary, and the real UI exists. Search a species and the draw originates at the MRCA and extends outward while the tree reflows — the signature interaction, end to end. Your job is no longer to build the machinery. It is to make the thing good, and to close the gap between what the gates say and what a person actually experiences.

## What this project is, and who it is for

**It is for curious people interested in evolution. It is not for evolutionary biologists.** That single fact decides most of the judgement calls you will face.

My focus, in order, unchanged:

1. **Identify any MRCA** between chosen species and get it right
2. **Draw the tree** — the induced subtree, beautifully, reflowing rather than jump-cutting
3. **Show useful species silhouettes**

The time axis is secondary; rough dating is fine. The fossil layer is secondary. Neither should ever delay the three above.

**Priorities 1 and 2 are done.** Priority 3 is not, and that is where you start.

## Read these, in this order — and note what has changed about how to read them

1. `docs/handoff.md` — current state, decisions taken, corrections the build forced, and §7's honest list of what is thin. **This is the truth.**
2. `docs/design-reference.md` — the product's visual and interaction language. Still authoritative for anything the user sees.
3. `docs/architecture.md`, `docs/ingest.md`, `docs/data-sources.md` — the original specs.
4. `docs/phase2-decision.md`, `docs/phase3-pbdb-path.md`, `docs/serving-binary.md` — settled decisions with their evidence.
5. `CLAUDE.md`, `pipeline/README.md` — conventions and how to run things.

**The previous version of this brief told you not to re-research the figures in those documents. That instruction was conditionally wrong for a year, and this paragraph is the account of why it no longer is.** The specs were written before anything was built. Building it proved a couple of dozen of their figures wrong, and for a while every correction lived *only* in a `handoff.md` §4 titled "Corrections to the design docs" — 2,148 lines into a 3,600-line file — while this page told every newcomer to read the specs first and called them the spec.

**§4 has now been applied in place and is gone.** Each correction is struck through where the wrong claim was, with the measured figure and the reason beside it, so a reader who half-remembers the old number finds out why it changed instead of wondering whether they misremembered. **Follow that convention.** It is the reason the reconciliation was worth doing at all: a deleted error teaches nobody anything, and a reader arriving with a stale figure in their head is the exact person the doc has to reach.

Every one was re-measured against the current build before it was applied, and that mattered — §4 recorded the artifact set as 2,004 MB and it is 2,062.6 MB; it recorded `node_fts` as two columns short and it is three; the accepted-key fallback it flagged as irreproducible is still irreproducible and still gives 138,180. **An errata list drifts exactly like the document it corrects.** That is the argument for applying corrections rather than accumulating them, and it is why nothing like §4 should be started again: correct the doc, or write the finding into `handoff.md` §3 or §7 where it is a *finding* rather than a pending edit.

So: **the specs and `handoff.md` should now agree.** Where they do not, `handoff.md` is still the truth and the spec is still the thing to fix — in place.

## What to do, in order

### 1. Silhouettes — **done**, and here is what it turned on

Left as the priority-one item. Closed: the pictures now mean something, phase 5a's flattering gate is gone, and the canvas is the demonstration.

**The diagnosis in the previous brief was half right.** It said two thirds of the tree resolved to an image the UI then refused to draw, and named two suspects for the empty screenshots — the semantic-zoom tier, or the suppression threshold. Neither survived contact. The threshold had already been dialled to permissive in `e333f90`, so silhouettes *were* rendering; measured over realistic selections, **8 in 10 of them were one of three blobs** — Ecdysozoa, `cellular organisms`, Opisthokonta. The failure had moved from "nothing renders" to "everything renders the same shape", which looks less broken and is not better.

**The fix was in resolution, not in the threshold.** A node used to take the image of its nearest ancestor that was *itself* seeded; with 7,470 seeds over 2.7M nodes that ancestor is usually a superphylum. It now takes the picture of its **closest drawn relative** — cousins included, which the old rule could not reach — and records `clade_idx`, the smallest clade containing both node and drawing. Measured: the median picture went from speaking for 1,208,417 species to **3,153**, and the share speaking for over a million went from 65.3% to **0.00%**. Selachii drew an opisthokont blob and now draws a shark.

**The gate is the clade, not coverage.** Coverage was 100% before and is 100% after — it was never the question. The blocking pair is now the share of nodes whose picture speaks for a group of ≤ 10,000 species: 71.2% of leaves, 81.9% of internal nodes. Note what that gate does *not* claim: 10,000 is a product judgement written down in `images.py`, not a validated one.

**And note what the measurement refused to do**, because the reasoning matters more than the result. The brief asked for a few hundred realistic selections. There is no realistic-selection distribution to sample: drawing uniformly from typeable names gives obscure moths, and weighting by `tip_count` — handoff §7's own model of what a palette experiences — gives "opisthokont" and "dicondylian", which nobody types. Gating on either would have invented a user. The clade-size distribution needs no such invention, which is why it is what ships. **The audience risk below is still entirely open and is now the binding constraint on this work.**

**Do not expect more assets to solve what remains.** The corpus is the ceiling: 12,863 images, 11,080 declaring an OTT id, 6,976 in-tree, 7,470 seeded nodes. There is no third source of PhyloPic images, and a materially larger corpus means a *different* corpus, which is a project, not a crawl. What is left is a rendering question at the top of the tree — Eukaryota's picture speaks for 2,267,368 species and probably should not be drawn at all — and handoff §7 records it.

### 2. Close the front door properly

- ~~**Finish the Wikidata P9157 crawl.**~~ **Done — 287/287 pages.** 162,466 rows, 159,961 resolved: **4.26% of named nodes**, but **54.32% weighted by `tip_count`**, which is the number a palette experiences. Figures from `build/phase6_gates.json`; the ones this brief carried before (75/287, 148,515, 3.71%, 56.74%) described the partial run and are superseded.
- **The two ranking divergences are fixed**, and neither was small. `animal` was not mis-ranking *Metazoa*, it was losing it entirely — a plural counted as a prefix rather than a whole word, and a node's ranking tier was being taken from the single name picked for display. `E. coli` was not a missing `kind` field: broken-taxon rows were **leaking into the node path**, so searching *Dinosauria* returned a node called *Sauria* above the explanation, which is the live Open Tree substitution handoff §3 exists to refuse. Full account in handoff §7; every front-door word now resolves — `animal`, `dog`, `shark`, `human`, `whale`, `bird`, `spider`, `T. rex`, `Dinosauria`.

### 3. Put extinct taxa somewhere true on the axis

**This used to be item 3 and the drill-down used to be item 4, on the reasoning that one was small and the other was a treat to be deferred. Treat them as one item.** They read from the same table, they turn on the same unanswered question about how much of a PBDB bracket to trust, and answering it twice is how the two ship disagreeing with each other.

*T. rex* renders with no number — correct, it is `structural` — but its layout position lands at 25.9 Ma, against a last fossil occurrence at 66. That is not the ordinal-position caveat doing its job. An ordinal position between two real bounds is honest; a position 40 Ma past the taxon's extinction is not, and the two render identically. Measured: **1,742 of the 1,743 extinct-flagged nodes are `structural`**, 1,078 of them are drawn younger than their own last fossil, and Cambrian trilobites land in the Neogene. Widen past the extinct flags and 5,640 structural nodes have an exact-attach bracket sitting unused.

The work splits cleanly and the halves have very different risk:

- ~~**Bounding `age_layout` by the fossil record is the safe half.**~~ **Done.** *T. rex* is drawn at 66.0 Ma rather than 25.9, *Gorgosaurus* at 72.2, *Allosaurus fragilis* at 129.6; 1,920 undated nodes moved and `age_ma` is untouched, so nothing gained a number. Three findings the plan did not anticipate, all in handoff §7: the `fea` occurrence-count floor this brief called a prerequisite **does not work** and the fix is to read the bracket's latest end instead; a last-appearance bound must be refused where the lineage has a living descendant, which removed 1,617 bogus bounds; and phase 3's `xref` resolves PBDB to OTT **by name across kingdom homonyms**, which is an unfixed defect affecting every `xref` consumer, not just this one.
- ~~**A fossil-derived range becomes a fourth tier, `occurrence`.**~~ **Built in the pipeline and the server; the UI is the remainder.** 2,133 nodes carry a range and still report no age — *T. rex* 83.6–66, *Homo erectus* 5.33–0.012. All four constraints hold and three are gated on the arrays rather than trusted to the code. It went into its own **table** rather than its own array: the constraint is that it is not `age_ma`, and a dense `(n, 4)` array would have been 43.6 MB for 2,133 useful rows. handoff §7 has the two judgement calls inside it — best-attested single taxon rather than a union, and `structural` nodes only.

**The trap in both, and it is not the one this brief described.** `fea` is frequently junk-wide. *Homo erectus* carries `fea = 5.333` — the base of the Zanclean — off a single badly-dated occurrence, against a true first appearance near 2 Ma. Trust the `lea`/`lla` end, and set an occurrence-count floor or an outlier rule *before* either half, not after. Get this wrong and the product trades a missing number for a confident wrong one, which is the trade this whole design exists to refuse.

Full evidence and measurements: handoff.md §7.

### 4. The fossil drill-down — **done**

Built alongside item 3, which was the right call: the bracket is one component and the age tier reuses it, so the two cannot disagree about what PBDB's uncertainty model means. Clicking a segment opens a lane sharing the time axis; Amniota → *Homo sapiens* reads "showing 8 of 2,657" with Mammalia, Simiiformes and Homininae on the spine.

It also corrected architecture §7, which describes the four bounds as if they chained. They do not: `fla ≥ lea` holds for 39.6% of taxa, so for the other 60.4% there is no certain extent at all and the solid bar must be left undrawn rather than drawn zero-width. Three cases, not two.

**What it needs now is a better sample.** Ranking by occurrence count guarantees nested near-duplicates — seven of those eight rows read "239 Ma – present" and nothing a person would recognise appears. Mixing in rank diversity, or preferring taxa that carry a vernacular, would make the lane worth opening twice.

### 5. Fix phase 3's cross-kingdom homonyms — **done**

Shipped as `refuse_disagreements` in `resolve.py`, and the account below is what it was
before the fix. **16,833 resolutions withdrawn over every method** — not `name_exact`
alone; `gbif_backbone_provenance` supplied 7,191 of them, so "only trust the backbone"
was never the fix — plus 235 more where a name is still claimed by two accepted PBDB
taxa. Phase 4's independent check went from **1,019 of 1,048** to **31 of 60**. Three
details are load-bearing and none may be reordered: the extancy sweep runs *before* the
ambiguity one, so *Scopus* keeps the hamerkop instead of losing both; it needs phase 2's
`age_ma` as a living-lineage guard, without which 1,162 correct attachments go; and
`manual` overrides are exempt. handoff.md §5 has the rest.

Found while doing item 3 and previously unrecorded. `xref` resolves PBDB to OTT **by name**, and OTT carries the same genus name in unrelated kingdoms, so a Cambrian fossil lands on a living plant. Measured with a test that needs no new data — a taxon last seen before the Permian cannot be a living genus: **1,019 of the 1,048** nodes carrying an exact attachment with `lla > 250 Ma` have living descendants. Phase 4 already reports it every build as an `observe`, so the baseline is recorded. *Sadleria* is a Hawaiian fern with a Devonian fossil on it; *Streptosolen* is a South American shrub with an Ordovician one.

It is not confined to the naive path — `name_exact` 991, `gbif_backbone_provenance` 221, `gbif_pbdb_chain` 168 — so 389 survived a route meant to be evidence-based.

~~The fix is a lineage comparison in phase 3~~ — PBDB's own `parent_no` hierarchy against OTT's tree, refusing a resolution where the two disagree above family level. **That is not what shipped**, and the discriminator that did is cheaper and sharper: an *extancy* disagreement, guarded by phase 2's `age_ma`. The rest of this paragraph held and was followed — the test went in as an `observe` gate before the fix so the baseline was on the record, and phase 4's own guard (refuse a fossil bound on any node with a living descendant) is right for phase 4 and does nothing for every other `xref` consumer. `xref` is 258.5 MB of this database.

## Decisions already taken — implement, don't relitigate

Everything settled in the previous brief still holds, and is now implemented rather than pending. In particular:

- **The Duke et al. dated tree is accepted**, 32/32 gates, criterion restated as compatibility. **Do not build the fallback congruification pipeline** — 4–6 weeks for a less defensible time axis on a secondary feature.
- **Three age arrays ship and must stay separate.** `age_ma` is what may be shown (NaN where nothing may be), `age_tier` is how, `age_layout` is where to draw. Merging the first and third to save 10 MB puts a confident number on every dashed node, which is the exact failure the design exists to prevent.
- **The serving binary is Go**; it reads the pipeline's `.npy` output directly and there is deliberately no `topology.bin`. Reasoning in `serving-binary.md` and `package.py`.
- **Layout uses no dagre, no ELK, no d3-hierarchy.** A graph engine assigns `x` by depth; here `x` is time.
- **Not a commercial project.** No NonCommercial filtering. Attribution still applies and renders in the node card plus a credits *command*.

## What not to do

- Do not start the congruification fallback.
- Do not attempt the exhaustive 73-hour PBDB crawl. The prioritised `n_occs`-ordered crawl is the settled answer.
- Do not optimise the artifact set yet. It is ~~2,048 MB~~ **2,062.6 MB on the current build** against architecture §11's 700 MB estimate — a reading rather than a constant; it moves with every pipeline run and `concestor-build package` reports it. §11's cost paragraph has now been re-derived in place, and `deployment.md` §1 measures the deployable payload (2,229 MB, silhouettes included) and the RSS a container actually needs (361 MB after startup). Nothing is broken by the size, and trimming `xref` before the product is finished is optimising the wrong thing.
- Do not reintroduce a fixed layout width in the frontend. It follows the viewport so the fit stays near 1:1; at a fixed 1240px a narrow panel fits at ~0.45 zoom, which renders every label at under 6px. This matters more since the semantic-zoom tiers were removed: the names no longer disappear at that scale, they are merely unreadable, and the layout width is the only thing still keeping them legible.

### 6. The vernacular join was producing false statements — **fixed**

An outside design review of the running app found the product **lying**, which is the one thing this codebase's culture exists to refuse. *Homo sapiens* was "also known as Homo floresiensis". Typing `frog` returned Archaea, captioned "Giant Bullfrog", above the actual frogs. 4,262 nodes had vernaculars claimed by two or more Wikidata items, and one taxon has one item.

The cause: P9157 is a free-text external identifier and nothing stops an item carrying somebody else's OTT id. The fix: the query now fetches each item's own `wdt:P225` and refuses any contribution whose taxon name disagrees with OTT's — no arbitration, no heuristic, no extra requests, one OPTIONAL triple on a query already being made.

**Crawled and verified.** 63,872 names dropped. `frog` returns Anura then Hylidae; *Homo sapiens* keeps "Human" without gaining "Homo floresiensis"; Archaea keeps "archaeans" without gaining a bullfrog. That last pair is what makes it right — **no cheaper rule could keep both**, and three were tried: dropping every contested claimant loses "Dog" off *Canis lupus familiaris* and fails the spot check, and preferring the largest claim hands Archaea to the frog. handoff §7 has the table; do not re-derive them.

**The ranking that survived it is fixed too, and `oak` was not a coverage gap.** `butterfly` now returns Papilionidae, `eagle` returns *Haliaeetus*, and `oak` returns nine *Quercus* species. The principle is worth carrying: *an exact match settles which **name** the query is, not which **taxon** the reader means* — a common name can be filed far below the group it names, so exactness is now withdrawn in two measured cases, and a **head-word band** sits under it because "oak moss" is a moss and "sessile oak" is an oak. `oak` looked like the coverage half and was not: the Wikidata crawl is already complete at 287/287 pages, and *Quercus* is a **broken taxon**, so no crawl could ever have given the word a node. handoff §7 has the bounds and the two known limits; the front-door words are pinned in `server/internal/store/fts_test.go`.

It was found only because someone who had not built the UI actually used it. That is the argument for the risk below, made concrete.

## The risk nobody has touched

**No curious non-specialist has ever opened this.** Every judgement call so far was made by reading the design documents very carefully, which is not the same thing as watching someone use the product. This is yours to close, and it does not need anyone's permission: recruit two or three people from the audience it is for, watch what they type into the palette, and record what they typed. Their second and third guesses are the real test of vernacular coverage, and no percentage substitutes for it. If you genuinely cannot get people in front of it, say so in `handoff.md` §7 and treat every coverage number in this document as unvalidated — do not quietly let the gap stay invisible.

**The design pass has happened** and its findings are folded into this list and into handoff §7. The headline ones, beyond the vernacular defect above: the MRCA had no bloom at all and was the dimmest filled mark on the canvas (fixed); `design-reference.md` promises a spring reflow on add and **no code implements one** — the tree jump-cuts and only the trace draws, which contradicts priority 2 as stated; labels can land more than two rows from their own node with no leader line, so a whole right-hand stack reads off by one; the time axis carries a single numeric tick on shallow selections, which is most first queries; `dinosaur` and `ape` dead-end on a broken-taxon note that names nothing clickable (`oak` no longer does — it answers with nine oak species, and handoff §7 records why giving *Quercus* a note as well is worth doing only once that note has somewhere to go); and there is no way into the app but a keyboard shortcut, which makes it unusable on touch. Still outstanding, still worth reading in full.

Related, and still true: **get a critical design pass from someone other than whoever wrote the UI.** It implements `design-reference.md` faithfully — phosphor persistence, the MRCA flare at `t=80`, orthogonal traces, dash-not-luminance for provenance. Whether it actually *reads* that way on screen is a different question, and its author is the wrong person to answer it. A fresh agent instance with no memory of building it is an acceptable substitute; the author re-reading their own work is not.

## The culture of this codebase, which matters more than the schedule

**Figures are measured, not estimated.** When a gate fails, assume a real bug — but check what the gate is *measuring* before changing either side. One gate failed at 41.67 against 41.32 because the doc said *root-to-tip* depth and the gate averaged over all nodes; the doc was right. Another flagged `ott_sorted.npy` as disagreeing with the node count when it is deliberately a sorted index over only the nodes that carry an OTT id.

**Beware the gate that passes while flattering you.** This is the failure mode that has cost this project the most. `age_tier` reported 89.6% "measured" when 2.27M of those were extant tips sitting at the present; the figure that describes the chronogram is 50.2% of *internal* nodes. Phase 5a reports 100% silhouette coverage while two thirds of the tree gets nothing drawable. Both numbers were true and both were useless. When you add a gate, ask what a reader would wrongly conclude from it passing.

**The dangerous bugs here do not error.** Three found in the last build, all of the same shape: `--tree birth_model` silently overwrote the accepted tree's ages (both trees pass identically, so the only symptom was nodes shifting by a fraction of a Ma); a stale `phase2_gates.json` had `/v1/about` reporting a failed phase 2 from a build that no longer existed; and `node_fts` is one row per *name*, so joining `node.idx = node_fts.rowid` joined cleanly to unrelated nodes and returned confident nonsense for every search. Assume this class exists in what you touch.

**Never apply a lint or type fix without reading the surrounding code.** Two real bugs came from exactly that, including one where silencing an unused-variable warning left a database column permanently `NULL` while every gate passed.

**Everything must pass all four**, from `pipeline/`:
`uv run ruff format src tests && uv run ruff check src tests && uv run ty check && uv run pytest`
Plus `npm test` and `npx tsc --noEmit` in `web/`, and `go vet ./... && go test ./...` in `server/`.

**Three implementations of the same primitive now exist** — `induced_subtree` in Python (`render.py`, the reference), Go (`server/internal/topo`), and TypeScript (`web/src/tree/induced.ts`). The latter two are pinned to the first by tests built from the real baked arrays. If you change the suppression rule, change it in three places and let those tests tell you when you have missed one.

**Be honest about uncertainty visually, and never numerically.** Only 6.7% of the synthesis tree is phylogenetically placed. A `structural` node gets a dashed trace and no figure — never a confident age where nobody has estimated one. This matters *more* for a lay audience, not less.

## Running it

```bash
scripts/dev.sh            # Vite with hot reload, backed by its own API, :5173
scripts/serve.sh          # API + built frontend, one process, :8080
```

The first is the `concestor` configuration in `.claude/launch.json`, so the preview browser and any agent start it the same way. It leads because it is the one to work in: the frontend is served from source, so an edit is on screen without a build step.

The second is `concestor-built`. Run it before merging, and for anything touching asset loading or analytics — Vite serves transformed modules rather than the shipped chunks, and under `dev.sh` the beacon `404`s because Vite proxies `/v1` to a Go binary that has never heard of it. It rebuilds `web/dist` whenever an input is newer than the bundle. It used to rebuild only when `web/dist` was *missing*, which served an hour-old bundle in silence and cost a bug report filed against source that was already fixed.

**Restart the server after any pipeline run.** The arrays are mmap'd and SQLite is opened at startup, so a running server keeps serving the previous build — and because both builds are internally consistent, the only symptom is quietly stale answers. This has already caused confusion twice.

Take it from here.
