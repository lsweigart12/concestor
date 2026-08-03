# Ranking common names by use

**Status: shipped**, 31/31 gates, build `854cdfa42f77e78e`. Phase 6b,
`concestor-build names`. §7 is the canvas scientific/common switcher, **also
shipped** — and the reason this document exists in the shape it does. The canvas
now opens on common names, which is what the ranking was for: without
`usage_rank` the default would be whichever name a crawl returned first.

It moved **7,958 headline names** of 110,794, and gave an order to the 26,262
nodes that had none. Nothing was added, removed or rewritten: the phase writes
order and evidence only, and a gate compares the row census either side of it.

---

## 1. What was wrong

Phase 6 harvests every English name a taxon goes by. It elected one headline
and left the rest unordered, and both halves failed in ways a reader meets on
the first card they open.

**The election was decided by `length(name)`** once source and kind had tied.
Measured against the shipped build `b48553b2b8a4a2ed`:

| taxon | headline it elected | why |
|---|---|---|
| *Tyrannosaurus rex* | **TRex** | 4 characters beats `T. rex`'s 6 |
| Carnivora | **Ferae** | a Latin clade name; the P1843 statement |
| Lepidoptera | **lepidopteran** | likewise |
| Bacteria | **eubacteria** | likewise |
| Archaea | **Archaeon** | likewise |

**Below the headline there was no order at all.** `Vernaculars()` stable-sorted
`is_primary` to the front and returned the remainder in rowid order, so the card
read *"Homo sapiens — also called human being, human beings, humans, man,
men"*. **26,262 nodes carry more than one English name**; that is the population
an ordering is for, and the other 84,532 have one name and no choice to make.

**The evidence had already been thrown away.** `vernaculars.py` computed a
`kind` for every row — `v` a declared common name, `l` an item label, `a` an
alias — used it during dedup, and did not store it. The same for how many
sources carried a string. By the time anything downstream saw the table, the
strongest signals phase 6 held had been compressed into one boolean.

---

## 2. What "most used" is measured against

**English Wikipedia's title and redirect graph.**

A name that is an article **title** is, by that project's own naming policy,
the name most used in reliable English sources — which is the question being
asked, decided by people rather than by us. A name that is a **redirect** to
that article is one somebody thought a reader would type. A name that is **no
page at all** is one nobody did. A name that is a page landing on a **different
article** is a name whose ordinary English referent is something else.

The pass costs 50 titles per request against the MediaWiki API, is checkpointed
per batch, and replays offline. Measured on the current build: **177,223
distinct titles in 3,545 batches, 29 minutes**, no early stop. 71,955 of the
108,683 items we hold a QID for carry an English article — the other 36,728
have none, and every name on them is `NULL`, not `none`.

What it found, over 159,961 resolved names:

| evidence | names | |
|---|---:|---|
| `title` | 7,725 | the name **is** the taxon's article |
| `redirect` | 48,909 | it reaches the taxon's article |
| `elsewhere` | 12,174 | a real page, landing somewhere else — demoted |
| `none` | 47,522 | no such page |
| *not asked* | 43,631 | the taxon has no English article |

It settles by measurement the whole class of failure that would otherwise need
a rule written about each case. Verified against the live API on 2026-08-02:

```
man, men      -> "Man"            not Homo sapiens' article     demoted
bug, bugs     -> "Bug" / "Bugs"   not Insecta's article         demoted
moth          -> "Moth"           not Lepidoptera's article     demoted
Ferae         -> "Ferae"          not Carnivora's article       demoted
TRex          -> no page at all                                 demoted
carnivorans   -> "Carnivora"                                    kept
T. rex        -> "Tyrannosaurus"                                kept
eubacteria    -> "Bacteria"                                     kept
```

Nothing in that table is hand-written. `Ferae` and `carnivorans` are separated
because Wikipedia files them differently, not because anybody decided `Ferae`
looked too Latin.

### The trap that inverts the result

**The taxon's own article title has to be resolved through redirects before
anything is compared against it.** Wikidata gives *Homo sapiens* (Q15978631)
the enwiki sitelink `Homo sapiens` — and `Homo sapiens` on English Wikipedia is
a **redirect to `Human`**. Compared against the unresolved sitelink, `human`
lands on `Human`, which is not `Homo sapiens`, so the single best name for the
species reads as pointing somewhere else and is demoted. Both ends go through
the same resolution and the comparison is between **targets**.

### Absent evidence is not evidence of absence

