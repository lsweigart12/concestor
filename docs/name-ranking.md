# Ranking common names by use

**Status: shipped.** Phase 6b, `concestor-build names`, orders the English names
a taxon goes by and writes `vernacular.usage_rank`. §7 is the canvas
scientific/common switcher, also shipped. The score is **display-only**: it
orders one taxon's own names and no search path reads it.

The phase writes **order and evidence only** — nothing is added, removed or
rewritten, and a gate compares the row census either side of it.

---

## 1. What "most used" is measured against

**English Wikipedia's title and redirect graph.**

- A name that is an article **title** is, by that project's own naming policy, the
  name most used in reliable English sources. **Leads.**
- A name that is a **redirect** to that article is one somebody thought a reader
  would type. **Mid.**
- A name that is **no page at all** is one nobody did. **Low.**
- A name that is a page landing on a **different article** (`elsewhere`) is a name
  whose ordinary English referent is something else. **Demoted one band, never
  removed** — `man` is a name humans go by even though the article `Man` is about
  something narrower, and a reader who searched it deserves to be told why they
  arrived.

The pass costs 50 titles per request against the MediaWiki API, is checkpointed
per batch, and replays offline.

**Two rules that are load-bearing:**

- **The taxon's own article title must be resolved through redirects before
  anything is compared against it.** Wikidata gives *Homo sapiens* the sitelink
  `Homo sapiens`, which is a redirect to `Human`; comparing against the unresolved
  sitelink would demote the species' single best name. Both ends go through the
  same resolution and the comparison is between targets.
- **Absent evidence is not `none`.** Where a taxon has no English article
  `wiki_evidence` stays **NULL**, a fifth state, and the ranking falls through to
  the offline bands. Conflating NULL with `none` would let a half-finished crawl
  silently demote every name it had not reached.

---

## 2. The bands

Strongest evidence first.

| band | meaning |
|---:|---|
| 1 | `title` — the name is the taxon's article title |
| 2 | `redirect` — the name reaches the taxon's article |
| 3 | `declared` — Wikidata `P1843` or PBDB ColDP: a curated common name |
| 4 | `label` — the Wikidata item's own label |
| 5 | `alias` — a Wikidata `altLabel` and nothing more |

`elsewhere` is demoted one band. Within a band, in order: a stem-derived name
yields to one that is not (§3), then corroboration (`n_sources`) descending, then
shape penalty, then word count, then length, then the string.

---

## 3. Three tiebreaks that are judgement, and are fenced

All three decide ties **inside** a band and can never move a name across one. A
shape rule may reorder two names Wikipedia is silent about; it may never overrule
Wikipedia about a name Wikipedia has an opinion on.

- **Shape penalty** counts defects in a name's form — a trailing comma
  (`Sibbold's Rorqual,`), a disambiguator (`spider (arachnid)`), a leading
  article (`the lion`), a nomenclatural citation that reached a vernacular column.
- **Stem derivation** — is the name the scientific name with an English suffix
  bolted on (`lepidopteran` from *Lepidoptera*)? Applied **relatively**, never
  outright: where a taxon has both a stem-derived name and one that is not, in the
  same band, the one that is not goes first. `arthropod`, `tetrapod`, `mollusc`,
  `primate` are all stem-formed and all the ordinary English word, so Arthropoda
  keeps `arthropod` because nothing else is on offer.
- **Mangled abbreviation** — `T. rex`, `T rex`, `T-Rex`, `TRex` are all redirects
  to *Tyrannosaurus*, so the evidence is silent between them. The taxon's own
  binomial is the discriminator: `X. epithet` is the standard abbreviated form, so
  a string that abbreviates *this* binomial and is not in that form is penalised
  as a mangling. It is a penalty on the manglings, **not a promotion of the
  abbreviation** (which would put `B. musculus` above `blue whale`), and fires
  only on the taxon's own abbreviation.

---

## 4. Where it lives

**`vernacular` carries five columns:**

| column | written by | meaning |
|---|---|---|
| `kind` | phase 6 | `v` declared / `l` label / `a` alias — the strongest any source claimed |
| `n_sources` | phase 6 | how many distinct sources carried this string for this taxon |
| `wiki_evidence` | phase 6b | `title` / `redirect` / `elsewhere` / `none`; **NULL means not asked** |
| `usage_rank` | phase 6b | 1-based within `(idx, lang)`, most used first |
| `is_primary` | phase 6b | defined as exactly `usage_rank = 1` |

`node_wiki(idx, qid, title, target)` records which English article each taxon sits
at and where that title lands after redirects. It is stored (not held in the crawl
files) so a gate can check the evidence on the table.

**One scoring function, two callers.** `name_rank.assign_ranks` is called by phase
6 with no wiki evidence — so a build that never runs `names` still has a defensible
order — and by phase 6b with the crawls. Phase 6b writes order and evidence only.

**Order of phases.** `names` reads the `vernacular` table, so it runs after
`vernaculars`. It does not touch `node_fts`, so it is independent of `search`. It
is a separate subcommand so the ordering can be retuned without replaying phase
6's ingest.

**On the card**, "Also called" sits on the face above the description, clamped to
one row with `+N more`:

- **How many fit is measured, not guessed** — `web/src/detail/oneRow.ts` does the
  arithmetic and is unit-tested in `node`, against a hidden twin that holds the
  whole list (`position: absolute; visibility: hidden`, **not `display: none`**,
  which would give every item an `offsetTop` of 0).
