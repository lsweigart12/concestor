/**
 * What the species palette offers a reader who has not typed anything.
 *
 * The box used to answer that with one grey line — *Type to search 110,794
 * species* — which states the size of the corpus and nothing a person can act
 * on. A blank search field asks for the two things an exploring reader does not
 * have: the right word, and the confidence that the word will work. Naming the
 * corpus makes both worse, because 110,794 is the number of ways to be wrong.
 *
 * So the empty list is a list. Ten taxa, each one row, each one press from
 * being on the canvas.
 *
 * **These are single species and not openings, and the distinction is the
 * reason this file exists rather than importing `openings.ts`.** An opening
 * *replaces* the canvas — it clears the selection and plays several taxa in a
 * scripted order to make an argument. Every row in this palette *adds* to
 * whatever is already there. Putting an opening here would give the reader a
 * row that silently destroys the tree they have been building, which is why
 * `openings.ts` refuses the palette in as many words and why that refusal still
 * holds. The carousel on the empty canvas is where an opening belongs, and it
 * is already there, larger and with its question written out.
 *
 * That also settles what these rows are *for*. They are not a second front door
 * — the front door is the carousel. They are the answer to "I have a tree and I
 * want to put something else on it", and the species that best serve that are
 * the ones a reader can place in the tree of life without help.
 *
 * ## What earned a place
 *
 * **Breadth first, recognisability second**, and the order of those two is the
 * whole design. A list of ten mammals would be more instantly nameable and
 * would teach the reader that this is a mammal app; the corpus is all of life,
 * and the list is the only place that fact is ever *shown* rather than
 * asserted. So the ten cover nine branches a person can name unaided — primate,
 * carnivoran, whale, fish, reptile, bird, mollusc, insect, plant, fungus — and
 * mammals carry three of the ten only because the reader is one, and the blue
 * whale and the human are each doing work no other row does.
 *
 * The three constraints below are `openings.ts`'s, unchanged, because they are
 * facts about this corpus rather than about that feature. Each cost hours to
 * find there and nothing to apply here:
 *
 * 1. **`node_image.climb` must be 0.** Phase 5 resolves an image for all 2.7M
 *    nodes by climbing to a relative, so "has an image" is true of everything
 *    and means nothing. Zero means the drawing is of this taxon or of something
 *    inside it, never borrowed from a group larger than it. `hitSilhouette`
 *    ships with its suppression dialled to infinity, so a borrowed picture
 *    renders perfectly happily and the failure is silent — the reader is handed
 *    a shape that belongs to something else and has no way to know.
 *
 * 2. **A rank-1 English common name.** The row prints the scientific name and
 *    subtitles it with the vernacular, so a taxon without one is a row that
 *    says only *Blaberus giganteus* to an audience of curious people. That
 *    rejected the cockroach `openings.ts` uses. It also rejected two taxa whose
 *    headline name is real and wrong for a stranger: *Agaricus bisporus* is
 *    filed under **cremini** and *Formica rufa* under **horse ant**.
 *
 * 3. **A species, not a clade.** A clade-rank taxon is drawn at its crown age
 *    rather than at the present, so its mark lands mid-plot and reads as a
 *    living group that stopped. This is what keeps *Felis* out — it is `climb`
 *    0 and headlined **cat**, which is the one obvious companion to the dog and
 *    the single most-wanted word this corpus handles badly (*Felis catus*
 *    carries no QID, so the article **Cat** reaches no evidence). A genus drawn
 *    at 8 Ma is not the fix for that; phase 6 coverage is.
 *
 * ## What is deliberately not here
 *
 * **A fungus was nearly dropped and is the row worth defending.** *Amanita
 * muscaria* is the only fungus in the corpus that clears all three constraints
 * with a name a stranger reads without effort, and a list that lost it would
 * have been ten organisms across eight branches with the two non-animal
 * kingdoms represented by an oak alone. The one press that most changes what a
 * reader thinks this app is about is the one that puts a mushroom on the same
 * tree as a dog.
 *
 * **The lion was cut, and it was the closest call.** It is `climb` 0, a
 * species, headlined **Lion**, and about as recognisable as a taxon gets. It
 * went because the dog already holds the familiar-carnivoran slot and every
 * other row is the only thing of its kind here — spending two of ten on one
 * branch is the mammal-app failure above, arriving through the back door. It is
 * one carousel opening away, where it does more work.
 *
 * ## Where the rest of the row comes from
 *
 * **Keys only, and nothing else may be added to this file.** A row needs a
 * name, a rank, a tip count and a resolved silhouette, and every one of those
 * is a fact about the *dataset* rather than about this list. Baking them here
 * would ship one build's answers to readers on another, and the failure is the
 * quiet kind this codebase keeps meeting: a stale `idx` resolves cleanly and
 * describes a different animal. `/v1/hits` dresses these at read time against
 * whatever build is deployed — see `server/internal/store/hits.go`, which
 * carries the other half of the split.
 *
 * An OTT id is the one identifier that survives a rebuild, and even it is not
 * quite stable: forwarding is silent, 297,070 entries deep. `Resolve` chases
 * forwards transitively and `HitsForKeys` skips what it cannot find, so a
 * retired id costs this list one row rather than all ten.
 *
 * `starters.test.ts` pins the shape and the count; the gate that matters is in
 * Go — `TestStartersAreDrawableAndNamed` reads *this file* and checks every key
 * against the built database, because "make sure every suggestion actually has
 * good results" cannot be checked anywhere the dataset is not.
 */

/**
 * The taxa offered on an empty species palette, in the order they are shown.
 *
 * Ordered by pull on a reader who has to recognise the row at a glance, with
 * the human first for the reason `openings.ts` puts the fish question first:
 * a row about *you* needs no other hook. The oak and the fly agaric hold the
 * bottom two places because they are the two a reader is least likely to be
 * looking for and most likely to be surprised by, and the bottom of a short
 * list is where a surprise is free.
 *
 * The comment on each row is the branch it is here to represent. If one is ever
 * replaced, replace it with something from the same branch or the list stops
 * covering what its own doc comment claims.
 */
export const STARTERS: readonly string[] = [
  "ott770315", // Homo sapiens — you
  "ott247341", // Canis lupus — the familiar carnivoran, dog included
  "ott226190", // Balaenoptera musculus — the largest animal that has ever lived
  "ott554297", // Carcharodon carcharias — a fish, and the one in "are you a fish?"
  "ott1091028", // Varanus komodoensis — a reptile
  "ott494370", // Aptenodytes forsteri — a bird
  "ott110468", // Octopus vulgaris — a mollusc, and the far end of most people's intuition
  "ott190091", // Danaus plexippus — an insect
  "ott239659", // Quercus robur — a plant
  "ott75257", // Amanita muscaria — a fungus
];

/**
 * How many of the reader's own recent picks sit above the starters.
 *
 * Six, which is one more than fits above the fold on the shortest palette and
 * deliberately so: the list is *history*, and a history that ends exactly where
 * the panel does reads as the whole of it. Raycast, Notion and Slack all lead
 * their empty state with recents for the same reason — on every visit after the
 * first it is the highest-hit-rate content there is, and it costs no request.
 */
export const RECENT_LIMIT = 6;
