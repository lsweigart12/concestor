# Raising the divergence witness to its real ceiling

**Status: shipped, all five steps.** Read
[handoff.md](handoff.md) §5 on the witness first; this assumes it.

The witness layer shipped drawing 548 forks. The design capped out at about
2,552 however many images anyone sourced, and the cap was not the corpus — it
was one line in the data model. Witnesses now come from phase 4's fossil
attachment points instead, and *Acanthostega gunnari* stands at the fish/tetrapod
split where a Triassic archosaur 110 Ma adrift used to.

**What it cost to do honestly is most of the headline number**, and §9 is the
part to read if you are here to check the plan against what happened. The
figures below were measured against build `7621312b5760ec1a` on the corpus *as
it then was* — before step 1 withdrew 17,068 wrong resolutions and before the
extancy filter was checked against the bracket rather than the flag. Both were
required by §4 and §5 of this document, and together they take the projection
of 1,416 forks down to a measured **885**. The forks that went are the ones
that should never have been there.

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
| **fossils, drawn with today's images** | 2,267 taxa | **1,416** | 242 |
| **fossils, every dated one drawn** | 234,746 taxa | **22,808** | 5,187 |

Those last two rows count **extinct taxa only**, and that filter is not
optional — see §5. Without it they read 5,917 and 33,428, and the difference is
almost entirely crown groups: PBDB carries *Mammalia* at 239.5–0 Ma,
*Viverridae* at 56–0 and *Panthera* at 23.04–0. A range running to the present
contains every split inside it, so an unfiltered rule hands the biggest forks a
picture of the living group — the exact failure the witness exists to correct,
arriving with a fossil's label on. Every figure below excludes `is_extant = 1`.

Two readings of that table matter more than the totals.

**Row 3 costs no images.** 2,267 already-mirrored PhyloPic drawings name a
dated extinct PBDB taxon. Changing the join alone is worth **2.6× the current
coverage**, and what it buys is not spread evenly — it lands on the forks a
reader actually visits. Tetrapoda stops drawing a Triassic archosaur 110 Ma
adrift and draws *Acanthostega gunnari*, 372–359 Ma against a 360 Ma split.
Perissodactyla stops drawing nothing and draws *Eohippus*. The turtle/crocodile
split draws *Odontochelys*, the half-shelled stem turtle. Worked examples in
§7.

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

## 3. Phase 1 — done, and it stands on its own

**Shipped.** The join that makes a fossil drawable was the first step of this
plan and it pays for itself before any of the rest lands, because the drill-down
lane needed exactly the same thing. Three changes:

**`fossil_image`** maps a PBDB `accepted_no` to a PhyloPic drawing, matched by
name — the only key the two corpora share — with `_seed_by_name`'s refusal rule
applied unchanged. **4,656 PBDB taxa now have a picture**, *Acanthostega*,
*Pakicetus*, *Odontochelys*, *Purgatorius* and *Diplocaulus* among them. It is
keyed on the taxon, not the name, because of the `Scopus` case in §5. This is
step 2 of §4 already built; a witness implementation joins straight onto it.

**The lane's ordering was the same bug in another place.** It ranked on
`n_occs`, and a clade accumulates every occurrence of everything inside it, so
the least specific row always won. Measured on Tetrapoda's 623 attached taxa,
the first eight were Tetrapoda itself (211,065 occurrences, `is_extant` true),
Anthracosauria, Reptiliomorpha, Amphibiosauria and Cotylosauria — five living
wastebaskets — and *Acanthostega gunnari* sat at **rank 147**. Ordering is now a
sum of penalties: extant 8, undrawn 2, broad rank 1, `n_occs` breaking ties
within a tier. The same lane opens on *Diplocaulus*, *Diadectes*, *Seymouria*
and *Discosauriscus*, and *Acanthostega* is rank 9. `is_primary` is filtered in
SQL rather than deduplicated afterwards, so a synonym no longer consumes a lane
row before the dedup can drop it.

