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
