# Concestor

An interactive tree-of-life visualiser. Pick species, see the minimal subtree
connecting them through their common ancestors, drill into the fossil record
along any branch, laid out against deep time.

## Read the design docs first

They are the spec, and they contain figures verified against live APIs and data
files on 2026-07-31 — tip counts, file sizes, coverage percentages, response
shapes. **Do not re-research them.** Several widely-repeated public numbers are
wrong and these docs record the corrections.

| Doc | Contents |
|---|---|
| [docs/handoff.md](docs/handoff.md) | Current state, priorities, decisions taken. Start here |
| [docs/design-reference.md](docs/design-reference.md) | Visual and interaction language. Authoritative for anything the user sees |
| [docs/management.md](docs/management.md) | The standing brief for whoever owns the project |
| [docs/data-sources.md](docs/data-sources.md) | Verified facts and corrections. Read this before the architecture doc |
| [docs/architecture.md](docs/architecture.md) | Data model, storage, backend, rendering |
| [docs/image-store.md](docs/image-store.md) | How drawings are identified, stored, ranked and served. Governs every image source. Designed, not built — the migration is only needed when a *second* source arrives |
| [docs/ingest.md](docs/ingest.md) | The six build phases and their validation gates |
| [docs/phase2-decision.md](docs/phase2-decision.md) | The dating decision — accepted, with the evidence |
| [docs/phase3-pbdb-path.md](docs/phase3-pbdb-path.md) | How fossils resolve to the tree, measured |
| [docs/phase5c-decision.md](docs/phase5c-decision.md) | Generated outlines from Wikimedia photos — **optional future enhancement, not scheduled**. Kept complete and measured. Four rejected approaches, with numbers |
| [docs/witness-ceiling.md](docs/witness-ceiling.md) | Raising the divergence witness off nodes and onto fossil attachment points. **Shipped**; §9 is what it actually cost |
| [docs/fossil-grafts.md](docs/fossil-grafts.md) | Drawing a fossil *in* the tree at its own date. **Shipped**; §2 is why grafting into the baked arrays was refused |
| [docs/worktrees.md](docs/worktrees.md) | Why the preview works in a parallel session's worktree |

**This product is for curious people interested in evolution, not for evolutionary
biologists.** Identifying an MRCA, drawing the tree well, and showing useful
silhouettes are the priorities; the time axis and the fossil layer are secondary.
That makes `ingest.md`'s numbering a *dependency* order, not a priority order.

## Where things are

```
docs/          the spec
pipeline/      the offline build pipeline (Python) — see pipeline/README.md
server/        the read API (Go) — mmaps the arrays, opens the DB read-only
web/           the real UI (React + xyflow v12). The signature interaction lives here
snapshot/      pinned upstream sources. Gitignored except manifest.json
build/         derived artifacts. Gitignored
```

The three halves share only *files*. `server/` reads the pipeline's `.npy`
output directly and `web/` talks to `server/` over `/v1`; there is no shared
runtime, no FFI, and no code generation between them.

## Language choices

**Build pipeline: Python 3.14**, managed with `uv`. The phylogenetics ecosystem
is there when needed, Duke et al.'s own interpolation code is Python + numpy,
and the work is one-pass array manipulation over files. It is fast enough:
2.7M nodes parse in 0.9 s.

**Serving binary: Go**, in `server/`. Decided on mmap ergonomics, a static
binary, and mature read-only SQLite; reasoning in `docs/serving-binary.md`. It
reads the pipeline's `.npy` files directly — there is no `topology.bin`, and
that is deliberate (see `package.py`).

**Frontend: React 19 + TypeScript + `@xyflow/react` v12**, in `web/`. Layout is
our own; **no dagre, no ELK, no d3-hierarchy**, because a graph-layout engine
assigns `x` by depth and here `x` is time.

```bash
cd web && npm install && npm run build && npm test   # 220 tests
cd server && go test ./... && go run . -build ../build
```

