/**
 * What separates a species the tree has from a species it does not.
 *
 * # The relationship, stated once
 *
 * The app searches two catalogues and the reader should never have to know
 * that. **They are all species.**
 *
 * - The **synthesis tree** is 2,385,875 tips and 2.7M nodes of Open Tree
 *   topology, dated by Duke et al.'s chronogram. It is *not* a tree of living
 *   things: *Tyrannosaurus rex*, *Tyrannosaurus* and *Stegosaurus* are all
 *   nodes in it. What a node has is a **position in a lineage** — an ancestry,
 *   a subtree, and an MRCA with everything else on the canvas.
 * - The **Paleobiology Database** is 523,112 taxa, of which 365,038 are
 *   accepted names. It is not a catalogue of extinct things either: 93,686 of
 *   its rows are flagged extant. What a PBDB row has is an **observed
 *   stratigraphic extent** — the dates the rock gives it — and an
 *   `attach_idx`, the deepest node it is known to sit below.
 *
 * The two **overlap**. 32,386 accepted PBDB taxa are themselves nodes, and
 * phase 3 records that as `attach_walk = 0` — zero `parent_no` hops taken to
 * reach the tree. For those, the node is strictly the better object: phase 4
 * has already written the PBDB bracket onto it as an `occurrence` row, so the
 * node carries the dates *and* the ancestry. The server therefore refuses them
 * from the fossil corpus outright (`store.notInTree`), which is what lets the
 * remaining difference be stated in two words on a row:
 *
 * > **A fossil row is a species the tree has no lineage for.**
 *
 * Not "extinct" — the tree is full of extinct taxa. Not "in PBDB" — plenty of
 * those are nodes. It is the one fact that changes what happens when the reader
 * presses Enter: a node joins the tree, and this is pinned to the branch it
 * belongs below, at its own date.
 *
 * # Why this file exists
 *
 * Because the distinction used to be spelled out three times — a pinned palette
 * section, a second random command, a second key — and each spelling was a
 * slightly different claim. Everything downstream of the relationship now reads
 * it from here.
 */

import type { RandomKind } from "./api";

/**
 * How many species there are to search, as a reader is told it.
 *
 * **There are three numbers here and only one of them is a species count.**
 * The synthesis tree is 2,725,682 nodes; 2,385,875 of those are tips; and
 * 2,295,972 carry `rank='species'`. Copy has reached for the wrong one twice.
 *
 * It said **2.7 million species** in five places, which is the node total —
 * 339,807 of those are *groups*, Carnivora and Mammalia and the unnamed forks
 * between them, and calling a group a species is the one error this product
 * cannot afford to make in the sentence that invites somebody to search,
 * because telling a clade from a species is most of what the canvas is for.
 *
 * The first correction reached for the **tip** count instead, on the reasoning
 * that a tip is what a species is here. It is not, and the error survived a
 * review that was looking straight at it: the tips include subspecies,
 * varieties, cultivars and 1,615 group-rank terminals, while 21,977 species
 * are *internal* nodes because they have subspecies beneath them. Tips and
 * species disagree by about ninety thousand in each direction at once. So this
 * is the rank count, which is the only figure answering the question the word
 * "species" asks.
 *
 * **It is not the searchable set, and that is deliberate.** 2,599,664 nodes
 * carry a name, and neither `search.py`'s index nor `store/search.go` filters
 * on rank or on tip-ness — type `Carnivora` and you get the order, ranked
 * above the beetle named after it. "Search 2.3 million species" stays true
 * under that: there really are 2.3 million species to search. It simply does
 * not boast about the groups, which the about page's sources list names in
 * words rather than in a second number nobody asked for.
 *
 * The fossil corpus is left out on the same principle. 523,112 PBDB taxa are
 * searchable too, but the two catalogues overlap by name — 32,386 accepted
 * PBDB taxa are themselves nodes — so any sum double-counts. Where both matter
 * the copy names the second corpus in words, which is what the species key's
 * hint does.
 *
 * **The phrase is a phrase and not a number** so that no caller decides how to
 * say it. Seven render sites read it. `corpora.test.ts` takes the exact figure
 * out of `docs/data-sources.md`, checks this rounds from it, and — the part
 * that matters more — refuses *any* hardcoded "N million species" outside this
 * file, because guarding the one wrong string only stops the mistake that has
 * already been made.
 */
export const TREE_SPECIES = 2_295_972;