Where a taxon has **no English article**, `wiki_evidence` stays **NULL** and
the ranking falls through to the offline bands. NULL is a fifth state and is
not `none`. Conflating them would let a half-finished crawl silently demote
every name it had not reached yet — and it is the same rule phase 6 already
applies to a Wikidata item carrying no `P225`.

---

## 3. The bands

Strongest evidence first.

| band | meaning |
|---:|---|
| 1 | `title` — the name is the taxon's article title |
| 2 | `redirect` — the name reaches the taxon's article |
| 3 | `declared` — Wikidata `P1843` or PBDB ColDP: a curated common name |
| 4 | `label` — the Wikidata item's own label |
| 5 | `alias` — a Wikidata `altLabel` and nothing more |

**`elsewhere` is demoted one band and never removed.** That is deliberately the
same shape as the rule `handoff.md` records for search — exactness is
*withdrawn*, not deleted. `man` is a name humans go by, however much the
article `Man` is about something narrower, and a reader who searched it
deserves to be told why they arrived rather than to conclude the search
misheard.

Within a band, in order: a stem-derived name yields to one that is not (§4),
then corroboration (`n_sources`) descending, then shape penalty, then word
count, then length, then the string. **The last two are the old election's
entire ruleset**, kept as a dead-heat breaker rather than as a ranking. Length
is a fine way to choose between two names nothing else distinguishes and a
catastrophic way to choose a headline; it elected `TRex`.

---

## 4. Three rules that are judgement, and are fenced

All three decide ties **inside** a band and can never move a name across one. That
fence is the whole of why they are allowed to exist: a shape rule may reorder
two names Wikipedia is silent about, and may never overrule Wikipedia about a
name Wikipedia has an opinion on.

**Shape penalty** counts defects in a name's form, and every clause was found
in the shipped table rather than imagined — `Sibbold's Rorqual,` with its
trailing comma, `spider (arachnid)` carrying a disambiguator meant for a
different medium, `the lion`, and `Zanthoxylum diversifolium Warb. (1891), non
Lesq. (1878)`, a nomenclatural citation that reached a vernacular column. 1,498
names contain a comma and 14,101 contain a bracket.

**Stem derivation** — is the name the scientific name with an English suffix
bolted on? `lepidopteran` from *Lepidoptera*, `Dipterous` from *Diptera*. It is
**never** applied outright, and the reason is decisive: `arthropod`,
`tetrapod`, `mollusc`, `primate` and `chordate` are all formed exactly that way
and all of them are the ordinary English word. There is nothing else to call an
arthropod. So the rule is **relative** — where a taxon has both a stem-derived
name and one that is not, in the same band, the one that is not goes first.
Lepidoptera gets `butterflies and moths` over `lepidopteran`; Arthropoda keeps
`arthropod`, because nothing else is on offer.

**Mangled abbreviation** — the one rule added *after* seeing the phase's own
output, which is why it is worth recording how it was found. *Tyrannosaurus
rex* carries `T. rex`, `T rex`, `T-Rex` and `TRex`. `TRex` is no page at all
and falls away, but the **other three are all redirects to *Tyrannosaurus***,
so the evidence is silent between them and the generic tiebreaks picked the
shortest: the app headlined its most famous fossil as **T-Rex**. Passing gates,
correct by every rule then written down, and wrong on the screen.

The discriminator is the taxon's own binomial. `X. epithet` is the standard
abbreviated form — the same form this project's search already indexes as an
abbreviation kind — so a string that abbreviates *this* binomial and is not in
that form is a mangling of a convention rather than a name in its own right. It
is a penalty on the manglings, **not a promotion of the abbreviation**, which
matters: promoting it would put `B. musculus` above `blue whale`. It fires only
on the taxon's own abbreviation, so it cannot reach an ordinary name.

---

## 5. Three sources considered and not used

- **English corpus frequency** — Google Books ngrams, `wordfreq`, any general
  word list. It measures how common the *string* is in English, not how
  commonly it is used *for this taxon*, and the two come apart precisely where
  the ranking matters: within *Homo sapiens*'s own names it ranks `man` above
  `human`, and `mouse` is mostly a pointing device. Refused on the principle
  that keeps `age_ma` and `age_layout` apart — a number measuring a different
  question does not become the right one by being numeric.

