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

## 7. What this does not do

It does not make fossils searchable. Typing `Homo georgicus` still finds
nothing, because `search_name` has five corpora and none of them is the fossil
table. That is a separate change — a sixth `kind` resolving to the attachment
node — and it needs a pipeline run rather than a client-side rule. It is the
obvious next step and nothing here forecloses it.

It also does not fix the *H. floresiensis* synonym, which is upstream in OTT and
would need the search layer to report `matched_on` — the server already sends
it, `api.ts` already types it, and nothing renders it.
