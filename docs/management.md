# Management brief

The standing brief for whoever owns and runs this project. Hand it over verbatim.
Keep it current alongside [handoff.md](handoff.md) — that one carries *state*,
this one carries *mandate*.

Revised 2026-07-31, after the build that took the project from three implemented
phases to a working product.

---

You are taking over as the owner of **concestor** (`/Users/lukesweigart/Projects/concestor`, working on `main`), and running it to completion.

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

**The previous version of this brief told you not to re-research the figures in those documents. That instruction is now conditionally wrong, and this is the most important thing on this page.** The specs were written before anything was built. Building it proved a dozen of their figures wrong, and every correction is enumerated in `handoff.md` §4 — but the corrections live *only* there. The specs still say the old thing.

**Those four traps are now fixed in the specs themselves** — `fossil` is keyed on `taxon_no`, the Dinosauria spot check names Tyrannosauridae, phase 1 step 8 says the `search` phase builds the index, and the GBIF-vernaculars-are-free claim is struck in all three places. Each correction is struck through in place rather than deleted, so a reader who half-remembers the old figure finds out why it changed instead of wondering whether they misremembered.

The reconciliation is not finished. `handoff.md` §4 is still the authoritative list and it is longer than those four.

So: **trust `handoff.md` over the specs wherever they disagree.** The traps that would have cost a reader real time are corrected in place; the rest of §4 has not been folded back, and until it is, §4 wins.

## What to do, in order

### 1. Silhouettes — **done**, and here is what it turned on

Left as the priority-one item. Closed: the pictures now mean something, phase 5a's flattering gate is gone, and the canvas is the demonstration.

**The diagnosis in the previous brief was half right.** It said two thirds of the tree resolved to an image the UI then refused to draw, and named two suspects for the empty screenshots — the semantic-zoom tier, or the suppression threshold. Neither survived contact. The threshold had already been dialled to permissive in `e333f90`, so silhouettes *were* rendering; measured over realistic selections, **8 in 10 of them were one of three blobs** — Ecdysozoa, `cellular organisms`, Opisthokonta. The failure had moved from "nothing renders" to "everything renders the same shape", which looks less broken and is not better.

**The fix was in resolution, not in the threshold.** A node used to take the image of its nearest ancestor that was *itself* seeded; with 7,470 seeds over 2.7M nodes that ancestor is usually a superphylum. It now takes the picture of its **closest drawn relative** — cousins included, which the old rule could not reach — and records `clade_idx`, the smallest clade containing both node and drawing. Measured: the median picture went from speaking for 1,208,417 species to **3,153**, and the share speaking for over a million went from 65.3% to **0.00%**. Selachii drew an opisthokont blob and now draws a shark.

**The gate is the clade, not coverage.** Coverage was 100% before and is 100% after — it was never the question. The blocking pair is now the share of nodes whose picture speaks for a group of ≤ 10,000 species: 71.2% of leaves, 81.9% of internal nodes. Note what that gate does *not* claim: 10,000 is a product judgement written down in `images.py`, not a validated one.

**And note what the measurement refused to do**, because the reasoning matters more than the result. The brief asked for a few hundred realistic selections. There is no realistic-selection distribution to sample: drawing uniformly from typeable names gives obscure moths, and weighting by `tip_count` — handoff §7's own model of what a palette experiences — gives "opisthokont" and "dicondylian", which nobody types. Gating on either would have invented a user. The clade-size distribution needs no such invention, which is why it is what ships. **The audience risk below is still entirely open and is now the binding constraint on this work.**

**Do not expect more assets to solve what remains.** The corpus is the ceiling: 12,863 images, 11,080 declaring an OTT id, 6,976 in-tree, 7,470 seeded nodes. There is no third source of PhyloPic images, and a materially larger corpus means a *different* corpus, which is a project, not a crawl. What is left is a rendering question at the top of the tree — Eukaryota's picture speaks for 2,267,368 species and probably should not be drawn at all — and handoff §7 records it.

### 2. Close the front door properly

- **Finish the Wikidata P9157 crawl.** 75 of 287 pages are done, it resumes and re-fetches nothing, and it is roughly 3.5 unattended hours at WDQS's pace. Coverage is 148,515 names — 3.71% of named nodes, but **56.74% weighted by `tip_count`**, which is the number a palette experiences. The notable end is done; this finishes the tail. `oak` currently returns "Oak moss".
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

### 5. Fix phase 3's cross-kingdom homonyms

Found while doing item 3 and previously unrecorded. `xref` resolves PBDB to OTT **by name**, and OTT carries the same genus name in unrelated kingdoms, so a Cambrian fossil lands on a living plant. Measured with a test that needs no new data — a taxon last seen before the Permian cannot be a living genus: **1,019 of the 1,048** nodes carrying an exact attachment with `lla > 250 Ma` have living descendants. Phase 4 already reports it every build as an `observe`, so the baseline is recorded. *Sadleria* is a Hawaiian fern with a Devonian fossil on it; *Streptosolen* is a South American shrub with an Ordovician one.

