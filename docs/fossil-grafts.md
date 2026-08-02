# Fossils drawn in the tree

**Status: shipped.** A PBDB taxon can now be drawn against the tree as a
*graft* — placed at its own date, hanging off the branch it belongs to, showing
its own silhouette. `web/src/tree/graft.ts` is the whole of the placement rule
and `graft.test.ts` pins it.

Measured against build `b48553b2b8a4a2ed` on 2026-08-02.

---

## 1. The question this answers

"Why can't I add *Homo floresiensis* or *Homo georgicus*?"

Because neither is a node. The synthesis tree carries six *Homo* species —
`antecessor`, `erectus`, `habilis`, `heidelbergensis`, `rudolfensis`, `sapiens`
— against seventeen in OTT 3.7.3, and `opentree16.1` was built against that same
taxonomy, so this is not version skew. *H. georgicus* (ott 3607679) and
*H. naledi* (ott 6145143) carry flags identical to the six that made it in and
are simply absent from the supertree. *H. floresiensis* is worse: OTT's
`synonyms.tsv` maps it onto ott 770315, *Homo sapiens*, so searching it silently
returns the wrong species.

Both, however, are in the `fossil` table with brackets and PhyloPic drawings.
They were reachable only through a drill-down lane. Now they can be drawn.

## 2. What was rejected, and why

**Grafting into the baked arrays.** The obvious reading of "put them in the
tree". It fails on the thing this product exists to get right. A fossil has no
resolved sister group — `attach_walk` is how many PBDB `parent_no` hops the
resolution took, and *H. georgicus* took one, meaning the only supported claim
is *somewhere inside genus Homo*. Graft it as a polytomy child and
`MRCA(H. sapiens, H. georgicus)` becomes the attach node, whose **crown** age is
an *upper bound* on the split rendered as a point. Across the credible candidate
set (walk ≤ 1, dated, extinct, ended pre-Holocene: 50,605 fossils over 10,044
attach nodes) **7,251 of those nodes carry a real `age_ma`** — so it would have
put a confident number on ~7,000 divergences that nobody has dated. That is the
exact failure the three-array design exists to prevent.

It also costs: every array in `build/topology/` extends, `tip_count` shifts for
every ancestor and feeds `search_rank.rank_score`, `ott_id` has no answer for a
PBDB taxon while `ott_to_idx` assumes one id space, **2,251 of the 10,044 attach
nodes are currently tips** and would become internal, and `induced_subtree` is
pinned in three places by tests built from the real baked arrays.

**A separate "fossil lane" band.** Already exists, as `DrillLane`. The request
was for the tree, not another strip.

## 3. What shipped

A graft is a **synthetic occurrence-tier node**, built client-side, that never
enters `Induced`.

| | |
|---|---|
| **x** | its own `lla` — the latest end of the last appearance |
| **y** | a row of its own, after the last row of its anchor's subtree |
| **join** | its own **first appearance**, clamped to the branch |
| **idx** | `-(pbdb_taxon_no)` |
| **tier** | `occurrence`, so `markAge` prints a range and never a figure |
| **mark** | the ammonite from `AgeGlyph`, not a dot |

**x needed no invention.** On this canvas x is time, and a fossil is the one
thing in the corpus that carries its own date — every node has to be *estimated*
onto the axis and a fossil is simply observed there. `lla` alone, matching phase
4's clamp: `fea` is junk-wide and widens with occurrence count, and the latest
end is the one that holds throughout.

**The join is the fossil's own first appearance.** It was the attach node's
`age_layout` in the first cut, and that was arbitrary in the precise sense —
`age_layout` is documented as *x-position only, never a label*, and for genus
*Homo* it is 3.37 against an `age_ma` of NaN. So the connector left the lineage
at a synthesized coordinate. The first appearance is measured, and it is the
right measurement: a lineage that was already a distinct taxon at time T parted
from its neighbours at or before T, so it is the *youngest* the split can be —
the least the data allows rather than a number nobody estimated.