**Running in a worktree.** `scripts/serve.sh` and `scripts/dev.sh` are the two
`.claude/launch.json` configurations and work unchanged in a parallel
session's worktree, which has the source but neither `build/` (2.9 GB) nor
`snapshot/` (1.7 GB). They borrow both, read-only, from the main checkout.
**`go test` does not.** `testenv.BuildDir` walks six parents for
`build/concestor.db` and from `<worktree>/server/internal/store` that stops one
level short — so 70 of 87 tests skip and the suite still prints `ok`. Symlink
`build` into the worktree root (it is gitignored) before trusting a green run.
Nothing may hardcode a port. `docs/worktrees.md` explains the split; the rule
to keep is that borrowed paths are pipeline output nobody edits, and `web/`
always belongs to the worktree.

`web/src/tree/induced.ts` and the Go equivalent are both ports of `render.py`'s
`induced_subtree`, each pinned to the Python reference by a test built from the
real baked arrays. If you change the suppression rule, change it in three
places and let those tests tell you when you have missed one.

## Working on the pipeline

```bash
cd pipeline
uv sync
uv run concestor-build snapshot   # phase 0
uv run concestor-build topology   # phase 1
uv run concestor-build dates      # phase 2 — the decision gate
uv run concestor-build render     # throwaway renderer
```

### Every change must pass all four

```bash
uv run ruff format src tests
uv run ruff check src tests
uv run ty check
uv run pytest
```

`ruff` and `ty` are pinned in the dev dependency group; use the versions
resolved there rather than a system install.

### Strict typing is required

The project is fully annotated and `ty check` must pass clean. Rules live in
`pipeline/pyproject.toml`.

- **Annotate every function** — ruff's `ANN` rules enforce it. Tests are exempt
  from return annotations only.
- **Use the aliases in `concestor_build/typing_.py`** rather than bare
  `np.ndarray`. The dtypes are load-bearing: `parent` being `u32` is what makes
  it 10.9 MB instead of 21.8, and a signature saying `U32Array` says so.
- **`Any` is allowed only for decoded JSON**, via the `Json` / `JsonDict`
  aliases. A remote payload's shape is the remote service's business.
- **Narrow optionals explicitly.** `ParsedTree.branch_length` is `F64Array |
  None`; phase 2 raises a clear error rather than letting numpy fail obscurely.
  ty caught that one, which is the point.

### Do not apply a lint or type fix without reading the surrounding code

Two real bugs in this repo came from exactly that:

- Renaming `rank` to `_rank` to silence an unused-variable warning left the
  column it fed permanently `NULL`. Every gate still passed. The only symptom
  was the database being 19 MB smaller.
- `is_broken` on `node` was always zero, because broken taxa are *rejected*
  from synthesis and so are not nodes at all. They now live in `broken_taxon`.

Both are now covered by `tests/test_db_contents.py`. When a lint fix touches a
name that flows into output, check the output.

## Gates, and how to treat them

Each phase collects **gates** rather than raising on the first failure, so a run
reports every problem at once and then refuses to write its output. `require`
blocks the build; `observe` is recorded but never fails it. Results land in
`build/phase{N}_gates.json`.

The expected values are **measured, not estimated**. A mismatch usually means a
real bug — but check what the gate is measuring before changing either side.
Mean depth failed at 41.67 against an expected 41.32 because `data-sources.md`
says *root-to-tip* depth, and the gate was averaging over all nodes including
internal ones. The doc was right.

Counting rows is not the same as checking them. Structural gates validate the
shape of the data; add a content gate whenever a column starts carrying
something a downstream consumer depends on.

## Facts that will cost you hours

All detailed in `docs/data-sources.md`:

- `files.opentreeoflife.org/synthesis/current/` is **frozen at 2016**. Pin
  `opentree16.1` explicitly, resolved from the live API's `synth_id`.
- **OTT id forwarding is silent** — 297,070 entries. Always compare the
  returned `ott_id` against what you sent, and chase forwards transitively.
- `taxon_info`'s `is_suppressed_from_synth` field is **wrong**. Don't trust it.
- **Never** point treePL or `ape::chronos` at a branch-length-free topology.
  treePL does not error; it emits a confident dated tree containing zero
  information.
