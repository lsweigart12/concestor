# Handoff — current state

Last updated 2026-08-02. This is the living state document: it should read as
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
the only light source, operated from a `P` command palette, phosphor-persistence
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

That line has since lost its units and gained a control: the right end is one
word, `logarithmic` or `linear`, and clicking it toggles the scale. The units
were carried by every tick and every dated node already; that there is a second
scale was carried nowhere. The top edge is now a bar of **buttons** rather than
a hint — see design-reference.md's command surface — and the split by edge is
what survived unchanged.

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
| 3 — resolution | built — `resolve.py`, `xref` populated, **56/56 gates**. A disagreement sweep withdraws 17,068 cross-kingdom homonyms (§5) |
| 4 — fossils | built — `fossils.py`, **39/39 gates**, `fossil` table populated |
| 5a — images | built — `images.py`, **39/39 gates**. Coverage is 100% and says nothing; the gate is the size of the clade a picture speaks for. Divergences carry a second silhouette, the fossil witness, now on 885 forks (§5) |
| 5b — timescale | built — `timescale.py`, 26/26 gates, `build/timescale.json` |
| 6 — vernaculars | built — `vernaculars.py` + `search.py`, `node_fts` live. `search.py` also builds `fossil_fts`, which ended the full scan behind `/v1/search` (§2, [fossil-grafts.md §7](fossil-grafts.md)) |
| 6b — name ranking | built — `name_rank.py`, **31/31 gates**, `usage_rank` live. A taxon's names in the order people use them, measured against English Wikipedia's title and redirect graph. Moved 7,958 headline names and gave an order to the 26,262 nodes that had none. [name-ranking.md](name-ranking.md) |
| walking-skeleton renderer | done, throwaway, superseded |
| serving binary | **built, in Go** — `server/`, every endpoint live. [serving-binary.md](serving-binary.md) |
| real UI | **built** — `web/`, React + xyflow v12. The signature interaction works end to end. Fossils are drawn *in* the tree as client-side grafts, searchable and selectable — [fossil-grafts.md](fossil-grafts.md) |

Everything in `ingest.md` is now implemented. What remains is depth and polish,
not new machinery — see §7 for the honest list of what is thin.

> **The current artifact set is `67630b66a5d425ca`, and it is the first with
> `fossil_fts` in it.** That index ended the full scan of the 523,112-row
> `fossil` table behind `/v1/search` — about 90% of the endpoint, 100–117 ms
> flat against match count, and several times worse in production than on the
> machine it was measured on, because the container is a `standard-1` with
> **half a vCPU**. The same queries now cost 0.1–15 ms. Two smaller changes rode
> with it: `lower()` came off the fallback scan's column (30%), and the palette
> aborts superseded requests instead of paying for answers it discards.
> [fossil-grafts.md §7](fossil-grafts.md) is the account.
>
> **The same trap then took a second endpoint.** `/v1/random` measured 167 ms on
> the pipeline machine and **1.19–1.51 s in production**, two full scans behind
> `ORDER BY random()` per press, which made it the most expensive thing in the
> app by 10–30×. It is deleted: `/v1/random-pool/{build_id}` serves the two
> pools once per container process, the client draws, and the API's only
> uncacheable response went with it. §3 is the account. Where a figure in these
> docs was taken locally on a CPU-bound path, assume it is a lower bound.
>
> **Rebuilding it is `uv run concestor-build search` then `concestor-build
> package`, and it takes about a minute** — but do not run it against
> `build/concestor.db` while anything is serving from it. Every worktree
> symlinks `build/` to the main checkout's, `search.py` drops and rebuilds
> `node_fts`, and there were three live servers on it at the time. Build into a
> staging directory (point the worktree's `build` symlink at it; `paths.py`
> resolves through the link) and `mv` the finished database into place —
> `rename(2)` is atomic, so a running server keeps its open inode and keeps
> answering until it restarts.

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
scripts/dev.sh      # Vite with hot reload, backed by its own API, :5173
```

That is the `concestor` configuration in `.claude/launch.json`, so the preview
browser and any agent start the app the same way. Vite serves the frontend from
source and proxies `/v1` to an API the script starts itself on a private port,
so it never depends on the other entry already running — and, being served from
source, it cannot show a stale frontend.

`scripts/serve.sh` is the `concestor-built` configuration: API and built
frontend in one Go process on :8080. Run it before merging, and for anything
touching asset loading or analytics, since Vite serves transformed modules
rather than the shipped chunks and under `dev.sh` the beacon `404`s. It verifies
the artifacts exist first, rather than serving a blank canvas that looks
identical to a broken one, and it **rebuilds `web/dist` whenever an input is
newer than the bundle** — `web/src`, `public`, `index.html`, `package.json`,
`package-lock.json`, `vite.config.ts` and `tsconfig.json`, enumerated because
`node_modules` and `dist` sit in the same directory. It used to rebuild only
when `web/dist` was *missing*, on the reasoning that recompiling every launch
hides staleness; nothing implemented the other half, so it neither recompiled
nor reported, and an hour-old bundle was served in silence. That produced a bug
report against `title` attributes the source had already stopped emitting and
`web/src/chrome/tip.test.ts` forbids. Rebuilding rather than warning, because
the build is 0.4–0.6 s cold — TypeScript 7 is the native compiler — and a
warning above a server's own startup output is a warning nobody reads.

Both configurations set `autoPort`, and both scripts run unchanged inside a
git worktree — see [worktrees.md](worktrees.md). That matters because every
parallel Claude Code session gets its own worktree, and a worktree has the
source but none of `build/`, `snapshot/` or `node_modules`.

**Restart it after any pipeline run** — the arrays are mmap'd and SQLite is
opened at startup, so a running server serves the previous build and the only
symptom is quietly stale answers.

```bash
cd web && npm install && npm run build   # the server picks up web/dist
npm test                                 # 632 tests, in two vitest projects
npm test -- --project=dom                # just the ones that render components
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
uv run concestor-build names       # phase 6b; ranks common names, AFTER vernaculars
uv run concestor-build search      # FTS index; must run AFTER vernaculars
uv run concestor-build render      # throwaway skeleton, still useful as an oracle
```

Order matters in four places. `search` and `names` both read the `vernacular`
table, and are independent of each other — `names` writes order and evidence
onto rows `search` does not read;
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

### The empty canvas asks a question, and every opening is a triple

`web/src/openings.ts` is fifteen pre-built selections, offered by the empty
canvas and by `NextOpening` at the end of one. It replaced
*"press S and search for two species"*, which asked for the one thing a curious
reader does not have — two species, chosen, for a reason — and then described
the mechanism (*the smallest tree that connects them*) rather than the payoff.

**No opening is a pair, and that is the design rather than a preference.** A
pair draws one number; three or more draw an *argument*, because the nesting is
the proof and needs no reading. "Are you a fish?" seeds you, a salmon, a shark,
a sea star and a jellyfish, joining in four rungs outward — Euteleostomi ≤ 455,
Gnathostomata ≤ 491, Deuterostomia ≤ 628, and Bilateria / Cnidaria ≤ 719 Ma.
You meet the salmon before the shark meets either of you, so any group holding
both fish holds you.

**An earlier cut ran this through a coelacanth**, which is the cleaner
cladistics and the worse hook: it is a fish almost nobody can picture, and OTT
headlines it *Gombessa*, so the canvas captioned the crux of the argument with a
word the reader has never seen. Salmon and shark carry it unaided.

**The two invertebrates are a ruler, not decoration.** Without them the picture
is one tight cluster with nothing to be tight against, and 455 against 491 Ma
does not read as *near*. They are not free: the deepest sets `maxAge`, so on the
linear axis the rung that matters is 5.0% of the plot width with both against
7.3% with neither, and the four gaps run 5.0 / 19.2 / 12.6%. Fifty-odd pixels is
worth the contrast; **re-measure before adding a fifth rung.** Neither outgroup
is named in the copy — a thing visibly alone on the canvas needs no caption.

**Pick a silhouette by looking at it at 30px, not by picking the species.** The
jelly was *Aurelia aurita* and is now *Pelagia noctiluca*; both are Scyphozoa
and both give the identical MRCA, so nothing measured above moved. PhyloPic
draws *Aurelia* from **above** — a radial starburst that reads as a flower at
the size these are actually shown, and reads as a *second sea star* beside the
one already in that opening. Most of the corpus is drawn to be read large:
*Cyanea* and both other *Chrysaora* are profile views hanging on hairline
tentacles that dissolve to grey fuzz. The mauve stinger has a solid bell and
four thick separated tentacles, which is the whole of why it was chosen.

Four things not to redo:

- **The copy claims relationships, never dates**, and `openings.test.ts`
  enforces it with a regex. Ages are tiered, so prose promising "1.1 billion
  years" beside a canvas drawing `≤ 1314.8 Ma` would make the app contradict
  itself on the one axis it exists to be careful about. Branching order is
  exact; let the axis carry the figures.
- ***"T. rex lived closer to us than to Stegosaurus" is out, and the data is not
  why.*** It was cut once as genuinely false — *Stegosaurus*'s last appearance
  read 93.9 Ma, so the gap was 27.9 against 66 — which was the `sp.`
  contamination §"A fossil's young end" describes. That is fixed: on `lla_drawn`
  143.1 against *T. rex*'s uncorrected 66.0 the gap is 77.1 against 66.0 and the
  claim is **true**. It was built, verified on build `45ada2238ded2c93`, and
  **removed anyway** — it is a comparison of two species' *ages*, not a claim
  about phylogeny, and §1 puts the time axis behind identifying an MRCA and
  drawing the tree. It also draws badly: three dots along one line, with none of
  the nesting that makes the others readable at a glance. **Do not re-derive
  it** — the data supports it and the product does not, and those are different
  questions. The near miss is worth keeping though: it is true on `lla_drawn`
  and false on raw `lla`, which still carries PBDB's own 93.9 by design. A claim
  here is only as stable as the column it rests on.
- **`tree.open()` nulls `prevInduced` and `lastCount`.** An opening replaces the
  canvas and its paths arrive one at a time, so leaving those refs on the old
  tree makes each intermediate `addDelta` compute draw-waves against a baseline
  that is neither tree. Nodes land in waves whose turn never comes and their
  traces stay at zero opacity — marks and labels draw, branches do not. Nulling
  both puts it on the cold-load path, which is the one that renders.
- **`text-align` belongs on `.opening`, not `.openings`.** A `button` takes
  `center` from the user-agent sheet and inherits nothing, so the first cut left
  six centred paragraphs that read as prose rather than as a menu.

`showAbout` and `showCredits` were two five-second toasts — one printing a build
id, one a licence paragraph too long to finish before it vanished. They became
one modal, and the modal is now **a page at `/about`** —
`web/src/chrome/AboutPage.tsx`, with `web/src/route.ts` beside it.

**A modal was the right shape for the question it used to answer and the wrong
shape for the one it answers now.** *What do the dashes mean* is asked while
looking at the canvas, is wanted for a moment, and is about something still on
screen behind the dialog. *What is this and why would I use it* is asked by
somebody who has not used the app, and that reader wants room, headings they can
scan, and an address they can send to a colleague. A dialog gives none of those
and takes the canvas hostage while failing to.

**The split is at the root, and it has to be.** `main.tsx` mounts `App` **or**
`AboutPage`, never both. The store writes `encode(view)` on every view change
and compares it against `search || pathname`; on `/about` the search is empty
and the pathname is not `/`, so a store mounted alongside the page would
`replaceState` the reader onto `/` on its first pass and the page would vanish
under a canvas. Unmounted, the store has no opinion about the address bar.

**It leads with a claim, not a description**, and `.hero-claim` is the only text
above the fold carrying `--ink`. The line is *"The fastest way to a phylogenetic
tree worth showing someone."* What it replaced — "pick any two species and see
where their lineages meet" — was accurate, is what the empty canvas already
says, and answered *what does this do* without ever answering *why would I open
it*. A reader scanning a page stops on the brightest thing, and the brightest
thing should be the sentence that says why they would use it. The etymology
drops to the footer.

**Everything below the hero is a list or a card.** The first cut was six
sections of running prose; every sentence was true and load-bearing and it was
still unreadable, because an about page is *scanned* and **prose hides its own
index**. `What it draws` is six feature cards in an `auto-fit` grid and `Where
this comes from` is a list where each item leads with the thing it is about. No
*claim* was cut for length — the two witness fossils, the `Ivesia` collision and
the 16,833 withdrawn matches all survive, because a claim a reader cannot check
is a slogan.

**`Reading the tree` was cut whole, and it is the one deletion worth
defending.** Three items — dashed means unestimated, `≤` means upper bound, no
figure means no defensible one. Every one is true and load-bearing, and every
one is **already on the canvas**: `Legend.tsx` derives exactly those rows from
the edges actually drawn, renders its swatches with the real `.trace-core`
classes, and says them where a reader is looking at the thing they describe. A
second copy on a page the reader is not on could only go stale against it. This
does not weaken the honesty rule; it stops stating it twice in two places that
can disagree.

**The column is a layout width, and each run of prose carries its own measure.**
It was `65ch` on `.page-body` alone, which is a reading measure standing in for a
layout, and on a large monitor the difference showed: 573px of content centred in
1920, under a strip of drawings running the full width, with the feature cards
pinned at the 260px floor `auto-fit` will not go below. A 3× mismatch between the
widest thing on the page and the column under it does not read as a comfortable
measure; it reads as a broken one. `.page` now carries `--page-w: 62rem` and
`.page-bar`, `.page-body` and the footer all hang off it, so the way back sits
over the first word of the hero instead of in the viewport's corner half a screen
away. Three things decided it:

- **62rem is chosen by the feature grid, not by taste.** 960px of content divides
  three ways at the grid's own 260px floor and not four, so six cards are two full
  rows; a wider column gives four and leaves a row of two hanging.
- **A measure that stayed on the container silently stops working when the
  container becomes a layout.** `.page-list` went to `auto-fit` with a 28rem
  floor — two columns of ~65 characters where the page has room for two, one
  below — and a floor has to leave room for *two* of itself inside `--page-w` or
  it buys nothing: at 34rem the pair wanted 1112px of 960 and the list stayed
  single at full width, the 140-character line the rule exists to prevent. The
  cap that keeps a *single* column readable is on the `li` (34rem), because a
  `1fr` track fills whatever it is handed and between one column and two — a
  768px tablet — that track is 721px.
- **The hero claim has a display measure of its own (28ch).** Across the full
  62rem the sentence fits *once*, in a single 900px run, which is the one shape a
  claim must not take: the eye travels the whole page width to read the thing it
  stopped on. The clamp's cap rose 34 → 38px with the extra room.

`Where this comes from` names **the joins rather than the sources** — a
chronogram matched clade by clade, PBDB homonyms refused on an extancy
disagreement, a silhouette carrying the size of its own claim, names ordered by
Wikipedia's redirect graph. A list of seven databases says nothing a reader
could not guess; what is hard here is what happens between them.

Five things not to redo:

- **`body` is `overflow: hidden` and `#root` is `height: 100%`**, which is right
  for an instrument that pans and fatal for a document. At `min-height`, `.page`
  grows past `#root` and is clipped by the body: it renders correctly, reports a
  `scrollHeight` equal to its own height, and **nothing below the fold can be
  reached by any means**. It reads as a rendering bug and is a containing-block
  one. `.page` takes `height: 100%` and owns its own scroll, which is also what
  `.page-bar`'s `position: sticky` resolves against. Releasing the body's lock
  per route instead would put two documents' scrolling in one global.
- **`routeOf` matches the whole path, never a prefix.** A `startsWith` passes
  every obvious test and silently routes `/about-the-data` and every future
  path beginning with those six characters. Trailing slashes are tolerated
  because a server that canonicalises, or a person typing, will produce one.
  `route.test.ts` pins both directions.
- **`leaveAbout` is not unconditionally `history.back()`.** Back is right for a
  reader who pushed `/about` from inside the app — that entry holds the
  selection, axis and drill lane `/` cannot reconstruct — and sends a reader who
  opened a shared `/about` link **off the site**. A `sessionStorage` flag set at
  the push decides, and its absence falls through to a plain navigation to `/`.
- **Leaving the tree unmounts it, and that is affordable only because
  `api.ts`'s cache is a module singleton** that outlives the component tree.
  Coming back re-reads the URL and rebuilds from paths already in memory.
  Verified: back from `/about` restores `?n=…&sel=…` with its marks and its card.
- **An opening is now reachable from the empty canvas and from the end of
  another opening, and nowhere else.** The panel used to be a standing second
  route. A reader who assembles a tree by hand and never presses one has to
  clear the canvas to find them. Accepted; if it matters, the fix is a route
  from a *built* canvas, not a carousel on the about page.
- **The hero's strip is a marquee, and the pair `two copies` / `-50%` is what
  makes it seamless.** At the end of a cycle the second copy sits exactly where
  the first began, so there is no seam to time; any other distance leaves one,
  and it is the kind that shows up once a minute and reads as a page stutter.
  The pool is **every drawing the openings use, deduplicated** — borrowed rather
  than chosen because each passed `openings.ts`'s thirty-pixel test, which that
  file records as having rejected more candidates than every other rule
  combined. A fixed row of five said *five animals*; a strip that never runs out
  says *the tree of life*, which is what the sentence above it claims.
- **Full-bleed costs `.page` an `overflow-x: hidden`.** `100vw` includes the
  scrollbar, so the `calc(50% - 50vw)` break-out adds a horizontal scrollbar on
  every browser that reserves one. And `.silhouette` carries a
  `margin-right: 10px` for its palette slot, which compounds with the flex gap
  into a visible wobble in something moving — zeroed in the track.
- **`.about-p` is gone with the prose.** `.about-list` carries the same size,
  leading and ink it had; if a paragraph is ever wanted back on this surface it
  wants those three values and not new ones.

**One opening at a time**, in `chrome/OpeningCarousel.tsx`. Every question and
answer at once was a wall of prose on a surface whose whole argument is that the
graph is the only thing worth looking at. The silhouettes carry what the deleted
text was carrying: `OpeningTaxon.art` is a PhyloPic id rendered straight off
`/v1/silhouette/{id}.svg`, so the preview needs no API round trip before the
canvas holds anything.

**`autoRotate` now has one caller and keeps its opt-out.** It defaults on, which
is what the canvas — the only place the carousel renders — wants. Nothing passes
`false` any more; the prop stays because the reason it existed still holds if
the carousel ever lands on a reading surface again: text sliding above the
paragraph you are on is
the exact behaviour that gives carousels their reputation, and hover-to-pause
does not save it, because that only holds while the pointer is over the
carousel.

**Auto-rotation is otherwise the part that needed care.** Three more rules, none
optional: hover or focus anywhere in the card stops it; any manual press stops it
*for good* rather than on a timer; `prefers-reduced-motion` disables it and the
fade outright. And it is never the only route — arrows and dots reach each one
directly.