It is not confined to the naive path — `name_exact` 991, `gbif_backbone_provenance` 221, `gbif_pbdb_chain` 168 — so 389 survived a route meant to be evidence-based.

The fix is a lineage comparison in phase 3: PBDB has its own `parent_no` hierarchy and OTT has the tree, so refuse a resolution where the two disagree above family level. Put the test in as an `observe` gate *before* the fix so the baseline is recorded. Phase 4 already guards itself by refusing a fossil bound on any node with a living descendant, which is right for phase 4 and does nothing for every other `xref` consumer — and `xref` is 270 MB of this database.

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
- Do not optimise the artifact set yet. It is 2,048 MB against architecture §11's 700 MB estimate, which means §11's cost paragraph needs re-deriving before anyone sizes a machine — but nothing is broken by it, and trimming `xref` before the product is finished is optimising the wrong thing.
- Do not reintroduce a fixed layout width in the frontend. It follows the viewport so the fit stays near 1:1; at a fixed 1240px a narrow panel fits at ~0.45 zoom and semantic zoom correctly drops every label.

### 6. The vernacular join is producing false statements — do this first

An outside design review of the running app (see below; it happened, and the report is worth reading in full) found the product **lying**, which is the one thing this codebase's culture exists to refuse. *Homo sapiens* is "also known as Homo floresiensis". Typing `frog` returns Archaea, captioned "Giant Bullfrog", above the actual frogs. 4,262 nodes have vernaculars claimed by two or more Wikidata items, and one taxon has one item.

Full measurements in handoff §7. **The fix is implemented and the crawl that activates it was running when this was written** — the P9157 query now fetches each item's own `wdt:P225` and refuses any contribution whose taxon name disagrees with OTT's. Three cheaper rules were tried against the real data first and all three fail; handoff §7 has the table, and one of them fails by taking "Dog" off *Canis lupus familiaris*, which the `dog` spot check caught.

**What is left is to confirm it landed.** `search` and `package` are chained to run automatically when the crawl finishes, so in the ordinary case there is nothing to run. Confirm it by checking that `build/vernaculars/wikidata/page_00001.jsonl` carries an `"s"` field and that phase 6 reports names dropped for a P225 mismatch; if the chain did not fire:

```bash
cd pipeline && uv run concestor-build vernaculars && uv run concestor-build search
```

`search` must follow, because it indexes the vernacular table and would otherwise keep serving the old names from a stale index. Then verify the two cases by hand — the *Homo sapiens* card must not say "Homo floresiensis", and `frog` must not return Archaea — and re-run `concestor-build package` so `/v1/about` reports the new build. If the crawl was interrupted, the old names are still in place (the phase rewrites the database only on a completed crawl) and the pre-P225 checkpoint is at `build/vernaculars/wikidata_pre_p225/`.

**Everything else on this list is depth. This one is correctness, and it is at the front door.**

## The risk nobody has touched

**No curious non-specialist has ever opened this.** Every judgement call so far was made by reading the design documents very carefully, which is not the same thing as watching someone use the product. This is yours to close, and it does not need anyone's permission: recruit two or three people from the audience it is for, watch what they type into the palette, and record what they typed. Their second and third guesses are the real test of vernacular coverage, and no percentage substitutes for it. If you genuinely cannot get people in front of it, say so in `handoff.md` §7 and treat every coverage number in this document as unvalidated — do not quietly let the gap stay invisible.

**The design pass has happened** and its findings are folded into this list and into handoff §7. The headline ones, beyond the vernacular defect above: the MRCA had no bloom at all and was the dimmest filled mark on the canvas (fixed); `design-reference.md` promises a spring reflow on add and **no code implements one** — the tree jump-cuts and only the trace draws, which contradicts priority 2 as stated; labels can land more than two rows from their own node with no leader line, so a whole right-hand stack reads off by one; the time axis carries a single numeric tick on shallow selections, which is most first queries; `dinosaur`, `oak` and `ape` all dead-end on a broken-taxon note that names nothing clickable; and there is no way into the app but a keyboard shortcut, which makes it unusable on touch. Still outstanding, still worth reading in full.

Related, and still true: **get a critical design pass from someone other than whoever wrote the UI.** It implements `design-reference.md` faithfully — phosphor persistence, the MRCA flare at `t=80`, orthogonal traces, semantic zoom, dash-not-luminance for provenance. Whether it actually *reads* that way on screen is a different question, and its author is the wrong person to answer it. A fresh agent instance with no memory of building it is an acceptable substitute; the author re-reading their own work is not.

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
scripts/serve.sh          # API + built frontend, one process, :8080
```

That is the `concestor` configuration in `.claude/launch.json`, so the preview browser and any agent start it the same way. `concestor-web-dev` runs Vite on :5173 with hot reload for frontend iteration.

**Restart the server after any pipeline run.** The arrays are mmap'd and SQLite is opened at startup, so a running server keeps serving the previous build — and because both builds are internally consistent, the only symptom is quietly stale answers. This has already caused confusion twice.

Take it from here.