A consequence worth having: the connector's horizontal run now spans first
appearance to last, so where it is unclamped **that run is the taxon's observed
extent**. On the hominin case *H. georgicus* joins at 2.58 and ends at 0.774,
and *H. neanderthalensis* joins at exactly the x *H. georgicus* ends at, because
both are 0.774 Ma. The vertical drop is the part nobody knows.

### The clamp has two ends and they mean opposite things

`joinAt` is a three-way, not a boolean, and the boolean it replaced put the
reverse of the truth on screen.

| `joinAt` | when | what the caption says |
|---|---|---|
| `first-appearance` | unclamped | split is at or before this point |
| `anchor` | first appearance is *younger* than the anchor | split is **below** the anchor, off the drawn branches |
| `branch-top` | first appearance is *older* than the whole branch | split is **earlier** than anything drawn |

*Dimetrodon* is the `anchor` case — 299–267 Ma hanging off Amniota at 323 — and
a single "clamped" flag captioned it "its lineage parted somewhere earlier",
which is backwards. It parted later, inside Amniota.

**The mark is the ammonite, not a shape of its own.** Every circle on the canvas
is a position in the topology and a graft is not one, so it may not wear the
same mark; but inventing a third shape leaves the reader two vocabularies. The
glyph already means *fossils* in the age slot of the graft's own label, so the
figure beside the range and the figure that is the mark are the same figure.
Stroked, per `AgeGlyph`'s note: a filled form beside a node is a silhouette.

**The negative index is load-bearing.** `nodeMap.get()` misses,
`Arrays.parent[]` is undefined, `IsAncestor()` refuses. Any code path that
mistakes a graft for a node fails immediately rather than returning a silently
wrong answer about a neighbouring taxon.

**The connector says what is not known.** It is drawn with the widest dashes in
the file, no halo, and **no hit target** — a segment's one interaction is a
drill-down, and there is nothing between a graft's ends to drill into. The
legend earns a new row for it: *fossil · attaches somewhere along*.

**A fossil's drawing is the only unhedged caption in the app.** `borrowedTitle`
must explain that a silhouette is of a relative; `witnessTitle` must explain
that the taxon merely sits below a fork. `fossil_image` matches PBDB and PhyloPic
on the same name and never inherits, so a graft's picture is a portrait. The
only thing left to qualify is the placement, which `placementNote` does in the
same three bands a witness uses.

## 4. Three refusals, no approximations

| Reason | Count | Behaviour |
|---|---:|---|
| `no-range` | **112,073** of 523,112 (21.4%) | no appearance interval, so no x |
| `off-tree` | situational | attach node is not on a drawn branch |
| `no-identity` | 0 on this build | no `pbdb_taxon_no` to key a URL on |

`off-tree` is recoverable and says so: the fossil stays in the URL and the
notice names the remedy, because removing the species a fossil hung from is an
ordinary thing to do and putting one back brings the fossil with it.

**The refusal notice is gated on the tree having resolved.** `off-tree` is
computed against the induced subtree, which is empty until the paths land — so
on a cold load with fossils in the URL every graft is briefly off-tree. Without
the gate, *Dimetrodon* was announced as undrawable one frame before being drawn.

## 5. Reach

- **411,039** of 523,112 PBDB taxa (78.6%) carry at least one appearance bound
  and can therefore be placed in time.
- **9,951** of those also carry a PhyloPic drawing.
- No cap. Grafts are added one at a time by name, so there is no lane-style
  explosion to bound, and an arbitrary limit would only be arbitrary.

## 6. Surface

- `GET /v1/fossil/{pbdb_taxon_no}` — one taxon by its own key. The segment query
  is keyed on the branch and cannot serve a cold load that arrives holding an id.
- `f=108454,91487` in the URL, beside `n=`. Deliberately a **separate list**:
  a selection is a node and induces a subtree, a graft is an annotation and
  induces nothing. A fossil in `keys` would be sent to `/v1/paths`.
- The drill-down lane's action menu leads with *Draw … on the tree*.

## 7. Searchable, and selectable

