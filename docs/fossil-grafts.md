# Fossils drawn in the tree

**Status: shipped.** A PBDB taxon can be drawn against the tree as a *graft* —
placed at its own date, hanging off the branch it belongs to, showing its own
silhouette. `web/src/tree/graft.ts` is the placement rule and `graft.test.ts`
pins it.

---

## 1. The question this answers

"Why can't I add *Homo floresiensis* or *Homo georgicus*?" Because neither is a
node — the synthesis tree carries six *Homo* species and these are simply absent
from the supertree (*H. floresiensis* is worse: OTT's `synonyms.tsv` maps it onto
*Homo sapiens*). Both are in the `fossil` table with brackets and PhyloPic
drawings, and can now be drawn.

## 2. Why grafts are not baked into the arrays

A fossil has no resolved sister group — `attach_walk` is how many PBDB
`parent_no` hops the resolution took. Grafting a fossil as a polytomy child makes
`MRCA(sister, fossil)` the attach node, whose **crown** age is an upper bound on
the split, and rendering that as a point would **put a confident number on ~7,000
divergences nobody has dated** — the exact failure the three-array age design
exists to prevent. It would also extend every topology array, shift `tip_count`
for every ancestor (which feeds `search_rank.rank_score`), break the single OTT
id space (`ott_to_idx`), turn ~2,251 tips internal, and disturb the three-place
`induced_subtree` pin. So a graft is client-side and never enters the baked data.

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

**x is `lla` alone**, matching phase 4's clamp: a fossil is the one thing in the
corpus observed on the time axis rather than estimated onto it, `fea` is
junk-wide, and the latest end is the end that holds throughout.

**The join is the fossil's own first appearance** — measured, and the youngest
the split can be (a lineage distinct at time T parted from its neighbours at or
before T). Where it is unclamped, the connector's horizontal run spans first
appearance to last, which is the taxon's observed extent.

### The clamp has two ends and they mean opposite things

`joinAt` is a three-way, not a boolean:

| `joinAt` | when | what the caption says |
|---|---|---|
| `first-appearance` | unclamped | split is at or before this point |
| `anchor` | first appearance is *younger* than the anchor | split is **below** the anchor, off the drawn branches |
| `branch-top` | first appearance is *older* than the whole branch | split is **earlier** than anything drawn |

### The young end a graft sits at is not always PBDB's

PBDB's `lastapp_min_ma` aggregates a taxon's whole subtree. When a taxon's young
end is younger than every one of its descendants', it cannot come from any
identified member — it rests only on material catalogued no finer than the taxon
itself (an `sp.` or `indet.`). **That test is structural and exact** and falls
out of `pbdb_taxa.csv`. (*Stegosaurus* stops at 93.9 Ma on one `Stegosaurus sp.`
occurrence while every named species ends at 143.1.)

**Detecting it is exact; correcting it is a judgement, and the two are kept
apart. `lla` is never overwritten.** Four columns carry the reading, on the same
principle that keeps `age_ma`/`age_tier`/`age_layout` separate:

| column | meaning |
|---|---|
| `lla` | PBDB's own young end. Untouched, named in the card's disclosure |
| `lla_identified` | youngest end an *identified* member reaches. `> lla` is the exact test |
| `young_end_occs` | occurrences sitting at it — how much the alternative is worth |
| `lla_drawn` | where the taxon may be drawn. **The only column a mark's x may read** |
| `lea_drawn` | the **other end of the same bracket**, moved with it |

The position moves only when the alternative survives four refusals, each falling
back to PBDB's own number:

- **Ichno- and form taxa** (PBDB's `I`/`F` flags): a genus-level id is the finest
  that exists, so the wide range is true.
- **Uncorroborated alternatives** — fewer than `MIN_YOUNG_END_OCCS` = 5
  occurrences at the identified end. (*Tasmanites*'s "identified young end" is
  1600 Ma against an own end of 5.33; clamping would be a 1,595 Myr error.) The
  discriminator is corroboration at the identified end, **not** the share of the
  record identified to species.
- **Contradicting the taxon's own first appearance** — identified end older than
  `fea` means the whole bracket disagrees with its children.
- **Per row, the invariant `lla ≤ lla_drawn ≤ fea` enforced on the row's own
  bounds** — PBDB lets bounds differ across rows for one accepted taxon, and
  without this 414 rows would be dragged to the Holocene.

**The correction propagates and has to** — a parent reads its children's
*corrected* positions, or the fix is defeated one rank up. Propagation stops at a
parent's youngest genuinely identified member.

**The `[lea, lla]` bracket moves as a pair.** Both ends come from the same
occurrences, so correcting `lla` alone would rebuild the bracket out of the very
occurrence being refused. **Three consumers print the pair and all read the
corrected one:** the graft's own `occurrence` block, the card's range, and
**phase 4's `occurrence` table** (the node-level range for the `occurrence`
tier). Missing the last put a *Stegosaurus* node reading `162–94 Ma` above a
graft of the same taxon reading `162–143`.