**The rows are interactive.** Each carries its own silhouette — never a borrow,
since a fossil has no clade to inherit from — and clicking one opens that
fossil's card. This paragraph used to say the click opened a palette scoped to
the row, on the reasoning that a fossil has no ancestor path and so cannot be
selected at all. That was true when it was written and stopped being true when
the graft got a key: `pbdb<taxon_no>` is a selection like any other, and the
card it opens says what the fossil is, where in the rock it turns up, which
node it hangs below, and who drew it. See `fossil-grafts.md` §6.

What this proves for the rest of the plan: the image link works, the refusal
discipline holds, and the `is_extant` hazard in §5 is real enough to have been
silently wrong in two places at once.

---

## 4. Work, in order — all five done, see §9 for what each actually cost

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
   2,267 dated extinct PBDB taxa today. Reuse `_seed_by_name`'s discipline verbatim —
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

## 5. Hazards, all of them measured

- **`fea` stays unread as a position.** The containment test on `[lla, fea]` is
  fine and the narrow-bracket tie-break is what protects it; phase 4's finding
  that the first-appearance bracket *widens* with occurrence count still holds
  and still forbids drawing anything at `fea`.
- **An extant taxon's range runs to the present and so spans every split
  inside it.** This is the one that will quietly undo the feature: unfiltered,
  the biggest forks take *Mammalia* (239.5–0 Ma) or *Viverridae* (56–0) at gap
  zero, which is the crown-group failure again in a fossil's clothes. Exclude
  `is_extant = 1`; 234,746 of 275,082 dated primaries survive. The 4,538 rows
  where `is_extant` is null are genuinely unknown — exclude those too, since a
  wrong include is a silent regression and a wrong exclude is one missing
  picture.
- **A young end stretched by `sp.` material widens the bracket in the exact
  direction the containment test is vulnerable to.** This is the extant-range
  hazard above arriving through a different door, and it does not need a wrong
  `is_extant` flag to do it: PBDB's young end for 10,655 taxa is one no
  identified member of them reaches, because it rests on material catalogued no
  finer than the taxon itself. A bracket widened toward the present cannot fail
  to contain a recent split. Measured on the built corpus, **41 of the 885
  witnesses** were chosen on such a taxon and **10 of the 192 spanning
  witnesses spanned on that strength** — *Eodiscoglossus* took three forks at
  `gap_ma` 0.0 with a young end 55.4 Myr younger than any identified
  descendant. `load_fossil_candidates` reads `lla_drawn`, phase 4's corrected
  end, and spanning fell from 192 to **190**: the two it lost are the false
  ones, and every anchor case (*Acanthostega*, *Eohippus*, *Sahelanthropus*,
  *Pakicetus*) is untouched. **The residue is 3**, all on taxa phase 4
  deliberately refused to correct — an ichnotaxon or an uncorroborated
  alternative — where keeping PBDB's number is the conservative answer. See
  `fossil-grafts.md` §3.
- **PBDB carries homonyms internally, not only against OTT.** `Scopus` is two
  taxa in the fossil table: the extant hamerkop genus at 5.3–0 Ma and an
  extinct Permian genus at 254–252 Ma. Aggregating rows by *name* merges them
  into a 254–0 envelope, and an image matched by name lands on whichever the
  query returned. Key on `pbdb_taxon_no`, never on name, and refuse an
  ambiguous name exactly as `_seed_by_name` already does.
- **Individual rows carry junk-wide `fea`.** *Psammophis*, an extant sand snake
  genus, has a row reading 323.4–5.3 Ma — a 318 Ma envelope on a Neogene
  animal. Uncapped it wins any fork it contains. The narrow-bracket tie-break
  demotes it only when something better exists; consider refusing a bracket
  wider than some multiple of the fork's own age.
- **Attachment is wrong sometimes, and wrong loudly.** Helminthochitonidae, a
  chiton family, wins both Sauria and the turtle/crocodile split at
  `attach_walk` 1. Ranking on `attach_walk` does not catch it, because the walk
  is short; only a sanity check on the attachment would.
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

## 6. Where images pay, if sourcing continues in parallel

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

## 7. What it looks like on real forks

Measured on the same build. "Already mirrored" needs no new images; "best
possible" is the ceiling with the whole corpus drawn, and is shown partly to
prove §4's hazards are real rather than theoretical.

