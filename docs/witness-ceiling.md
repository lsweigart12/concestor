# Raising the divergence witness to its real ceiling

**Status: proposed, measured, not started.** Everything below was measured
against build `7621312b5760ec1a` on 2026-08-01. Read
[handoff.md](handoff.md) §5 on the witness first; this assumes it.

The witness layer shipped drawing 548 forks. The design caps out at about
2,552 however many images anyone sources, and the cap is not the corpus — it is
one line in the data model. Changing that line reaches **33,428**, and reaches
**5,917 with no new images at all**.

---

## 1. Where the cap actually is

A witness is currently a **node**: a taxon that is in the Open Tree synthesis
tree, carries its own PhyloPic drawing, and has a PBDB bracket in the
`occurrence` table. All three, or nothing.

The binding constraint is the first one, and it is severe. architecture §3.4
records it: **only 0.5% of OTT taxa flagged extinct appear in the synthesis
tree at all.** Fossils are not gaps in an otherwise complete topology; they are
a parallel corpus with no topology of its own. So the taxa most worth drawing
at a fork — the stem forms that actually sat near it — are overwhelmingly
*not nodes*, and cannot be witnesses however well drawn or dated they are.

*Indohyus* is the case the owner raised at the start and it is exactly this:
in the data, dated, correctly placed below Whippomorpha, and ineligible.

| | eligible taxa | forks with a witness | range spans the split |
|---|---:|---:|---:|
| today — nodes, drawn, dated | 398 | **548** | 207 |
| nodes, **every** dated one drawn | 2,133 | 2,552 | 607 |
| **fossils, drawn with today's images** | 1,903 attach nodes | **5,917** | 854 |
| **fossils, every dated one drawn** | 28,831 attach nodes | **33,428** | 10,434 |

Two readings of that table matter more than the totals.

**Row 3 costs no images.** 2,194 PhyloPic titles already name a dated PBDB
taxon that is not an OTT node — *Phenacodontidae*, *Goniatitida*, Orthocerida,
*Ammonitina*. They are mirrored, licensed and sitting on disk unused. Changing
the join is worth **11× the current coverage** before anyone draws anything.

**Row 2 is the ceiling of the current design.** An unlimited image budget on
the present model tops out at 2,552 forks. That is the number to weigh a
sourcing effort against, and it is why this document exists.

---

## 2. The change

**Witnesses come from `fossil`, not from `occurrence`.**

Phase 4 already gives every PBDB taxon an **attachment point**: `attach_idx`,
the deepest node in the synthesis tree that is an ancestor-or-self of it,
computed by walking PBDB's own `parent_no` hierarchy upward until a taxon
resolves. 275,082 primary taxa carry a bracket and attach below 28,831 nodes.

A fossil attached at `a` may witness `a` and every ancestor of `a`. Nothing
else about the rule changes: rank by gap against the fork's age, tie-break on
the narrower bracket, refuse where the fork carries its own drawing, fall back
to `age_layout` where `age_ma` is NaN.

### The claim weakens, and the UI must weaken with it

This is the part to get right. Today a witness is *inside* the clade, so the
picture claims "a member of this group, dated to about here". A fossil claims
less, and architecture §3.4 already writes the honest phrasing:

> *"this taxon belongs somewhere below node X, and existed between these
> dates."* Not *"this taxon is the sister of that one."* The UI must not imply
> more.

So the caption changes from *from inside this group* to *from somewhere below
this fork*, and `attach_walk` — how many `parent_no` hops PBDB took to find an
in-synth ancestor — is the number that says how loose the placement is. It is
distributed 29,074 at 0 hops, 48,764 at 1, tailing to 698 at 11. **Zero hops is
a different quality of claim from eight** and the ranking must say so; a
witness that walked eleven is a statement about a family, not a lineage.

---

## 3. Work, in order

1. **Fix `xref`'s homonyms first, before anything depends on this.** Phase 3
   resolves PBDB to OTT **by name**, and OTT carries homonyms across kingdoms:
   PBDB's *Ivesia* is an Ediacaran rangeomorph and OTT's is a rose-family
   plant. `images.py` refuses an ambiguous name outright and phase 3 does not.
   handoff §5 records this as **unfixed and affecting every `xref` consumer** —
   and this proposal makes the witness layer a consumer. Do not build on top of
   it. The refusal rule already exists in `images.py`'s `_seed_by_name`; port
   it.