/** {@link TREE_SPECIES}, as it prints. */
export const SPECIES_PHRASE = "2.3 million species";

/**
 * How often the one random pick draws from the fossil corpus.
 *
 * There used to be two commands and two keys, and that split asked the reader a
 * question only the app can answer: *is the thing you want to be surprised by
 * one the synthesis tree happens to contain?* Nobody knows that about a taxon
 * they have not met, and for the famous ones the answer is counter-intuitive —
 * the tree holds *Tyrannosaurus rex* and has never heard of *Triceratops*.
 *
 * So one command draws from both, weighted rather than even. A fifth, because
 * the two picks do not cost the same: a species joins the tree on its own,
 * while a graft usually drags in the clade it hangs below (see `drawFossil`),
 * which is a larger change to a canvas the reader may have spent time on. One
 * in five is often enough to be a real part of the surface and rare enough that
 * pressing `R` twice is not usually two rearrangements.
 */
export const RANDOM_FOSSIL_CHANCE = 0.2;

/**
 * Which corpus a press of `R` draws from, given a roll in [0, 1).
 *
 * Split out from the callback so the weighting is testable: it is the one
 * number in the app whose value cannot be checked by looking at the screen.
 */
export function randomKind(roll: number): RandomKind {
  return roll < RANDOM_FOSSIL_CHANCE ? "fossil" : "species";
}

/**
 * Draw one identifier from a pool, never one the canvas already holds.
 *
 * Here rather than in the callback for the same reason {@link randomKind} is:
 * this is the app's other piece of logic whose correctness cannot be checked by
 * looking at the screen. A draw that quietly returned something already drawn
 * would show a toast saying "Added X" over an unchanged canvas, which is a
 * false statement about the one thing the reader was watching for — and it
 * would look exactly like a working command until somebody counted.
 *
 * **Excluding before choosing is the whole point of holding the pool.** The
 * server drew blind and could only over-ask a dozen candidates and hope; which
 * taxa are on this canvas is a fact no request ever carried. Filtering
 * thousands of numbers per press costs nothing measurable and removes a
 * constant somebody would otherwise have had to guess.
 *
 * `null` means the pool is exhausted, which is a different thing from empty and
 * both callers say so differently: an empty pool is a build with no silhouette
 * resolution, an exhausted one is a canvas holding all 13,918.
 *
 * `roll` is injected so the draw is testable. `Math.random` is the caller's.
 */
export function pickFrom(
  pool: readonly number[],
  taken: (n: number) => boolean,
  roll: number,
): number | null {
  const free = pool.filter((n) => !taken(n));
  if (free.length === 0) return null;
  // Clamped rather than trusted. `Math.random()` never returns 1, but this
  // takes a number, and an index one past the end would return `undefined`
  // through a signature that promises it cannot.
  const i = Math.min(free.length - 1, Math.max(0, Math.floor(roll * free.length)));
  return free[i] ?? null;
}

/**
 * The badge a fossil row wears, and the sentence behind it.
 *
 * It carries the whole of the difference now that the section heading is gone,
 * so it says what the reader will see happen rather than naming a category. A
 * badge reading "fossil" would be wrong about the one animal everybody tests it
 * with: *T. rex* is a node, would go unbadged, and is unambiguously a fossil.
 */
export const FOSSIL_BADGE = "on a branch";
export const FOSSIL_BADGE_HINT =
  "Known only from the fossil record — the tree has no lineage for it. " +
  "It is pinned to the branch it belongs below, at its own date, instead of " +
  "joining the tree as a species does.";

/**
 * Where a search row sits in the one ranking covering both corpora.
 *
 * `/v1/search` answers with two arrays because a node and a PBDB taxon are
 * different *shapes*, and stamps every row in both with `order` — its position
 * in the single list `store.Interleave` ranked them into. Reading that is the
 * client's whole part in the merge.
 *
 * **This is not re-ranking.** `handoff.md` §7's rule — `web/` must not re-sort
 * `/v1/search` — is what the client-side fuzzy score broke by outweighing four
 * server ranks it could not see. Taking an integer the server computed is the
 * opposite of that.
 *
 * `fallback` is the row's index in its own array, used against a server that
 * predates `order`. Each list is still internally ranked there; they just
 * cannot interleave, so the nodes lead as they did before.
 */
export function rowScore(order: number | null | undefined, fallback: number): number {
  return 4000 - (order ?? fallback) * 10;
}
