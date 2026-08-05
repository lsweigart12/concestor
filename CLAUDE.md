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
| [docs/name-ranking.md](docs/name-ranking.md) | Ordering a taxon's common names by use. **Shipped**, §7 included — the canvas switcher, and what the design there got wrong |
| [docs/phase2-decision.md](docs/phase2-decision.md) | The dating decision — accepted, with the evidence |
| [docs/phase3-pbdb-path.md](docs/phase3-pbdb-path.md) | How fossils resolve to the tree, measured |
| [docs/phase5c-decision.md](docs/phase5c-decision.md) | Generated outlines from Wikimedia photos — **optional future enhancement, not scheduled**. Kept complete and measured. Four rejected approaches, with numbers |
| [docs/witness-ceiling.md](docs/witness-ceiling.md) | Raising the divergence witness off nodes and onto fossil attachment points. **Shipped**; §9 is what it actually cost |
| [docs/fossil-grafts.md](docs/fossil-grafts.md) | Drawing a fossil *in* the tree at its own date. **Shipped**; §2 is why grafting into the baked arrays was refused |
| [docs/biolum-gpu.md](docs/biolum-gpu.md) | The bioluminescent mode on WebGL2 — rivers, marine snow, and five things that will cost you an afternoon. **Shipped** |
| [docs/worktrees.md](docs/worktrees.md) | Why the preview works in a parallel session's worktree |
| [docs/ci.md](docs/ci.md) | What CI checks, what a green run does *not* mean, and what can deploy on Cloudflare |
| [docs/deployment.md](docs/deployment.md) | Where it runs: all of it on Cloudflare, the Go binary in a Container. The alternatives with numbers |
| [docs/analytics.md](docs/analytics.md) | What readers search for, add and build. Why no server-side log can say, the three events that can, and the plan limits measured against the live account. §9.6–§9.7 are the four measurement sources and why they must not be added up |

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
cd web && npm install && npm run build && npm test   # 745 tests, two projects
cd server && go test ./... && go run . -build ../build
scripts/check.sh          # everything CI runs, plus the dataset tests it can't
```

**`web` has two vitest projects, and which one a test lands in is decided by
its filename.** `node` is everything that was there before — pure modules, no
document, 652 tests in about 320 ms, and that speed is the reason the
environment was not simply switched over. `dom` boots jsdom and renders with
`@testing-library/react`, and it collects **`*.test.tsx`** (a component test)
and **`*.dom.test.ts`** (a module test that needs `localStorage`,
`sessionStorage`, `matchMedia` or `window` — calling such a file `.tsx` when it
renders nothing would be a lie about what it is). `vitest.config.ts` is the
whole rule and `src/test/setup-dom.ts` is the whole harness: `cleanup`, a
`scrollIntoView` stub for a layout engine jsdom does not have, a `sendBeacon`
that swallows analytics, and a `fetch` that **throws** rather than quietly
resolving against `http://localhost:3000` and hanging. Stub the `api` method
you are exercising — `vi.spyOn(api, "search")` — rather than the transport.
Four things not to redo are in `docs/handoff.md` §3, chief among them that
**timer advances must be wrapped in `act`**: the tooltip store notifies
`useSyncExternalStore` subscribers from a `setTimeout`, and `fireEvent` wraps
its own dispatch, so a *chained* tip that opens with zero delay passes without
`act` and a delayed one silently reads the DOM from before the timer fired.
`Palette.test.tsx`, `Tooltip.test.tsx` and `Confirm.test.tsx` are the pattern
to copy; the first is the debounce-and-abort path around `/v1/search`, which is
not arithmetic that could have been lifted into a pure module because it is
entirely a property of when React runs an effect's cleanup.