**The palette does not carry the openings at all**, and the reason is what makes
them different from every other command. An opening is not additive: `tree.open`
*replaces* the selection, the fossils and the axis, because its claim is only
true of its own taxa. Offered against a tree somebody has spent time assembling,
"Are you a fish?" is an undo-less clear wearing the label of a question —
sitting one fuzzy match away from the species they were reaching for. The first
fix was a `Start here` section hidden once anything was drawn, which made the
rule safe without making it coherent: a section that appears and disappears is a
list nobody can learn, and on the one surface where it *was* shown — the empty
canvas — the carousel was already offering the same questions, larger and with
their silhouettes. So the section is gone. The about panel used to be the
standing second route and no longer is; `NextOpening` is, and it appears exactly
where the reader has just finished one.

### The palette hides what would do nothing, and pins what nobody is asking for

Two rules, both about the same failure: a row that answers a press with no
visible change teaches the reader that this list is unreliable.

**`TAIL_SECTIONS` pins `Fossils` and then `About` to the bottom.** The about
section *climbed*, and climbed precisely because it is useful once — sections
float on their best row's score, `sessionBoost` adds to whatever has been
pressed before, so opening the panel twice parked credits and the ranking reset
above Fit and Species for the rest of the session. They stay findable: type
"about" and every other section stops matching. `ABOUT_SECTION` is exported
from `Palette.tsx` and imported by `App.tsx` so the string cannot drift.

**`Fit all` is absent while the canvas already shows the fit**, and the control
bar's button says *"The whole tree is already framed"* rather than going quiet.
`Graph.reportFit` **asks the viewport** instead of remembering a flag, and that
is the part worth keeping: the tree reframes itself on an add and on a lane
opening, and the target moves on a window resize, so a flag set at the last
`fitToContent` is stale after any of them. `fitTarget()` is the same
computation `fitToContent` applies, compared against the live transform within
1.5px and half a percent of zoom — the animated fit lands a hair off its own
target, and an exact test reports "not fit" immediately after fitting.

It runs on `onMoveEnd` and on layout change, **never per frame**. React Flow
pans by transform without re-rendering subscribers, so taking a viewport
subscription to keep a palette row current would trade a smooth drag for it.
The palette is opened between gestures, not during one.

Two structural notes. **`Opening.taxa` is one list of `{key, art, label}`, not
parallel arrays** — a drifted pair shows a salmon captioned as a shark and
nothing throws, and `openings.test.ts` additionally refuses a repeated drawing
inside one opening. And **the carousel card is keyed on `opening.id`**, so React
swaps the subtree rather than mutating it; without the key the outgoing
silhouettes linger under the incoming text for a frame and read as a glitch.

This put `design-reference.md`'s "no onboarding overlays or empty-state
illustrations — the palette is the empty state" out of date, and that line has
been rewritten rather than quietly broken: the bar it now sets is that
everything on an empty canvas must be a live control over real data.

### The time axis defaults to linear

Symlog is still the better *instrument* and `symlogFrac` is unchanged — it
remains the only scale that can hold 6.7 Ma and 1.3 Ga on one canvas. It is no
longer the default, and the reason is the audience rather than the geometry.

**Linear is the honest one about scale.** Log flatters recent divergences: it
gives human-and-chimp a share of the width comparable to eukaryotes when the
true ratio is nearer 1:200. Deep time being genuinely that vast is what this app
is for, so the crushing is the message and not a defect. A log axis is also a
specialist convention, and this is a product for curious people (§1).

It suits the openings too, and for a structural reason worth keeping: **a
comparison is only interesting when its two ages are close, which is exactly
when symlog collapses them.** The fish rungs at 409/455/491 Ma span 2.9% of the
log portion against 16.7% linear.

Three things to know before touching it:

- **`encode` and `decode` each name the non-default axis, in opposite
  directions.** Flipping the default means editing both, and getting one is
  silent: every shared link either carries a redundant `axis=` or drops the
  caller's choice. `state/store.test.ts` pins the pair.
- **`Opening.axis` overrides per opening**, and exactly one uses it. The
  chimp-and-rat comparison is the only one whose ages span an order of magnitude
  — 6.7, 21.7, and ~83 where the two pairs join — so linear sets the axis by
  that last number and crushes both comparisons into the right quarter.
- **The axis command's copy was rewritten.** It used to sell symlog by warning
  that "linear puts every recent divergence in one pixel", which is a fair
  warning about an alternative and a poor description of a default.

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

### Search: an exact name is evidence about the name, not about the taxon

`butterfly`, `eagle` and `oak` were the last three front-door failures, and the
fix is a change of principle rather than three special cases. The band treated
string equality as unanswerable, so a Caribbean nickname on one reef fish
outranked the swallowtails and a fossil genus PBDB had labelled "eagle"
outranked the sea eagles. Exactness is now **withdrawn** in two measured cases
and demoted exactly one band, never removed; §7 has both, their bounds and what
each one protects. A head-word band sits under it, because "oak moss" is a moss
and "sessile oak" is an oak.

Three things decided along the way, all on evidence, all recorded in §7 where
they bite:

- **No pipeline phase was re-run, and `oak` is why that is a finding.** The
  crawl looked like the obvious fix and it is already **complete at 287/287
  pages** — §7's "75 of 287" was stale. *Quercus* is a **broken taxon**, so it
  is not a node and the crawl never asks about it. Nothing upstream could have
  closed this.
- **Broken taxa still get no vernaculars.** One WDQS page would give `oak` the
  *Quercus* explanation, and §3's whole-name rule extends to it cleanly — but
  it would add a dead end beside an answer that now works. After `BrokenNote`
  has somewhere to go, not before.
- **The client does not re-rank search results.** `Palette.tsx`'s fuzzy score
  was outweighing four server ranks and failing silently on exactly the names
  the server had just got right. Ranking is server-side; the client highlights.

### Silhouettes: the PhyloPic corpus is what ships

**The current image set is enough, and expanding it is deferred.** Every node
carries a drawing, and since resolution was rewritten to find a node's closest
drawn *relative* the median picture speaks for 3,153 tips rather than 1,208,417
(§5). Nothing about the images is broken.

**Generated outlines traced from Wikimedia photographs —
[phase5c-decision.md](phase5c-decision.md) — are an optional future
enhancement and are not scheduled.** The phase is fully specified and every
figure in it is measured; it is deferred on cost and priority, not on doubt:

- it would take the median clade a picture speaks for from 3,153 tips to 270,
  and the share of nodes claiming over 10,000 tips from 27.8% to 10.5% — a large
  improvement to a number that is currently *honest and captioned*, not wrong
- the crawl is 50–73 hours of throttled fetching at ~0.8 img/s, which is the
  entire cost of the phase
- it is **macOS-only**, since it depends on Apple's Vision framework. Every
  other phase builds anywhere
- it drags [image-store.md](image-store.md) §9's identity migration in with it,
  because a second image source has no `phylopic_id`

That migration is likewise unscheduled and unnecessary while PhyloPic is the
only source. Both documents are kept complete and are written to be picked up
cold; **do not re-derive their figures, and do not delete either one.** The
triggers worth watching for are named in `phase5c-decision.md`'s status
section — chiefly user testing finding that borrowed drawings read as *wrong*
rather than as approximate.

§2 gains a row if this is ever built. It deliberately has none.

### Random picks: the pool is "has its own drawing", and the draw is the client's

`R` adds a random species, drawn client-side from the pools that
`/v1/random-pool/{build_id}` serves. **One key and one command**, with a 20%
chance of drawing from the fossil pool instead — `⇧R` and the second palette row
are gone, and `fossil-grafts.md` §9 is why. The command exists because the empty
canvas is a command list and
every other command on it assumes the reader has already thought of a species —
which, for an audience of curious people rather than systematists, is the hard
part.

**The pool is the entire design, and uniform-over-the-corpus is wrong twice
over.** A uniform node draw returns one of the 1.6M unnamed `mrcaott…` clades or
an undescribed mite; a uniform PBDB draw returns a single-occurrence brachiopod
with no stratigraphic bracket, which cannot be placed on the axis at all. So
both pools require the taxon to carry **a silhouette of its own** — which is not
a decoration filter but the strongest notability signal either corpus has,
somebody having chosen to illustrate the thing.

Measured on build `03473db1bfce56ca`:

| pool | filter | rows |
|---|---|---:|
| species | `node_image.climb = 0`, named | **13,918** |
| fossils | `is_primary`, `is_extant = 0`, `lla > 0.0117`, `attach_walk <> 0`, joined to `fossil_image` | **1,935** |

Both are **readings, not constants** — the same treatment `deployment.md` gives
the artifact sizes. A code comment saying 1,946 fossils survived a rebuild that
made it 1,935, and nothing was wrong with either number.

Four things not to redo about the filters:

- **`attach_walk <> 0`.** A pick that lands on *Tyrannosaurus rex* has found a
  taxon the tree already holds, and drawing it as a graft hands the reader the
  poorer of the two things it could have — the node carries the same PBDB
  bracket as its `occurrence` row *and* an ancestry. Costs 168 of 2,114, all
  still reachable as species.

- **`climb = 0`, not "has an image".** Phase 5 resolves a drawing for all
  2,725,682 nodes by climbing to a relative, so "has an image" is true of the
  whole corpus and carries no information. `climb` is hops to the clade the
  drawing *speaks for*, so zero means that clade is the node itself.
- **The Holocene bound is load-bearing**, for the same reason `witness-ceiling.md`
  gives: PBDB flags *Thalassia testudinum*, the living turtle grass, extinct at
  48.07–0.0117 Ma. `is_extant` alone admits living things wearing a fossil's
  clothes.
- **Written as a subquery, not a join.** As a join SQLite drives from
  `node_name` and probes `node_image` per row, 745 ms; as `IN (SELECT … WHERE
  climb = 0)` it scans `node_image` once and probes `node` by rowid, 83 ms —
  88 ms for the 13,918 rows when it was re-measured for the pool.

**The endpoint used to make the pick and now serves the pool**, and seven more
things not to redo come out of that:

- **The draw is the client's, and it is not mainly about speed.** There was a
  `/v1/random` that ran both scans behind `ORDER BY random()` per press and
  returned decorated rows. Which taxa are already on the reader's canvas is a
  fact **no request ever carried**, so that endpoint had to over-ask — twelve
  candidates, `RANDOM_CANDIDATES`, ten or eleven of them thrown away — and hope
  one was unused. With the pool in hand the exclusion happens *before* the
  choice, so a pick is always usable, always exactly one lookup, and there is no
  constant to guess. The failure mode "every pick this round is already on the
  canvas — try again" is now structurally impossible; the message that survives
  is reachable only with all 13,918 species on screen.
- **It was also the most expensive endpoint in the app, by 10–30×**, and
  nothing local said so: 1.19–1.51 s for `kind=species` and up to 2.45 s for
  `kind=fossil` against production on a warm container, where the same machine
  answered a search in 49 ms and a path in 39 ms. `deployment.md` §1 recorded it
  at 167 ms, measured on the machine the pipeline runs on. **That is the second
  time this exact trap has cost this project an endpoint** — the first was the
  unindexed `fossil` scan inside `/v1/search` — and both times the tell was the
  same: a CPU-bound full scan, cheap on a laptop, several times worse on half a
  vCPU.
- **The pool ships the resolved list and never the policy.** The two node
  filters and the five fossil ones stay in `store/random.go`; a client that
  recomputed them would be a second copy to keep in step with a set of rules
  that each have an argument behind them. It is the same line `store.Interleave`
  draws when it stamps `order` on a row so the client reads a rank rather than
  computing one, and the same principle as `web/` not re-sorting `/v1/search`.
  Bare identifiers are also what makes it cheap: the whole response is 114,193
  bytes of JSON, **39.8 KB gzipped and 21.3 KB brotli** — measured on the
  response — where the same rows carrying names, ranks and ages would be several
  hundred KB to spend one of them. It compresses that far because both lists are
  ascending runs of integers, so the `ORDER BY` pays for itself twice: once as
  the determinism the ETag needs and once as 5.4× off the wire. Delta-encoding
  was refused for buying less than the sort already had. The decoration is
  fetched for the one taxon drawn, from `/v1/node/idx:N` or `/v1/fossil/{id}`,
  both immutable and both free on a repeat.
- **The build id is in the path, and it is load-bearing.** A node index is only
  meaningful within the build that assigned it. This response is held an hour by
  the browser and a year at the edge, so a reader who kept a pool across a
  deploy and drew from it would be handed a different, entirely plausible
  animal, with nothing on screen to say so. Same reasoning as the container
  image tag being `<build_id>-<commit>` and as `cross_version_cache` being off.
- **A mismatched build id is refused `404` + `no-store`**, not answered from the
  current pool. Answering would let the edge file build B's list under build A's
  URL and serve it to everyone still on A — the mismatched pair the versioned
  path exists to prevent, arriving through the fix for it. The `no-store` on the
  refusal is the half that is easy to drop: a 404 is heuristically cacheable,
  and one pinned at the edge outlives the deploy that caused it.
- **The pools are warmed in the background at startup, and the two obvious
  answers are both wrong.** This is the entry most likely to be "simplified"
  back into one of them, so the order matters. Building on **first request** put
  the two scans on the press a reader is waiting on: measured against
  production, the first pool request on a freshly provisioned container took
  **29.9 s** — most of it the container's own cold start against an empty page
  cache and a 1.9 GB mmap, but the reader was holding all of it. Building inside
  **`Store.Open`** fixes that by moving the cost in front of every request the
  container has not answered yet, including the reader's first *search* — which
  taxes the primary flow to speed up a secondary one, on one instance and half a
  vCPU. So `server/main.go` starts a goroutine after the store opens, and
  `Store.RandomPool` stays mutex-guarded so a press arriving mid-scan waits on
  the build already running instead of starting a second. Measured locally: the
  listener is up at 861 ms unaffected, the warm-up logs `took=309ms` behind it,
  and the first pool request is **0.75 ms** against 307 ms unwarmed. A failure
  is **not** memoised — doubly load-bearing now, because a warm-up that runs
  once and failed would otherwise leave the surface broken until the container
  next slept.
- **The warm-up logs its own duration, and that is the point.** `random pool
  warmed nodes=… fossils=… took=…` is currently the only figure this project
  has for what anything costs on `standard-1`, and it exists because §7 records
  that nothing measures the deployed API. Estimating it from a laptop is what
  this whole entry is about.
- **It is on the Containers dashboard and *not* in Workers Logs**, and that
  sentence was written the wrong way round in three files before anybody
  checked it. The two are different streams: the container writes to stdout,
  Workers Logs holds the Worker's own invocation logs. The check that settles
  it is cheap and worth repeating before trusting any claim of this shape —
  query `dataset loaded`, a line the binary emits on every single start, across
  the whole account for the window around a deploy. It returns **zero**. The
  container's output is under Workers & Pages → Containers → Logs, which since
  2026-04-21 shows the correlated Worker and Durable Object lines beside it.
  Nor can it be forwarded: the container starts on its own, with no Worker
  invocation to log from.
- **The client still fetches it lazily**, on the first press and not at boot —
  the server-side warm-up is what makes that cheap, and moving the client to a
  boot fetch would put 40 KB on every page load for a command most readers never
  press. It is memoised by
  `api.ts`'s `get` cache: verified in the browser at 1 pool request
  across 4 presses. The old endpoint had to be fetched *outside* that cache
  through a `getFresh` helper, or the second press would have been answered from
  cache with the first press's pick — looking like it worked. `getFresh` and
  `writeVolatileJSON` are both deleted; each had exactly one caller.

The draw itself is `pickFrom` in `web/src/corpora.ts`, beside `randomKind` and
for the same stated reason: it is logic whose correctness cannot be checked by
looking at the screen, so it is a pure function with unit tests rather than a
few lines inside a callback. Adding something already on the canvas is a no-op,
and "Added Pallas's cat" over an unchanged canvas is a false statement about the
one thing the reader was watching. A fossil pick also adds the clade it hangs
below when that clade is missing — reusing `drawFossil`'s existing path —
because a fossil the tree does not contain almost always attaches to a branch
nobody has drawn, and without it the usual outcome would be a refusal notice for
something nobody chose by name. A fossil roll that comes back empty **falls
through to a species silently**: the reader pressed *surprise me*, and "the pool
you did not pick was empty" answers a question they never asked.

### A taxon's names are ordered by use, and Wikipedia is what measures it

Phase 6 elected one headline name and left the rest unordered. Both halves
failed where a reader meets them. The election broke ties on `length(name)`,
which elected **`TRex`** for *Tyrannosaurus rex* — four characters against
`T. rex`'s six — and, one key earlier, **`Ferae`** for Carnivora,
**`eubacteria`** for Bacteria and **`Archaeon`** for Archaea, none of which is
an English name anybody uses. Below the headline there was no order at all:
the server stable-sorted one boolean and returned the rest in rowid order, so
the card read *"Homo sapiens — also called human being, human beings, humans,
man, men"*. **26,262 nodes carry more than one English name**; the rest have
one and no choice to make.

**The measure is English Wikipedia's title and redirect graph**, and it is
what makes this evidence rather than taste. An article title is by that
project's own policy the name most used in reliable English sources; a
redirect is a name somebody thought a reader would type; no page is a name
nobody did; and a page landing on a *different* article is a name whose
ordinary referent is something else. That last band is the valuable one,
because it settles by measurement a class of failure that would otherwise need
a rule per case — `man` and `men` land on **Man**, `bug` and `bugs` on
**Bug**, `moth` on **Moth**, `Ferae` on **Ferae**, and none of those is the
taxon's article, while `carnivorans` and `T. rex` reach theirs. Nothing about
`Ferae` was hand-written; Wikipedia files it separately and that is the whole
of it. [name-ranking.md](name-ranking.md) is the full account.

Six things not to redo:

- **Resolve the taxon's own article title through redirects before comparing
  anything to it.** Wikidata gives *Homo sapiens* the sitelink `Homo sapiens`,
  and `Homo sapiens` on enwiki is a **redirect to `Human`**. Compared
  unresolved, `human` points at an article that is not the taxon's and the
  single best name for the species is demoted — the ordering inverts exactly
  where it matters most. Both ends go through the same resolution.
- **NULL evidence is not `none`.** Where a taxon has no English article the
  column stays NULL and the ranking falls through to the offline bands. Same
  rule phase 6 applies to an item with no `P225`; without it, a half-finished
  crawl silently demotes every name it has not reached.
- **`elsewhere` is demoted one band and never removed** — deliberately the
  same shape as the withdrawal rule for search exactness. `man` is a name
  humans go by, and a reader who typed it deserves to be told why they arrived.
- **Corpus frequency is refused and is not a near miss.** Google Books,
  `wordfreq`, any general list — they measure how common the *string* is, not
  how commonly it names *this taxon*, and inside *Homo sapiens*'s own names
  that ranks `man` above `human`. The Wikimedia pageview dump would be the
  real thing (5.53 GB, measured) and is a strict **addition** to this design
  rather than an alternative, since its counts still need this phase's
  redirect pass to be attributed to a taxon at all.