- The Open Tree API has **no rate limiting because nobody implemented it**, and
  it is one `waitress` process behind a small academic project. Pace requests.
  It is a build-time oracle only, never a runtime dependency.
- GBIF caps paging at **offset 100,000**, and the PBDB checklist has 461,889
  records. Shard, then prove coverage by counting distinct keys.

## Current state

**All six phases are implemented, the server is built, and the UI works end to
end.** Every phase is green and `concestor-build package` succeeds; the current
build is `b48553b2b8a4a2ed`. `docs/handoff.md` §2 has the table and §7 the honest list of what is
thin. `test_vernaculars.py` asserts the words a person actually types and is
**green** — `dog`, `cat`, `whale`, `human`, `shark`, `T. rex` all resolve, and
so now do `frog`, `animal` and `bird`. The P9157 crawl is complete, 287/287
pages. `butterfly`, `eagle` and `oak` are asserted there too, under a weaker
claim they can actually meet: no taxon carries any of those words *bare*, so
what phase 6 owes them is a name the word **heads** — "swallowtail
butterflies", "Sea eagles", "Pedunculate Oak". Ordering is the server's and is
pinned in `server/internal/store/fts_test.go`.

**A Wikidata item can carry another taxon's OTT id**, and until it was fixed the
app said *Homo sapiens* is "also known as Homo floresiensis" and returned a
domain of 2,080 archaea for `frog`, captioned "Giant Bullfrog". The query now
fetches each item's own `wdt:P225` and refuses any contribution whose taxon name
disagrees with OTT's. Three cheaper rules were tried first and all three fail —
`vernaculars.py` records why, and one of them fails by taking "Dog" off *Canis
lupus familiaris*. Do not re-derive them.

**Ranking at the front door is fixed too**, and the principle is worth keeping:
*an exact match settles which **name** the query is, not which **taxon** the
reader means.* A common name can be filed far below the group it names, so
exactness is **withdrawn** — demoted one band, never removed — where the word
is the only thing recorded about a single species (PBDB's "eagle" on
*Miraquila*) or is an alias the taxon is not headlined by and a clade 100×
larger carries it as a head word (*Chaetodon capistratus*, headlined "Kete",
against Papilionidae). Under that sits a **head-word band**, because "oak moss"
is a moss and "sessile oak" is an oak. `handoff.md` §7 has the bounds, what
each clause protects, and the two known limits. Two things not to redo: the
Wikidata crawl cannot fix `oak` (*Quercus* is a **broken taxon**, so it is not
a node and is never crawled), and **`web/` must not re-sort `/v1/search`** — the
client's fuzzy score was outweighing four server ranks and silently putting a
sea snail above the butterflies.

**The keyboard surface is bare letters, and `web/src/chrome/bindings.ts` is
the only table.** `P` palette, `S` species-filtered palette, `F` fit (`⇧F` fit
selection), `/` isolate, `Tab` step, `L` time scale, `R` random species, `⇧R`
random fossil, `C` clear. `matchKey` refuses any press holding ctrl, meta or
alt — that refusal is the feature, because the old `⌘`-based surface was a
losing negotiation with the browser (`⌘L` is the URL bar and cannot be
prevented, `⌘F` is find, `⌘R` is reload) and every binding that survived it was
double-shifted. The same table feeds the control bar's buttons and the palette
rows, so a key cannot print one thing and do another. Two consequences worth
knowing before changing it: **share has no key** on purpose, and **clear is the
one action with a confirmation dialog** — one unshifted letter beside two
others, and the only one that can destroy an hour of work.