- **Wikimedia pageview dumps** — `pageviews-202606-user.bz2`, **5.53 GB**
  measured, one month, all projects. Exact per-title view counts including
  redirects, which is the strongest possible statement of "most used". It is a
  strict **addition** to what is built here rather than an alternative: every
  count still has to be attributed to a taxon, which needs this phase's
  redirect pass anyway, and it lands as one more evidence column keyed on
  titles already resolved. Deferred on the gigabytes and the hours, **not on
  doubt.** Reopen it if ordering below rank 2 turns out to matter.

- **Ranking search results by the same score.** `server/internal/store/band.go`
  answers *which taxon does this query mean*. This answers *which name does
  this taxon go by*. They are different questions, this score is display-only,
  and no search path reads it. Changing search ranking is its own decision with
  its own gates — and `handoff.md` already records what it cost the last time
  something outranked those bands.

  **Still true of `usage_rank`. No longer true of `wiki_evidence`, and the
  distinction is the point.** Search now reads exactly one of that column's five
  values, `title`, as a tiebreak between two taxa carrying the query verbatim.
  A usage rank is *relative to one taxon* — rank 1 on *Homo* and rank 1 on *Homo
  sapiens* are not comparable quantities, and ranking search by them would be
  comparing two taxa on a number neither was measured against the other for. An
  **article title is absolute**: English Wikipedia has one page called `Human`
  and it is *Homo sapiens*'s, so `wiki_evidence = 'title'` on the name the reader
  typed is a statement about which taxon the word denotes — band.go's question,
  answered by the instrument §2 already built. `handoff.md` §7 has the
  measurement, the 358 names it moves, and the mirror rule that was refused.

---

## 6. Where it lives

**`vernacular` gained five columns**, of which two are recovered evidence phase
6 was already computing:

| column | written by | meaning |
|---|---|---|
| `kind` | phase 6 | `v` declared / `l` label / `a` alias — the strongest any source claimed |
| `n_sources` | phase 6 | how many distinct sources carried this string for this taxon |
| `wiki_evidence` | phase 6b | `title` / `redirect` / `elsewhere` / `none`; **NULL means not asked** |
| `usage_rank` | phase 6b | 1-based within `(idx, lang)`, most used first |
| `is_primary` | phase 6b | kept, and defined as exactly `usage_rank = 1` |

`node_wiki(idx, qid, title, target)` records which English article each taxon
sits at, and where that title lands after redirects. It is the thing every
comparison is made against, so it is stored rather than held in the crawl
files: a gate can then check the evidence on the table rather than trusting the
code that wrote it.

**One scoring function, two callers.** `name_rank.assign_ranks` is called by
phase 6 with no wiki evidence — so a build that never runs `names` still has a
defensible order rather than rowid order — and by phase 6b with the crawls.
Same rules, different inputs. Phase 6b **writes order and evidence only**; a
gate compares the row census before and after and fails if any name was added,
removed or rewritten.

**Order of phases.** `names` reads the `vernacular` table, so it runs after
`vernaculars`. It does not touch `node_fts`, so it is independent of `search`.
It is a separate subcommand rather than part of phase 6 so the ordering can be
retuned without replaying phase 6's 287-page ingest — the same reason `search`
is separate.

**"Also called" moved onto the face of the card, above the description.** It
was an 11.5px comma-run in a `.note` at the bottom, beside the scientific
synonyms — which was the right place while the order was arbitrary and the
content was therefore trivia. Ranked, it is a short answer to a question the
reader has, so it goes above the four sentences of encyclopaedia rather than
below them. The **scientific synonyms stayed** where they were: they answer
*why did I land here*, which is provenance, so `NamesBlock` and
`AlsoCalledBlock` are now two components rather than one.

**It is clamped to one row, with `+N more` at the end.** Carnivora carries
eight of these and would otherwise cost three lines above the description —
which is the space the promotion was meant to buy the description in the first
place. One row is what the ranking earns: the names that fit are the ones the
evidence put first, and the rest are one press away. The control appears only
when it has something to count; *Homo sapiens*'s five names fit and it does not
appear. It is one-way, like the description's "Read the rest" a few lines below
it.

Four things in that block are not taste:

- **How many fit is measured, not guessed.** The card is 360px on desktop and
  full-width on narrow, and these strings run from `cat` to
  `Artiodactylamorpha`, so any fixed count is wrong on one of them.
  `web/src/detail/oneRow.ts` does the arithmetic and is unit-tested; the
  component only feeds it boxes. The suite runs in `node` with no layout
  engine, so a DOM test would pass on a rule that is wrong — the arithmetic is
  where the mistakes are, so the arithmetic is what is pinned.
