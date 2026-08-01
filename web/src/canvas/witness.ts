/**
 * Which of a node's two pictures it may draw.
 *
 * The server sends both and refuses to choose, because the choice depends on
 * something only the client knows: how the reader arrived at the node. This is
 * where that gets decided, in one place, so the canvas and the detail card
 * cannot drift into disagreeing about what a node looks like.
 *
 * The rule is the induced subtree's own distinction, and it is short:
 *
 *   a leaf        — a species or clade the reader *chose*  -> its exemplar
 *   anything else — a divergence they arrived at           -> its witness, or nothing
 *
 * The second half is the part with a decision in it. `node_image` is a
 * *borrow*: the closest drawn relative, which is nearly always a living group.
 * Beside a chosen clade that is what a silhouette is best at — a mammal beside
 * Mammalia says something a photograph could not. Beside a fork it is wrong in
 * the specific way this whole mechanism exists to fix, because the fork
 * predates the group being drawn. The bear/dog split is dated 57 Ma and drew
 * Procyonidae; raccoons are not 57 million years old and nothing on screen
 * said otherwise.
 *
 * So a witness-less divergence draws nothing, and that is the point rather
 * than a shortfall. Only 66 nodes have a witness, so most forks now carry no
 * picture — an empty slot withholds where the raccoon misinformed. Caniformia
 * is the case to hold in mind: its oldest drawn *and* dated member is
 * Archaeocyon at 31.8 Ma, 25 Ma adrift of the split, and the stem carnivorans
 * that would fit (Vulpavus, 56–45.9 Ma) sit inside Carnivora but outside
 * Caniformia, so they are not eligible. There is no picture to draw. Saying so
 * is the honest answer.
 */

import { witnessFor, silhouetteIsInformative, type PathNode, type Witness } from "../api";

/** What the two rules below need to know about a node. Both come from layout. */
export interface Placement {
  node: PathNode;
  /** True for a species or clade the reader chose, per `Induced.leaves`. */
  isLeaf: boolean;
}

/** The witness for a placed node, or null — and always null on a leaf. */
export function witnessOn(p: Placement): Witness | null {
  return p.isLeaf ? null : witnessFor(p.node);
}

/** Whether a node may draw its group's exemplar. A divergence may not. */
export function mayDrawExemplar(p: Placement): boolean {
  return p.isLeaf && silhouetteIsInformative(p.node, p.node.silhouette_clade_tips);
}