**The detail card leads with what a thing is, and the tree prose is folded
away.** `web/src/detail/` is the whole surface — common name, a Wikipedia
description, the classification, the figures, then one collapsed disclosure
holding every caveat about tier, placement and what the picture depicts. No
caveat was shortened; they moved. The one sentence that stayed on the face of
the card is a divergence's derived name, because for an `mrcaott…` node that is
the only identity it has. Three things not to redo: **the classification is the
ancestor path** (`/v1/path` already carries a rank on every entry, already
cached), **its gaps are named rather than filled** — *Homo sapiens* has no
ranked order and **Hominidae is not a node at all**, so five rungs and silence
looks broken to anyone who knows humans are hominids — and **the description is
fetched at read time on purpose**. That is not a crack in architecture §9: it is
not part of the dataset, no gate touches it, it covers the 523,112 fossil taxa a
QID-keyed crawl cannot, and the card is complete without it. The guard is the
whole difficulty — with a QID (108,293 nodes, served on `/v1/node` off
`vernacular.source_id`) phase 6 already refused any item whose `wdt:P225`
disagrees with OTT, and **without one the item must prove itself by `P225` or
there is no answer**, because PBDB has genera called *Ares*, *Iris* and *Nike*.
`docs/handoff.md` §3 has the rest, including why the article thumbnail is
deliberately not read.

**The card is also the second navigation surface.** Every name on it that names
a taxon opens that taxon's card, and it carries its own add/remove control. The
two arrived together and had to: a link that could only reach *drawn* nodes is a
dead end, and a control that could only remove is half an answer. So
`focusedIdx` now means only "which mark to light" and `selectedNodeKey` means
"which card to show", asking the API directly. Four things not to redo: **a
witness links to the fossil, never to its attachment point** (a node, therefore
the tempting target, and a clade tens of thousands of species wide); **`idx:N`
is a real key** for the nodes we hold no key for, and `idxFromKey` matches it
exactly because `Number("")` is 0 and the first draft selected the root; **a
node not in `induced.rendered` is a clade the reader *chose***, so it keeps its
exemplar rather than drawing a witness for a fork it is not sitting at; and the
add button has **three** states, because a drawn divergence exists only as long
as the selections that induced it and "Add" over something already visible
promises a change the press does not make. `docs/handoff.md` §3 has the rest.

**Decisions in this codebase are made by whoever holds it.** These docs escalate
nothing and hold nothing open pending approval; where a question was once
deferred, the file now records what was decided and on what evidence. If you
meet a fork the docs do not cover, decide it, write the reasoning where the next
reader will find it, and continue.

**Phase 2 accepted the Duke et al. dated tree**, 32/32 gates. It missed the gate
*as originally written* (99.6036% clade compatibility against 99.9%), and the
criterion was restated rather than the data changed: the original threshold
assumed a node-for-node identity no bifurcating chronogram can have against a
12,964-way polytomy. The 947 genuinely contradicted nodes are demoted to the
`structural` tier and render without a number. Read `docs/phase2-decision.md`
before touching anything that depends on ages, and do **not** start the fallback
congruification pipeline — it is 4–6 weeks for a less defensible time axis.

Three age arrays ship and must stay separate — `age_ma` (what may be shown, NaN
where nothing may be), `age_tier` (how), `age_layout` (where to draw, finite
everywhere). Merging the first and third to save 10 MB would put a confident
number on every dashed node, which is the exact failure this design exists to
prevent.

**Four tiers now, and the fourth is not a fourth grade of estimate.**
`measured`, `interpolated` and `structural` all answer "when did these lineages
part", from a chronogram of **extant** species — so an extinct taxon has no
counterpart to join to and is `structural` by construction, not by measurement.
`occurrence` answers a different and weaker question: when the taxon is observed
in the rock. 2,133 nodes carry one. It is written by **phase 4**, not phase 2,
because the `fossil` table does not exist until then, and it lives in the
`occurrence` table rather than in `age_ma` — a gate checks that on the array
rather than trusting the code that wrote it. It renders as a range and **never**
as a point; no midpoint is computed anywhere, so there is no single number to
reach for.

**Phase 4 also rewrites `age_layout` with the fossil brackets**, which is why
*T. rex* is drawn at 66.0 Ma rather than 25.9 and Cambrian trilobites are no
longer in the Neogene. Phase 2's output survives as `age_layout_phase2.npy` and
`age_tier_phase2.npy` so the two can be diffed and so re-running phase 4 clamps
the original rather than compounding its own output. Three things that pass will
cost you if you touch this:

- **PBDB's `fea` is junk-wide and an occurrence-count floor does not fix it.**
  Measured, the first-appearance bracket *widens* with occurrence count, 5.24 Ma
  median at one occurrence against 6.20 at fifty or more. The discriminator is
  which end of the bracket you read: the *latest* end is trustworthy throughout
  (*Homo erectus* `fea` 5.33 against `fla` 1.80 and a true ~2 Ma). The layout
  uses `lla` alone and never reads `fea`.
- **A fossil bound is refused where the node has a dated descendant**, because a
  last appearance is evidence about a lineage that *ended*. That removed 1,617
  bogus bounds.
- **Phase 3's `xref` resolved PBDB to OTT by name and OTT carries homonyms
  across kingdoms.** PBDB's *Ivesia* is an Ediacaran rangeomorph and OTT's is a
  rose-family plant. **Fixed** — `refuse_disagreements` withdraws a resolution
  where PBDB calls a taxon extinct, OTT's taxon of that name carries no extinct
  flag, and the node still has a chronogram-dated descendant. 16,833 rows over
  *every* method, not just `name_exact`, plus 235 where a name is still claimed
  by two accepted PBDB taxa. Phase 4's independent check went from 1,019 of
  1,048 to 31 of 60. Three things are load-bearing: the extancy sweep runs
  before the ambiguity one (so `Scopus` keeps the hamerkop instead of losing
  both), it needs phase 2's `age_ma` as a living-lineage guard (without it 1,162
  correct fossil attachments go), and `manual` overrides are exempt.

**architecture §7's double bracket is wrong in one place.** It reads as a chain
`fea ≥ fla ≥ lea ≥ lla`; the middle link holds for only **39.6%** of PBDB taxa,
because a taxon known from one stratigraphic interval has both appearances
inside it. For the other 60.4% there is **no certain extent at all** and the
solid bar must be left undrawn — not zero-width, which reads as precision.

**Silhouettes resolve to the closest drawn *relative*, not the nearest drawn
ancestor**, and `node_image.clade_idx` — the smallest clade holding both the
node and the drawing — is the size of the claim the picture makes. That is the
number the gates measure and the UI must render; coverage is 100% and always
was, and it means nothing. Read `docs/handoff.md` §5 before changing the
resolution.

**The PhyloPic corpus is the ceiling, and shipping on it is accepted.** The
whole corpus declares 9,461 distinct OTT ids, so better seeding is worth
thousands of nodes at most. Expanding the image set with generated outlines is
an **optional future enhancement and not current work** —
`docs/phase5c-decision.md` holds the design and its measurements, and
`docs/handoff.md` §3 records why it is deferred and what would reopen it.

**A divergence carries a second silhouette, and the two tables must stay
apart.** `node_image` answers "what does something in this clade look like" and
so prefers the most inclusive drawing beneath a node — which at a *split* is
always a crown group that did not exist yet. `node_divergence_witness` answers
"what was alive when these lineages parted": a **witness**, a fossil taxon from
*somewhere below* the fork whose PBDB bracket sits at the split. *Acanthostega
gunnari* at the fish/tetrapod divergence, *Eohippus* at horse/rhino, *Pakicetus*
at whale–hippo, *Sahelanthropus* at human–chimp. **885 forks.**

**A witness is a fossil, not a node**, and that is the whole of the layer's
reach — it used to have to be in the synthesis tree, where only 0.5% of extinct
OTT taxa are, so the design capped at 2,552 forks whatever the image budget. It
now hangs off phase 4's `attach_idx`. The claim weakens with the reach: *somewhere
below this fork*, not *inside this group*, and `attach_walk` is the number that
says how loose the placement is. `witness-ceiling.md` §9 is the before/after and
is the first thing to read before touching this.

Four refusals, and two of them will look like they cost too much: the fork must
be dated (falling back to `age_layout`), the taxon must carry a bracket, the
fork must not have its own image — and **the taxon must be extinct *and* have
ended before the Holocene**. `is_extant` alone is not enough: PBDB flags
*Thalassia testudinum*, the living turtle grass, extinct at 48.07–0.0117 Ma, and
it won a fork of 378,328 tips. A range running to the present cannot fail to
contain a recent split, which is the crown-group failure this feature exists to
fix, arriving through a wrong flag. `NEAR_FRACTION` caps how far a fossil may
sit from the split and **currently caps nothing**, because refusing a witness
falls back to no picture rather than to a worse one. Where `age_ma` is NaN the
match is made against `age_layout` — 326 of the 885, Carnivora → *Vulpavus*
among them — which holds only because the layout age is used to *choose* and
never to display. A witness never renders without its own fossil range beside it.