**A test does not read its subject as a string, and `web/src/test/` holds the
two things that replaced the ten that did.** `App.test.tsx` and
`App.bare.test.tsx` render the *whole* app through `test/appHarness.tsx` — the
real canvas, not a mock, because `PaletteFab` is the entire chrome below 620px
and is drawn inside `Graph`, so a stub there quietly halves every claim about
the two surfaces agreeing. The two files exist separately because
`FULLSCREEN_AVAILABLE` and `BIOLUM_AVAILABLE` are module-scope consts and a
file is the unit a module graph is evaluated in; the capability stubs go in
`vi.hoisted`. `test/css.ts` parses `styles.css` with **postcss** for the tests
that pin a constant to the rule that draws it — `CARD_W`, `MAX_W`,
`labels.ts`'s font stack — which is a genuinely good test badly executed six
different ways before. Seven things not to redo are in `docs/handoff.md` §3,
chief among them that `renderApp` must clear the URL and `sessionStorage`
(the store writes the tree into the address bar with `replaceState`, `cleanup`
cannot see it, and the next test boots on the last one's tree), and that
`chrome/tip.test.ts`'s `title` census stays source text on purpose — you cannot
prove an absence by rendering the components you remembered to render.

**Running in a worktree.** `scripts/serve.sh` and `scripts/dev.sh` are the two
`.claude/launch.json` configurations and work unchanged in a parallel
session's worktree, which has the source but neither `build/` (2.9 GB) nor
`snapshot/` (1.7 GB). They borrow both, read-only, from the main checkout.
**`go test` does not.** `testenv.BuildDir` walks six parents for
`build/concestor.db` and from `<worktree>/server/internal/store` that stops one
level short — so **82 of 99** tests skip and the suite still prints `ok`. Run
`scripts/check.sh`, which symlinks `build` into the worktree root (it is
gitignored) and sets `CONCESTOR_REQUIRE_BUILD=1` so a skip becomes a failure;
`docs/ci.md` §2 is why a green `go test` on its own means very little here.
Nothing may hardcode a port. `docs/worktrees.md` explains the split; the rule
to keep is that borrowed paths are pipeline output nobody edits, and `web/`
always belongs to the worktree.

**Commits carry a Conventional Commits type, and nothing else about them
changes.** The type decides the version bump, and **`release.config.cjs`'s
`releaseRules` is the one place that mapping is written down** — read it there
rather than from memory, and do not restate it elsewhere. It was previously
asserted in three prose files, enforced in none of them, and wrong in all
three. The subject stays a sentence in this project's voice — `feat: Make the
card say what a thing is, and let the reader walk from it` — because
`subject-case` is off in `commitlint.config.cjs` for exactly that reason.
Getting the type wrong is not cosmetic: merging to `main` cuts a release, and
the version is computed from these prefixes and nothing else. `docs/ci.md` §4
has the rest, including why there is no `CHANGELOG.md` and why the pipeline
never runs in CI.

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
build is `854cdfa42f77e78e`. `docs/handoff.md` §2 has the table and §7 the honest list of what is
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

**A taxon's common names are ordered by use, and English Wikipedia is what
measures it.** Phase 6b (`concestor-build names`) writes `vernacular.usage_rank`
from the title and redirect graph: an article title is the name that project's
own policy calls the most used in reliable English sources, a redirect is a name
somebody thought a reader would type, no page is a name nobody did, and a page
landing on a *different* article is a name whose ordinary referent is something
else. That last band is the valuable one — it demotes `man` and `men` (the
article **Man**), `bug` and `bugs` (**Bug**), `moth` (**Moth**) and `Ferae`
(**Ferae**) without a rule written about any of them, while `carnivorans` and
`T. rex` reach their taxa and lead. It replaces an election that broke ties on
`length(name)` and so headlined *T. rex* as **`TRex`**, plus a list below the
headline that had no order at all. `docs/name-ranking.md` is the account and
`docs/handoff.md` §3 the six things not to redo — chief among them that **the
taxon's own article title must be resolved through redirects first** (Wikidata
gives *Homo sapiens* the sitelink `Homo sapiens`, which is a redirect to
`Human`, so comparing unresolved demotes every good name the species has), that
**NULL evidence is not `none`**, that **`elsewhere` is demoted one band and
never removed**, and that **corpus frequency is refused** because it measures
the string rather than the name — inside *Homo sapiens*'s own names it ranks
`man` above `human`. The score is **display-only**: `band.go` decides which
*taxon* a query means and nothing here touches it. The canvas
scientific/common-name switcher is **shipped** — `name-ranking.md` §7 is the
account, including the two clauses the design there did not anticipate: only
genus, species and subspecies get a common name, and it is rank 1 or nothing.

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

**Withdrawal has a counterpart now, because clade size was the wrong tiebreak
in both directions.** Where two taxa are both called exactly what was typed,
the larger won — right for `beetle` (Coleoptera against two one-species
beetles), wrong for `human`, where the genus *Homo* beat *Homo sapiens* by five
tips and the product's most ordinary query answered with the clade holding
*H. erectus*. The discriminator is **English Wikipedia's article title**, phase
6b's `wiki_evidence` read for a different question than `name-ranking.md` §2
asks: `usage_rank` orders one taxon's own names and stays display-only, but a
title is held by one taxon and no other, so `title` on the name typed says
which taxon the *word* denotes. Of the 6,619 English names more than one node
claims, 663 have exactly one titled claimant, 5,942 have none, and **14 have
two or more — every one a monotypic pair** whose two answers are the same
species. It moves 358 leaders: `onion` to *Allium cepa*, `camel` to *Camelus*
off Camelidae (the llamas), `sloth` to Folivora off Pilosa (the anteaters).
Four things not to redo, all in `handoff.md` §7: it is a **tiebreak and not a
band**, sitting above `rank_score`, so no taxon climbs past a better-matching
name and nothing leaks into `Interleave`, where the band is a pure function of
two strings shared with a corpus that has no articles; it **only ever
promotes**, and the mirror rule — withdraw on `elsewhere` — was written,
measured and refused, because **Whale** and **Rat** are broad-concept pages and
Cetacea and *Rattus norvegicus* are the only exact claimants there are; a title
**blocks both withdrawals**, since *Allium cepa* is a one-species category
label by every offline signal and the subject of the article *Onion*; and
`cat` is the **known limit**, unfixed, because *Felis catus* carries no QID
so the article **Cat** reaches no evidence — a coverage gap in phase 6, not a
reason to weaken the rule.

**The keyboard surface is bare letters, and `web/src/chrome/bindings.ts` is
the only table.** `P` palette, `S` species-filtered palette, `F` fit (`⇧F` fit
selection), `/` isolate, `N` next (`⇧N` previous), `T` time scale, `L` labels, `A` ages, `B`
bioluminescence, `R` random species, `E` expand to fullscreen, `C` clear. **The four canvas modes hold the
letters that name them**, which is why the time scale is on `T`: `l` names the
labels, where it only ever named one of the two scales it switched between.
**Fullscreen is on `E` and the button says "Fullscreen"** — the second row here
whose label is not the word its letter came from, after `P` **Commands**. The
letter is forced: `f` is fit and names it exactly, so the trade that let the axis
give `l` up to the labels has no counterpart here, and printing `F` on a button
that does something else is the one failure this whole table exists to make
impossible. The *word* is not forced, and **Expand** — tried first, for the
symmetry — is wrong twice over: it names the gesture rather than the result, and
a canvas that already opens drill lanes and isolates lineages gives "expand" a
competing meaning. A badge teaches the key, a label teaches the action, and where
they cannot be the same word the label wins.
**`Tab` is the browser's and has no row at all**, which is what makes the rest of
this surface honest. It held `step` — globally, and the handler
`preventDefault`s everything it matches — so the focus ring did not move in this
app at all and *every* control the bar, the mode panel and the detail card draw
was unreachable without a pointer. That is the Enter failure one level up (Enter
would have cost keyboard activation; `Tab` cost keyboard navigation) and it is
fixed the same way, except by **absence rather than a `Scope`**: no surface here
wants `Tab`, and scoping it to a focused canvas would trap a reader inside the
canvas, which is a keyboard trap and a worse bug. So `step` moved to `N` and the
*word* moved with it — "Step" has no free letter left (`s`, `t`, `e` and `p` are
all spent), and the alternative was a third badge printing one thing and doing
another. `keyboard.test.tsx` is the pin, and it transcribes App's handler rather
than mounting it, on purpose. `matchKey` refuses any press holding ctrl, meta or
alt — that refusal is the feature, because the old `⌘`-based surface was a
losing negotiation with the browser (`⌘L` is the URL bar and cannot be
prevented, `⌘F` is find, `⌘R` is reload) and every binding that survived it was
double-shifted. The same table feeds the control bar's buttons, the palette
rows and the card's remove button, so a key cannot print one thing and do
another. Three consequences worth knowing before changing it: **share has no
key** on purpose; **clear is the one action with a confirmation dialog** — one
unshifted letter beside two others, and the only one that can destroy an hour of
work; and a badge is printed **only where the press would do it**, which is why
`⌫` rides on the card's remove state and not on its add state or on the fossil
card. `remove` fires on `induced.leaves`, which is the selection, which is
exactly what puts that button in its remove state; a graft's index is negative,
so the handler resolves no node and the press does nothing.

**Every tooltip in this app is drawn by this app, and `title` is banned.**
`chrome/tip.ts` is the placement and the timing, `chrome/Tooltip.tsx` is the
store, the `useTip` hook and the one layer, and `tip.test.ts` censuses the
`.tsx` corpus so neither `title=` nor an SVG `<title>` child can come back. The
mechanism was the smaller half of the problem: the native tooltip is
unstyleable, a second late, unwrappable, undismissable, absent on touch, and
positioned against the *pointer* rather than the control — which is why the
bioluminescence switch, bottom left, explained itself across the timeline. The
**copy** was the leak. `title` costs nothing to fill and nothing checks it, so
it filled with the reasoning that belongs in the header comments: 372 characters
of naming policy on one segment of the labels switch, 243 on bioluminescence.
Every one is a sentence now and nothing moved anywhere, because all of it was
already written in the components and in `name-ranking.md`. Seven things not to
redo are in `docs/handoff.md` §3, chief among them that **it is a hook and not a
wrapper** — `useTip` returns handlers, so the DOM is unchanged attribute for
attribute, where `<Tip>` would put an element inside `.mode-chip`'s grid and
`.canvas-modes`'s subgrid; that **placement has no flip in it**, because "away
from the nearer edge" and "the side with more room" are provably the same test
(`r₋ − r₊ = 2y + h − H`) and "flip when it does not fit" would not have fixed
the bug at all — a tip below that switch *fits*, across the timeline; that the
anchor is **measured once**, so `pointerdown` and `keydown` are listened for on
the **window** rather than on the trigger, which is the only way to catch a
press on another element or a keystroke while the pointer sits still; and that
`.control` had to become **`aria-disabled`** rather than `disabled`, because a
disabled button fires no pointer events and the five disabled hints are the most
useful tooltips on the bar.

**The control bar is captioned groups, and on a phone it is one button.** Each
group is a `ModeChip`'s anatomy — small-caps mono caption over a recessed track
— because a reader has to see where the pressable thing starts before reading
any of the words in it, which is the argument the canvas-mode panel already
settled. Four: **Concestor** (the app's mark, the palette under it), **Add
species** (`S` and `R` as *search* and *random*), **Canvas** (fullscreen, clear
and share — everything that acts on the canvas as a whole, with the two one-way
ones kept adjacent at the far right), **Navigate** (fit, isolate, next, second
row).
**Fullscreen is absent rather than disabled where the browser has none**, which
is deliberately the opposite of the bar's own rule: a greyed `fit` says "add a
species and this works" and a greyed fullscreen would say "your browser will
never do this". `FULLSCREEN_AVAILABLE` is asked once at module scope on the
`BIOLUM_AVAILABLE` precedent, and it gates the bar button and the palette row
from the same expression — gating them separately is how an iPhone ends up with
a command for a thing that cannot happen. **Below 620px none of it is drawn** — nor the
mode panel, nor the scale switch — and a 54px circle wearing the same mark sits
bottom right above the timeline, opening the palette. That swap is only
legitimate because of a rule the app already kept: every control has a command,
and the palette's field searches species as well as commands. Seven things not
to redo are in `docs/handoff.md` §3, chief among them that the media block
**must sit at the foot of styles.css** (it hides `.canvas-modes`, declared two
thousand lines lower, and at equal specificity the later rule wins — the first
draft drew a permanently hidden button and nothing else), that `share` **must
not get a row in `bindings.ts`** so `ControlAction` is a union requiring the one
keyless control to carry its own words, that the mark in `BrandMark.tsx` is a
**third copy of the favicon** and is pinned to it by `icons.test.ts`, and that
`TIPPED` is **exactly the bar's `lead` slot** — the outline wraps whole groups,
so a fourth button in either takes it off both.

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

**And the canvas knows the card is on top of it.** `canvas/viewport.ts` gives
two answers because there are two questions. `cardReserve` narrows the width the
fit is computed against and `plotWidth` follows it, so the tree **reframes into
the strip beside the card** by the same path a window resize takes — the plot
shrinks, the fit stays near 1:1, and the labels keep their size instead of being
scaled under `Z_LABEL` until the tree has no names on it. `revealShift` is the
floor under that: the smallest pan that puts the subject back in the clear,
exactly `{0, 0}` when it already is. Five things not to redo: the reserve is
**refused below `MIN_FREE_W`**, because 408px of canvas fits a tree only at a
scale that costs every label; it is **also refused while the reader is off the
fit**, which is why `reserved` is state that lags `cardOpen` rather than a
derived value — taking it re-lays out the tree, and a reader who zoomed into a
corner and clicked a mark did not ask for the whole tree back; the reveal
**never runs on the live transform**, because a reader dragging a mark under the
card is panning and a viewport that pans back is fighting them; **`freeRect` is
not `cardReserve`** — a card refused a reserve is still an opaque panel, and
under 620px it spans the top rather than the right; and the subject is **the
mark and its label**, centred rather than edge-clamped when the two together are
wider than the strip. `viewport.test.ts` pins the card's width, gap and stacking
width to styles.css by reading it, because the failure without that is silent.

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

**A fossil's young end can be a fact about the catalogue rather than the
animal, and `lla` is not always where a taxon may be drawn.** PBDB's
`lastapp_min_ma` aggregates a taxon's whole subtree, so a young end younger
than every descendant's can only rest on material catalogued no finer than the
taxon itself — an `sp.` or an `indet.`. That test is **exact**, not a
heuristic, and it fires on 10,655 taxa. *Stegosaurus* stopped at 93.9 Ma on
**one** occurrence of 86, `Stegosaurus sp.` from the Mussentuchit Member, and
was drawn in the Cenomanian 50 Myr after it lived; *Iguanodon* and
*Megalosaurus* were both at 66.0 Ma on one hedged record each. **The bracket moves as a pair** — `[lea, lla]` are the same
occurrences, so `lea_drawn` travels with `lla_drawn`, and **all three surfaces
that print it must read the corrected pair**: the graft, the card, and phase
4's `occurrence` table (the node-level range). Missing the last put `162–94 Ma`
on the *Stegosaurus* node directly above a graft reading `162–143`. `lla` is
never overwritten — `lla_identified`, `young_end_occs`, `lla_drawn` and
`lea_drawn` carry the reading, on the same principle that keeps `age_ma`/`age_tier`/`age_layout`
apart, and **`lla_drawn` is the only column a mark's x may read.** The card
prints PBDB's range unchanged and says the difference in words. Four things not
to redo, all in `docs/fossil-grafts.md` §3: the **share** of a record identified
to species does not discriminate (*Stegosaurus* is 20.9% identified, like
*Tasmanites*, whose alternative would be a 1,595 Myr error) — **corroboration at
the identified end** does; **ichno- and form taxa are exempt** by PBDB's `I`/`F`
flags, because there a genus-level id is the finest that exists; the correction
**must propagate** or it is defeated one rank up; and the invariant
`lla ≤ lla_drawn ≤ fea` is enforced **per row**, since *Crassispira* is a living
genus whose synonym *Tripia* is an Eocene fossil and 414 rows would otherwise
be dragged to the Holocene. PBDB's aggregate is **not monotone** (440 taxa),
which the first version of that gate assumed. **`fea` is left alone** and is a
different problem: *Stegosaurus* reaches 161.5 Ma because one of its 86
occurrences is logged only as "Late Jurassic", an epoch whose base is 161.5 —
coarse stratigraphic resolution, not a bad ID, and what the faded envelope
already means.

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

**A label is three rows — rank, name, age — and the age row is `age_ma` and
nothing else.** Each row is on its own line, so a label is as wide as its widest
row rather than the sum of them; the age used to ride on the name's line, and on
a left-hand label that line is right-aligned, so the figure took the space
nearest the dot and pushed the *name* away from the thing it names. The age slot
also used to carry a **clock** where a taxon reached the present, and
`caption.test.ts` had already written down why that was wrong: *"'present' is a
position, not a quantity."* That fact now decorates the **mark** — a rounded
arrow into the present, in the dot's own footprint. Five things not to redo, all in `docs/handoff.md` §3:
**a tip has no start date and there is none to find** (`age_ma` is a divergence
age, a tip's own is zero, the stem age belongs to the fork above and is drawn
there, and a PBDB first appearance is the `occurrence` tier — never collapsed to
a point), so a tip prints no figure at all; **do not key the arrow on position** —
the first attempt used the clock's own `age_ma < 0.05` and *Cetacea* and *Homo*
are as alive as *Homo sapiens*, a clade sitting at its **crown age**, and a mark
meaning "this is at x ≈ 0" says what the axis already says; **the tier is the
extinction signal** (`occurrence` is applied only where nothing below the node is
alive), its known limit being an extinct OTT taxon with no occurrence range; the
arrow **rides on chosen taxa and never on a divergence**, because a fork is a
moment and a moment is neither alive nor extinct — the same line `witness.ts`
draws between an exemplar and a witness; and it **takes the dot's footprint**
because the margin to the
right of a terminal mark is where its label goes and on an internal node a mark
beside the dot is drawn along the branch leaving it; and **every row pins its own
font-size and line-height**, because a row is at least as tall as its strut and
one that inherits is one whose height `labels.ts` cannot predict — a row
inheriting `.mark.is-leaf .mark-label`'s 13.5px stood 17.9px against a reserved
15. Relatedly, `labels.ts`'s font constants are pinned to styles.css by a test
that reads the stylesheet: three had drifted, all under-measuring, and `SLACK`
was spending its whole 6% hiding the largest of them.

**Which of those rows a mark draws is the reader's choice, and semantic zoom is
gone.** Three tiers used to decide it from the scale — name at 0.55, age at 0.62
— which is a rule about legibility answering a question about intent: pulling
back to see the whole tree took every name with it, and reading one name meant
zooming until the tree no longer fitted. Two switches replace it, in one panel
bottom-left above the axis with bioluminescence, because the three are one set —
*controls that change how the canvas is drawn rather than what is on it*. They
share a `subgrid` so the key, the caption and the switch line up down the stack;
the caption is small-caps mono and the options sit in a recessed track, because
set alike the caption read as a fourth option. It carries **no border, no fill
and no lit state**, at 0.62 opacity until hovered: it was a bright card brighter
than the tree, and three controls taking the accent to report a *setting* is not
what "the graph is the only light source" means. **Bioluminescence is the one
choice allowed to glow**, in the mode's own cyan, because glowing is what it
does and the chip is the only preview of it.
`labels` is **off · common · scientific** on `L` — **common is the default**,
because the product is for curious people rather than biologists and `Human`
tells a stranger what they are looking at where *Homo sapiens* tells a
specialist what they knew — `ages` is **on · off** on `A`,
and both are held in `sessionStorage` with the light rather than in the URL — a
setting that is a claim about the *reader* may not ride in a link, and a link
made with the labels off would open on a canvas of unnamed dots. Eight things
not to redo, all in `docs/handoff.md` §3. The lesson worth carrying is the **threshold**
rather than the tiers: the age tier sat at 1.15 and the fit lands at 1.144 for
six species, so *adding a sixth species* stripped a row from every label on
screen — nothing load-bearing may hang off a number the fit can wander across,
which is the second time that exact fact has cost this canvas something. The
rank gets **no switch of its own** because it carries `DIVERGENCE_META`, the only
mark saying a derived name is derived, and a control whose only honest setting is
on is not a control. A **common name is served for genus, species and subspecies
only** — above that it names a group rather than a kind of animal and the word
usually belongs to something else, so a fork would be captioned "great apes",
which is naming a clade after its crown group; the rule is enforced in the server
*and* in `markName`, deliberately twice. It is **rank 1 or silence**
(`HeadlineVernaculars`, not `BestVernaculars`): here the common name *replaces*
the scientific one rather than captioning it, so an unranked guess is another
taxon's word in the only slot saying which taxon a mark is, and silence means the
scientific name, which is never wrong. The canvas is a **mixture** in common mode
— 110,794 nodes of 2.7M carry an English name — and `NamePart.rank` being null
for a common run is what sets it roman, which is the only thing telling a reader
which kind of name they have. A **divergence keeps its Latin more often than you
would expect**, and that is `firstNamed` working as designed: it reads the
suppressed run before the leaf so a fork between two genera is not labelled with
two species, and genera rarely have ranked English names. `docs/name-ranking.md`
§7 is the account of the switcher, now shipped.

**A row belongs to a lineage that ends there.** A node with rendered
descendants is drawn *on* the lineage that continues past it, at the midpoint of
its children — even when the reader chose it by name. Rows go out in ascending
`idx`, which is preorder, which puts an **ancestor before every one of its
descendants**, so a chosen clade given a row of its own always took the *first*
row of its own block: choosing Cetacea beside the blue whale and the hippo drew
Cetacea above the whale it contains and Whippomorpha below both. Dropped onto
the lineage, Cetacea is a marked point at 50 Ma on the whale's branch and
Whippomorpha forks above it. Four things not to redo, all in `docs/handoff.md`
§3: **ladderizing by clade size is refused** — rows ascending `idx` are what
make adding a species insert in place rather than permute the canvas, and the
fix needs no reordering; the **one exception** is a branch with no length on the
axis (*Homo sapiens* and *H. s. neanderthalensis* both at `age_layout` 0, drawn
on one pixel joined by a zero-length trace), where the parent keeps a row and
the drop becomes visible — **a row, never an offset in x**; `terminal` in
`labels.ts` is **no longer `isLeaf`**, because a clade on its descendant's line
has that descendant's trace to its right and printed its name along it; and a
**graft's rows go on the far side of its anchor's block from the fork** it
descends from, because a row inserted between the two drags the fork's midpoint
half a row per row inserted and with one graft lands it exactly on the graft's
own line. Separately, `joinX` is held clear of the branch's own vertical: a
fossil older than its whole branch clamps to the branch top, and `xAt` of that
*is* that vertical, so the connector was drawn along the line it is meant to be
distinguished from.

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

**They are all species, and one search answers for both corpora.**
`docs/fossil-grafts.md` §9 is the account and the first thing to read here. The
two catalogues **overlap** — 32,386 accepted PBDB taxa are themselves nodes,
which is `attach_walk = 0`, and *Tyrannosaurus*, *T. rex* and *Stegosaurus* are
all in that set — so "Tyrannosaurus" used to return the same animal twice with
two different futures while *Triceratops*, which the tree has never heard of,
sat under nine orchids and beetles named after it. `store.notInTree` now refuses
`attach_walk = 0` from **both** `SearchFossils` and the fossil pool, on the
merits rather than a preference: phase 4 already wrote the taxon's PBDB bracket
onto the node as its `occurrence` row, so the node carries the dates *and* an
ancestry *and* an MRCA. That costs 8.9% of the accepted corpus, all of it
reachable by the same name as a node, and it is what earns the only sentence a
reader is asked to hold — **a fossil row is a species the tree has no lineage
for.** Not "extinct", which would be wrong about *T. rex*; the badge therefore
reads **"on a branch"**. `store.Interleave` ranks the two lists into one order
server-side (band, then position in the row's own corpus, then node-before-
fossil as the *last* tiebreak) and stamps every pickable row with `order`; the
client sorts on that integer, which is reading a rank rather than computing one.
`⇧R` is gone and unbound — `R` rolls a die, 20% fossil, falling through to a
species in silence.

**The draw is the client's, and `/v1/random` is gone with it.** `R` used to ask
the server, which meant it could not know what was already on the canvas — so it
over-asked twelve candidates and threw eleven away — and its answer could not be
cached, which made it the **only** `no-store` response on `/v1` and the reason
`writeVolatileJSON` and `getFresh` existed. Measured against production it was
also the most expensive endpoint in the app by an order of magnitude: **1.19–1.51 s**
for a species and up to **2.45 s** for a fossil, against 49 ms for a search and
39 ms for a path, because both draws are full scans and both ran per press. The
167 ms in `deployment.md` §1 was taken on the pipeline machine, and `standard-1`
is half a vCPU — **the same trap that hid the unindexed `fossil` scan inside
`/v1/search`, and the second time it has cost this project an endpoint.** Now
`GET /v1/random-pool/{build_id}` serves both pools as bare id lists — 13,918
node indices and 1,935 fossil taxon numbers, 114 KB of JSON, 21 KB brotli — the
scans run once per process behind a mutex, and the client picks with
`corpora.pickFrom` and then fetches the one taxon it drew from an immutable URL.
Five things not to redo, all in `docs/handoff.md` §3: the **build id is in the
path** because an index means nothing across builds and this response is held a
year at the edge, so a stale one is refused **404 with `no-store`** rather than
answered with the current pool — answering would file build B's list under build
A's URL for everyone still on A, and a bare 404 is heuristically cacheable and
would outlive the deploy that caused it; the pool ships **the resolved list and
never the rule**, the same line `Interleave` draws by stamping `order`; the
scans are **warmed in a background goroutine at startup**, which is neither of
the two obvious answers — on the request they land on the press a reader is
waiting on (29.9 s on a freshly provisioned container), and inside `Store.Open`
they land in front of every request the container has not answered yet,
including the first *search*; and the exclusion now happens **before** the
choice, which is why there is no `RANDOM_CANDIDATES` to get wrong and why
"every pick is already on the canvas" stopped being reachable.

**The boot probe was answering about the wrong server.** `ping()` fetched
`/healthz`, which exists on the Go mux and nowhere else — `run_worker_first`
covers `/v1/*` and `not_found_handling: single-page-application` answers
everything else with `index.html`, and vite's fallback does the same — so it
read `res.ok` off the app's own HTML shell and reported the API healthy whether
or not it was running. Verified against production: `200`, `content-type:
text/html`. It worked only in the mode it was written in, the Go binary serving
both halves on one origin, and the consequence is that the boot-error screen was
**unreachable in production for its entire life**, which is why its copy told a
reader on the web to run `go run ./server`. `/v1/about` is the probe now, and it
is also the **warm-up**: it is `max-age=60, must-revalidate` rather than
immutable precisely so it reaches the container on every boot, so it is what
wakes a sleeping one — asking it first rather than second starts that a round
trip earlier. Shortening that lifetime, or making it immutable, silently removes
the warm-up along with the freshness. A graft selects like a node:
same click, same `sel=`, and `pbdb108454` cannot collide with an OTT id. Its
card is not the node card with fields blanked — it has no age, no tip count and
no ancestry, and it is where the PhyloPic credit finally lives. That credit was
blank at first because the server sends `creator`/`uploader` while every card
reads `attribution`/`contributor`; `normalise()` was doing that rename for
`/v1/node/` alone.

**Fossil names are indexed, and the figure that said they needn't be was
wrong.** `SearchFossils` was a full scan of the 523,112-row table, accepted at a
measured ~40 ms. Through the serving binary it is **100–117 ms** and flat
against match count — `zzzqqq` costs 100 ms — which made it **~90%** of
`/v1/search`, everything else in the endpoint being 0.02–11 ms. And the figure
came from a laptop: production is a `standard-1` container with **half a
vCPU**, which is the whole of why search felt fine locally and slow deployed.
Phase 6 now builds `fossil_fts` (18 MB, 1.0 s) and the same queries cost
0.1–15 ms. Four things not to redo, all in `docs/fossil-grafts.md` §7: the
index covers **every** row because `notInTree`'s filter is a serving policy and
an index encoding it goes wrong silently the day the policy changes; the rowid
is a `pbdb_taxon_no` and `verifyFossilFTS` **proves** it by sampling both ends
of the keyspace, because this is the `node_fts.rowid` trap and a wrong key
there joins cleanly and describes a different animal; that proof must go
through `MATCH`, since the index is `content=''` and a join-and-compare gate
reads NULL and passes on a corrupted index — both the gate and the probe were
written that way first; and the index **narrows** recall, dropping the mid-word
substring matches (*Eotriceratops* for "triceratops"), which is safe only
because `matchBand` already scores those `bandNone` and `Interleave` ranks them
behind every node. Separately, `lower()` came off the column in both paths: the
corpus has **zero** non-ASCII names and SQLite's LIKE is already
case-insensitive over ASCII, so it was a call and an allocation per row, worth
30% of the fallback scan.

**And a superseded search is now cancelled.** The palette's 110 ms debounce only
ever stopped a request being *sent*; one already in flight ran to completion and
had its answer thrown away. With `max_instances: 1` that is not idle waiting —
it is a full search's worth of the only half-vCPU there is, taken from the
keystroke the reader is actually waiting on. `api.get` takes an `AbortSignal`
and the palette aborts on cleanup. Two things worth knowing: the signal cancels
only a request **this call started**, never one it joined from the memo cache,
because a cache hit is somebody else's request already paid for; and no new
error path was needed, since every branch below the `await` was already guarded
by `cancelled`.

**A row can say which name got it there**, and only for a synonym.
`matched_name` rides alongside `matched_on` from `searchFTS`, tracked in
lockstep with `kinds` so the two can never credit different names, and is
omitted where the row already prints the string. It exists for the worst pair in
the corpus: OTT files *Homo floresiensis* as a synonym of *Homo sapiens*, so
without it the reader types a real hominin and is silently handed us. A `name`
or `vernacular` match is already lit by `litRanges`, and an abbreviation repeats
the same line down all eight rows of "T. rex" without distinguishing any of
them — so neither is captioned.

**A typo is forgiven, and a missing name is not — they are two problems and
only one of them is spelling.** Eighteen real queries pulled from Workers Logs
and replayed gave 47 settled strings, 8 of them empty. `ardvark` and `betual`
are typos; **`hard maple` is a correctly spelled English name for *Acer
saccharum* that the corpus does not carry**, 3–4 edits from anything real, and
no threshold may reach it — conflating the two is how you ship fuzzy matching,
watch `hard maple` still fail, and loosen the cap until search is useless. So:
**correct the query, never relax the matcher.** `/v1/search` is untouched; only
when the answer is one `store.Answer.Weak` calls no good does `store.Suggest`
run, and then the unchanged search runs again on the corrected string.
`spelling.py` builds the recall half — a phonetic key per distinct word across both catalogues, 1.25M
rows and 50.6 MB — and Go ranks the handful that share a key by
Damerau distance. Eight things not to redo are in `docs/handoff.md` §3, chief
among them that **`hard maple` is refused by the key rather than by the
threshold** (`hrd mpl` against `sgr mpl`, so it yields no candidates at all and
the distance code never runs — a design where the cap is the only guard is one
where raising the cap reaches a wrong answer); that **Double Metaphone was
refused because the key exists in two languages** and a disagreement between
them returns an empty bucket, which is indistinguishable from a word nobody
misspelled, so the key is fifteen lines scoring 19/20 where plain vowel-dropping
scores 16/20, pinned by a Go test that recomputes sampled rows out of the built
table; that **every further English sound rule was measured and refused** —
folding `z` and `q` puts this project's own benchmark string `zzzqqq` in a
bucket with 69 candidates; that the unit is the **word** and not the whole name,
which is 7× the index (362 MB) and cannot fix `betual pendula` at all, since
with typeahead the typo that kills a query is always the leading one; that the
**six-character floor** is where all the precision lives, taking the
false-correction rate on random junk from 25.3% to 0.5%; and that it is
**Damerau** rather than Levenshtein, because under plain Levenshtein `betual` is
equidistant from `betula` and `betel` and the shorter string wins. The
correction is **shown, never performed** — the same rule as `age_tier`, on a
different surface.

**The gate in front of it was `no rows at all`, and that gate assumed something
false.** Over 2.3M names plus 523k fossil taxa a typo almost never returns
nothing: `elefant` returns *one* row, a single-celled ciliate reached through
the synonym *Paradileptus elefantinus*, so the list was not empty and the
correction was silently suppressed. `Answer.Weak` is the gate asked properly —
**nothing matched as a whole word, and there are no more than eight rows** — and
the empty list is the bottom of that scale rather than a case beside it. Both
halves are load-bearing and the second is the one that is not obvious: a prefix
match *is* what typeahead means, so band alone fires on every second keystroke.
Measured over 870 prefixes of real corpus words, the weak ones never return
fewer than a **full page**, so not one of them reaches the corrector and the
half-vCPU argument survives intact; the bounds are `elefant` (1 row), `cheeta`
(4) and `mamal` (6) on one side and `tyrannosau` (10 rows, whose only correction
is the reader's own prefix truncated) on the other. Four things not to redo,
in `docs/handoff.md` §3: **a weak answer is offered a spelling and never
substituted for** — `corrected` and `suggested` are separate fields because
mid-word the two are indistinguishable and taking a reader's own rows away is
destructive where merely being wrong is not; the guard is now a **strictly
better band** rather than "it returned something"; refusing a suggestion that is
a **prefix relative** of the query was measured and refused, because it kills
`cheeta`→`cheetah`; and **`mamal` is still not corrected** — five characters,
under the six-character floor, which is the matcher and stays where it is.
Separately, **`ph`→`f` has to be folded in the distance as well as the key**, or
it does nothing: the key put `elefant` in `elephant`'s bucket and the raw
distance then charged two edits over a cap of one. `dolfin` used to reach
*dolfyn*.

**The species palette opens on a list now, and the list is species rather than
openings.** `S` used to open on one grey line — *Type to search 110,794
species* — which names the size of the corpus and nothing a reader can act on;
a blank field already asks for the right word and the confidence it will work,
and a count is the number of ways to be wrong. It opens on **Recent** over
**Start here** — ten curated taxa, each an ordinary `RowView` one press from the
canvas, so arrow keys, `↵ add` and the *on canvas* accessory all work by
construction. **An opening may not go here** and `openings.ts`'s refusal still
holds: an opening *replaces* the canvas where every palette row *adds*, so a row
that silently destroys the reader's tree would be indistinguishable from its
neighbours. **The client says which and the server says what they are** —
`palette/starters.ts` holds keys and nothing else, because name, rank, tip count
and silhouette are facts about the deployed build and a baked `idx` resolves
cleanly against a rebuild and describes a different animal. `/v1/hits?keys=`
dresses them, **skipping unknown keys** so one silently-forwarded OTT id costs
one row rather than the whole empty state, and sharing `batchKeys` and its
200-key cap with `/v1/paths`. It is a pure function of the key set and the
build, so it takes the ordinary long-lived `Cache-Control` and ETag — one fixed
URL, one edge entry, the container answering about once per Worker version —
and it is **prefetched on boot** beside `/v1/about`, 3.4 KB, under 1 ms at the
origin, with nothing added to `worker/index.ts`. Recents are `localStorage`
where the canvas *modes* are `sessionStorage`, and the precedent is
**`fuzzy.ts`, which has stored a recency-and-frequency table there since the
palette got its ranking** — this is the visible half of a thing the app already
did, not an exception to be argued. It stores *whole rows* so the band draws
with no request, which is why the blob carries the build id and is dropped whole
on a mismatch. **Both stores are cleared by one command**, and that is a
correctness point rather than a courtesy: "Reset search ranking / Forget
recency and frequency history" predates this band and would have cleared the
invisible half while a list captioned **Recent** sat on screen — the store the
reader can see is the one that must not survive a command that says it forgets.
It is now *Clear search history*, `resetUsage` and `forgetRecent` together, with
the command id unchanged because `sessionBoost` is keyed on it. **The curated
list is gated in Go against
the real database**: `hits_test.go` reads the TypeScript and requires a name, a
rank-1 English common name and `node_image.climb = 0`, which is the only place
those can be checked — phase 5 gives every node an image by climbing and
`hitSilhouette` ships with suppression at infinity, so a borrowed drawing
renders happily and belongs to something else. That rejected three taxa
`openings.ts` uses successfully (**cremini**, **horse ant**, and a cockroach
with no common name), because a carousel tile captions its own drawing and a
palette row does not. `docs/handoff.md` §3 has the rest, including why breadth
beat recognisability and why the lion was cut.

**Four things measure readership and they disagree by design, so a single
number is always wrong.** Same three days, same site: the zone log says 237
unique IPs, Workers Logs says 52 reached the Worker and 22 drew a tree, Web
Analytics says 83 visits, and the beacon says 20 sessions. None is the truth
and each fails in a different direction — **the edge counts scanners as
readers** (`/.env` was fetched 28 times, and `/v1/about` is a single well-known
URL that scanners probe by name, so it is *not* a proxy for "the app loaded" —
26 of its 38 addresses were datacenter), **Workers Logs is blind to every cache
hit**, **RUM's beacon is a third-party script that any content blocker drops**,
and **the beacon only exists once somebody acts**. That third one is the bias
to hold onto: the reader most likely to block `static.cloudflareinsights.com`
is the curious tinkerer this product is for, and on 2026-08-04 the single most
engaged outside reader was invisible to RUM while fully visible in the request
log. Report a range and say which instrument produced it. `docs/handoff.md` §3
has the five things not to redo, chief among them that comparing unique-IP
counts across paths also measures URL cardinality, because a cached path stops
invoking the Worker. **Reading any of it needs no credential this repository
holds** — Cloudflare's own MCP servers carry their own OAuth, and
`cloudflare-api`'s `execute` tool reaches any REST or GraphQL endpoint,
including the RUM datasets that refuse the wrangler token. The one thing that
still needs the wrangler token is `scripts/analytics-report.sh`, and only
because resolving a key to *Apis mellifera* needs the 1.9 GB local database that
no hosted dashboard can join against.

`concestor-build package` gates the artifact set as a whole and writes
`build/manifest.json`, which `/v1/about` serves. It refuses to package while any
phase's own gates record a failure. Every phase is green as of this writing, so
it should be re-run after any pipeline change rather than assumed stale.