**Fossils are in the palette**, as their own section below the species, and no
pipeline run was needed. `SearchFossils` is a full scan of the 523,112-row
table — there is no index on `name`, since the table is keyed on
`(attach_idx, n_occs DESC)` for the segment query — and a prefix scan measures
**~40ms**, comfortably inside the palette's 110ms debounce. An in-memory prefix
index would cost ~15MB and a slower boot to save something nobody can perceive.

Ordering is match tier — exact, prefix, contains — then the same `notability`
a drill-down lane uses. Without the tier, "homo" returns whatever the
most-recorded substring match happens to be.

The section is **pinned last** whatever it scores, because the two corpora
answer different questions: a species is a node you can build a tree from, a
fossil is an observation that hangs off one. Typing "dimetrodon" should not
bury the species list under eight PBDB rows.

Picking one draws it, **and adds the clade it hangs below when that clade is
not on the canvas** — otherwise the one thing the reader asked for produces no
visible change and a notice explaining why. The added clade is named in the
toast rather than slipped in silently.

Undated taxa are a **note, not a row** — the `BrokenNote` pattern, for the same
reason: 21.4% of PBDB has no interval, nothing Enter could do would work, and
"nothing matched" is a worse answer than the true one. *Homo naledi* is exactly
this case.

### A graft is selectable like a node

Same click, same `sel=` in the URL, same card slot. The key namespaces keep the
two apart without a second parameter — `pbdb108454` cannot collide with an OTT
id or a node key — and `focusedIdx` becomes the negative graft index so the mark
highlights and the lineage dims exactly as a node's would. A focused graft's
"lineage" is its anchor's, since it has none of its own.

The card is **not** the node card with fields blanked. A node card leads with an
age, a species count and a depth; a fossil has none of those. It carries the
range, the occurrence count, the attachment point, and the two uncertainties —
where it hangs and when it lived — stated separately.

**It also closes a licensing gap.** A graft puts a PhyloPic image on the canvas
and CC-BY applies to whatever is on screen; until this card existed there was
nowhere for the credit to go. The credit was silently blank at first, because
the server sends `creator`/`uploader` and every card in the app reads
`attribution`/`contributor` — a rename `normalise()` was doing for `/v1/node/`
only. That is now one helper covering all three call sites, which is what the
existing comment there had already warned about.

## 8. The synonym, explained rather than fixed

OTT files *Homo floresiensis* as a synonym of ott770315, *Homo sapiens*. That is
upstream and not ours to change, so the **species** section still answers with a
different species — but it no longer does so silently.

`matched_on` was already sent and already typed and rendered nowhere.
`matched_name` is new: the string that actually matched, carried in lockstep
with the kind that was already being reported, and **omitted when the row
already shows it** — captioning *Homo sapiens* with "matched Homo sapiens" is a
caption on the obvious. The row now reads:

> *Homo sapiens* · Human · species · 2 species
> matched *Homo floresiensis*, which the taxonomy files under this name

**Synonyms only.** `abbreviation` looked like it belonged and does not: "T. rex"
returns eight rows that all matched the same way, so the line repeats down the
list without distinguishing anything, and *Tyrannosaurus rex* with `rex`
highlighted already explains itself. A synonym is the one case where the typed
string appears nowhere on the row.

The wording is the taxonomy's filing, not a fact about the animal. **"Also known
as" is the exact phrasing a Wikidata bug once put on this exact pair** — see the
vernacular fix in `handoff.md` — and it would be no more true coming from OTT. A
deprecated name is not an alias.

Together with §7 this closes the original question: the species row explains
itself, and the Fossils section directly below carries the real *Homo
floresiensis*, drawable.

## 9. A note on running the tests in a worktree

`testenv.BuildDir` walks six parents looking for `build/concestor.db`. From
`<worktree>/server/internal/store` that reaches `.claude/` and stops one level
short of the main checkout, so **70 of 87 Go tests silently skipped** and the
suite still printed `ok`. `scripts/serve.sh` borrows `build/` explicitly; the
tests do not.

Symlinking `build` into the worktree root — it is gitignored — makes all 87 run
against the real database. Worth doing before trusting a green suite here.