**Gate on the share of forks whose witness spans the split, never on coverage** —
and know that spanning is not clean either. Old rule against new on the same
corpus: 548 forks → 885, spanning 207 → **192**. It went *down* because 14 of the
old 207 spanned only by running to the present, *Moho braccatus* — a bird that
died in 1987 — across Passeriformes at a 52 Ma gap among them. `MIN_SPANNING_WITNESSES`
carries the comparison.

Which of the two to draw depends on how the reader reached the node, so **only
the client can decide it**, and `web/src/canvas/witness.ts` is where that
happens. A leaf of the induced subtree is a clade they *chose* and keeps its
exemplar; **a divergence draws its witness, or its own picture, or nothing.**
What it may never draw is a *borrow* — `node_image`'s closest drawn relative,
which is nearly always a living group younger than the fork. Caniformia's 57 Ma
split drew Procyonidae, raccoons, with nothing on screen saying they postdate it
by 25 million years. A node's own drawing is exempt because it was never a
borrow: Cetacea at Cetacea is what a silhouette is for. Select Caniformia
itself and the raccoon comes back, correctly.

**A fossil can now be drawn *in* the tree, and it is still not a node.** A
*graft* is a synthetic occurrence-tier node built client-side, placed at its own
`lla`, hanging off the branch its `attach_idx` sits on, showing its own
`fossil_image` drawing. It never enters `Induced`, so it can never move an MRCA,
and its index is `-(pbdb_taxon_no)` precisely so that any code path mistaking it
for a node fails on the array lookup instead of answering about a neighbour.
Read `docs/fossil-grafts.md` §2 before proposing that fossils be grafted into the
baked arrays instead — that costs a confident crown age on ~7,000 undated
divergences, and the numbers are there. Three refusals, none of them
approximated: no bracket (21.4% of PBDB), attach node not on a drawn branch, no
`pbdb_taxon_no`.

**Fossils are searchable and selectable, and neither needed a pipeline run.**
`SearchFossils` full-scans the 523,112-row table at ~40ms — there is no index on
`name` — and the palette renders it as its own section, pinned *last* whatever
it scores, because a species is a node you can build a tree from and a fossil is
an observation that hangs off one. Sections are a **grouping, not a
re-ranking**: inside one, rows keep the server's order with only the session
boost layered on top, exactly as before — fossils on the server's
tier-then-notability, nodes on `/v1/search`'s. The rule above holds unchanged,
and now covers two corpora: `web/` must not re-sort either. A graft selects like a node:
same click, same `sel=`, and `pbdb108454` cannot collide with an OTT id. Its
card is not the node card with fields blanked — it has no age, no tip count and
no ancestry, and it is where the PhyloPic credit finally lives. That credit was
blank at first because the server sends `creator`/`uploader` while every card
reads `attribution`/`contributor`; `normalise()` was doing that rename for
`/v1/node/` alone.

**A row can say which name got it there**, and only for a synonym.
`matched_name` rides alongside `matched_on` from `searchFTS`, tracked in
lockstep with `kinds` so the two can never credit different names, and is
omitted where the row already prints the string. It exists for the worst pair in
the corpus: OTT files *Homo floresiensis* as a synonym of *Homo sapiens*, so
without it the reader types a real hominin and is silently handed us. A `name`
or `vernacular` match is already lit by `litRanges`, and an abbreviation repeats
the same line down all eight rows of "T. rex" without distinguishing any of
them — so neither is captioned.

`concestor-build package` gates the artifact set as a whole and writes
`build/manifest.json`, which `/v1/about` serves. It refuses to package while any
phase's own gates record a failure. Every phase is green as of this writing, so
it should be re-run after any pipeline change rather than assumed stale.
