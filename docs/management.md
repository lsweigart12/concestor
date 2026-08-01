# Management brief

The standing brief for whoever owns and runs this project. Hand it over verbatim.
Keep it current alongside [handoff.md](handoff.md) — that one carries *state*,
this one carries *mandate*.

Revised 2026-07-31, after the build that took the project from three implemented
phases to a working product.

---

You are taking over as the owner of **concestor** (`/Users/lukesweigart/Projects/concestor`, working on `main`), and running it to completion. I am away and will not be available to answer questions for a while, so proceed autonomously and queue anything that genuinely needs me rather than blocking on it.

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

Concretely: someone reading `architecture.md` §3.4 today will implement `fossil.pbdb_orig_no INTEGER PRIMARY KEY`, which cannot work, because `orig_no` is not unique (407,634 distinct over 523,112 rows). `ingest.md` phase 4 asks for a spot check "at or below Dinosauria", which is untestable because Dinosauria is not a node in the synthesis tree. `ingest.md` phase 1 step 8 claims phase 1 builds the FTS index; it never did. Three separate documents state that GBIF vernaculars arrive free via `ott_sourceinfo`; they do not exist in our snapshot at all.

So: **trust `handoff.md` over the specs wherever they disagree, and make reconciling them your first substantial task.** It is a few hours and it stops the next person walking into a trap we already know about and documented. When you finish, this paragraph can go back to saying "do not re-research them".

## What to do, in order

### 1. Make silhouettes real, and fix the gate that says they already are

Phase 5a reports **100% node coverage** and passes 24/24. That number is flattering us the same way the age tiers were before we split them, and it should not have survived review.

The mechanism resolves every node to the nearest ancestor-or-self carrying a PhyloPic image. Mean climb is **27.3 ancestor hops**; only **0.22% of tips** get an exact image; and three sources — Ecdysozoa, `cellular organisms`, Opisthokonta — serve **1.79M of 2.73M nodes** between them. The UI correctly declines to draw those, because a generic blob labelled as your beetle is worse than nothing (architecture §7: "rendering a mole for Mammalia is worse than rendering nothing"). So roughly **two thirds of the tree resolves to an image we then refuse to show**.

I do not know how often a real selection actually displays a picture. Neither does anyone else. In every screenshot taken during the last build, not one silhouette rendered — and I cannot tell you whether that was the semantic-zoom tier or the suppression threshold. It is no longer the mirror: that finished, all 12,863 SVGs. Two candidates left, and both are cheap to test.

**Measure it, then fix it.** Take a few hundred realistic selections, count what fraction of rendered leaves and internal nodes actually display a silhouette, and **replace the node-coverage gate with that number**. Then decide what to do about it: relax the suppression threshold and lean harder on labelling what the image depicts, surface silhouettes at the clade level where they are genuinely meaningful, or some combination. This is priority-one work and it is the least-delivered of the three things this product is for.

**Do not expect more assets to solve it.** The corpus is the ceiling and we are close to it: 12,863 images, of which 11,080 declare an OTT id, resolving to 6,976 in-tree ids. Seeding now also matches an image's node *name* against `taxonomy.tsv`, which is the only way to reach the 1,783 images that resolve solely in GBIF/PBDB namespaces; that pass is implemented and worth 337 nodes, taking seeds from 7,133 to 7,470 and mean climb from 27.29 to 27.18. There is no third source of PhyloPic images. A materially larger corpus means a *different* corpus, which is a project, not a crawl.

### 2. Close the front door properly

- **Finish the Wikidata P9157 crawl.** 75 of 287 pages are done, it resumes and re-fetches nothing, and it is roughly 3.5 unattended hours at WDQS's pace. Coverage is 148,515 names — 3.71% of named nodes, but **56.74% weighted by `tip_count`**, which is the number a palette experiences. The notable end is done; this finishes the tail. `oak` currently returns "Oak moss".
- **Fix two ranking divergences in the server**, both small and both cases where the corpus already holds the right answer: `animal` returns *Arthropoda* where `search.py`'s own measurement gives *Metazoa*, and `E. coli` returns *Entamoeba coli* because `search_name.kind = 4` (broken taxa, all 9,839 rows) is indexed but not wired through to the API's `kind` field. *Escherichia coli* and *Dinosauria* are both broken taxa and explaining that is a stated requirement.

### 3. Give extinct tips their real ages

*Tyrannosaurus rex* currently renders with no number — correct, it is `structural` — but its ordinal layout position lands near 26 Ma. PBDB has its range and phase 4 now has it attached (`fea=83.6, fla=72.2, lea=72.2, lla=66`). Feeding appearance intervals into the layout for the ~1,129 extinct taxa that survive into the synthesis tree is small, self-contained, and turns a visibly odd placement into a correct one.

### 4. Then, and only then, the fossil drill-down

This is the largest unbuilt product surface and it is fully de-risked: all 523,112 taxa are attached, and `/v1/segment` already returns them ranked with both uncertainty brackets and a `fossils_total` for the "showing N of M" cap. Architecture §7 "Drill-down" specifies the rendering — spine of intermediates, **double bracket** (faded envelope `fea→lla`, solid bar `fla→lea`), offset lane sharing the time axis. ~21% of taxa have no interval and need an explicit "no range recorded" treatment, not a zero-width bar.

It is genuinely the most satisfying thing left to build, which is exactly why it comes fourth. Fossils are secondary and the three items above serve the stated priorities.

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

## The risk nobody has touched

**No curious non-specialist has ever opened this.** Every judgement call so far, mine included, was made by reading the design documents very carefully. Before committing to another large build, put it in front of two or three actual people from the audience it is for and watch what they type into the palette. Their second and third guesses are the real test of vernacular coverage, and no percentage substitutes for it.

Related: **get a critical design pass from someone other than the person who wrote the UI.** It implements `design-reference.md` faithfully — phosphor persistence, the MRCA flare at `t=80`, orthogonal traces, semantic zoom, dash-not-luminance for provenance. Whether it actually *reads* that way on screen is a different question, and its author is the wrong person to answer it.

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