| divergence | age | today | already mirrored | best possible |
|---|---:|---|---|---|
| human / frog — **Tetrapoda** | 360 Ma | Ctenosauriscidae, **110 Ma adrift** | ***Acanthostega gunnari*** 372–359, spans it | *Molophyllum* 365–359 |
| horse / rhino — **Perissodactyla** | 56 Ma | *nothing* (Equidae borrow refused) | ***Eohippus angustidens*** 56–51, spans it | *Teilhardimys* 59–56 |
| sea turtle / crocodile | 262 Ma | *Epidendrosaurus*, 96 Ma adrift | ***Odontochelys semitestacea*** 234–227, the half-shelled stem turtle | — |
| blue whale / hippo — **Whippomorpha** | 52 Ma | *Basilosaurus*, spans it | ***Pakicetus*** 56–41, spans it | *Hapalodectes* 56–48 |
| human / chicken — **Amniota** | 323 Ma | Ctenosauriscidae, 73 Ma adrift | *Leiocephalikon* 319–317, 4 Ma off | *Dromopus* 323–299, spans it |
| python / anole | 173 Ma | *Aigialosaurus*, 72 Ma adrift | ***Tetrapodophis amplectus***, the four-legged snake | — |
| human / mouse — **Euarchontoglires** | 83 Ma | Notharctidae, 23 Ma adrift | ***Purgatorius*** 66–58 | *Pandemonium* 66–63 |
| dog / cat | 67 Ma | *Archaeocyon*, 35 Ma adrift | *Maofelis*, 19 Ma adrift | *Ictidopappus* 63–61, 4 Ma off |
| polar bear / dog — **Caniformia** | 57 Ma | *Archaeocyon*, 25 Ma adrift | *Hesperocyon gregarius*, 17 Ma adrift | *Chailicyon* 56–38, 1 Ma off |
| lion / tiger — **Panthera** | 6.6 Ma | *nothing* (own borrow) | *P. gombaszoegensis*, 1 Ma off | *P. blytheae* 12–4 |

*Acanthostega* at the fish/tetrapod split and *Eohippus* at the horse/rhino
split are the two to judge this by: both are the textbook animal for that
divergence, both are already drawn and mirrored, and both are unreachable today
purely because they are not nodes.

**Where it does not help.** The chicken/crocodile split (245 Ma) moves from 119
Ma adrift to 119 Ma adrift — the archosaur stem is drawn badly at every source.
Gnathostomata improves from 108 to 52 Ma adrift and is still wrong. Those need
sourcing, not a join.

**And the "best possible" column is not achievable by sourcing**, which is the
point of §4. Unfiltered it hands the bird/crocodile split `Scopus` — the
Permian homonym of the hamerkop — Sauria and the turtle/crocodile split a
chiton family, and human/octopus a Proterozoic stromatolite. Those are data
faults, not missing drawings, and they must be filtered before the ceiling is
worth anything.

---

## 8. What not to do

- **Do not compute a midpoint.** No part of this may collapse a fossil range to
  a point, in the pipeline or the UI. The whole layer rests on that.
- **Do not let a witness render without its dates.** The client refuses one
  today and must keep refusing; the dates are the entire difference between
  this and an unlabelled silhouette.
- **Do not merge the tables.** `node_image` and the witness answer different
  questions and only the client knows which applies. That holds unchanged.
- **Do not raise `age_layout` to an age.** It picks a picture. It is never
  shown, and `structural` forks still say "not estimated".

---

## 9. What shipped, and where it differs from the plan above

Measured on the rebuilt corpus. Everything in §1–§8 stands except the totals,
and the totals moved for reasons §4 and §5 predicted.

| | projected here | shipped |
|---|---:|---:|
| eligible fossil taxa | 2,267 | **2,114** |
| forks with a witness | 1,416 | **885** |
| forks whose witness spans the split | 242 | **192** |