- **Shape and stem rules decide ties inside a band and never cross one**, which
  is why they are allowed to be judgement at all. The stem rule is *relative*
  and must stay that way: `lepidopteran` yields to `butterflies and moths`, but
  `arthropod`, `tetrapod`, `mollusc` and `primate` are all the Latin with an
  English ending and all of them are the ordinary word — there is nothing else
  to call an arthropod.
- **`kind` and `n_sources` were already being computed and thrown away.** Phase
  6 knew whether a name was a declared `P1843` common name, an item label or a
  bare alias, used it during dedup, and stored none of it. Persisting them is
  what lets a build that never runs the crawl still order its names.
- **`T. rex`, `T rex` and `T-Rex` are all redirects to *Tyrannosaurus*, so the
  evidence is silent between them** and the generic tiebreaks picked the
  shortest — the first green run headlined the app's most famous fossil as
  **T-Rex**. The fix is a penalty on strings that abbreviate *this taxon's own
  binomial* in anything but the standard `X. epithet` form. It is a penalty on
  the manglings and **not a promotion of the abbreviation**: promoting it would
  put `B. musculus` above `blue whale`.

**Two things the gates did not catch on their own.** The `--no-api` branch
originally left `complete` unset on the crawl report, and the spot checks only
*require* when the crawl is complete — so a full, finished crawl replayed
offline silently downgraded every content gate to an observation. It took a
passing **31/31** captioned *"resolution crawl incomplete"* to notice. And this
crawl's plan is **alphabetical**, unlike phase 6's `tip_count`-ordered one, so
a partial run is safe but biased; `name-ranking.md` §8 has both.