- **The separator trails its name** (a leading dot opens a wrapped line on a dot),
  bound with a wrapping flex row so the gap is layout rather than whitespace.
- **A dot, not a comma**, because several names carry commas of their own.
- **No brightness ramp** down the list — luminance is reserved for selection.

**The server orders in SQL and the client does not reorder.** `Vernaculars()`
sorts by `usage_rank` NULLs-last; `BestVernaculars()` takes the lowest rank. Both
fall back to the boolean where the column is absent. On the client, `toStrings`
has no `preferredFirst` sort; `web/src/api.test.ts` pins it.

---

## 5. The title tiebreak in search

`server/internal/store/band.go` decides *which taxon a query means*. It reads
exactly one of `wiki_evidence`'s five values — `title` — as a **tiebreak between
two taxa carrying the query verbatim**.

A usage rank is relative to one taxon and is not comparable across taxa. An
**article title is absolute**: English Wikipedia has one page called `Human` and it
is *Homo sapiens*'s, so `wiki_evidence = 'title'` on the name typed is a statement
about which taxon the word denotes. The tiebreak **only ever promotes** — it sits
above `rank_score` so no taxon climbs past a better-matching name, and nothing
leaks into name ordering.

---

## 6. The canvas scientific/common switcher — shipped

A control that flips the canvas between scientific and common names.

- **The data hook is `/v1/path`.** `PathNode` gains `vernacular: string | null`,
  filled by one batched `BestVernaculars` call over the path's indices — an
  existing query against an existing index (`vernacular_rank`). No new endpoint and
  no second round trip; the switch must not become a fetch.
- **Names are not baked onto the node arrays.** They are memory-mapped flat
  arrays; the table plus a batched join is the right shape.
- **The canvas is mixed, and that is the design.** 110,794 nodes carry an English
  name against 2,725,682, so "common names" means *prefer the common name where
  one exists*. **Italics say which**: scientific names are italic (`.sci-italic`),
  common names are not. `NamePart.rank` is the italic channel and is null for a
  common run, so the existing renderer sets it roman with no new rule.
- **It is a layout change, not a CSS toggle.** Swapping every label's string
  changes every label's width, so the fit and the tier-off re-run through the
  normal layout-change path.
- **A common name is served for genus, species and subspecies only** — enforced in
  `Entry.Vernacular` and again in `markName`. Above genus a common name names a
  group rather than a kind of animal ("great apes" would name a clade after its
  crown group). 107,593 of 110,794 ranked names sit at those three ranks.
- **Rank 1 or nothing, and no fallback.** On the canvas the common name *replaces*
  the scientific one, so an unranked guess would be another taxon's word in the
  only slot saying which taxon a mark is. `HeadlineVernaculars` is the strict
  sibling of `BestVernaculars`: `usage_rank = 1`, or silence — and silence means
  the scientific name, which is never wrong.
- **A divergence keeps its Latin more often than expected.** `divergenceFor` reads
  the *suppressed run* before the leaf (a node separating two genera must not be
  labelled with two species), and genera rarely carry ranked English names, so a
  human/chimp choice still draws "Homo / Pan". Where the genera do have names it
  translates run by run ("human / chimpanzee"); `abbreviateRepeatedGenus` is
  skipped for a common run (`H. uman`).
- **Common is the default**, because the audience is curious people rather than
  biologists and a canvas of binomials asks a stranger to learn a vocabulary
  first. The ranking is what makes this safe: without `usage_rank` the default
  would be whichever name a crawl returned first, and *Homo sapiens* would headline
  as `man`.
- **It is not in the URL.** It lives in `sessionStorage` with bioluminescence,
  per-tab — a setting that is a claim about the reader may not travel in a link.
  `state/store.test.ts` pins that `encode` writes neither and `decode` drops them.
- **It got the key `L`**, which the time scale gave up for `T` and then gave up
  altogether with the second scale; `A` flips the ages. Both have a palette
  command and a button, from `bindings.ts` — the one table.

---

## 7. Known limits

- **English only**, in both the names and the encyclopaedia prose.
  `web/src/detail/wiki.ts`'s `LANG_NOTE` is the other half.
- **A taxon with no English article gets no wiki evidence** and falls through to
  the offline bands — a real ordering but a weaker one.
- **Broken taxa carry no vernaculars at all**, so *Quercus* has no names to rank.
- **Ordering below band 2 is evidence-tiered, not measured.**
- **A half-finished resolution crawl gives a worse ordering, not a wrong one.** An
  unresolved name is NULL, never `none`. The plan sorts titles alphabetically (it
  is unbudgeted and runs to completion under an hour), so a partial run biases the
  order toward whatever sorted early; the spot-check gates therefore `require` only
  when the crawl reports complete and `observe` otherwise.

---

## 8. Casing, which is a different question

Everything above decides **which** name a taxon goes by. How it is *cased* on
screen was owned by nothing, so the corpus's own mixed capitalisation reached the
reader ("Aardvark" beside "aardvark").

**`web/src/vernacular.ts` is the rule.** It capitalises the first letter and
changes nothing else:

- **Full sentence case is unreachable.** Many interior capitals are proper nouns
  and no frequency threshold separates `African` from `Mountain`, so
  "Glassy-Winged Tiger" is left as it is and a lexicon is refused.
- **Up rather than down**, because the canvas is a mixture — "human" beside "Pan"
  is the same bug reversed.
- **It is display-only and the server is untouched.** Applied at `api.ts`'s
  boundary and at `recent.ts`'s `loadRecent`.