**Step 1 was most of the difference, and it was worth more than the coverage.**
`refuse_disagreements` in `resolve.py` withdraws a resolution where PBDB calls
a taxon extinct, OTT's taxon of that name carries no extinct flag, and the node
still has a chronogram-dated descendant — 16,833 of them, over *every* method
rather than `name_exact` alone, because `gbif_backbone_provenance` supplies
7,191 and the backbone merges a fossil name onto the living genus exactly as a
bare string does. A second refusal takes 235 more where a name is still claimed
by two accepted PBDB taxa after that, which is §4's port of `_seed_by_name`.

Two things about it are worth carrying forward. The **order matters**: the
extancy sweep runs first, so `Scopus` loses its Permian claimant on evidence
and the hamerkop keeps the resolution, where refusing on ambiguity first would
have thrown away both. And the sweep needs a **living-lineage guard** — refusing
on OTT's flag alone costs 1,162 correct attachments, *Neochelys*, *Baptemys* and
*Roxochelys* among them, because OTT simply has not flagged every fossil genus.
Phase 4's independent check moved from **1,019 of 1,048** exact attachments
older than 250 Ma landing on a living lineage to **31 of 60**: the population
collapsed, which is the shape a real fix makes rather than a threshold moving.

**§5's `is_extant` hazard is real and the flag does not carry it.** Filtering on
`is_extant = 0` as written let *Thalassia testudinum* — the living turtle grass,
flagged extinct, bracketed 48.07–0.0117 Ma — win a fork of 378,328 tips, along
with the roan antelope, the northern kelp crab and a living foram at 85.7–0 Ma.
The rule is now applied to the evidence: a witness's last appearance must
predate the Holocene (`HOLOCENE_MA`). That costs 3,505 candidates and 222 forks,
including genuine recent extinctions — the dire wolf, and *Moho braccatus*,
which died in 1987 — and it is the trade §5 already specified.

**Spanning went down, and that is the finding.** §5 says to gate on the share
of forks whose witness spans the split rather than on coverage. Measured old
rule against new on the *same* corrected corpus:

| | node-only | fossil attachment |
|---|---:|---:|
| forks | 548 | **885** |
| spanning | 207 | **192** |
| median gap, as a share of the fork's age | 14% | 17% |
| p90 gap | 100% | **81%** |

Of the 107 forks the old rule reached and this one does not, **14 were
"spanning"** — and the list is *Moho braccatus* across Passeriformes at a 52 Ma
gap, *Styliola* across Opisthobranchia, and *Pseudamia*, the living cardinalfish
§6 names, across Gobiaria. A range that runs to the present cannot fail to
contain a recent split, so spanning is inflatable by exactly the taxa that must
not be witnesses. It is still the right gate — it does not rise when the rule
loosens — but it is not a clean one, and `MIN_SPANNING_WITNESSES` carries the
comparison so the next reader does not re-derive it. 444 forks are reached that
the old rule could not touch at all, and where both fire the new witness is
closer on 177 and further on 108.

**The table was renamed, not redefined.** `node_divergence_image.source_idx` was
a node index; `node_divergence_witness.pbdb_taxon_no` is a PBDB taxon number.
Same shape, different universe, and a consumer joining the old name against
`node` would join cleanly and return nonsense — the `node_fts.rowid` failure in
handoff §5, waiting to happen again. The server reads either and reports which
through `WitnessSchema.Fossil()`.

**What the caption gained.** `attach_walk` reaches the client and is rendered as
three bands rather than a number: *placed exactly here in the tree* at 0 hops
(243 forks), *just below this point* at 1–2 (325), and *its exact position is not
known — only that it belongs below here* above that (317). The card's opening
line went from "one lineage from inside it" to "a fossil taxon from somewhere
below this fork", which is architecture §3.4's wording and the strongest true
statement available.

**One thing the plan did not anticipate.** At these scales rounding turns a true
sentence into an apparent contradiction: Perissodactyla is dated 56.26 Ma and
*Eohippus* tops out at 56.0, so the card showed "56 Ma" beside "56–51 Ma" and
then said the range does not reach the split. The gap is now stated — *it stops
0.3 Ma short* — through `gapLabel`, which is deliberately not `maLabel`: a gap
is a quantity, and `maLabel` renders anything under 0.05 Ma as "present".
