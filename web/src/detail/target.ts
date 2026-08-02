/**
 * What a link on a card selects.
 *
 * Every clickable name on a card names one of three things, and they are not
 * interchangeable:
 *
 *   - **A node with a key.** A classification rung, a fossil's attachment
 *     point. The key is on the `PathNode` already and is used verbatim.
 *   - **A node known only by index.** The silhouette's subject, the clade it
 *     speaks for, a witness's attachment point. These arrive as bare `idx`
 *     values because they are references *into the arrays*, and nothing sends
 *     their keys.
 *   - **A fossil.** A witness. Not a node at all — it opens the other card.
 *
 * The awkward one is the second, and the awkwardness is worth one function.
 * `idx:N` is a key the API accepts and the URL round-trips, so it always works;
 * it is also opaque in a shared link, where `ott244265` at least says which
 * taxonomy it came from. So a node already in memory contributes its real key
 * and only a node we have never seen falls back to its index. The two produce
 * the same card either way — this is about what the link a reader copies says.
 */

import type { PathNode } from "../api";

/**
 * A link target: a key the store already understands, or a node index.
 *
 * Numbers are node indices and only node indices. A fossil is passed as its
 * `pbdb…` key precisely so that the two can never be confused — `graftIdx`
 * negates PBDB numbers for the same reason, and a positive number reaching here
 * as a fossil id would address a real and unrelated node.
 */
export type LinkTarget = string | number;

export function selectionKeyFor(
  target: LinkTarget,
  nodes: ReadonlyMap<number, PathNode>,
): string {
  if (typeof target === "string") return target;
  return nodes.get(target)?.key ?? `idx:${target}`;
}

/** The `sel=` form for a fossil, which is a fossil card and never a node one. */
export function fossilTarget(pbdbTaxonNo: number): string {
  return `pbdb${pbdbTaxonNo}`;
}

/**
 * The node index a `idx:N` key addresses, or null for any other key.
 *
 * Selection resolution needs this so a link into a node that *is* on the canvas
 * still lights its mark. Without it the card would open correctly and the
 * canvas would show nothing selected, which reads as the click having half
 * worked.
 */
export function idxFromKey(key: string): number | null {
  // A regex rather than `Number(key.slice(4))`, which was wrong in a way worth
  // recording: `Number("")` is **0**, so the malformed key `idx:` resolved to
  // node 0 — the root of the tree — and lit it as the selection. Every
  // near-miss here is a confident answer about an unrelated taxon, so the
  // shape is matched exactly instead of coerced.
  const m = /^idx:(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}