**`fea`/`fla` are never touched** — a coarse `"Late Jurassic"` occurrence
reaching 161.5 Ma is stratigraphic resolution, not misidentification, and the
faded envelope is already the honest rendering of it. **PBDB's aggregate is not
monotone** (a descendant can reach younger than its parent); the test fires only
when the identified end is *older*.

### Row order among grafts

Several fossils on one branch is ordinary (PBDB resolves most hominins to one
node). `joinAge` is clamped no younger than the anchor, so `joinX` is never right
of the anchor: every connector leaves the lineage at or above the branch top and
travels right, and the one that leaves furthest back has furthest to travel.
Sorting **deepest join lowest** (ascending `joinAge`, so it holds under both axis
modes and every zoom) makes a graft-on-graft crossing unsatisfiable.
`graft.test.ts` asserts it as intersecting segments, not an expected order.

### `terminal`, not `isLeaf`, for label placement

`placeLabels` picks its candidate list from a **geometry** question — a terminal
mark tries right-at-`dy:0` first because nothing continues past it. A graft is
terminal (its connector arrives from the left and stops) without being *chosen*
(the meaning `isLeaf` carries on `Placed`, deciding whether a borrowed exemplar
may be drawn — a graft's may not). So the field is `terminal`, set from
`p.isLeaf || p.graft !== undefined`.

**The mark is the ammonite** (the `AgeGlyph` that already means *fossils* in the
label's age slot), stroked — a filled form beside a node is a silhouette. **The
negative index is load-bearing:** `nodeMap.get()` misses, `Arrays.parent[]` is
undefined, `IsAncestor()` refuses, so any path mistaking a graft for a node fails
immediately rather than answering about a neighbour. **The connector says what is
not known** — widest dashes, no halo, no hit target (there is nothing between a
graft's ends to drill into). A `fossil_image` matches PBDB and PhyloPic on the
same name and never inherits, so a graft's picture is an unhedged portrait; only
the placement is qualified, by `placementNote`.

## 4. Three refusals

| Reason | Behaviour |
|---|---|
| `no-range` (21.4% of PBDB) | no appearance interval, so no x |
| `off-tree` | attach node is not on a drawn branch |
| `no-identity` | no `pbdb_taxon_no` to key a URL on |

`off-tree` is recoverable: the fossil stays in the URL and the notice names the
remedy (adding back the species it hangs from brings the fossil with it). The
notice is **gated on the tree having resolved** — `off-tree` is computed against
the induced subtree, which is empty until paths land, so without the gate a graft
is briefly announced undrawable one frame before being drawn.

## 5. Reach

411,039 of 523,112 PBDB taxa (78.6%) carry at least one appearance bound and can
be placed in time; 9,951 of those also carry a PhyloPic drawing. No cap — grafts
are added one at a time by name.

## 6. Surface

- `GET /v1/fossil/{pbdb_taxon_no}` — one taxon by its own key (the segment query
  is keyed on the branch and cannot serve a cold load holding an id).
- `f=108454,91487` in the URL, beside `n=`. Deliberately a **separate list**: a
  selection is a node and induces a subtree, a graft is an annotation and induces
  nothing. A fossil in `keys` would be sent to `/v1/paths`.
- Drill-down lane rows **select**, exactly as a canvas mark does: one press puts
  `sel=pbdb<taxon_no>` in the URL and opens the fossil card, whose button draws
  it. A row with no `pbdb_taxon_no` is not pressable.

## 7. Searchable, and selectable

**Fossils are in the palette**, ranked among the species. Phase 6 builds
`fossil_fts`, an FTS5 index over the fossil names (18 MB, 1.0 s build); queries
cost **0.1–15 ms** against a full-scan alternative that is 100–117 ms and flat
against match count on a `standard-1` half-vCPU container. `SearchFossils` uses
the index where it exists and falls back to the scan where it does not. Three
load-bearing points:

- **The index covers every row, not just the searchable ones.** Encoding
  `notInTree`'s serving policy (§9) into the index would make it 40% smaller and
  go wrong silently the day the policy changes.
- **The rowid is a `pbdb_taxon_no`, and the server proves it** — a wrong key does
  not error, it joins cleanly and describes a different animal. `verifyFossilFTS`
  samples both ends of the keyspace and requires each taxon to be returned by a
  search for its own name; a mismatch skips the index and keeps the scan.
- **The check must go through `MATCH`.** The index is `content=''`, so selecting a
  column off it yields NULL and a join-and-compare gate passes on a corrupted
  index alike.

The index **narrows recall** (FTS5 matches whole tokens and prefixes, not
mid-word substrings like `LIKE '%q%'`), which is safe only because those dropped
rows score `bandNone` in `matchBand` and `Interleave` ranks them behind every
node. SQL generates candidates by a coarse tier (exact, prefix, contains) then
`notability`; the rows are re-banded in Go by `matchBand` and merged by
`store.Interleave`, with truncation *after* the re-band.

Picking a fossil draws it, **and adds the clade it hangs below when that clade is
not on the canvas** (named in the toast, or the reader's press produces no
visible change). Undated taxa are a **note, not a row** (`BrokenNote`) — 21.4% of
PBDB has no interval and "nothing matched" is a worse answer than the true one.

### A graft is selectable like a node

Same click, same `sel=` in the URL, same card slot. Key namespaces keep them
apart — `pbdb108454` cannot collide with an OTT id — and `focusedIdx` becomes the
negative graft index so the mark highlights and the lineage dims. The card is
**not** the node card with fields blanked: a fossil has no age, species count or
depth; it carries the range, occurrence count, attachment point, and the two
uncertainties (where it hangs, when it lived) stated separately. It is where the
PhyloPic credit lives — `normalise()` renames the server's
`creator`/`uploader` to the card's `attribution`/`contributor` for all three call
sites (it did so for `/v1/node/` only, which left the credit blank).

## 8. The synonym, explained rather than fixed

OTT files *Homo floresiensis* as a synonym of *Homo sapiens*. That is upstream,
so the **species** row still answers with a different species but no longer
silently: `matched_name` carries the string that actually matched, in lockstep
with `matched_on`, **omitted when the row already shows it**.

> *Homo sapiens* · Human · species · 2 species
> matched *Homo floresiensis*, which the taxonomy files under this name

**Synonyms only** — an abbreviation like `rex` matches every "T. rex" row the
same way and distinguishes nothing. The wording is the taxonomy's filing, not a
claim about the animal: a deprecated name is not an alias, so "also known as" is
refused.

## 9. One corpus at the front door

The two catalogues are not "living" and "extinct" and are not disjoint:

| | the synthesis tree | the Paleobiology Database |
|---|---|---|
| holds extinct taxa? | yes — *T. rex* is a node | yes |
| holds living taxa? | yes | yes |
| what a row has | an ancestry, a subtree, an MRCA | a stratigraphic bracket, an `attach_idx` |

They **overlap**: `attach_walk = 0` means the PBDB taxon *is* a node (32,386
accepted rows — *Tyrannosaurus*, *T. rex*, *Stegosaurus* among them). So a search
used to return such an animal twice with two different futures.

**`store.notInTree` refuses `attach_walk = 0` from `SearchFossils` and
`RandomFossils`.** The node wins on the merits: phase 4 has already written the
taxon's PBDB bracket onto the node as its `occurrence` row, so the node carries
the dates *and* an ancestry *and* an MRCA. That costs 8.9% of the accepted
corpus, all reachable by the same name through the node path. Name equality is
deliberately **not** also required — 1,320 rows are spelled differently from
their node (`Animalia`/`Metazoa`) and are the same taxon written twice.

That exclusion earns the badge's one sentence:

> **A fossil row is a species the tree has no lineage for.**

Not "extinct" (wrong about *T. rex*). The badge reads **"on a branch"**.

`/v1/search` answers with two arrays (a node and a PBDB taxon are different
*shapes*); `store.Interleave` stamps every pickable row in both with `order`, and
the client sorts on that integer — reading a rank, never computing one, and never
re-sorting `/v1/search`. The ranking:

1. **Band** — `matchBand`, over both corpora. It does nearly all the work.
2. **Position within the row's own corpus** — each list arrives ranked on signals
   the other has no counterpart for; comparing positions asks each corpus how
   good a row is relative to its own best.
3. **Node before fossil** — the last tiebreak and smallest claim (any earlier is
   the pinned tail under a new name; `TestANodeOnlyBeatsAFossilOnAnOtherwiseExactTie`
   catches it).

`R` rolls a die with a **20%** chance of drawing from the fossil pool
(`web/src/corpora.ts`) — weighted because a graft usually drags in a clade. An
empty fossil roll falls through to a species silently. `⇧R` is unbound.

Three checks worth keeping: `TestSearchNeverOffersATaxonTheTreeAlreadyHas`,
`TestFossilOnlyTaxaAreStillFound` (*Triceratops*, *Dimetrodon*, *Anomalocaris*),
`TestInterleaveStampsOneContiguousOrder` (no collision, no gap; broken taxa are
unstamped because they render as notes).