**The card leads with it now.** "Also called" moved above the description —
`web/src/detail/blocks.tsx`'s `AlsoCalledBlock`, split out of `NamesBlock`,
which keeps the *scientific* synonyms at the bottom because those answer "why
did I land here" rather than "what is this". Ranking it is what earned it the
position: an ordered list is an answer, an arbitrary one is trivia. Three
things in the markup are not taste — the separator **trails** its name (leading
it opened Carnivora's second line on `· Digitigrada`), the parent is a
**wrapping flex row** because binding name and dot with `white-space: nowrap`
leaves the line no breakable space at all and the list then overflows the card,
and it is a **dot rather than a comma** because several of these names carry
commas of their own. No brightness ramp down the list: luminance is selection's.

**It is clamped to one row with `+N more`**, and how many fit is *measured* —
the card is 360px on desktop and full-width on narrow, and the names run from
`cat` to `Artiodactylamorpha`, so a fixed count is wrong somewhere. Two things
not to redo: the arithmetic lives in `web/src/detail/oneRow.ts` and is
unit-tested **because the suite runs in `node` with no layout engine**, so a
DOM test would pass on a rule that is wrong; and the measurement runs against a
**hidden twin holding the whole list**, because measuring the visible row does
not converge — collapsing it changes what is laid out, so the next measurement
re-expands and measures again. That first attempt settled on never collapsing
at all, which looks exactly like a measurement deciding everything fitted. The
twin is `visibility: hidden`, never `display: none`: the latter gives every
item an `offsetTop` of 0 and one row then holds the world.

`length(name)` survives as the last tiebreak, on purpose: it is a fine way to
choose between two names nothing else distinguishes and a catastrophic way to
choose a headline. And **the client no longer re-sorts** — `toStrings` lost its
`preferredFirst` flag, because a sort on one boolean flattens every distinction
below rank 1 back into arrival order, which is the `/v1/search` failure again
in a second place.

### The detail card: what a thing is, before why it is drawn that way

The card used to be a name, four numbers, and up to six paragraphs about the
tree — why no age is shown, what tier the age is, what the picture is actually
of, how loosely the witness is placed. Every one of those paragraphs still
exists and **none has been shortened**, because each stops a specific wrong
reading and deleting one lets that reading back in.

What was wrong was the order. A reader clicks a badger to find out what a badger
is; the first thing the card said was that the horizontal axis is ordinal in this
region. So the provenance is now one collapsed disclosure below the facts, and
above it sits the common name, a description, and the classification.
`web/src/detail/` is the whole surface — `App.tsx` lost 400 lines and holds no
card markup at all.

**One sentence stayed on the face of the card:** a divergence's derived name.
For an `mrcaott…` node, "the last common ancestor of X and Y" is not provenance,
it is the only identity the node has.

**And it is that sentence and no more.** Each of the surviving face-of-card
paragraphs had grown a trailing clause that explained the paragraph rather than
the taxon — *"That is a statement about the tree, not a name anyone has given
it"* after the derived name, *"This node is both a taxon you chose and the
divergence you are looking for"* after the nested-selection note. Both are gone.
The test is the ordering rule above applied one level down: a sentence stating a
fact about *this animal* earns the face of the card; a sentence explaining what
the previous sentence was doing is provenance, and provenance is a disclosure.
Nothing moved into `WhyBlock` — these had no wrong reading of their own to
stop, which is what separates them from the six paragraphs that may not be cut.

Four things worth knowing before changing it:

- **The classification is the ancestor path.** There is no taxonomy table and
  none is needed; `/v1/path` already carries a rank on every entry and is
  already cached from the selection that opened the card. `lineageOf` splits it
  into a **ladder** (the major Linnaean rungs, which is the question people ask)
  and a **full lineage** (every named ancestor, folded away, which is the more
  interesting list — *Bilateria*, *Primates*, *Opisthokonta* are all `no rank`).
- **The gaps in the ladder are real and are not filled.** *Homo sapiens* has no
  ranked **order** and no ranked **family** on its path: *Primates* is filed
  `no rank` and **Hominidae is not a node at all**, having not survived
  synthesis. Five rungs and silence looks broken to anyone who knows humans are
  hominids, so the missing rungs are *named* in a note. Reaching for a second
  taxonomy to fill them would put a claim on the card that the tree behind it
  does not make.
- **`no rank` is never printed as a rank.** It is what OTT files an unranked
  clade under, and rendered under a heading it reads as a statement about the
  clade — *Boreoeutheria* wore "NO RANK".
- **A fossil's classification is its attachment point's**, captioned as such —
  except at `attach_walk = 0`, where PBDB's taxon is itself in the synthesis
  tree and the attachment point *is* this taxon. Without that branch
  *Tyrannosaurus rex* is described as the node *Tyrannosaurus rex* hangs
  beneath, with itself as the last rung of its own lineage.

### The card is the second navigation surface

Every name on a card that names a taxon opens that taxon's card, and the card
carries its own add/remove control. The two arrived together and had to: each is
what makes the other honest.

**A link that could only reach drawn nodes would be a dead end.** The card used
to be fetched through `focusedIdx`, so it opened only on something already in
`tree.nodes` — drawn, or on the path of something drawn. *Carnivora* is three
rungs above *Felidae* and is neither, so under the old rule clicking it changed
the URL and nothing else. `focusedIdx` now means only "which mark to light" and
is null for a taxon with none; `selectedNodeKey` means "which card to show" and
asks the API directly.

**A control that could only remove would be half an answer.** Selection no
longer implies drawing, so the reader needs a way to say "and put this one on
the canvas" about a thing with no mark to click. That is the whole reason the
old objection to clickable rungs — *it opens a card for something the canvas
does not show* — no longer stands.

Five things worth knowing:

- **A witness links to the fossil, never to its attachment point.** The
  attachment point is a node, and nodes are what the canvas draws, so it is the
  tempting target — but it is a clade the fossil sits somewhere below, often
  tens of thousands of species wide. `Witness.pbdbTaxonNo` exists to make the
  right one the easy one, and `witness.test.ts` asserts both fields by value
  because swapping them fails *silently*: an index resolves cleanly to a real
  and unrelated clade.
- **`idx:N` is a real key**, and it is what a link into a node we hold no key
  for produces — the silhouette's subject, a clade, a witness's attachment
  point, all of which arrive as bare references into the arrays.
  `selectionKeyFor` prefers a node's own key when we have one, purely so a
  shared URL says `ott244265` rather than a position in this build's arrays.
  `idxFromKey` parses it back so a link into something *already* drawn still
  lights its mark. Its first draft used `Number(key.slice(4))`, and
  **`Number("")` is 0** — the malformed key `idx:` selected the root of the
  tree. A test caught it; the match is now exact.
- **An undrawn clade is a clade the reader *chose*.** `isLeaf` feeds
  `witness.ts`'s rule that a divergence draws its witness and a chosen clade
  keeps its exemplar. A node not in `induced.rendered` is not a divergence
  between anything — nobody arrived at it, they named it — so without that
  clause every link into an undrawn clade answered "what does a carnivoran look
  like" with a fossil from a fork it is not sitting at.
- **The button has three states, because "on the canvas" and "chosen" are
  different things.** A drawn divergence is there only as long as the
  selections that induced it: *Boreoeutheria* while a human and a cat both are.
  Labelling that "Add to the canvas" promises a visible change and the press
  then appears to do nothing, so it reads **Pin**. The verb is the whole of it:
  a hint under the button ("It is drawn now only because of what sits below it.
  Pinning keeps it.") explained the mechanism above the name, the description
  and the classification, and was therefore among the first things read on a
  card opened to find out what an animal is. It is gone, along with the
  `hint` prop that carried it. `refusal` is a different case and stays — it
  says why a press would do nothing, and it replaces the button rather than
  annotating it.
- **A fossil card draws through `drawFossil`, not `addFossil`.** It is now
  routinely open on something whose host branch is nowhere near the canvas — a
  witness reached by a link, a search hit — and the bare add would put it in the
  URL and draw nothing. The two refusals no selection can fix (no bracket, no
  identifier) replace the button with a sentence rather than disabling it.

### The description is fetched at read time, and that is not a crack in §9

`docs/architecture.md` §9 is emphatic that the Open Tree API is a build-time
oracle and never a runtime dependency, and nothing here weakens it. The
encyclopaedia block is a different kind of thing:

- **It is not part of the dataset.** A build id has to mean the same tree every
  time. A description of a badger is prose about a badger — no gate touches it,
  and freezing a 2026 revision into the artifact would make the app *staler*.
- **It covers the corpus a crawl cannot.** 108,293 nodes carry a Wikidata QID;
  the 523,112 PBDB fossil taxa carry none, so a QID-keyed crawl leaves every
  fossil card exactly as bare as it was.
- **It costs nothing when it fails.** The card is complete before it resolves
  and complete without it. Offline, the block does not appear.

The cost, stated plainly: opening a card sends a taxon name to the Wikimedia
Foundation. That is the whole privacy surface, and it happens only on a click.

**The guard is the whole of the difficulty.** A name-shaped link is how a Greek
war god ends up on a fossil card — PBDB has genera called *Ares*, *Iris* and
*Nike*, and the same trap already cost this project a phase-3 fix
(`refuse_disagreements`) and a phase-6 one (the `P225` check in
`vernaculars.py`). So:

- **With a QID, nothing is re-checked**, because phase 6 already refused any
  item whose own `wdt:P225` names a different taxon from OTT's. Re-testing would
  fetch the same triple and learn nothing — and where the triple is absent it
  would learn nothing there either, which is the documented residual both ends
  live with. The QID reaches the client on `/v1/node`, read off
  `vernacular.source_id`; it rides in the vernacular table because that is where
  the crawl put it, so a node with no common name has no QID either.
- **Without one, the item must prove itself.** Found by its English article
  title, then refused unless its `P225` names the taxon asked about. An item
  with *no* `P225` is refused here — the opposite of what phase 6 does with the
  same absence, and right for the opposite reason: there a QID had already been
  tied to a node by an explicit identifier, and here the only thing linking them
  is the string. *Ares* is verified refused against the live API.

Two smaller calls that are load-bearing:

- **A binomial that resolves to nothing is retried as its genus**, because
  Wikipedia files most extinct species under the genus and a sitelink lookup
  does not follow redirects. The result carries `broaderThanAsked` and the card
  **must** print it — an article about *Tyrannosaurus* under a heading reading
  *Tyrannosaurus rex*, unlabelled, is the borrowed-silhouette mistake in prose.
- **The REST summary's thumbnail is deliberately not read.** A photograph would
  be the one warm, high-detail object on an instrument whose whole visual
  argument is a dark field and flat silhouettes, and it arrives with a Commons
  attribution obligation the PhyloPic credit block cannot carry.
  `docs/phase5c-decision.md` is the standing record of what Wikimedia imagery
  costs here.

### A fossil's young end can be a fact about the catalogue, not the animal

Reported as a bug against the app: *Stegosaurus* was drawn with a last
appearance of 93.9 Ma, and it is famously Late Jurassic.

The number was PBDB's, copied faithfully. **One occurrence of 86** put it
there — `Stegosaurus sp.`, Mussentuchit Member of the Cedar Mountain Formation,
a genus-level indeterminate identification — against every named species ending
at 143.1. PBDB's `lastapp_min_ma` aggregates a taxon's whole subtree, which
makes the diagnosis exact rather than a guess: **a young end below every
descendant's cannot come from an identified member**, so it can only rest on
`sp.`/`indet.` material. No threshold, no occurrence-level data, and the whole
sweep runs offline over `pbdb_taxa.csv`.

It is common enough to matter. **10,655 taxa** corpus-wide; inside Dinosauria,
71 stretched by ≥10 Ma of which **not one** has an identified species at its
young end, 52 resting on a single occurrence and 20 on records hedged `?`,
`cf.` or `aff.` by the identifier. *Iguanodon* and *Megalosaurus* were both
drawn at 66.0 Ma, each on one hedged record — the two great wastebasket genera
of nineteenth-century naming, showing straight through into the layout.

What shipped: `lla` untouched, three new columns carrying the reading, and the
position — and only the position — moving on 7,802 rows. The full rule, its
four refusals and the numbers behind each are in
[fossil-grafts.md](fossil-grafts.md) §3. Four things not to redo:

- **The share of a record identified to species does not discriminate.**
  *Stegosaurus* is 20.9% identified — most of its own record is `Stegosaurus
  sp.` too, exactly like *Tasmanites*, whose alternative would be a 1,595 Myr
  error. Corroboration *at the identified end* is what separates them.
- **Ichnotaxa must be exempt**, and PBDB's `I`/`F` flags do it cleanly. For
  *Gyrolithes* a genus-level identification is the finest that exists.
- **The correction has to propagate**, or it is defeated one rank up and the
  reader meets the same error by selecting the family.
- **The witness layer was affected too**, and in the direction that hurts: a
  bracket widened toward the present cannot fail to contain a recent split.
  Spanning witnesses 192 → 190, and the two lost are the false ones.

Two gate assumptions were wrong and both were caught by writing them down.
PBDB's aggregate is **not monotone** (440 taxa have a descendant reaching
younger than they do), and the invariant `lla ≤ lla_drawn ≤ fea` has to be
enforced **per row** rather than per accepted taxon — 414 rows would otherwise
have been dragged to the Holocene, because *Crassispira* is a living genus
whose synonym *Tripia* is an Eocene fossil.

---

### A row belongs to a lineage that ends, not to a clade you happened to pick

Reported as a bug against the app: choosing **Cetacea** beside *Balaenoptera
musculus* and *Hippopotamus amphibius* threw Cetacea to the top of the canvas,
above the whale it contains, and left *Pakicetus* — a fossil whose attach node
**is** Cetacea — reading as though it hung off Whippomorpha instead.

Both halves came from one rule. `layout()` gave a row to every selection,
including one that is an ancestor of another selection, and rows go out in
ascending `idx` — which is preorder, which puts an ancestor **before every one
of its descendants**. So a chosen clade always took the *first* row of its own
block, and its parent's midpoint then landed inside that block. Read down the
canvas the picture said: Cetacea, blue whale, *then* the ancestor of both, then
a fossil. Nothing about x could help — Cetacea carries no `age_ma` at all, so
phase 2 synthesized an `age_layout` of 50.34 against Whippomorpha's 51.83 and
the two branches ran back up the canvas eight layout units apart.

The fix is the rule the rest of the file already implied: **a node with rendered
descendants is drawn on the lineage that continues past it, never on a row of
its own.** Cetacea becomes a marked point at 50 Ma on the branch running out to
the blue whale, and Whippomorpha forks above it — which is how every phylogeny
in print draws a named clade containing a sampled tip. It needs no reordering to
get there, and that matters: **ladderizing by clade size was refused**, because
sorting rows by subtree size would break the property the motion design rests on
— rows ascending `idx` mean adding a species inserts it in place and permutes
nothing. Four things not to redo:

- **The unconditional row had a real case behind it.** OTT files *Homo sapiens
  neanderthalensis* as a child of *Homo sapiens* and both sit at `age_layout` 0,
  so putting the parent on its child's row puts two chosen species on one pixel
  joined by a zero-length trace — rendered correctly, and invisible. A node
  within `MARK_MIN_SEP` in x of the single child it would take its row from
  keeps a row. **The fix is a row and not an offset in x**: x is time.
- **A node with two or more rendered children never needs one** — its midpoint
  is strictly between two distinct rows.
- **`terminal` stopped being answerable by `isLeaf`.** A chosen clade sitting on
  its descendant's line has that descendant's trace running out to its right, so
  it takes the divergence candidate list. Left terminal it asked for `right,
  dy: 0` first and got it: "Cetacea" printed along the whale's own branch.
- **Which side a graft's rows go is not taste.** A row inserted *between* the
  anchor and the fork it descends from drags that fork's midpoint half a row per
  inserted row, and with one graft it lands **exactly** on the graft's row —
  arithmetic, not luck. It was already true before this change and already
  visible: with *Homo georgicus* on screen the Homo/Pan divergence dot sat on
  the fossil's line. Grafts now go on the far side of the anchor's block from
  the fork, and the connector ordering that keeps them from crossing reverses
  with them, because the rule is the distance from the anchor and not the
  direction.

One thing the layout cannot fix, and should not pretend to: `joinAge` clamps to
the branch top for a fossil older than its whole branch, and `xAt` of that is
exactly the x of the branch's own vertical — so the connector was drawn *along*
the line it is meant to be distinguished from, collinear however the rows are
arranged. `joinX` is now held clear of that corner and never past the anchor's
own mark, so on a branch shorter than the clearance the connector leaves the
anchor's dot itself. `joinAge` and `joinAt` are untouched; the caption still
says which of the three joins it is.

---

### The age slot answers *when*, so it stopped answering anything else

A label was two rows — name with the age riding on its line, rank beneath — and
the age was the part that did not belong there. On a left-hand label the name's
line is right-aligned, so the figure took the space nearest the dot and the
**name** was pushed away from the thing it names: `Boreoeutheria ≤ 96 Ma`
reserved 139 units for a name that needs 85, and every one of those units is
distance between a label and its own point.

It is now three rows — **rank, name, age** — each on its own line, so a label is
as wide as its widest row rather than the sum of them, and they read in the
order a stranger needs: what kind of thing this is, which one it is, when.

They also **tier off in that order, reversed**: the age is last on and first
off. It is the one thing on a label the canvas already says another way — x is
time and there is a ruler under it — so a figure repeating a position is the
first thing that can be spent, while the rank and the name are unavailable
anywhere else on screen. Promoting the rank fixed a second thing on the way:
`DIVERGENCE_META` shares that row and is the only mark saying a derived name is
derived, and it was gated a whole tier below the name it qualifies — so between
the two thresholds the canvas showed `Homo / Pan` in the position every real
taxon name occupies with nothing to say it was ours.

The second half is the one worth keeping. The age row used to carry a **clock**
where a species reached the present, and `caption.test.ts` had already written
down why that was wrong without drawing the conclusion: *"'present' is a
position, not a quantity."* Every neighbour in that slot is a figure. So the
clock is gone and the fact it carried decorates the **mark** — a rounded arrow
pointing at the present, in the dot's own footprint. Four things not to redo:

- **A tip has no start date, and there is none to find.** `age_ma` is a
  divergence age; a species tip's own is zero. The stem age belongs to the fork
  above and is already drawn there, and a PBDB first appearance is the
  `occurrence` tier — a weaker, differently-shaped claim that is never collapsed
  to a point. So the age row prints `age_ma` and nothing else, and a tip prints
  nothing. No number is the honest answer, exactly as it is for a structural
  node.
- **Do not key the arrow on position.** The first attempt kept the clock's own
  condition — `age_ma` under 0.05, so *drawn at the present* — and it was wrong
  twice. *Cetacea* and *Homo* are as alive as *Homo sapiens* is, and neither is
  drawn at the present: a clade sits at its **crown age**, which is when it
  began. And a mark meaning "this is at x ≈ 0" says only what the reader can
  already see, which is the same objection that took the date off the label.
  **The tier is the signal**: `occurrence` is applied only where nothing below
  the node is alive, and is the one place a node's extinction is recorded. The
  known limit is an extinct OTT taxon carrying no occurrence range, which reads
  as living — 0.5% of extinct OTT taxa are in the synthesis tree at all, and the
  fossil layer is where the rest of them live.
- **It rides on chosen taxa, never on a divergence.** *Is this still alive* is a
  question about a **thing**; a fork is a **moment**, and a moment is neither.
  Asked of every node it would be true of nearly all of them and distinguish
  nothing — a canvas of arrows. This is the same line `witness.ts` already
  draws: a leaf of the induced subtree is a clade they chose and keeps its
  exemplar, a divergence draws its witness.
- **The arrow takes the dot's footprint rather than sitting beside it.** The
  margin to the right of a terminal mark is where its label goes — a terminal
  mark asks for `right, dy: 0` first and gets it — so a mark out in that margin
  argues with the name for the same pixels, and on an internal node it is drawn
  along the branch leaving the node and vanishes into it. The footprint is the
  one place already reserved for the node.
- **Every row pins its own font-size and line-height.** A row is at least as
  tall as its strut whatever is inside it, so a row that inherits is a row whose
  height nothing in `labels.ts` can predict. One inherited `.mark.is-leaf
  .mark-label`'s 13.5px and stood 17.9px against a reserved 15.

`AgeGlyphKind` is down to one member, correctly: the only word the age slot
still has to say is *fossils*.

**The zoom no longer decides any of this, and the reader does.** The rows used
to tier off with scale — name at 0.55, age at 0.62, and 1.15 before that — and
the ordering above was right while the *mechanism* was wrong. Zoom is how a
reader looks at a tree: pulling back to see the whole shape is the most ordinary
thing they do and it took every name with it, while reading one name meant
zooming until the tree no longer fitted. The thresholds were also guesses the
fit kept landing either side of — the age tier at 1.15 against a fit of 1.144
for six species, so **adding a sixth species stripped a row from every label on
screen**. Nothing load-bearing may hang off a threshold the fit can cross.

What survives is the *ordering*, as two controls rather than one axis: `labels`
(off · common · scientific, defaulting to common) and `ages` (on · off),
bottom-left above the axis,
both in the URL. The age is the row that switches separately because it is the
one the canvas already states another way. The rank does not get a third switch
— it is what says a derived name is derived, and a control whose only honest
setting is on is not a control. `chrome/LabelModes.tsx` and design-reference.md's
*What a label says* are the account; `name-ranking.md` §7 is the common-name
half, including why it is restricted to genus, species and subspecies.

### A rank the taxonomy does not give, from the catalogue that does

The Open Tree taxonomy files *Tyrannosaurus rex* as `no rank`. Not blank, not
"species" — the literal string OTT writes for a row whose source gave it no
Linnaean rung. So the most famous fossil in the product carried **no rank row**,
and `isScientificItalic` set its name roman while *Homo sapiens* two rows above
it was italic. One missing field, three visible symptoms, across the canvas, the
card and the palette.

PBDB has the field: taxon 54833 is a **species**, and phase 3 already resolved
that taxon to that node. **2,039 nodes** are in the same position — unranked in
OTT, ranked by a PBDB taxon of the same name attached at the node — and across
all of them the PBDB rows never disagree with each other about the rank.
`store/rank.go` loads them once at open and `Metas` serves them, so every
surface reads one answer. Four things to know before touching it:

- **This is not the gap-filling the card refuses.** Naming the gaps in a
  classification rather than filling them is about *rungs* — Hominidae is not a
  node, and inventing one would be a lie about the tree's shape. Here nothing is
  invented and no rung is added: a second catalogue records a rank for a taxon
  this same node already **is**. Requiring the two names to match exactly is the
  guard on top of phase 3's `refuse_disagreements`, and it is what keeps PBDB's
  Ediacaran *Ivesia* from ranking OTT's rose.
- **The taxonomy always wins where it has an answer**; PBDB only ever fills a
  hole. `TestPBDBNeverOverridesTheTaxonomy` is that claim.
- **PBDB spells "unranked" its own way**, as `unranked clade` and `informal`, and
  both must be refused or they print as ranks. This is not hypothetical:
  *Amniota* and *Sauropsida* are `no rank` in OTT and `unranked clade` in PBDB,
  so they keep an empty rank row — which is right, because both catalogues agree
  there is no rung, and `AMNIOTA / UNRANKED CLADE` would be worse than silence.
- **It is loaded at open, not joined per request.** The join is name equality and
  `fossil` has no index on `name` — only `(attach_idx, n_occs DESC)`. A path
  through *Sauropsida* would pay for its 10,818 attached rows to answer about
  one, and *Sauropsida* is itself unranked, so every dinosaur in the product
  would pay it. Once at open it is a 150 ms scan and ~2,000 map entries.

Found alongside it and fixed with it: the canvas kept its **own** copy of "is
this word a rank", and that copy knew about `no rank` but not `no rank -
terminal` — the other unranked string, on **78,696** nodes. The row that says
what kind of thing this is could say `NO RANK - TERMINAL` above the name. The
card's `rankIsInformative` had the full set from the day it was written, and
`metaLine` now calls it rather than approximating it.

### The canvas knows the card is there, and gets out from under it

Clicking a mark opened a 360px panel directly on top of the mark that had just
been clicked. Select the moose beside a bat and a mouse and the card covers the
moose's dot, its silhouette and its name — the one element on screen the reader
has just said they are looking at. The canvas measured itself against the whole
window and the card is `position: fixed` over the corner of it, so nothing in
the layout had any idea.

`canvas/viewport.ts` is the whole of the fix and it gives **two** answers,
because there are two questions:

- **The reserve.** `cardReserve` narrows the width the fit is computed against,
  and `plotWidth` follows it. That is deliberately the same path a real window
  resize takes: the plot shrinks so the fit stays near 1:1 and the labels keep
  their designed size, rather than the same tree being scaled down until every
  name on it is 6px of type. The whole tree then reframes into the
  strip beside the card, timeline and all.
- **The reveal.** `revealShift` is the floor under that — the smallest pan that
  puts the subject back inside the part of the canvas the card is not on.
  Exactly `{0, 0}` when it is already clear, so the caller has no second
  predicate that could disagree with it.

Five things not to redo:

- **The reserve is refused below `MIN_FREE_W`.** At 800px wide the card leaves
  408px of canvas, which fits a `MIN_PLOT_W` tree and its labels at a scale that
  renders the names at around 7px — so honouring the card would buy a tree
  nobody can read, which is worse than a tree with a corner covered. This got
  *sharper* when the zoom tiers went: the names no longer vanish at that scale,
  so nothing on screen would tell the reader why they cannot read them. Under that width the reveal
  is the entire remedy, and it is enough.
- **The reserve is also refused while the reader is off the fit**, and this is
  the constraint that shaped the design. Taking it *re-lays out* the tree, so it
  cannot be a pure function of "is a card open" — a reader who has zoomed into a
  corner and clicks a mark to read about it would have the tree reflow and
  reframe under their hands. So `reserved` is state that lags `cardOpen`, moving
  only at a moment the canvas was going to be reframed anyway. A reserve left
  standing after its card closed is reconciled the next time the reader returns
  to the fit; the cost is an empty strip on the right, and it is the right cost.
- **The reveal must not run on the live transform.** It fires on the selection
  and on the card appearing or going, never on pan — a reader dragging a mark
  under the card is panning, and a viewport that pans back is fighting them.
- **The two questions need two geometries**, which is why `freeRect` is not
  `cardReserve`. A card refused a reserve is still 360px of opaque panel, and
  below 620px it is not on the right at all — it spans the window under the
  control bar, so the free region is the strip *below* it.
- **The subject is the mark and its label.** A dot on the seam with its name
  printed under the card is not visible in any sense a reader would recognise.
  Where the two together are wider than the strip, `revealShift` centres rather
  than clamping an edge: clamping something too large resolves to whichever edge
  is tested first, so the mark would jump left or right depending on which way
  it was already overflowing.

`viewport.test.ts` pins `CARD_W`, `--s4`, the 620px stacking width and the
stacked card's `top` and `max-height` to styles.css by reading it, on the same
principle as `labels.ts`'s font constants. The failure mode without that is
silent: the tree simply starts sliding a little way back under the card.

### A shared link now says what it is, and shows it

The document carried a title, a viewport and a colour scheme, so every link
anyone sent unfurled as the word "Concestor" and a blank rectangle — the one
surface where this app meets a person who has never seen it, describing itself
with nothing. `index.html` now carries a description, a canonical link, the
Open Graph set and `twitter:card`, and `scripts/make-icons.py` grew a third
output: `web/public/og.png`, the 1200×630 card. `docs/design-reference.md`
§"The share card" is the design; this is what not to redo.

- **The card is generated, not committed as an opaque PNG.** That is the same
  rule the icons already live under and the reason is the same: an image nobody
  can regenerate stops matching the product the first time the palette moves,
  and nothing in the repository can tell. It is 120 lines of distance fields in
  the standard library — no font, no rasteriser, ~1.7 s for all four files —
  and `--check` is what makes it a gate rather than a good intention.
- **`png()` now picks its row filter per image, and the textbook answer was
  measured and rejected.** libpng's per-row minimum-sum-of-absolute-differences
  heuristic optimises each row in isolation, but what carries these images is
  LZ77 matching across rows: on the touch icon it costs 60% (`None` 3,016
  bytes, adaptive 4,824, all-`Up` 5,082), while the card's radial ramp wants
  `Up` (47,549 against 42,758). So both whole-image filters are compressed and
  the smaller ships, which left the two committed rasters byte-identical.
- **The metadata is checked against other files, never against a second copy of
  itself.** `meta.test.ts` reads the apex out of `wrangler.jsonc`, the void out
  of `styles.css`, `LANE_HUES` out of `layout.ts`, and the card's size out of
  the PNG's own IHDR. Every failure this file exists to catch is invisible from
  inside the app: a title and an `og:title` that drift apart, a card redrawn at
  a new size with the old one still declared (which every scraper obeys, and
  letterboxes), a relative `og:image` (which most drop entirely), a domain move
  that leaves absolute URLs on the old host.
- **`ambient.d.ts` gained a binary `readFileSync` overload**, typed
  `Uint8Array` rather than `Buffer`. `Buffer` is a Node global and the point of
  that file is that this project has none; a `Buffer` *is* a `Uint8Array`, so
  nothing untrue is claimed.
- **Per-selection cards were refused on cost**, not overlooked. The reasoning
  and what would reopen it are in the design doc, and the short version is that
  it moves `/` from a static asset to a Worker route with a container hop on
  the critical path of a cold human load.

### What a mark says is the reader's choice, not the zoom's

Semantic zoom is **gone**. Three tiers decided which rows a label drew — mark
and silhouette, + rank and name at 0.55, + age at 0.62 — and it was a rule about
legibility answering a question about intent. Pulling back to see the whole tree
is the most ordinary thing anyone does here and it silently took every name;
reading one name meant zooming until the tree no longer fitted. Two switches
replace it, bottom-left above the axis, in a stack with bioluminescence because
the three are one set: **controls that change how the canvas is drawn rather
than what is on it**.

Eight things not to redo:

- **The lesson is the threshold, not the tiers.** The age tier sat at 1.15 and
  the fit lands at 1.144 for six species, so adding a sixth species stripped a
  row from every label on screen. Nothing load-bearing may hang off a number the
  fit can wander across — which is the same fact that once stripped every
  silhouette from the default view, recorded twice now and worth believing.
- **The rank travels with the name and gets no switch of its own.** It carries
  `DIVERGENCE_META`, the only mark saying a derived name *is* derived, and
  without it `Homo / Pan` sits where every real taxon name sits and reads as
  one. Under the tiering it was gated a tier below the name it qualifies, which
  is how that was found. A control whose only honest setting is on is not a
  control.
- **A common name is served for genus, species and subspecies only.** Above
  that it names a group rather than a kind of animal, and §3's whole demotion
  machinery exists because those words mean something else — a fork captioned
  "great apes" has named a clade after its crown group. The rule is applied in
  the server, which does not send one, *and* in `markName`, which would not draw
  one; the duplication is deliberate, so a payload predating the restriction
  cannot leak one through.
- **Rank 1 or silence.** `HeadlineVernaculars` is the strict sibling of
  `BestVernaculars`: on the canvas the common name *replaces* the scientific one
  rather than captioning it, so an unranked guess would be another taxon's word
  in the only slot saying which taxon a mark is. Silence means the scientific
  name, which is never wrong, and a build predating the `names` phase therefore
  draws no common names at all.
- **The italics were already the channel.** `NamePart.rank` is null for
  punctuation, so a common name is a run with `rank: null` and the existing
  renderer sets it roman with no new rule. It is the only thing telling a reader
  which kind of name they are looking at on a canvas that is always a mixture —
  110,794 nodes of 2.7M carry an English name.
- **A divergence keeps its Latin more often than you would expect, and that is
  `firstNamed` working.** The derived name reads the *suppressed run* before the
  leaf, deliberately, so a node separating two genera is not labelled with two
  species — and 5,548 genera carry a ranked name against 99,960 species. Human
  and chimp alone still read "Homo / Pan". Where the genera do have names it
  translates run by run, and `abbreviateRepeatedGenus` is skipped for those:
  `H. erectus` is a convention of scientific names and applied to "Human" it
  gives "H. uman".
- **The letter a mode takes is the letter that names it.** The labels took `L`
  and the time scale moved to `T` — `l` names the labels, where it only ever
  named one of the two scales it switched between. `A` is the ages, `B` the
  light, and the four canvas modes are the four rows in `bindings.ts` whose
  control lives on the bottom edge rather than in the control bar. (A `chrome`
  field used to say which rows the bar drew; it is gone — see the swap entry
  below.) `L` **cycles** through three states where every other
  toggle here flips, which is legible only because the chip is beside it: the
  reader sees where the press landed and what the next one will do.
- **A label with no words must reserve none.** `metricsFor` floored at
  `MIN_TEXT_W` (88) and one name line whatever the strings were, because before
  this there was always a name. A box padded out to where the text *would* have
  been pushes every neighbouring label aside — on a wordless canvas, the whole
  layout spread out around nothing.
- **The three controls are one panel, not three chips**, and it took two passes.
  Three chips each drew their own border and sized themselves to their own
  words, so the columns began at three different x positions and a set read as
  clutter; the rows share the panel's grid through `subgrid` now. Then the
  caption sat in a *column*, which is as wide as the longest word in the set —
  `BIOLUMINESCENCE` deciding the indent of a row reading `AGES` — so it stacks
  **above** its switch instead: 322px wide became 217. Two more, both found on
  screen rather than reasoned out: the caption set like the segments read as a
  **fourth option** (`labels off scientific common` is four words and three are
  pressable), which small-caps mono plus a recessed track fixes; and an option
  must grow from its own word rather than from zero, or the widest word in a row
  sets every option in it — `off` as wide as `scientific`, three times over. The
  three switches are one width because the three-option row packs tight and
  *sets* it at 164px while the two-option rows spread into it, which is the
  narrowest common width there is rather than one anybody picked.
  And it was still too loud when all that was fixed: a bordered, filled card
  with `--ink` on the chosen option, brighter than the tree it annotates, on an
  instrument whose principle is that the graph is the only light source. No
  border, no fill, 0.62 opacity until hovered — the treatment `.controls` has
  always had. **The accent on a non-default choice went with it**, and with it
  `ModeChip`'s `modified` prop: three controls lighting up to report a *setting*
  is what the loudness was. Bioluminescence keeps its cyan and is the only lit
  choice on the panel, because glowing is what that mode does and the chip is
  the one preview of it. design-reference.md's *What a label says* is the
  anatomy.

**Neither is in the URL**, and that is the second thing this shares with
bioluminescence. Both live in `sessionStorage`, per-tab. The line is what a
setting is *about*: everything `encode` writes is a claim about taxa, and these
are claims about the reader — which name they read a taxon by, whether they want
the figure. A link carrying them imposes one person's habits on somebody who did
not ask, and the sharp case is louder than the light's ever was: a link made
while the labels were **off** opens on a canvas of unnamed dots with nothing on
screen saying why. A fresh tab therefore always starts at scientific names and
ages on. The labels mode is the first stored preference with *three* values, so
`loadLabels` looks the string up in `LABEL_MODES` rather than comparing down a
chain — a stored value this app did not write has somewhere wrong to land, which
the booleans cannot have.

They are on `L` and `A`, which cost the time scale its letter: it moved to `T`.
That is the better trade in both directions — `l` names what it switches now,
where before it named one of the two scales it toggled between, and a reader
whose fingers remember the old `l` lands on a chip in the same corner of the
canvas rather than on nothing. `L` **cycles** where every other toggle on that
edge flips, which is legible only because the chip is beside it: the reader sees
where the press landed and what the next one will do.

### The app draws its own tooltips, and the copy was the other half

Every hover explanation in this app was a `title` attribute. That is the
browser's tooltip, and the complaint that started this was one of its faults
rather than a bug in our code: the bioluminescence switch sits bottom left, the
platform draws its tooltip under the cursor, and the sentence landed across the
timeline.

**The mechanism was the smaller half.** `title` cannot be styled, arrives about
a second late, wraps where the platform chooses, never appears on a touch
screen, cannot be dismissed, and is positioned against the pointer rather than
against the control. `chrome/tip.ts` and `chrome/Tooltip.tsx` replace all of it
— placement and timing in the first, the store, the hook and the one layer in
the second.

**The copy was the real leak.** `title` is a slot with no cost to filling, no
linter objects to it and no test notices it, so it filled with the reasoning
that belongs in the header comments: 372 characters of naming policy on one
segment of the labels switch, 251 on another, 243 on bioluminescence. The
rewrite cut every one to a sentence and moved nothing — all of it was already
written in the component headers and in `name-ranking.md`. What survives is the
answer to *what will pressing this do*, plus the one caveat whose absence would
cost the reader their trust in the canvas: "Nothing about the data changes" is
why the bioluminescence copy is two sentences rather than one.

Seven things not to redo:

**A hook, not a wrapper.** `<Tip><button/></Tip>` is the friendlier API and it
puts an element into `.mode-chip`'s grid, into `.canvas-modes`'s subgrid, and
into a `<g>` inside the drill lane's single SVG. `useTip` returns event
handlers, so the DOM after the change is the DOM before it, attribute for
attribute, minus every `title`.

**Placement is one line, and the proof is why there is no flip in it.** "Below,
flipping up when it does not fit" would not have fixed the reported bug: a 48px
tip below that switch *fits*, straight across the timeline. The rule is that a
tip goes towards the middle of the window — and writing out the two room
calculations shows `r₋ ≥ r₊` is exactly `y + h/2 ≥ H/2`, so "away from the
nearer edge" and "the side with more room" are the same test. A separate flip
pass could then only ever fire by preferring the side with *less* room. Two
clamps handle the rest, for both axes.

**Anything that relays out the page invalidates the anchor**, which is a
rectangle measured once at open time. This canvas re-lays out constantly —
opening the card re-fits the tree, `L` and `A` change every label, `F`
reframes — so `pointerdown` and `keydown` are listened for on the **window**,
not on the trigger. On the trigger they cannot see the two cases that matter: a
press on some other element, and a keystroke while the pointer sits still. Both
leave the old tip hanging over a control that has moved out from under it.
Re-placing rather than dismissing was considered and is wrong: the honest answer
to "that control is no longer where you asked about it" is to stop answering.

**A disabled button fires no pointer events**, so `.control` now carries
`aria-disabled` and an inert `onClick` instead of `disabled`. Under a `title`
this did not matter, because the platform draws a native tooltip for a disabled
control anyway. Under any tooltip the page draws itself, it loses exactly the
tooltip worth having: all five of these are the sentence saying what would make
the button work. The stylesheet followed, in four places.

**The SVG half hides.** `Bracket` and `SilhouetteSvg` used a `<title>` child,
which is the same platform tooltip by another route and which grepping for
`title=` never finds. `tip.test.ts` censuses both, and tells a component prop
(`<Confirm title=…>`, fine) from a DOM attribute by walking back to the nearest
tag and testing its case.

**A tooltip that repeats what is on screen is noise.** The palette's rows passed
`c.hint ?? c.subtitle`, and the subtitle is printed two lines under the pointer.
The fallback is gone.

**The focus path is near-dead, and not because of anything here.** `App.tsx`
prevents the default of every key it matches and `bindings.ts` claims bare `Tab`
for stepping the selection, so the focus ring does not move in this app at all.
The `onFocus` handlers stay — they are correct the moment that changes — but
keyboard reachability of the whole control surface is a bigger question than a
tooltip and belongs to whoever picks up `bindings.ts`.

### The bar is groups now, and on a phone it is one button

Two changes, and the second is the reason the first was worth making.

**The buttons are grouped, and a group wears a `ModeChip`'s anatomy** — a
small-caps mono caption over a recessed track. That is the same argument the
canvas-mode panel settled when three free-floating chips became one panel: a
reader has to be able to see where the pressable thing starts *without reading
any of the words in it*, and eight bare buttons on a strip of scrim gave them
nothing to see. Four groups: **Concestor** (the app's mark, and the palette
under it), **Add species** (`S` and `R` as *search* and *random*), **Canvas**
(expand, clear and share, opposite corner), **Navigate** (fit, isolate, step,
second row).

**Below 620px none of it is drawn.** The bar, the canvas-mode panel and the
scale switch all go, and one 54px circle wearing the app's mark sits bottom
right, above the timeline, opening the palette.

Seven things not to redo:

- **The swap is legitimate because of a rule the app already kept**, not
  because of anything arranged for it: every control has a command, and the
  palette's own field searches 2.7M species as well as the command list. So one
  tap reaches the search, the random pick, clear, share, the axis, the labels,
  the ages and the light. The one thing with no command is `step`, and losing it
  is correct — stepping a selection with no keyboard to step from is meaningless,
  which `bindings.ts` said where the key was claimed, years before this.
- **The button is rendered inside the canvas, not beside the bar it replaces.**
  It rides `--axis-h + --lane-h` exactly as `.canvas-modes` does on the other
  side, so an open drill lane moves it instead of covering it — and `--lane-h`
  is published by `Graph.tsx`, because that is the only thing that knows the
  lane's height. That is the whole reason `onPalette` is a `GraphProps`.
- **The media block has to sit at the foot of the stylesheet.** It hides
  `.canvas-modes`, which is declared two thousand lines below the control bar,
  and at equal specificity the later rule wins. The first draft put the block
  with the bar and drew nothing but a permanently hidden button.
  `chrome/Controls.test.ts` caught it and is what keeps it caught: four rules in
  three sections of one file have to agree, and getting three of them right
  fails silently — the app just opens on a phone with no way to add a species,
  or with a floating button *and* the bar it was meant to replace.
- **`share` has no row in `bindings.ts` and must not get one.** That table is
  *every key this app claims*; share has no key on purpose (`s` and `l` are the
  two most-used letters here), and a keyless row in a key table is a lie about
  what the table is. `ControlAction` is a union instead, so the one control with
  no binding is *required* to carry its own label and hint, and `Controls`
  prints no badge where there is no key to print. It used to carry a `no-key`
  class as well, for the 720px rule that hid every label and then had to put
  share's back; **that rule is gone and so is the class** — a control keeps its
  word at every width the bar is drawn at, so there is no width at which a
  keyless button could be empty, and the guarantee that share has words sits
  entirely in the type. `Controls.test.ts` asserts both halves, because a rule
  hiding `.control-label` is exactly the kind of thing that comes back in a
  stylesheet without anything erroring.
- **The `chrome` field on a binding is gone rather than updated.** It said
  which rows the bar drew and at what prominence, and it could never be the
  whole answer — `App.tsx` composes the bar and always did, the bar now holds a
  control with no row in that table at all, and a flat flag cannot say which of
  four captioned groups a button belongs in. Its one live use was
  `secondary`, meaning "drop me below 620px", which is a width where nothing is
  drawn any more.
- **The inline mark is a third copy of the icon, and it is pinned.** The favicon
  is already two copies in two languages — the SVG and `make-icons.py` —
  and `icons.test.ts` exists because of it. `BrandMark.tsx` cannot import the
  SVG (that file bakes in a black plate for a white tab strip, and literal hex,
  neither of which belongs on scrim), so it restates the geometry and the test
  compares the three circles attribute by attribute. It takes `currentColor`
  and the test refuses any hex literal in it, because the reason it is a
  component rather than an `<img>` is that it *can* read the app's accent.
- **The tip outline is a run of groups now, not of buttons.** `TIPPED` is
  exactly the bar's `lead` slot, and it has to stay exactly that: `Controls`
  outlines a contiguous run of groups whose *every* action is marked, so a
  fourth button in either group silently takes the outline off both. The button
  on a phone carries the same pulse, because the bar that would otherwise
  carry it is not on screen and the reader who has just been shown a tree they
  did not build is exactly the one who needs telling where their own species go.

### Fullscreen is on `E`, and the button says the word rather than the letter

A tree is wide and the browser's own chrome — tab strip, URL bar, bookmarks — is
the easiest few centimetres of it to buy back. The toggle is the first control in
the **Canvas** group at the top right, beside clear and share, on what all three
have in common: they act on the canvas as a whole rather than on anything
selected in it. `chrome/fullscreen.ts` is the whole implementation and
`chrome/fullscreen.test.ts` pins the two failures that are invisible from the
outside.

Six things not to redo:

- **`F` was asked for and is refused.** `f` is fit and `⇧F` is fit-selection.
  The precedent that looks like it licenses a move is the axis giving `l` up to
  the labels, and it does not reach here: that trade was allowed because `l`
  names *labels* better than it names a logarithmic scale, so the letter went to
  the thing it described. `f` names *fit* exactly, so the swap would buy nothing
  and cost a reader the most-pressed key on this canvas. Printing `F` on the
  button anyway is the option refused hardest — the entire reason the bar reads
  its badges out of `bindings.ts` is that a key cannot print one thing and do
  another. `e` is the nearest free mnemonic: expand, enlarge, enter.
- **The button then says "Fullscreen", not "Expand", and the letter is left to
  disagree with the word.** This is not a new exception: `P` has printed
  **Commands** since the bar was built, because `p` names the palette and the
  word names what opening one is *for*. **Expand** was tried first for the
  symmetry with every other row, and it is wrong twice over — it names the
  gesture rather than the result, and this canvas already has things you expand,
  since a drill lane opens and isolate narrows, so a reader scanning for more
  room can fairly read it as being about a clade. A badge teaches the key and a
  label teaches the action; where they cannot be the same word the label wins,
  because a reader who cannot find the control never gets as far as learning its
  letter. `bindings.test.ts` pins the word *and* pins that these two rows are the
  only ones allowed to disagree — the tidy-minded fix is to rename the odd one
  out back to something starting with E, which is exactly how "Expand" arrived.
  The palette's row is the one place that still varies its wording, saying **Go
  fullscreen** or **Leave fullscreen**: a row is read once, in a list, with no
  lit state beside it to say which way the press goes.
- **The state is read off `fullscreenchange`, never remembered.** A reader leaves
  with Escape or F11 as often as with this button, and the browser takes Escape
  *before* the page sees it — so `App.tsx`'s `escape` case never learns, and a
  boolean flipped on each press is wrong within one keystroke: a lit button over
  a window that is not. The listener also syncs once on mount, because a reload
  inside an already-fullscreen window fires no event at all.
- **A refused request has to reach the reader.** `requestFullscreen` *rejects*
  rather than throws when the browser declines — a spent gesture, an iframe
  policy, a window manager — so the version without a `catch` is a button that
  does nothing, says nothing, and logs into a console nobody has open. It comes
  back as a warning toast. **`exitFullscreen` is deliberately silent**: its only
  failure is the document having left fullscreen between the check and the call,
  and telling a reader looking at a windowed canvas that we could not unwindow it
  is noise.
- **No fullscreen means no control, not a greyed one** — the opposite of the
  bar's own "disabled, never hidden", and the split is capability against state.
  A greyed `fit` says "add a species and this works"; a greyed fullscreen would
  say "your browser will never do this" to somebody who cannot act on it.
  `BIOLUM_AVAILABLE` already made this call. `FULLSCREEN_AVAILABLE` is asked once
  at module scope and gates the bar button and the palette row from the *same*
  expression — `Controls.test.ts` counts the readers, because gating them apart
  is how an iPhone (no element fullscreen at all) ends up holding a command for a
  thing that cannot happen.
- **`:root:fullscreen` has to state the void.** `body` carries the background and
  the root has never carried anything; fullscreen paints the root. Without the
  rule the browser frames a dark instrument in its own default, which is a thing
  you only find out about from a screenshot somebody else took. Nothing else was
  needed for the canvas itself — fullscreen is a window resize, and `Graph.tsx`
  already reframes on one if the reader is at the fit and leaves their view alone
  if they are not.

**The ETag names the code as well as the dataset, and `/v1/about` is no longer
immutable.** `api.etag` was `store.BuildID` alone, which hashes the artifacts on
disk and nothing else, so a release changing only Go code emitted a byte-identical
validator against an unchanged URL under a one-year `immutable` — v0.23.0 shipped
`layout_spread` to nobody with a warm cache. It is now `"<build_id>-<code_id>"`,
the container tag's shape for the container tag's reason, with `code_id` falling
back to a fingerprint of the executable where no commit was compiled in.
`docs/deployment.md` §5 is the account. Seven things not to redo:

- **`computeBuildID` stays dataset-only.** Folding the commit in was the first
  instinct and it is wrong: `/v1/about` publishes that number as the *dataset*'s
  name, and there are already two build ids in this system that must not be
  conflated. The ETag is the one place they are combined.
- **The validator fix alone was not enough, and this is the half worth
  remembering.** It makes every conditional request correct — the old code
  answered `If-None-Match` with a wrong `304`, actively confirming stale
  content — but under `immutable` a browser never sends one, so the corrected
  ETag was a validator for a request that is never made. `/v1` is now
  `public, max-age=3600, s-maxage=31536000`: **the lifetime is two numbers
  because the two caches are corrected by different means.** A deploy is a new
  Worker version and the edge cache is keyed by version, so the edge keeps its
  year; nothing corrects a browser, so it gets an hour and the ETag does the
  rest. The revalidation is answered by the edge from its own copy and does not
  wake the container. The `-immutable` flag went with the header, renamed
  `-public-cache`.
- **URL versioning was the other candidate and is refused** — deployment.md §5
  has both, and versioning loses because the client learns the id *from*
  `/v1/about` and would queue the whole boot path behind it. **One endpoint
  takes it anyway**: `/v1/random-pool/{build_id}` is off the boot path and its
  body is a list of node indices, which are meaningless outside the build that
  assigned them, so there the objection does not apply and the alternative is a
  stale pool answering with a plausible wrong animal.
- **Nothing un-sticks a copy cached before this shipped.** Same URL, and the
  stored response says not to ask. Those last a year. It cost nothing only
  because the app had no readers yet.
- **A deploy is two things and they are not atomic**, which is a separate bug
  the same afternoon found. The Worker version flips at once and the container
  pulls 2.2 GB behind it — ~3 minutes measured — and Workers Cache is keyed by
  version, so requests in that gap are answered by the **old** container and
  cached under the **new** version for a year. Verifying the deploy is what
  triggered it. The remedy is manual and is two commands in deployment.md §5:
  wait for `/v1/about` to report the pinned commit, then deploy again, because
  a new version is the only purge Workers Cache has. It **was** automated in
  `deploy-web.yml` and the automation is gone — the runner cannot reach
  `concestor.com` at all, so the step read "unreachable" as "still rolling" and
  stalled every deploy for its full ten-minute window while protecting nothing.
  A guard that cannot see what it guards is worse than a documented step.
- **`/v1/about` is `max-age=60, must-revalidate`, not `no-store`.** It is the
  endpoint that answers "what is running", so it must be askable again; but it
  is fetched on every page load, and `no-store` would take request collapsing
  off the boot path on half a vCPU.
- **That same minute makes it the warm-up, and now the boot probe.** A
  `must-revalidate` at 60 s is what makes this request reach the container on
  every boot, where an immutable one would not — so it is what wakes a sleeping
  container, and the frontend asks it **first** rather than second to start that
  wake a round trip earlier. It replaced a `ping()` that fetched `/healthz`,
  **which could not fail**: that route is on the Go mux and nothing routes a
  non-`/v1/*` path to the container — `run_worker_first` covers `/v1/*` and
  `not_found_handling: single-page-application` answers the rest with
  `index.html`, and vite's fallback does the same under `scripts/dev.sh`.
  `curl -sI https://concestor.com/healthz` returns `200 text/html`, the app's
  own shell. So the probe reported the API healthy whether or not it was
  running, the boot-error screen was **unreachable in production for its entire
  life**, and its copy had drifted to telling readers to run `go run ./server`.
  It only ever worked in the mode it was written in — the Go binary serving both
  halves off one origin. A probe that cannot see what it probes is the same
  defect as the deploy guard two bullets up.

### The front door was selling a weaker product than the one behind it

Three claims a first-time reader met before anything was drawn, all wrong, none
of them reachable by any gate. The pattern is worth more than the three fixes:
**prose is the only output in this repo that nothing validates**, so an error
introduced by editing a sentence survives every check, and all three of these
were introduced exactly that way.

- **The species count has been wrong twice, and the second time was while
  fixing the first.** Five surfaces said 2.7 million, which is the *node* total;
  339,807 of those are groups, and calling a group a species is the one error
  the sentence inviting somebody to search cannot make. It arrived by deletion
  rather than invention — the palette's waiting line named the species count and
  the fossil count together, the second was dropped as plumbing, and the
  survivor was rounded up on the way through. The correction then reached for
  the **tip** total, which is a third wrong number: tips include subspecies,
  varieties, cultivars and 1,615 group-rank terminals, while 21,977 species are
  internal nodes with subspecies beneath them, so tips and species disagree by
  about ninety thousand in each direction at once. The figure is
  `rank='species'` — 2,295,972 — and `data-sources.md` now states all three
  counts and which question each answers. The lesson is the one the guard was
  rewritten around: **ban the shape, not the string.** `corpora.test.ts` refuses
  any hardcoded "N million species" outside `corpora.ts`, across `web/src`, the
  stylesheet, `index.html`, the Worker and the README — a guard on the two
  strings already known to be wrong caught neither the tip count when it was
  written nor the four comments still carrying their own copy of it. **The
  fossil corpus is deliberately not added in** — the catalogues overlap by name,
  32,386 accepted PBDB taxa being nodes, so any sum double-counts.
- **A pair is the weaker product, and the card was selling it.** Both
  descriptions, the README and the boot lede all opened "pick any two species",
  directly above a carousel of fifteen questions none of which is a pair. (The
  `<title>` never did, and an earlier draft of this bullet said it had — in a
  paragraph whose thesis is that unvalidated prose is where this repo goes
  wrong.) `openings.ts` had already written down why: *a pair draws one number.
  Three or more draw an argument — the nesting itself is the proof.* So the
  most-repeated sentence about this product contradicted the file that decides
  what the product opens with. `meta.test.ts` now asserts the absence — the
  count, not the phrasing, so the copy stays free to change.
- **A link carries the tree, not the view.** The share command said "all view
  state lives in the URL" while the bioluminescence command four rows above it
  said *a tree you share arrives unlit, however you are reading it*. Both were
  in the same list. `store.ts` is right and the share row was wrong: the tree,
  the axis, the selection, the isolate and the drill are in the link, and the
  labels, ages and light are in `sessionStorage` because a setting that is a
  claim about the **reader** may not ride in one. The about page's feature is
  "Every **tree** is a link" now, and the one-word change is the whole claim.

The fourth thing found is not fixed and is not a copy bug: **the best-positioned
artifact in the product is the one nobody opens.** `/about` leads with what this
is for, names the educator use case in its subhead, and carries the divergence
witness — *"a fossil that was alive at each split"*, the one thing here nothing
else does — and it is reached from a link held below the canvas's own contrast
in the corner of the axis footer. The witness now appears in the description
every shared link unfurls into and in the README's first sentence, which is the
cheap half. The expensive half is that a reader who never opens `/about` is
still told none of it, and `analytics.md` §2 can already answer whether that
matters: the `sequence` / `sequence-cut` / `open` causes are instrumented, the
conversion query is written down, and nobody has run it.

**The about page stopped asking the reader to think of a species first.** It
had one door — *Draw a tree* — which lands somebody who has just read four
paragraphs on an empty canvas and asks them for a name, the exact cold start
the openings were built to remove. It now has two, and the second hands the
canvas *Are you a fish?* and lets `state/sequence.ts` build the answer through
the ordinary code path. **Do not replace that with a recording.** A video of
this app is a claim about a build that has shipped since, and the sequence
module is already the thing the carousel drives, so the demonstration cannot
drift from the product. Two things not to redo: the handoff is `sessionStorage`
because `main.tsx` unmounts the app to show the page and there is no store on
that side, and `takeOpening` **clears as it answers** — `leaveAbout` is usually
`history.back()`, so a request that outlived being answered would rebuild the
demonstration over whatever the reader assembled next, for the life of the tab.

**The known gap, and it is the educator's:** there is still no image export.
`share` copies a URL, and for the audience the hero names in as many words — *a
slide, a video* — "worth showing someone" currently cashes out as a link they
must open live. It is not a copy problem and it was left alone deliberately
rather than missed: compositing the WebGL water under React Flow's SVG at an
export resolution, with the fonts and the axis, is a real piece of work and it
lands squarely on the renderer. It is the next thing worth building.

### Search forgives a typo, and refuses to forgive a missing name

Eighteen real queries were pulled from Workers Logs for 2026-07-29→08-04 and
replayed against the built dataset. Forty-seven settled strings, **eight**
returning nothing, and they were not one problem. `ardvark` and `betual` are
typos — one edit and one transposition from a string the corpus holds. `hard
maple` and `hard oak` are correctly spelled English names the corpus **does not
have**; `hard maple` is a real name for *Acer saccharum* and its distance to the
nearest name in the corpus is 3–4 on a ten-character string. `zzzqqq` is this
project's own benchmark string. `about` is a *command*, answered client-side and
never a search failure at all. Only the first two are this work's business, and
keeping them apart is the whole design: ship fuzzy matching, watch `hard maple`
still return nothing, and the next person loosens the threshold until search is
useless.

Settled as: **correct the query, never relax the matcher.** `/v1/search`
answers exactly as before; only when both corpora come back empty does
`store.Suggest` run, and then the *unchanged* search runs again on the corrected
string. Bands, `Interleave`, `notInTree` and the client are untouched, and every
query that worked pays nothing — which is the point on a `standard-1` container
with half a vCPU. `pipeline/src/concestor_build/spelling.py` is the account and
`server/internal/store/spelling.go` the serving half. Seven things not to redo:

- **`hard maple` is refused by the *key*, not by the threshold.** Its key is
  `hrd mpl` and `sugar maple`'s is `sgr mpl`, so it yields **no candidates at
  all** and the distance code is never reached. That is why the phonetic key
  comes first: a design where the cap is the only guard is one where raising the
  cap reaches a wrong answer. `spelling.REFUSALS` gates it in the pipeline and
  `TestRefuses` in Go, so loosening this fails the build in two places.
- **Double Metaphone was refused on the cost of *two implementations*.** The
  pipeline computes the key for 1.2M corpus words and the server computes it for
  the query; when they disagree the lookup returns an empty bucket, which is
  indistinguishable from a word nobody misspelled. Several hundred lines of
  order-dependent rules, twice, is two chances at an invisible failure. The key
  is fifteen lines instead — drop vowels, `ph`→`f`, drop silent `h`, collapse
  runs — and measured over twenty misspellings that scores **19/20** against
  plain vowel-dropping's 16/20. `TestKeyAgreesWithTheBuiltIndex` samples the
  built table and recomputes it, which is the contract; a test over invented
  pairs would only prove the two agree about pairs somebody thought of.
- **Every further English sound rule was tried and cost more than it bought.**
  Folding `c`/`k`, `z`/`s`, `v`/`f` and `x`/`ks` gained one case and put
  `zzzqqq` in a bucket with **69** candidates, where under the shipped key it
  has one. Do not re-derive Metaphone a rule at a time.
- **The unit is the word, and whole names were built first.** Whole-name
  matching is 7× the index — **362 MB against 50.6 MB**, because it stores
  6.16M complete names against 1.25M distinct words — and it cannot correct
  `betual pendula` at all, since the misspelling is in the leading token. That
  matters more than it looks: with typeahead a *trailing* typo still has the
  prefix's results on screen, so the misspelling that actually kills a query is
  always the first one.
- **The length floor is where all the precision is.** Words are denser than
  names, and every false correction measured came from a short one — `suag`→
  `sag`, `about`→`abut`, `abot`→`abt`, each a single legal edit on four or five
  characters. Refusing to correct anything under six characters takes the
  false-correction rate on random junk from **25.3% to 0.5%** and costs nothing:
  every misspelling in the measured corpus is six characters or longer.
- **Damerau, not Levenshtein, and `betual` is why.** Under plain Levenshtein it
  is two edits from `betula` *and* two from `betel` — a different plant — and
  the shorter string wins the tie, so the reader who typed a birch got a
  spice. Counting a transposition once makes the right answer the only answer
  inside the cap.
- **The corpus is both catalogues.** *Triceratops* is not in `search_name` at
  all — it is a PBDB taxon — so a corrector reading only the node corpus
  corrects toward the wrong catalogue. Two further refusals, both cheap and both
  load-bearing: a word the corpus already holds is never a typo (`racoon`,
  `squirel` and `tyranosaurus` are all real registered names, so the search
  answers them and this never runs), and **a correction that yields nothing is
  not a correction** — the server re-runs the search and reports the fix only if
  it produced results.

And the surfacing rule, which is the same one `age_tier` states: the correction
is **shown, never performed silently**. `SpellingNote` leads the list — a
caption on the rows below, unlike `BrokenNote` and `UndatedNote`, which footnote
rows that are *not* there — and names both strings, because the reader needs to
see what was misread to judge whether the answer is theirs. The literal is not
offered as a link: it is reachable and it is empty, and a link promising results
that do not exist would be a second wrong answer.

**Non-ASCII words are not indexed and never corrected** — 3,424 of 1,250,845
distinct words, 0.27%. That buys the whole Unicode question: without it Go needs
`golang.org/x/text` to agree with Python's `NFKD`, which is a dependency and a
second thing to keep in step for a quarter of one percent of a corpus nobody
misspells.

**`hard maple` is still unfixed and that is deliberate.** It is a phase 6
coverage gap and it needs its own work — measure how many well-known English
names are absent from `vernacular` before building anything, and note that the
Wikidata crawl cannot be assumed to fix it, for the same reason it cannot fix
`oak`. §7 has the bound.

### Readership: four sources that fail differently, and no single number

`docs/analytics.md` is the account and §9.6–§9.7 are the part written last.
The decision worth carrying up here is the negative one: **do not reconcile
these to one figure, and be suspicious of any answer that does.** Measured
2026-08-02→04, the same three days, the same site:

| Source | Says | Fails by |
|---|---|---|
| Zone GraphQL (`httpRequests1dGroups`) | 237 unique IPs in a day, 36 countries | counting scanners as readers |
| Workers Logs | 52 IPs invoked the Worker, 22 drew a tree | blind to every cache hit |
| Web Analytics (RUM) | **83 visits**, 3 countries | dropped by any content blocker |
| Analytics Engine (the beacon) | 20 sessions, 189 events | only exists once somebody acts |

The honest statement of outside readership on 2026-08-04 was **a handful, and
the range is the answer** — most of the traffic in every store is this
project's own machines, and the one most engaged outside reader is invisible to
the instrument built for counting readers, because RUM's beacon is a
third-party script and they blocked it. For a product aimed at curious
tinkerers, that bias is structural: the reader most likely to block it is the
reader most likely to enjoy the thing.

Five things not to redo:

- **`/v1/about` is not a proxy for "the app loaded".** It is one well-known URL
  on an API and scanners probe it by name — 26 of its 38 addresses were
  datacenter, most making a single request, and the same log shows `/.env`
  fetched 28 times. `/v1/silhouette/…` is the honest load signal because it is
  thousands of URLs only the running app knows to ask for. Even that catches
  JS-executing crawlers.
- **Comparing unique-IP counts across paths measures URL cardinality too.** A
  cache hit does not invoke the Worker, so every stage is a floor, and the
  single-URL stages hide more readers than the many-URL ones: `/v1/about` 38%
  hit, `/v1/timescale` 30%, `/v1/silhouette/*` 25%, `/v1/search` 10%.
- **Bot score is Enterprise and this zone is Free.** `botScoreSrcName` is
  refused outright. `cf.verifiedBotCategory` exists but named only 14 requests
  of 4,591; the discriminator that worked was `cf.asOrganization`.
- **A beacon event cannot be grouped by geography.** The seven fields group
  against each other, but city and ASN live on the *invocation* record and the
  Query Builder groups rather than joins — the result is empty, not sparse.
  Group the requests to `/v1/e` instead, which happen only when there is an
  event to send.
- **`refererHost` in RUM is the only place distribution is visible anywhere.**
  It is what showed the first organic Google arrivals and the first link pasted
  into somebody's Teams chat. Nothing else in any store can see that.

### Reading any of this needs no credential this project holds

Every figure above was pulled through Cloudflare's own MCP servers, which carry
their own OAuth and are connected per-session rather than stored here. That
matters because the previous account in `analytics.md` said twice that a token
would have to be minted, and it does not.

| Server | Reaches |
|---|---|
| `cloudflare-observability` | Workers Logs: keys, values, query builder |
| `cloudflare-api` | **any** REST or GraphQL endpoint, via its `execute` tool |
| `cloudflare-builds`, `cloudflare-bindings` | Workers, D1, KV, R2 |

`cloudflare-api`'s `execute` is the general answer and the one to reach for
first — it took the RUM datasets that refuse the wrangler token. What still
uses the wrangler OAuth token is `scripts/analytics-report.sh`, per
`analytics.md` §4, and that stays true: it is the only path that resolves a key
to *Apis mellifera*, because that join needs the 1.9 GB local database and no
hosted surface can do it.

### The species palette opens on a list, and it is species rather than openings

`S` used to open on one grey line — *Type to search 110,794 species* — which
names the size of the corpus and nothing a reader can act on. It is the worst
line the app had: a blank field already asks for the two things an exploring
reader lacks, the right word and the confidence it will work, and a count is
just the number of ways to be wrong. It now opens on **Recent** over **Start
here**, ten curated taxa, each an ordinary palette row one press from the
canvas.

Thirteen things not to redo.

**An opening may not go here, and the refusal in `openings.ts` still holds.**
An opening *replaces* the canvas — it clears the selection and plays several
taxa in a scripted order — where every row in this palette *adds*. A row that
silently destroys the tree the reader has been building is the failure, and it
would be indistinguishable from the rows above and below it. The carousel on
the empty canvas is where an opening belongs and it is already there, with its
question written out. That is also why the two files do not share a list: these
are single species, chosen on different criteria, for a different press.

**The rows are `RowView`, unchanged.** Same anatomy, same silhouette, same `↵
add`, same *on canvas* accessory when the taxon is already drawn — so arrow
keys, Enter and the present-set all work by construction rather than by a
second implementation. Giving suggestions a shape of their own was the obvious
first move and is what Raycast's grammar rule already forbids elsewhere in this
component.

**The bands are pinned, not scored.** Every suggestion row ties — there is no
query, so `litRanges` lights nothing and every fuzzy score is identical — so
left to float they would order on whichever band was built first. `sectionRank`
replaces `tailRank` and returns negative for a head section; a title cannot be
listed in both lists and get a different answer depending on which was asked
first.

**A head section always prints its heading, even alone.** The existing rule
suppresses a heading when there is only one section, correctly, because
"Species" over the only rows on screen labels the obvious. On a first visit
"Start here" *is* the only section, and without the heading it is ten species
sitting in a field nobody searched — which reads as leftovers rather than as an
offer.

**Suggestions stop at `MIN_QUERY`, read from the same constant the search
uses.** A band still standing beside real results competes with them. This is
the same class of bug the four `emptyState` values exist to separate, and it
shares their floor deliberately.

**Only under the species filter.** `P` already opens on the full command list,
which is a good empty state and the one this surface was modelled on; ten
species above it would bury the commands to fix a problem the root palette does
not have.

**The client says *which* and the server says *what they are*.** `starters.ts`
holds keys and nothing else. Name, rank, tip count and resolved silhouette are
facts about the deployed build, and a client that baked them would ship one
build's answers to readers on another — a stale `idx` resolves cleanly and
describes a different animal, which is the `node_fts.rowid` trap arriving
somewhere new. `/v1/hits?keys=` dresses them at read time and **skips unknown
keys rather than erroring**, because OTT forwarding is silent and one retired
id must cost one row rather than the whole empty state. It shares `batchKeys`
and its 200-key cap with `/v1/paths`, since a cap enforced on one of the two
key-list endpoints is a cap on neither.

**Cacheability is the whole performance story and it is declarative.** The
response is a pure function of the key set and the build, so it carries the
ordinary long-lived `Cache-Control` and ETag: one fixed URL, one edge entry,
and the container answers it roughly once per Worker version. It is prefetched
on boot beside `/v1/about`, so pressing `S` hits a settled memo and the list
draws on the first frame — 3.4 KB, measured under 1 ms at the origin, and
nothing was added to `worker/index.ts`, per `deployment.md`'s prohibition on a
path allowlist there.

**The build id is deliberately not in the path, and the contrast with
`/v1/random-pool/{build_id}` is the thing to understand before copying either
one.** The pool answers with bare `idx` values, which mean nothing outside the
build that assigned them, and the client *holds* that list — so a stale id
there is a plausible wrong animal, which is what buys the path segment and the
404. Neither half applies here: the request is OTT keys, which survive a
rebuild, and the response is consumed immediately rather than kept. Versioning
this URL would also cost what §"URL versioning is refused" already priced —
the id is learned *from* `/v1/about`, so the prefetch would queue behind it
instead of going out beside it. What *is* held across builds is
`palette/recent.ts`'s stored rows, and those carry the build id for exactly the
pool's reason.

**Recents are `localStorage` where the canvas modes are `sessionStorage`, and
the precedent was already there.** The mode rule is about *settings* — a claim
about the reader that must not ride in a shared link — and neither property
holds here: a pick changes nothing about how a canvas is drawn, and history that
dies with the tab has never once been useful. But this is **not** the app's
first `localStorage` value and should not be written up as an exception:
`fuzzy.ts` has persisted a recency-and-frequency table under
`concestor.usage.v1` since the palette got its ranking, on the same distinction.
This band is the visible half of something the app already did. Whole rows are
stored rather than keys so it draws with no request, which is why the blob
carries the **build id** and is dropped whole on a mismatch — losing six rows to
a deploy is cheap, showing the wrong six is the failure.

**One command clears both stores, and that was a bug before it was a feature.**
The palette has had *"Reset search ranking / Forget recency and frequency
history"* since long before this band. Adding a visible **Recent** list without
touching it would have produced the worst possible split — the store nobody can
see gets forgotten, and the one the reader is actually looking at appears to
ignore them. It is now *Clear search history*, running `resetUsage` and
`forgetRecent` together. Two stores rather than one because a usage count and a
whole search row are different shapes with different staleness rules and only
one of them carries a build stamp; one *command* because to a reader they are a
single thing. **The command id stayed `reset-ranking`** — `sessionBoost` is
keyed on it, so renaming it would silently discard whatever ranking that row had
accumulated. The general lesson is worth more than the fix: a new store is also
a new promise, and the promises already written down are the first place to look
for what it just broke.

**The curated list is gated in Go, against the real database.** `hits_test.go`
reads `web/src/palette/starters.ts` and checks every key resolves, has a name,
has a **rank-1 English common name**, and has `node_image.climb = 0`. Nothing
else in the stack catches the last two: phase 5 gives all 2.7M nodes an image
by climbing to a relative, and `hitSilhouette` ships with suppression at
infinity, so a borrowed drawing renders perfectly happily and belongs to
something else. Those two constraints rejected *Agaricus bisporus* (climb 2,
and headlined **cremini**), *Formica rufa* (**horse ant**) and *Blaberus
giganteus* (no common name at all) — all three of which `openings.ts` uses
successfully, because a carousel tile captions its own drawing and a palette
row does not. *Felis* is kept out by the third constraint, species-not-clade: it
is `climb` 0 and headlined **cat**, and a genus drawn at its crown age reads as
a living group that stopped. The gate was verified to bite by adding the
mushroom back and watching it fail.

**Breadth beat recognisability in the curation, deliberately.** Ten mammals
would be more instantly nameable and would teach the reader this is a mammal
app. The ten cover primate, carnivoran, whale, fish, reptile, bird, mollusc,
insect, plant and fungus, because the list is the only place "all of life" is
ever *shown* rather than asserted. The lion was the closest cut — it is a
perfectly good row, and the dog already holds the familiar-carnivoran slot.

### The components can be rendered by a test now, in a second vitest project

The gap was harness rather than culture, and that distinction is the whole of
why this took one small PR. `vitest.config.ts` was three lines — `environment:
"node"`, `include: ["src/**/*.test.ts"]` — so a `.test.tsx` would not have been
collected even if somebody had written one, and roughly 8,000 lines of `.tsx`
had no behavioural coverage of any kind. Everything around it was already
right: `tree/induced.ts` is pinned to a Python reference built from the real
baked arrays, `canvas/gl/tuning.test.ts` proves a float invariant with a stated
tolerance, and `chrome/tip.ts` exists as a separate module *specifically* so the
tooltip's arithmetic could be tested — its header says so, in the words "this
project having no DOM to render into."

Two projects rather than one environment. `node` keeps exactly the tests it had
in exactly the environment it had them in — 614 of them, about 350 ms — and
`dom` boots jsdom beside it. Switching globally would have cost that speed for
every pure module in the repo to serve the handful of files that need a
document, and the fast suite is the one people actually run on save.

Six things worth not redoing:

- **The filename decides the project, and there are two ways in.**
  `*.test.tsx` is a component test; `*.dom.test.ts` is a *module* test that
  needs a document anyway — `localStorage`, `sessionStorage`, `matchMedia`,
  `window`. The second door exists because `fuzzy.ts`'s persistence path is
  exactly that shape, and naming its test `.tsx` when it renders nothing would
  be a lie about what the file is. A node test that starts complaining a global
  is missing is a test to rename, not a reason to widen the config.
- **Naming `exclude` replaces it.** The defaults carry `**/node_modules/**`,
  and a project whose `include` is anchored at `src/` looks fine without them
  right up until it does not. They are spread back in.
- **Advance timers inside `act`.** This is the one that will cost an afternoon.
  `Tooltip.tsx` notifies its `useSyncExternalStore` subscribers from a
  `setTimeout`, and `fireEvent` wraps its own dispatch in `act` — so a
  *chained* tip, which `openDelay` opens with zero delay synchronously inside
  the handler, passes without `act`, while a delayed one schedules a render
  that is never flushed and the assertion reads the DOM from before the timer
  fired. The first tip of a run behaves differently from the second, which is
  the worst possible shape for a flake.
- **Module state outlives a test.** The tooltip store's `active` and
  `lastClosed` are module-level, so one test's tip is the next test's initial
  condition and `openDelay` will answer 0 inside `CHAIN_MS`. `Tooltip.test.tsx`
  has a `coldStart` that runs the clock past the chain; anything talking to a
  module singleton needs the same.
- **`fetch` throws in the harness rather than being mocked away.** jsdom
  inherits node's global `fetch`, which resolves against
  `http://localhost:3000` — so an unstubbed request in a component test does
  not fail, it *hangs* for a connection timeout and then fails somewhere
  unrelated. `setup-dom.ts` replaces it with something that says what to do
  instead: stub the `api` method you are exercising, not the transport.
- **The tests assert behaviour that could not have been a pure function.**
  `Palette.test.tsx` is the 110 ms debounce and the `AbortController` around
  `/v1/search`, both of which are properties of when React runs an effect's
  cleanup; `Tooltip.test.tsx` proves the two claims in that component's header
  that only rendered markup can settle — that `useTip` adds no element and no
  attribute to its trigger, and that `pointerdown` on some *other* element
  dismisses the tip. Each was confirmed to bite by breaking the source and
  watching the right tests, and only those, go red.

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

- **A slack factor can hide a measurement bug until a second one lands on top
  of it.** `labels.ts` measures every label with canvas `measureText` and
  reserves the box the placement pass then treats as truth, and its font
  constants are documented as having to match styles.css. Three had drifted, all
  under-measuring: the stack was written `ui-sans-serif, -apple-system,
  sans-serif`, which canvas resolves to a face **6.1% narrower** than the full
  `--sans` list; `.mark-age` renders at 11px and was measured at `.mark-meta`'s
  9.5, **15.8% short**; and `.mark.is-mrca .mark-label` sets `--w-med`, 560,
  which `.mark-name` inherits and which is **4.0% wider** than the 400 it was
  measured at. `SLACK = 1.06` exists to round against ourselves and was instead
  spending its whole margin on the first of those — so the app looked correct
  until a label hit a second mismatch and had nowhere left to go. "Primates",
  one word with room for it, broke as "Primate" / "s"; `Homo / Pan ≤ 6.7 Ma`
  wrapped to make space for a figure that then did not fit either. Four other
  measurements carried their own abbreviations of the same two stacks; they now
  read `SANS` / `MONO`. **The comment was right and unenforceable** — a comment
  cannot fail — so `labels.test.ts` reads styles.css and pins each constant to
  the declaration it claims to mirror, sizes, weight, letter-spacing, the age
  glyph's reserved width and the two line heights.
- **A CSS rule that draws nothing is not free, and the selector does not tell
  you which ones they are.** The sequel to the entry above, from the same
  branch. PR #23 shipped three declarations that rendered nothing, in two
  directions. `.mark-dot.flaring { box-shadow: … }` was the static substitute in
  the `prefers-reduced-motion` block, and `.mark-dot` sets `box-shadow` inline on
  every render, so the stylesheet always lost. `.mark-fossil` receives `flaring`
  in `NodeMark.tsx` and `.mark-fossil.flaring` did not exist, so grafts never
  flared. And `.mark.is-leaf .mark-label { font-size: 13.5px }` reached no text
  at all — a label has no bare text child and every row pins its own size — but
  an inline row is at least as tall as its **strut**, so the number silently
  became the height of any row that forgot to, and the figures row did exactly
  that and stood 17.9px against a reserved 15. That is the whole lesson: the
  cost of a dead rule is not the dead rule, it is what the value does on its way
  past. **Read the two rules that sit side by side and you learn nothing** —
  `.mark.is-mrca .mark-label { font-weight }` has the identical selector shape
  and *works*, because `.mark-name` sets no weight and inherits it. One property
  survives to an element that renders text and the other does not, and nothing
  about the selector says which.
- **Three ways to catch that were measured against the commit before the fixes
  and the commit after; two were built and two were rejected with numbers.** The
  criterion was **precision, not reach** — a check that fires on a dynamic class
  name is switched off within a week, and the real one goes with it. What ships
  is in `web/src/styles.test.ts`. **A modifier styled on some of the bases that
  wear it and not others** is flagged: on the pre-fix tree that is exactly one
  finding, `.flaring is styled on .mark-alive, .mark-dot but not on
  .mark-fossil`, and zero on the fixed tree. It is deliberately silent where a
  modifier is styled on *none* of its hosts, because that is a legitimate
  unstyled hook — `.card-action.add` carries no rule since `.card-action` styles
  the base and only `.remove` differentiates. And **a census of every font-size
  the label's text column can see** must equal the three `labels.ts` models;
  restoring the 13.5px makes it fail naming the selector. Rejected, and not to
  be re-derived: **cross-referencing every class in both directions caught none
  of the three against 17 false positives** — 9 classes applied with no rule, all
  legitimate, and 8 rules with no class, 6 of them third-party `react-flow__*`
  and 2 composed as `` `tier-${…}` `` — and it cannot see the third instance in
  principle, since both its classes are used and styled. **Flagging inline styles
  that collide with the stylesheet caught one of three against 13 false
  positives**, and the 13 are permanently false: inline `width`/`height` on
  `Silhouette`, inline `color` on the detail card, all of them a stylesheet
  default correctly overridden per instance. No static check separates that from
  a rule that was *meant* to win, so instance one stays uncaught on purpose.
  **Browser CSS coverage catches none of the three by construction** — it reports
  rules that never matched an element, and all three matched.
- **The fix was to delete the `font-size`, not to make it real.** Honouring the
  evident intent — leaves set larger than divergences — means moving the size to
  `.mark-name`, which needs a leaf flag on `LabelInput` distinct from `terminal`
  (a graft is terminal and not a leaf), two more font constants and two more
  assertions pinning them. That is a bill for a design that never shipped:
  `.mark-name` has been 12.5px for as long as the three-row label has existed.
  Measured in the running app, the container was in fact **inverted** — 13.5px on
  a leaf against the 14px an MRCA inherits from `body` — and nothing showed,
  which is the proof no reader was getting the intent. `color: var(--ink)` stays;
  leaves are already distinguished by ink and the MRCA by weight, and size would
  be a third channel saying what two already say.
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
- **A divergence wants a different picture from a clade, and now gets one.**
  `node_image` prefers the most inclusive drawing beneath a node, which is the
  right answer to "what does something in this group look like" and the wrong
  answer at a fork: the human–chimp split drew the generic *Homo*, Whippomorpha
  drew the Cetacea dolphin. Both are crown groups that did not exist when the
  lineages parted.

  `node_divergence_witness` is the second answer — a **witness**, a fossil
  taxon from *somewhere below* the fork whose stratigraphic bracket puts it at
  that split. The human path now reads Bilateria → *Dickinsonia*, Chordata →
  *Yuyuanozoon*, Gnathostomata → *Guiyu oneiros*, Sarcopterygii →
  *Ligulalepis*, Tetrapoda → ***Acanthostega gunnari***, Amniota →
  *Leiocephalikon*, Euarchontoglires → *Purgatorius*, Haplorrhini →
  *Teilhardina*, Simiiformes → *Aegyptopithecus*, Homininae → *Ardipithecus
  kadabba*, Homo/Pan → ***Sahelanthropus tchadensis***. Whippomorpha draws
  *Pakicetus*; Perissodactyla, which drew nothing at all, draws *Eohippus*.

  **A witness is a fossil, not a node, and that is the whole of the layer's
  reach.** It used to have to be in the synthesis tree, and only 0.5% of OTT
  taxa flagged extinct are, so the design capped out around 2,552 forks however
  many images anyone sourced. It now hangs off phase 4's `attach_idx`: a fossil
  attached at `a` may witness `a` and every ancestor of `a`. The full before and
  after, and the four steps it took, are in
  [witness-ceiling.md](witness-ceiling.md), **now shipped end to end** — read §9
  first, because two of the corrections it required cost more coverage than the
  change bought, and were right anyway.

  **The claim weakened and the wording weakened with it.** A witness inside the
  clade could say "a member of this group". A PBDB taxon is not in the tree at
  all, so architecture §3.4's phrasing is the strongest true one: *this taxon
  belongs somewhere below this node, and existed between these dates.*
  `attach_walk` — PBDB `parent_no` hops to an in-synthesis ancestor — is how
  loose that is, and the card renders it as three bands, not a number: *placed
  exactly here in the tree* (243 forks), *just below this point* (325), and
  *its exact position is not known* (317).

  **Two tables, not more columns, and the reason is not tidiness.** Which
  answer applies depends on how the reader reached the node — a species they
  picked wants its group's exemplar, a divergence they arrived at wants the
  witness — and the pipeline cannot know that. The client decides on the
  induced subtree's own leaf/internal distinction, in
  `web/src/canvas/witness.ts`. Merging them would force the choice at build
  time with the information missing, which is the same mistake as merging
  `age_ma` with `age_layout`.

  **The table was renamed rather than redefined**, and that is the same
  discipline as `node_fts.rowid` above. `node_divergence_image.source_idx` held
  a node index; `node_divergence_witness.pbdb_taxon_no` holds a PBDB taxon
  number. Identical shape, different universe, and a consumer joining the old
  column name against `node` joins cleanly and returns confident nonsense. The
  server reads either shape and says which through `WitnessSchema.Fossil()`.

  **A divergence draws its witness, its own picture, or nothing.** What it may
  never draw is a *borrow*. This reverses `SILHOUETTE_POLICY`'s "draw
  everything" for internal nodes, for a reason that policy does not cover: it
  judges a borrow by the *size* of the clade shared with the drawing, and what
  is wrong with a borrow at a fork is not size but **time**. Caniformia's split
  is dated 57 Ma and it drew Procyonidae — 469 species, well inside the
  threshold, and a family of living raccoons standing beside a fork that
  predates them by 25 Ma. The caption said "the closest relative anyone has
  drawn", which is true and warns nobody. A node's *own* drawing is exempt,
  because it was never a borrow; without that exemption Cetacea, Felidae and
  Homo went blank as forks, which is the rule failing rather than withholding.

  **`is_extant` is the hazard, and the flag does not carry it.** PBDB has
  *Mammalia* at 239.5–0 Ma, and a range running to the present contains every
  split inside it, so an unfiltered rule hands the biggest forks the crown group
  again wearing a fossil's label. Filtering on the flag is not enough: PBDB
  flags *Thalassia testudinum* — the living turtle grass — extinct, and it won a
  fork of 378,328 tips, alongside the roan antelope and a living foram at
  85.7–0 Ma. The rule is now checked against the bracket, which is the evidence:
  a witness's last appearance must predate the Holocene. That is what
  `HOLOCENE_MA` is, and it cost 222 forks including the dire wolf.

  **Coverage is not the measure, and spanning is not a clean one either.**
  Measured old rule against new on the same corrected corpus: 548 forks → 885,
  and spanning 207 → **192**. Spanning went down because 14 of the old 207
  spanned only by running to the present — *Moho braccatus*, a bird that died in
  1987, spanning Passeriformes at a 52 Ma gap. It is still the gate, because it
  does not rise when the rule loosens, and `MIN_SPANNING_WITNESSES` carries the
  whole comparison so nobody re-derives it.

  **`xref`'s cross-kingdom homonyms are fixed**, which had to happen first
  because this made the witness layer an `xref` consumer. Phase 3's
  `refuse_disagreements` withdraws a resolution where PBDB calls a taxon extinct,
  OTT's taxon of that name carries no extinct flag, and the node still has a
  chronogram-dated descendant — 16,833 rows, over every method rather than
  `name_exact` alone, since `gbif_backbone_provenance` supplies 7,191 of them. A
  second refusal takes 235 more where a name is still claimed by two accepted
  PBDB taxa, which is `_seed_by_name`'s rule ported. Phase 4's independent
  check went from **1,019 of 1,048** to **31 of 60**. Three details are
  load-bearing and all three are in `resolve.py`: the extancy sweep runs
  *before* the ambiguity one, so `Scopus` keeps the hamerkop and loses the
  Permian genus rather than losing both; it needs phase 2's `age_ma` as a
  living-lineage guard, without which 1,162 correct attachments go
  (*Neochelys*, *Baptemys*, *Roxochelys*); and `manual` overrides are exempt,
  because a reviewed judgement silently overruled is the failure the override
  gate exists to catch.

  Caniformia is the case that shows the coverage limit honestly, and it is why
  both knobs came off. It is dated 57 Ma and its oldest drawn *and* dated
  candidate is *Hesperocyon gregarius* at 39.7–18.5 Ma, 17 Ma adrift — better
  than the *Archaeocyon* it drew before the move onto attachment points, and
  still visibly a stretch. The stem carnivorans that would have fitted,
  *Vulpavus* at 56–45.9 Ma, sit inside Carnivora but **outside** Caniformia, so
  they are not candidates for it; Carnivora itself is `structural` and reaches
  *Vulpavus* only through the layout fallback below. Both render with their
  ranges on screen so the stretch is visible rather than hidden.

  Four refusals do the work, and they are why this fires on **885** forks
  rather than 28,831:

  - **No dated split, no witness.** `age_ma` must be finite, falling back to
    `age_layout` below. A fossil "near" a divergence nobody has dated at all is
    a claim about nothing.
  - **A candidate needs a bracket**, both `fea` and `lla`, read only as the two
    ends of a containment test and never as a position.
  - **A candidate must be extinct, and must have ended.** See `HOLOCENE_MA`
    above: the flag alone lets a living seagrass through.
  - **Exactness still wins.** A node with its own image keeps it and gets no
    witness, so Mammalia is Mammalia and not a Cretaceous monotreme — which is
    also why *Panthera* draws nothing as a fork.

  The ceiling is now the drawn corpus rather than the data model: **2,114**
  fossil taxa are drawn, extinct, dated and attached, out of 231,241 that are
  extinct and dated. Sourcing images finally moves this number, which it could
  not before.

  **`NEAR_FRACTION` is uncapped, and that is the second decision.** It shipped
  at 0.25 and gave 66 witnesses, which left the canvas too bare to be worth
  looking at — and the cap bought nothing, because a refused witness falls back
  to *no picture*, not to a worse one. The gap distribution is smooth — median
  17% of the split's age, p90 81% — so no threshold sits at a natural break,
  which is what makes this a preference rather than a finding. Uncapped, the
  ranking still does the work (nearest first, then the narrower bracket, then
  the firmer attachment) and both figures render together, so a poor match is
  visible rather than hidden. Dial it back by setting the constant; nothing
  else changes.

  **The layout fallback is the third, and the one to think hardest about.**
  Where `age_ma` is NaN — a `structural` fork, which nobody has dated — the
  match is made against `age_layout` instead. That unlocks 326 of the 885,
  including Carnivora → *Vulpavus*, all of which had nothing before. It
  does not breach the standing rule that a structural node never carries a
  number: the layout age is used to **choose** a picture and is never rendered
  as an age. The fork is already drawn at that position, so picking the fossil
  nearest to where the reader sees it is the consistent choice rather than a
  new claim — and both the tooltip and the card say outright that the split is
  undated and the pairing is by position. A gate reports the 326 so the share
  resting on a position rather than an estimate stays visible.

  **Reading `fea` is safe here** where phase 4 forbids it for
  layout: this is a containment test on `[lla, fea]`, never a position. What a
  junk-wide bracket costs is the tie-break, which prefers the narrower one —
  that is what puts *Sahelanthropus* (7.2–5.3) ahead of *Ardipithecus*
  (11.6–2.6) when both contain the 6.7 Ma split.

  **The dates are half of it.** A witness with no fossil range is refused —
  by the server now as well as the client, since the row carries its own
  bracket and a row without one is dropped rather than served half-resolved.
  The canvas tooltip and the card both read "*Sahelanthropus tchadensis*, known
  from 7.2–5.3 Ma, so it was around when these lineages parted, and this split
  is dated ≤ 6.7 Ma. It is placed exactly here in the tree." — a sentence the
  reader can check, with the placement's own uncertainty on the end of it.

  **Rounding can make a true sentence read as a false one**, and at these
  scales it does. Perissodactyla is dated 56.26 Ma and *Eohippus* tops out at
  56.0, so the card showed "56 Ma" beside "56–51 Ma" and then said the range
  does not reach the split. Every figure was right and the reader could see
  only a contradiction. The gap is now stated — *it stops 0.3 Ma short* —
  through `gapLabel`, which is deliberately **not** `maLabel`: a gap is a
  quantity rather than a position, and `maLabel` renders anything under
  0.05 Ma as "present", which would produce "it stops present short".
- **The node card's silhouette credit was reading fields that are not on the
  wire.** The server sends `creator`/`uploader`; `NodeDetail.silhouette`
  declares `attribution`/`contributor`, and `api.ts` translates between them at
  the boundary. The witness credit needed the same translation and did not have
  it, so it said "creator not recorded" about *Basilosaurus*, whose payload
  names Conty and T. Michael Keesey under a CC-BY-SA licence. Anything adding a
  second credit block must go through `normalise`; nothing else knows both
  vocabularies.
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
  second-corpus project — not a resolution one. The second corpus is specified
  and deferred; see §3 and [phase5c-decision.md](phase5c-decision.md).
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
  (8.7 KB gzipped, served from the long-lived cache, so this is immaterial —
  but the figure is
  quoted in two places).
- **`node_fts` is one row per *name*, not per node.** 6,834,727 rows against
  2,725,682 nodes, with `search_name` carrying `id → idx` and a `kind`.
  Architecture §3.3's sketch implies `rowid == node.idx`, and joining that way
  **does not error** — it joins cleanly to unrelated nodes and returns confident
  nonsense. Searching "dog" returned three unnamed `mrcaott…` internal nodes.
  Anything reading the index must go through the mapping table.
- **A view toggle that does not reach the layout is worse than no toggle.**
  `axisMode` reached `TimeAxis.tsx`, where it hid the knee marker and changed
  "symlog" to "linear" in the footer, and never reached `layout()` or
  `toScreenX` — both of which called `symlogFrac` unconditionally. So choosing
  linear left every node exactly where it was and removed the notice that the
  scale was bent. Nothing failed; the type was defined twice, once in
  `state/store.ts` and once in the props, and structural typing means two
  identical unions never disagree. `ageFrac(age, maxAge, mode)` is now the one
  mapping and `AxisMode` has one definition, in `layout.ts`.
- **An axis built from a fixed tick set is a decoration.** `AXIS_TICKS` was ten
  round ages, filtered to `≤ maxAge` and culled for collisions. Two failures,
  both reproducible from a link: human-and-chimp — whose whole tree is inside
  7 Ma, and the set holds nothing between 1 and 10 — drew an axis whose only
  number was `0`; and any zoom past the fit pushed all ten off-screen, so the
  strip rendered a bare rule with no ticks and no geologic band at all. The
  ticks and the band are now generated from the age range under the viewport,
  which needs the *inverse* of `toScreenX` — the piece that was missing.
- **An axis whose extent comes from the data is not an axis.** Ticks and the
  geologic band were both cut off at `maxAge`, the deepest node in the current
  selection, so the strip began abruptly and unlabelled wherever that root fell
  — and the edge moved every time a species was added. It now runs to the Big
  Bang at 13787 Ma. `maxAge` still sets the *scale*; it no longer sets the
  domain. The band stops 9,220 Ma short of the end because `chart.ttl` does, and
  both edges of that bare stretch are marked and named — *Earth forms* and *Big
  Bang* — on the principle that an edge a reader cannot account for is worse
  than one that runs off the screen.
- **On a log axis no single geologic rank is legible everywhere.** The same
  view gives the Cenozoic 225 px and the Neoproterozoic 29. Choosing one rank
  by median band width therefore picks between "PHANEROZOIC" across two thirds
  of the screen and a Precambrian of unreadable slivers, and it picked the
  first. The band is grown down the ICS containment tree instead; details and
  the two split rules that fail are in architecture §6.

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

**A commit body line may not begin `word: `.** This repo writes long, prose
commit bodies, and conventional-commits-parser reads any line matching
`^[\w-]+: ` as the start of the footer — so a sentence that happens to wrap onto
a line beginning `cannot: …` makes `Co-Authored-By:` no longer the first footer
line, and CI's `commits` job fails with `footer-leading-blank`. The message is
unhelpful because it names the footer rather than the line that stole it. Reflow
the sentence; do not shorten the body. `npx commitlint --from <base> --to HEAD`
reproduces it locally, and is worth running before pushing anything with a body
longer than a paragraph.

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

*Fixed, crawled and verified.* The P9157 pass fetches each item's own
`wdt:P225` and `load` refuses any contribution whose taxon name disagrees with
OTT's — no arbitration, no heuristic, one OPTIONAL triple on a query that was
already being made. A row with no P225 is kept rather than refused: not every
item has one, and absent evidence of a bad claim is not evidence of one.

**63,872 names dropped** on the re-crawl, and it does exactly what the three
heuristics could not:

| | before | after |
|---|---|---|
| *Homo sapiens* | Human, **Homo floresiensis**, man, men, humans, **Flores Man** | Human, man, men, humans, human being, human beings |
| Archaea | **Giant Bullfrog**, African Bullfrog, Highveld Bullfrog, … | Archaeon, Archaeans, Archaebacteria, Archaeobacteria |
| `frog` | Anura, then **Archaea "Giant Bullfrog"** | Anura, then Hylidae |

Note what that costs: nothing. "Human" survives on *Homo sapiens* and
"archaeans" survives on Archaea, which is the pair no cheaper rule could keep
at once. Build `a2b513305e2ddb95` when measured; the pre-P225 checkpoint is kept at
`build/vernaculars/wikidata_pre_p225/`.

*The ranking failures that survived it are fixed too* — `butterfly`, `eagle`
and `oak`. See **Group words reach the group** below; the short version is that
an exact match settles which *name* the query is and was being read as settling
which *taxon* the reader means.

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

**Vernacular coverage: the crawl is finished, and the ceiling is the corpus.**
`build/phase6_gates.json` is the source for all of this, 29/29 green:
**162,466 rows**, 159,961 of them resolved to a node — 156,270 from Wikidata
P9157 (OTT id join, no name matching), 5,633 from the PBDB ColDP archive and
563 from the bounded `wdt:P225` name pass, harvested out of 2,048,691 Wikidata
rows of which 1,828,252 were dropped as a repeat of the taxon's own scientific
name. `dog` → *Canis lupus familiaris*, `cat` → *Felidae*, `whale` → *Cetacea*,
`human` → *Homo*, `shark` → *Selachii*, `T. rex` → *Tyrannosaurus rex*.
`test_vernaculars.py` asserts the words a person actually types and is green.

Two numbers, and the gap between them is the whole story: **4.26% of named
nodes** have an English common name, but **54.32% weighted by `tip_count`** —
which is the number a palette experiences, because people search for inclusive
clades. Of the 100 largest clades, 58% have a name; the 42% that do not mostly
genuinely have none in English (Opisthokonta, Holozoa, Panarthropoda). Down the
ranks it falls away fast: top 1k 43.3%, top 10k 19.8%, top 100k 7.6%.

**The id-keyed crawl is 287/287 pages — complete.** Earlier revisions of this
section said 75 of 287 and quoted the coverage of that partial run; both were
left behind by the P225 re-crawl above and the figures in this section are now
read off the gate file rather than remembered. There is nothing left to resume:
`uv run concestor-build vernaculars` re-verifies and fetches nothing.

**Which settles `oak`, and not the way anyone expected.** The crawl is
*finished* and no node carries "oak" or "oaks" — because ***Quercus* is a broken
taxon**: non-monophyletic in the synthesis, ott 791121, substituted by the
unnamed `mrcaott37377ott106844` over seven attachment points. It is not a node,
and `_plan` asks Wikidata about `SELECT ott_id FROM node`. Above *Quercus
petraea* the lineage runs unnamed all the way up to Fagales. *Fagaceae*,
*Aquila* and *Papilionoidea* are broken in exactly the same way, which is why
none of the three words in **Group words** below has a group node to land on.
**No amount of crawling was ever going to close this**, and the fix had to be —
and is — a ranking one.

**Broken taxa are never asked for vernaculars, and could be.** Nine thousand
OTT ids is one WDQS page, ~50 s, and it would let `oak` produce the *Quercus*
explanation the way `Dinosauria` produces its own — §3's whole-name rule
extends to a vernacular cleanly, since a common name typed in full is a whole
name and not a prefix. Not done: the palette now answers `oak` with nine real
oak species, and management.md's design pass already records that a
broken-taxon note "names nothing clickable", so this would add a dead end
beside a working answer rather than replace a wrong one. Worth doing *after*
`BrokenNote` has somewhere to go.

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
gap: precedence runs band (exact string → head word → whole word → prefix) →
current-name vs synonym → node vs broken → **article title** → baked
`rank_score` → `tip_count`.
Four subtle bugs have been found in it, all worth knowing about because every
one of them will come back if the ranking is refactored: candidates were being
cut by raw `tip_count` *before* the band was known; synonym hits were
outranking current names (`Can` reached Elateroidea via "Cantharoidea"); and
the two below.

**Group words reach the group.** `butterfly` returned *Chaetodon capistratus*,
a Caribbean reef fish, above Papilionidae; `eagle` returned the one-species
fossil genus *Miraquila* above *Haliaeetus*; `oak` returned *Usnea* ("Oak
moss", a lichen) and *Enaphalodes* ("Oak Borer", a beetle) above every actual
oak. Three symptoms, two causes, and the first cause is the general one:

***An exact match settles which name the query is. It does not settle which
taxon the reader means.*** A common name can be filed against a taxon far below
the group it names, and the band treated a bare string equality as the
strongest possible evidence with nothing able to answer it. Two withdrawals,
both in `decorate`, both demoting a row to the head-word band — where clade
size decides — and never further:

- **A lone bare word recorded for a single species is a category label.** PBDB's
  ColDP vernacular field carries group words — "belemnite" on 33 taxa, "heart
  urchin" on 25 — and "eagle" is the whole of what anyone has written down
  about *Miraquila*. Restricted to `tip_count ≤ 1`, which is what keeps
  Serpentes ("snake", 4,156 tips), Nephropoidea ("lobster", 73) and *Salmo*
  ("salmon", 65): a clade's one recorded name is genuinely its name.
- **An alias the taxon is not headlined by answers to clade size.** *Chaetodon
  capistratus* is headlined "Kete" and carries "Butterfly" as one of nine local
  aliases. Withdrawn only against a head-word match on a clade **100×** larger.
  The corpus fixes both bounds and they are two orders of magnitude apart: it
  must not fire for `cow` (*Bos taurus*, headlined "Domestic Cattle", against
  Sirenia's "sea cows" at 7 tips — ratio 7) and must fire for `butterfly`
  (ratio 1,080). *Rattus norvegicus* is headlined "Brown Rat", so it is never
  eligible at all — which is the clause that saves `rat` from Muridae's "mice
  and rats" at 1,060 tips, a ratio the threshold alone could not have split.

**And one promotion, which is the same judgement read forwards.** Both
withdrawals answer *this taxon is probably not what the word means*, from
offline signals. Nothing answered the positive form, so two taxa equally
entitled to a word fell through to clade size — and the larger won. That is
right for `beetle`, where Coleoptera holds it against two one-species beetles,
and wrong for `human`, where the genus ***Homo*** (7 tips) beat ***Homo
sapiens*** (2) and the most ordinary query in the product returned the clade
containing *H. erectus* and *H. neanderthalensis* rather than the reader.

***English Wikipedia's article title is the discriminator***, and it is phase
6b's instrument (`name-ranking.md` §2) read for a different question than it
answers there. `usage_rank` orders one taxon's own names and stays display-only;
an **article title is held by one taxon and no other**, so `wiki_evidence =
'title'` on the name typed says which taxon that word denotes. Measured over the
**6,619** English names more than one node claims:

| titled claimants | names | |
|---:|---:|---|
| exactly one | 663 | the signal fires |
| none | 5,942 | nothing changes |
| two or more | **14** | every one a monotypic pair |

Those 14 are why the rule is safe rather than lucky: Sphenisciformes and
Spheniscidae both at 59 tips, Gaviidae and *Gavia* both at 7, Haliotidae and
*Haliotis* both at 70 — pairs where the two answers are the same set of species
and the tie cannot be lost. **The leader changes on 358 names**: `onion` to
*Allium cepa* from the 1,048-tip genus, `camel` to *Camelus* from Camelidae
(which is also the llamas), `sloth` to Folivora from Pilosa (also the
anteaters), `right whale` to *Eubalaena* from Balaenidae (also the bowhead),
`hare` to *Lepus* from Leporidae (also the rabbits), `mayfly` to Ephemeroptera
from **Tipulidae**, the crane flies.

Four things not to redo:

- **It is a tiebreak, not a band.** It sits below node-vs-broken and above
  `rank_score`, so it can only separate rows already equal on how well they
  match. A taxon never climbs past a better-matching name because it owns an
  article: `Homo` typed in full is an exact scientific name and still answers
  itself. Making it a band would also have leaked into `Interleave`, where the
  band is a pure function of two strings, shared with a fossil corpus that has
  no articles at all.
- **It only ever promotes, and the mirror rule was written, measured and
  refused.** Withdrawing an exact match whose evidence is `elsewhere` — a real
  English article by that name that is *not* this taxon's — reads well and
  breaks four pinned queries: `whale` on Cetacea and `rat` on *Rattus
  norvegicus* are both `elsewhere`, because **Whale** and **Rat** are
  broad-concept pages, and each is the only exact claimant there is. `snail` is
  `elsewhere` on all four of its claimants including Gastropoda. Absence of a
  title is not evidence against a taxon, which is the rule `name-ranking.md`
  already states for NULL.
- **A title blocks both withdrawals**, and has to. *Allium cepa* is one species
  whose one recorded name is `onion`: a category label by every offline signal,
  and the title of the article about the onion. Certifying a row by measurement
  and demoting it for looking like a label in the same pass is incoherent.
- **`cat` is the known limit and is left unfixed.** Felidae and *Felis* both
  carry it with evidence `elsewhere`; *Felis catus*, which the article **Cat**
  is about, has **no Wikidata QID in the vernacular crawl** and therefore no
  article, no evidence and no promotion — so the family still leads. The fix is
  coverage in phase 6, not a weaker rule here. The `elsewhere` withdrawal
  refused above is exactly what would "fix" it, and it costs `whale` and `rat`.

**The second cause is head position, and it is the one worth stealing.** An
English compound noun is named by its last word: "oak moss" is a moss, "sessile
oak" is an oak. Splitting the whole-word band on where the match *ends* is what
answers `oak` outright — the palette now returns nine *Quercus* species — and
measured across 77 everyday words it also takes `frog` off the froghoppers,
`lizard` off the booklice (Caeciliusidae, 817 tips, "lizard barklice"), `deer`
off the deer flies, `tiger` off the tiger beetles, `pigeon` off *Polytrichum*
and `tree` off a one-species legume. `fern` went from *Cryptogramma* (11 tips)
to Polypodiopsida (13,408) in second place.

Two things it needs, both measured rather than guessed:

- **Rank words are stepped over.** 577 of the 162,466 vernaculars end in
  "family", "genus", "order" and the like. Without skipping them the head of
  "dog family" is "family", and Canidae falls behind six one-species taxa
  called something-dog and off the page entirely — which is exactly the failure
  `TestWholeWordMatchOutranksMidWordPrefix` exists to catch, arriving from the
  other side.
- **`samePlural` gained consonant-y → -ies.** Papilionidae is headlined
  "swallowtail butterflies" and Danaini "Milkweed Butterflies", and neither
  matched `butterfly` *at all* before that landed.

**Known limit, left alone:** a coordinated name is multi-headed and this reads
only the last conjunct, so Hymenoptera's "wasps, ants and bees" is headed by
"bees" and `wasp` now answers Ichneumonidae instead. Treating each conjunct as
a head is a real refinement and it also hands `butterfly` to Lepidoptera
("Butterflies and Moths", 184,203 tips) over Papilionidae, which is a different
product judgement and wants deciding on its own evidence rather than as a side
effect. `bandPrefix` is likewise flat — it has no head/modifier split — so
mid-typing `butterfl` answers Lepidoptera and the final `y` flips it to
Papilionidae.

**The client was quietly undoing all of it, and that is the fourth bug.**
`Palette.tsx` scored each hit `4000 - i*10 + sessionBoost + fuzzy/40`, and the
fuzzy term is worth up to 42 points against a server rank step of 10 — four
places. Worse, it is one-sided: a row whose match the client cannot see scores
0 while its neighbour scores 32. `fuzzy` cannot find "butterfly" in
"butterflies", so with the server correctly answering Papilionidae first, the
palette on screen still showed *Thecosomata* — a sea snail called "sea
butterfly" — at the top. **Matching is a display question in the client, not a
ranking one.** The term is gone; `litRanges` still says why a row is on the
page and still says nothing when it cannot tell, and it now lights a regular
plural of the typed word, because the top result being the only unlit row reads
as *this one does not match*.

The whole of the ranking is server-side. `web/` must not re-sort `/v1/search`
on anything it can compute from the two fields on the wire — the server has
every name the taxon carries and the client has two.

*And the palette's sections do not weaken that.* The fossil work landed a
`Section` layer between the search result and the row, and grouping is the one
thing it does. Rows keep their server order inside a section, carrying the
session boost and nothing else; sections themselves float on their best row's
score, except About, which is pinned last.

*Nor does the corpus merge.* There was a **Fossils** section here, pinned last
however well a PBDB name matched, and it has gone — `fossil-grafts.md` §9 is
the account. Both corpora are now ranked into one order **on the server**, by
`store.Interleave`, and every pickable row in both arrays carries `order`, its
position in that single list. The client sorts on that integer. **Taking an
order the server computed is the opposite of the failure this rule exists to
prevent**, which was a score the client *could* see outweighing four ranks it
could not; the test is whether `web/` is reading a number or making one.

**The fossil layer is drawn.** Clicking a segment opens a lane beneath the
chronogram sharing its time axis; Amniota → *Homo sapiens* shows 8 of 2,657
with Mammalia, Simiiformes and Homininae labelled on the spine. `Bracket.tsx`
is the only place in the app a stratigraphic range may be drawn or phrased, and
the `occurrence` age tier goes through it rather than inventing a second
vocabulary for the same uncertainty. The ~21% with no interval are named in a
footer as not placed in time, never given a zero-width bar. The cap says
"showing 8 of 2,657" and says nothing at all when the lane is complete.

*What is thin here now.* Ranking by occurrence count guarantees a dull sample:
along Amniota → *Homo sapiens* all eight rows are nested near-duplicates
(Mammalia, Cladotheria, Zatheria, Tribosphenida, Theria, Eutheria, Placentalia,
Boreoeutheria) and seven read "239 Ma – present". Nothing a person would
recognise appears. A ranking that mixed in rank diversity, or one that
preferred taxa carrying a vernacular, would make the lane worth opening twice.

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

That sentence was half false until the label took the pointer. On the canvas the
claim is delivered as the silhouette's tooltip — that is the stated reason it
was taken *off* the label, where it had been wide enough to cross a neighbour's
trace — and `.mark-label` set `pointer-events: none`, so the tooltip could not
be reached and the canvas said nothing at all. The same line made the whole
label inert, so a node's only click target was its 10px dot. Both are fixed;
design-reference.md's **Hit targets** section is now the authority on what may
take a click on the canvas and what a label is allowed to cover.

*What is still thin here.* The corpus remains the ceiling: 12,863 drawings for
2.7M nodes, so 71.2% of leaves get a picture from a group of ≤ 10,000 species
and the rest get something broader. Nothing has been done for the top of the
tree — Eukaryota's picture still speaks for 2,267,368 species, which is honest
and useless, and a deliberate "no useful drawing exists for this" treatment
would serve a reader better than a caption admitting it. **No non-specialist
has looked at any of this**; the threshold at 10,000 tips is a stated product
judgement, not a validated one, and it is the first thing user testing should
attack.

The ceiling is **accepted rather than open** — the app is functional on this
corpus, so the fix for it (generated outlines from Wikimedia photographs) is an
optional future enhancement and not current work. §3 records the decision and
what would reopen it; [phase5c-decision.md](phase5c-decision.md) holds the
design and the measurements intact.

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

**Nothing measures how long the deployed app takes to answer.** Every latency
figure in `deployment.md` §1 was taken on the machine the pipeline runs on, and
production is half a vCPU. That gap has now hidden two expensive endpoints — the
unindexed `fossil` scan inside `/v1/search`, and `/v1/random` at 167 ms locally
against 1.19–1.51 s over the wire — and **both were found by somebody running
`curl` by hand on a hunch**, not by an instrument. Workers Logs holds the
timings and §9 of `analytics.md` says how to read it; nothing reads it for
latency, no p95 is tracked across deploys, and there is no threshold anybody is
alerted on. The cheap version is a handful of `curl`s against `concestor.com`
after a deploy, recorded in this doc — which is what the last two investigations
amounted to, done twice, by accident.

  **One instrument exists now and it is worth knowing about, because it is not
  a general one.** `server/main.go`'s pool warm-up logs `random pool warmed …
  took=…` on every container start, so the cost of those two scans on
  `standard-1` is a number somebody can read rather than estimate. That is one
  query, instrumented because it was the one that burned us; every other
  endpoint is still unmeasured in production, and a single line is not a
  latency budget.

  Read it under **Workers & Pages → Containers → Logs**. It is *not* in Workers
  Logs, which holds the Worker's invocation logs and not the container's
  stdout — this doc said otherwise for one commit, on an assumption nobody had
  tested, which is a small instance of exactly the failure this section is
  about.

**And the random pool is a payload that grows with the corpus.** 114 KB of
JSON today, 34 KB gzipped, fetched whole on the first press of `R` and cached
for a year at the edge — comfortable, and nothing watches it. It scales with
the number of taxa carrying their own drawing, which is the number
`phase5c-decision.md` would multiply if it were ever built. There is no paging,
no partition and no need for either yet; the thing to notice is that the
argument for shipping the list rather than the pick is a *ratio* argument, and
nobody is checking the ratio.
