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
| **y** | a row of its own, after the last row of its anchor's subtree; deepest join lowest |
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

### The young end a graft sits at is not always PBDB's

A graft is placed at the young end of the last-appearance bracket, and for
**7,802 rows** that end is one *no identified member of the taxon reaches*.

PBDB's `lastapp_min_ma` aggregates a taxon's whole subtree. So when a taxon's
young end is younger than every one of its descendants', it cannot be coming
from any identified member — it can only rest on material catalogued no finer
than the taxon itself, an `sp.` or an `indet.`. **That test is structural and
exact**: no threshold, no occurrence-level data, and the whole of it falls out
of `pbdb_taxa.csv`, which phase 0 already pins.

*Stegosaurus* is the case it was built for. PBDB stops the genus at 93.9 Ma on
the strength of **one** occurrence — `Stegosaurus sp.`, Mussentuchit Member of
the Cedar Mountain Formation, a "small collection" — while every named species
ends at 143.1. Drawn at 93.9, a Late Jurassic animal sits in the Cenomanian,
50 Myr after it lived, beside things it never met.

It is not a curiosity. Inside Dinosauria, 71 taxa are stretched by ≥10 Ma and
**not one** of the 71 has its young end supported by an identified species; 52
rest on a single occurrence and 20 on records the identifier themself hedged
with `?`, `cf.` or `aff.`. *Iguanodon* and *Megalosaurus* — the two classic
wastebasket genera — were both drawn at **66.0 Ma**, each on one hedged record.

**Detecting it is exact; correcting it is a judgement**, and the two are kept
apart. `lla` is never overwritten. Three columns carry the reading, on the same
principle that keeps `age_ma`, `age_tier` and `age_layout` separate — what PBDB
says, how to read it, and where to draw are different claims:

| column | meaning |
|---|---|
| `lla` | PBDB's own young end. Untouched, and named in the card's disclosure |
| `lla_identified` | youngest end an *identified* member reaches. `> lla` is the exact test |
| `young_end_occs` | occurrences sitting at it — how much the alternative is worth |
| `lla_drawn` | where the taxon may be drawn. `lla` except where the clamp is trusted |
| `lea_drawn` | the **other end of the same bracket**, moved with it |

The position moves only when the alternative survives four refusals, and each
one falls back to PBDB's own number rather than to a worse one:

- **Ichno- and form taxa** (PBDB's `I`/`F` flags), 327. For *Gyrolithes* or
  *Deltapodus* a genus-level identification is the *finest that exists*, so a
  Cambrian-to-Recent range is simply true. The flag is clean: every ichnogenus
  checked carries it and *Stegosaurus*, *Iguanodon* and *Camarasauridae* carry
  neither.
- **Uncorroborated alternatives**, 5,497 — fewer than `MIN_YOUNG_END_OCCS` = 5
  occurrences at the identified end. *Tasmanites* has 56 occurrences but two
  species entered, one with none of them and one with a single Proterozoic
  record, so its "identified young end" is 1600 Ma against an own end of 5.33.
  Clamping would be a **1,595 Myr** error, far worse than the one being fixed.
- **Contradicting the taxon's own first appearance**, 12. Where the identified
  end is older than `fea` the whole bracket disagrees with its own children,
  not just the young end.
- **Per row, bounds that cannot hold it.** The verdict belongs to the accepted
  taxon and the bounds are the row's own, and PBDB lets them differ in both
  directions — three *Paronychodon* rows carry first appearances of 154.8, 85.7
  and 72.2 against one accepted taxon, and *Crassispira* is a living genus
  whose synonym *Tripia* is an Eocene row ending at 37.71. The invariant
  `lla ≤ lla_drawn ≤ fea` is enforced per row, and it is what a gate found:
  414 rows would otherwise have been dragged to the Holocene.

**The share of a record identified to species is not the discriminator** and
was tried first. *Stegosaurus* is only 20.9% identified — most of its own
record is `Stegosaurus sp.` too, exactly like *Tasmanites*. What separates them
is corroboration at the identified end: *Camarasauridae* 167, *Iguanodon* 23,
*Stegosaurus* 18, *Megalosaurus* 10, against *Krausella* 2 and *Tasmanites* 1.

**The correction propagates**, and has to. The single occurrence stretching
*Stegosaurus* stretches *Stegosauridae* through it, so a parent reads its
children's *corrected* positions; otherwise the fix is defeated one rank up and
a reader meets the same error by selecting the family. Propagation does not
overshoot — a family stops at its youngest genuinely identified member, which
is why a real Early Cretaceous stegosaurid still holds *Stegosaurinae* where it
is.

**The last-appearance bracket moves as a pair, and every surface that prints
it has to move with it.** `[lea, lla]` is one bracket and both ends come from
the same occurrences: *Stegosaurus* has `lea` 100.5 and `lla` 93.9, and both
are the single Cenomanian record. Correcting `lla` alone rebuilds the bracket
out of the very occurrence being refused, and the solid bar still runs into the
Cretaceous under a glyph sitting in the Jurassic. Three consumers print it and
all three read the corrected pair — the graft's own `occurrence` block, the
card's range, and **phase 4's `occurrence` table**, which is the node-level
range for the `occurrence` tier. The last of those was missed at first and it
showed: the *Stegosaurus* node read `162–94 Ma` directly above a graft of the
same taxon reading `162–143`, the same number disagreeing with itself on one
screen. 45 node ranges move.

**`fea` and `fla` are never touched, and the reason is worth stating** because
it looks like the same problem and is not. *Stegosaurus* reaches **161.5 Ma**
at the old end, ~6 Myr before the animal, and that comes from **one** of its 86
occurrences being logged only as `"Late Jurassic"` — an epoch whose base is
161.5. No specimen is dated there; the record is simply coarse. That is
*stratigraphic resolution*, not misidentification, and the faded envelope is
already the honest rendering of it (architecture §7). 84 of the 86 occurrences
are Kimmeridgian–Tithonian, 154.8–143.1, which is the animal.

Two things the card must do, and does: **name PBDB's own young end in the
disclosure**, so nothing is hidden, and say in words that the later end is not
one any identified member reaches.

**PBDB's aggregate is not monotone**, which the first version of this gate
assumed. 440 taxa have a descendant reaching younger than they do —
*Planolites montanus* at 66.0 under a genus PBDB stops at 468.0. Nothing acts
on those; the test only ever fires when the identified end is *older*.

### Row order among grafts, and why it is not a matter of taste

Several fossils on one branch is the ordinary case, not the exotic one: PBDB
resolves most hominins to the same node, so asking for three at once puts three
connectors on the same point. Ordering them by last appearance — the obvious
choice, and the one that shipped first — drew this:

> *H. sapiens*, *H. erectus* selected; *H. georgicus*, *H. floresiensis* and
> *H. neanderthalensis* grafted. georgicus took the first fossil row and its
> horizontal run cut straight through the vertical carrying the other two down.

The crossing is not a near-miss to be nudged apart. It follows from where the
connectors start. `joinAge` is clamped to be no younger than the anchor, so
**`joinX` is never right of the anchor**: every connector leaves the lineage at
or above the branch's top and then has to travel right. georgicus first appears
at 2.58 Ma, *older* than the fork it hangs from, so its join sits up the branch;
floresiensis and neanderthalensis first appear at 0.129 and 0.774, *younger* than
the fork, so both clamp to the fork itself. The one that leaves furthest back has
furthest to travel, and anything drawn below it is in the way.

So the order is forced. For two grafts on one slot, `i` above `j`, the only
possible crossing is `j`'s vertical through `i`'s horizontal, which needs
`joinX(i) < joinX(j) < x(i)`. Sorting so `joinX` only ever *decreases* down the
rows makes that unsatisfiable, and `i`'s own vertical stops at `i`'s row so it
can never reach `j`'s run either. **Deepest join lowest**, stated as ascending
`joinAge` so it holds under both axis modes and at every zoom.

The same argument covers the tree, which is why nothing else had to change:
`joinX ≤ anchorX`, and every horizontal in the anchor's subtree starts at or
right of `anchorX`, so a connector cannot cross the clade it hangs from. Grafts
crossing *each other* was the only case left open, and it is now closed by
construction rather than by tuning. `graft.test.ts` asserts it as intersecting
segments rather than as an expected order, so the test measures the picture and
not the implementation of the picture.

`buildGrafts`' sort survives as the *base* order — it is what makes the picture a
function of the URL — with the layout's stable sort on top of it.

### `isLeaf` means *chosen*, and label placement wanted the other question

The same hominin view showed every fossil's silhouette, name and range sitting
half a row above the ammonite it belonged to. With three fossils stacked, the
pairing had to be guessed.

`placeLabels` picks a candidate list from `LabelInput.isLeaf`, and a graft was
passed `false` — correctly, because on `Placed` that flag means *one of the
reader's selections*, which is what decides whether a mark may draw a borrowed
exemplar and a graft may not. But the candidate list is a question about
**geometry**: a leaf tries right-at-`dy: 0` first because nothing continues past
it, while a clade defaults above-left and does not offer `dy: 0` until its ninth
entry. Anything terminal sent down the clade list is displaced by half a row even
when the space beside it is completely clear.

A graft is terminal without being chosen: its connector arrives from the left and
stops at the fossil. So the field is now `terminal`, named for what it actually
asks, and `layout` sets it from `p.isLeaf || p.graft !== undefined`. The two
meanings had been the same thing only because grafts did not exist yet.

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