2. **Link images to fossils.** Two paths, both already half-built: PhyloPic's
   own node sometimes resolves in the PBDB namespace (1,783 images cite no OTT
   id at all and are exactly these), and `node_title` name-matching reaches
   2,194 dated PBDB taxa today. Reuse `_seed_by_name`'s discipline verbatim —
   a name resolving to more than one taxon is refused, not guessed.
3. **Rewrite `divergence_witnesses` over attachment points.** Candidates become
   `(attach_idx, fea, lla, attach_walk, image)` rather than node indices. Cost
   is bounded by 28,831 attach nodes × depth ≤ 111, the same shape as now.
4. **Extend the ranking** with `attach_walk` after the bracket-width
   tie-break. Nearest first, then tightest evidence, then firmest placement.
5. **Carry `attach_walk` to the client** and reword the caption and card.
   `node_divergence_image` gains `attach_idx` and `attach_walk`; `source_idx`
   stops being a node index and becomes a `fossil.pbdb_taxon_no`. That is a
   breaking change to the table — version it or rename it, do not quietly
   change what the column means.

---

## 4. Hazards, all of them measured

- **`fea` stays unread as a position.** The containment test on `[lla, fea]` is
  fine and the narrow-bracket tie-break is what protects it; phase 4's finding
  that the first-appearance bracket *widens* with occurrence count still holds
  and still forbids drawing anything at `fea`.
- **High-rank fossil taxa will try to win everything.** *Ammonitina* spans
  249.9–56 Ma with 43,884 occurrences and would contain a great many forks.
  The narrow-bracket tie-break already demotes it — verify that it does, on
  this corpus, before shipping, because the failure is silent and looks like
  coverage.
- **35,819 dated primaries are flagged extant and 4,538 are unknown.** An
  extant taxon with a fossil record is a legitimate witness — that is the
  point, it was *there* — but it is not the same claim as an extinct stem form,
  and the caption should not read as though it were.
- **Coverage is not the measure.** The witness layer already learned this once:
  100% silhouette coverage was true and meaningless. The number to gate on is
  the share of forks whose witness *spans* the split — 207 today, 10,434 at the
  ceiling — not how many forks carry a picture.
- **More forks means more bad pairings on screen.** Median gap under full
  attachment is 36% of the fork's age against 14% today, because the new forks
  are the hard ones. `NEAR_FRACTION` is uncapped by owner decision; expect to
  want it back at 0.5–1.0 once coverage is high, and the constant is the only
  edit that takes.

---

## 5. Where images pay, if sourcing continues in parallel

Sourcing helps under either design, but the payoff differs:

- **Under the current design**, 1,735 of the 2,133 eligible nodes are undrawn,
  and 351 of the existing 548 forks would get a *closer* witness — mean gap
  37% → 19%. The upgrades are dramatic where they land: Actinopterygii (379 Ma)
  currently draws *Pseudamia*, a **living** cardinalfish 320 Ma adrift, and
  would draw *Howqualepis*, a Devonian ray-fin **3 Ma** off. Lepidosauria goes
  from 128 Ma adrift to 0.7. Testudines from 119 to 3.5.
- **Ranked by raw fork count the list is disappointing** — it is topped by
  *Fontainea*, a plant genus, then foraminifera and fossil molluscs, all
  serving forks nobody visits. Target the named clades, not the volume.
- **Linking is the constraint, not acquisition.** An image that cannot be
  resolved to an unambiguous taxon is worth nothing here, and a wrongly
  resolved one is worth less than nothing — handoff §5 records the Wikidata
  case where a mislinked id made the app call *Homo sapiens* "also known as
  Homo floresiensis". Any new corpus needs the same refusal discipline or it
  reintroduces that class of bug silently.

---

## 6. What not to do

- **Do not compute a midpoint.** No part of this may collapse a fossil range to
  a point, in the pipeline or the UI. The whole layer rests on that.
- **Do not let a witness render without its dates.** The client refuses one
  today and must keep refusing; the dates are the entire difference between
  this and an unlabelled silhouette.
- **Do not merge the tables.** `node_image` and the witness answer different
  questions and only the client knows which applies. That holds unchanged.
- **Do not raise `age_layout` to an age.** It picks a picture. It is never
  shown, and `structural` forks still say "not estimated".
