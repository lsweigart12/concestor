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
 * So a witness-less divergence draws nothing, and that is the point rather
 * than a shortfall. 548 nodes have a witness — the rule shipped capped at a
 * 25% gap and gave 66, which left the canvas too bare to be worth looking at,
 * so the cap came off and undated forks fell back to their drawn position.
 * Forks below that still draw nothing, and Caniformia is the case to hold in
 * mind for why the coverage is what it is: its oldest drawn *and* dated member
 * is Archaeocyon at 31.8 Ma, 25 Ma adrift, and the stem carnivorans that would
 * fit (Vulpavus, 56–45.9 Ma) sit inside Carnivora but outside Caniformia, so
 * they are not eligible. Uncapped it draws Archaeocyon anyway, with both
 * ranges on screen so the reader can see the stretch.
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

/**
 * Whether a node may draw its group's exemplar. A divergence may not *borrow*
 * one — but a picture of itself was never a borrow.
 *
 * The thing wrong with an exemplar at a fork is that it is somebody else's
 * portrait: `node_image` resolves to the closest drawn *relative*, and a
 * relative is nearly always a living group younger than the fork. When the
 * drawing is of the node itself that objection disappears — Cetacea drawn at
 * Cetacea is exactly what a silhouette is for. Without this, a fork that has
 * its own image and no witness draws nothing, which is the rule failing rather
 * than withholding: Cetacea, Felidae and Homo all went blank.
 */
export function mayDrawExemplar(p: Placement): boolean {
  if (!silhouetteIsInformative(p.node, p.node.silhouette_clade_tips)) return false;
  return p.isLeaf || p.node.silhouette_source_idx === p.node.idx;
}