- **The measurement runs against a hidden twin holding the whole list.**
  Measuring the visible row does not converge: collapsing it changes what is
  laid out, so the next measurement sees a different list, re-expands, and
  measures again. The first attempt did exactly that and settled on never
  collapsing — every name across two rows with no control, looking for all the
  world like the measurement had decided it all fitted. The twin is
  `position: absolute; visibility: hidden` — **not `display: none`**, which
  would give every item an `offsetTop` of 0 and make the arithmetic conclude
  that one row holds everything.
- **The separator trails its name.** Leading it means a wrapped line opens on a
  dot; Carnivora's second line read `· Digitigrada`. Binding name and dot with
  `white-space: nowrap` is then not enough on its own — it puts every space
  inside a nowrap span, leaving the line no break opportunity at all, so the
  list stops wrapping and overflows the card. The parent is a **wrapping flex
  row**, so the gap is layout rather than whitespace.
- **A dot, not a comma**, because several of these names carry commas of their
  own — `Sibbold's Rorqual,` shipped with a trailing one.

There is deliberately **no brightness ramp** down the list, tempting as it is
with a ranking in hand: the design language reserves luminance for selection,
and the order already carries the ranking.

**The server orders in SQL and the client does not reorder.** `Vernaculars()`
sorts by `usage_rank` with NULLs last; `BestVernaculars()` takes the lowest
rank. Both fall back to the boolean where the column is absent, because feature
detection over a partially built dataset is a documented property of this
server. On the client, `toStrings` lost its `preferredFirst` sort — with a real
ranking behind it, a client-side sort on one flag flattens every distinction
below the headline back into arrival order. `web/src/api.test.ts` pins it.

---

## 7. The canvas scientific/common switcher — shipped

A control that flips the canvas between scientific and common names. **Built.**
What follows is what it needed, what bit, and the two things the design as
written here got wrong.

**The data hook is `/v1/path`, and nothing else is needed.** `PathNode` carries
`name` and no vernacular. It gains `vernacular: string | null`, filled by one
batched `BestVernaculars` call over the path's indices — a query that already
exists, against an index that already exists (`vernacular_rank`). Mean path
length is 41, so it is ~41 short strings per selection, riding the existing URL
cache and build ETag. **No new endpoint and no second round trip**, which
matters because architecture §4 has the client owning the topology after first
paint and the switch must not become a fetch.

**Do not bake a name onto the node arrays.** They are memory-mapped flat
arrays; 2.7M variable-length strings is not one of those, and 110,794 of those
nodes carry a name at all. The table plus a batched join is the right shape and
is already fast.

**The canvas will be mixed, and that is the design rather than a defect.**
110,794 nodes carry an English name against 2,725,682 nodes. On a typical
induced subtree most internal nodes are `mrcaott…` clades that are not taxa and
will never have a common name — so "common names" can only mean *prefer the
common name where one exists*. The reader has to be able to tell which they are
looking at, and the app already has the channel: scientific names are italic
(`.sci-italic`), common names are not. That distinction is on the card today
and carries to the canvas unchanged. **A divergence is the case it helps least
and those are the marks a deep tree is mostly made of** — worth saying out
loud, so nobody expects the switch to transform a canvas it can only partly
touch.

**It is a layout change, not a CSS toggle.** `labels.ts` measures text to
reserve space, a label is three rows that tier off independently, and its font
constants are pinned to `styles.css` by a test that reads the stylesheet.
Swapping every label's string changes every label's width, so the fit and the
tier-off both have to re-run. They already recompute on layout change; the
point is that the switch must go through that path and not around it.

~~**It is a view preference, so it belongs in the URL** beside `axis=`.~~ **It
does not**, and this is the other thing the design above got wrong. It went in
the link first and came back out: the test is what a setting is *about*, and
this one is about the **reader** rather than about the taxa. A shared tree would
otherwise impose the sender's reading habit, and a link made with the labels off
would open on a canvas of unnamed dots. It lives in `sessionStorage` with
bioluminescence, per-tab, so a link always opens at the defaults in a fresh tab.
`state/store.test.ts` pins both halves: `encode` writes neither, and `decode`
drops them from a link that carries them.

**If it gets a key, it goes in `bindings.ts`**, which is the only table, and it
feeds the control bar and the palette from the same rows so a key cannot print
one thing and do another. It got **`L`**, and the time scale moved to `T` to
free it — `l` names the labels better than it named one of two scales. `A` flips
the ages. Both also have a palette command and a button, which is the rule
design-reference.md actually states.

**What it must not do is re-rank.** Same rule as everywhere else in this file.

### What it cost, and the two things above that were wrong

**A common name is served for genus, species and subspecies only**, which this
section did not anticipate and which is the single most important clause in the
feature. `Entry.Vernacular` applies it and `markName` applies it again. Above
genus a common name names a *group* rather than a kind of animal, and the whole
of §3's demotion machinery exists because those words' ordinary referents are
something else — a fork captioned "great apes" or "animals" has named a clade
after its crown group, which is exactly the failure `node_image` versus
`node_divergence_witness` was built to prevent on the picture side. It costs
2.9% of the ranked names: 107,593 of 110,794 sit at those three ranks.

**Rank 1 or nothing, and no fallback.** `BestVernaculars` degrades to
`is_primary` and then to the first row seen, which is right for a caption
sitting beside the scientific name it captions. On the canvas the common name
*replaces* it, so an unranked guess would be another taxon's word in the only
slot saying which taxon a mark is. `HeadlineVernaculars` is the strict sibling:
`usage_rank = 1`, or silence, and silence means the scientific name, which is
never wrong. A build predating this phase therefore shows no common names at
all — the intended degradation.

**The switch touches divergences even less than this section warned**, and the
reason is worth writing down because it looks like a bug. `divergenceFor` reads
the *suppressed run* before the leaf, deliberately — a node separating two
genera must not be labelled with two species — and 5,548 genera carry a ranked
English name against 99,960 species. So choosing human and chimp alone still
draws "Homo / Pan" in both modes. Where the genera do have names it does
translate, run by run: the human/chimp fork reads "human / chimpanzee", and
`abbreviateRepeatedGenus` is skipped for a common run, since `H. erectus` is a
convention of scientific names and applied to "Human" it produces "H. uman".

**The italics carried it.** `NamePart.rank` was already the italic channel and
already null for punctuation, so a common name is a run with `rank: null` and
the existing renderer sets it roman with no new rule. One fork can now carry
both kinds of name and say so typographically.

**It replaced semantic zoom rather than joining it.** The canvas used to decide
which rows to draw from the zoom level; that is gone, and `ages` is the second
switch left over from it. design-reference.md's *Zoom* and *What a label says*
are the account.

**And common is the *default*, which is what this whole phase was for.** The
switch opened on scientific names at first, on the argument that the mixture
would leave a reader unable to tell whether it had done anything. That reads the
audience backwards: this product is for curious people rather than for
evolutionary biologists, and a canvas of binomials asks a stranger to learn a
vocabulary before it will tell them anything. The ranking is what makes the
other setting safe to open on — without `usage_rank` the default would be
whichever name a crawl happened to return first, and *Homo sapiens* would
headline as `man`.

---

## 8. Known limits

- **English only**, in both the names and the encyclopaedia prose. Wikidata
  carries ~300 languages and a picker is a real feature, not a constant — and
  doing it properly means doing the names and the descriptions together, since
  they come from the same crawl. `web/src/detail/wiki.ts`'s `LANG_NOTE` is the
  other half of this.
- **A taxon with no English article gets no wiki evidence**, which is most of
  the corpus by node count. Those fall through to the offline bands, which are
  a real ordering but a weaker one.
- **Broken taxa still carry no vernaculars at all**, so *Quercus* has no names
  to rank. Unchanged by this phase and recorded in `handoff.md` §7.
- **Ordering below band 2 is evidence-tiered, not measured.** Among names
  Wikipedia files identically, the order is the bands and the tiebreaks. The
  pageview dump in §5 is the thing that would fix it.

- **A half-finished resolution crawl gives a worse ordering, not a wrong one —
  and unlike phase 6's crawl it is not prioritised.** Phase 6 orders its plan
  by `tip_count` precisely so an interrupted crawl still answers *dog*; this
  one sorts titles alphabetically, because it is unbudgeted and runs to
  completion in under an hour. The consequence is real and worth knowing: a
  taxon's names are scattered through the alphabet, so a partial run can leave
  one name in band 2 on evidence and its better sibling in band 3 for want of
  it. Nothing is *false* — an unresolved name is NULL, never `none` — but the
  order is biased toward whatever sorted early. **The spot-check gates
  therefore only `require` when the crawl reports complete**, and `observe`
  otherwise. Do not reorder the plan to fix this without accepting that the
  prefix digest changes and every checkpoint on disk is discarded.
