/**
 * What to call a divergence the taxonomy has no name for. Most internal Open
 * Tree nodes are unnamed (`mrcaott83926ott84217`), and naming one after the
 * taxon a reader expects (Hominini) would assert an identity the tree does not
 * have. What can be said without asserting anything is what the node separates:
 * the nearest named clade down each branch, so it becomes **Homo / Pan**. A
 * derived name is marked as derived everywhere (`DIVERGENCE` on the canvas, a
 * note on the card).
 */

import type { PathNode } from "../api";
import type { Induced } from "./induced";

/**
 * One run of a derived name. Punctuation is a part like any other; each taxon
 * run carries its rank rather than a boolean, so the caller's italicisation rule
 * need not be imported here (which would point `tree/` back at `canvas/`).
 */
interface NamePart {
  text: string;
  /** Rank of the taxon this run names; null for punctuation. */
  rank: string | null;
}

export interface Divergence {
  /** Runs to render, punctuation included. */
  parts: NamePart[];
  /** The same string, for measurement and plain-text contexts. */
  text: string;
  /** The clades separated, unabbreviated and in full. Reads as prose. */
  branches: string[];
}

/** Shown before the count takes over. Two is the overwhelmingly common case. */
const MAX_BRANCHES = 3;

const SEP = " / ";

/** The label for a divergence we could not derive anything for. */
export const UNNAMED = "unnamed divergence";

/**
 * What the canvas puts on a label: nothing, the scientific name, or the common
 * name. `off` is a real state — a tree read for its shape is a different reading
 * from one read for its names, and the words make the first hard to see.
 */
export type LabelMode = "off" | "scientific" | "common";

/**
 * The ranks a common name may be drawn for, matching the server's own filter
 * (deliberately duplicated, so a payload predating the restriction cannot leak
 * "animals" onto Metazoa).
 */
const COMMON_RANKS = new Set(["genus", "species", "subspecies"]);

/**
 * A name and the rank to italicise it by — null where the string is roman. Same
 * signal {@link NamePart} carries for punctuation, so a derived name can mix the
 * two from one rule.
 */
interface MarkName {
  text: string;
  rank: string | null;
}

/**
 * The one string a mark may show, decided in one place so `describeLabel` (which
 * measures it) and `NodeMark` (which draws it) cannot disagree. The common name
 * is used where all three hold, else the scientific name silently: the node is a
 * genus/species/subspecies, the ranking put a name first, and it is not the
 * scientific name repeated (as PBDB's ColDP rows routinely are).
 */
export function markName(
  node: Pick<PathNode, "name" | "rank" | "vernacular"> | null | undefined,
  mode: LabelMode,
): MarkName | null {
  if (!node) return null;
  const common = commonName(node);
  if (mode === "common" && common) return { text: common, rank: null };
  return node.name ? { text: node.name, rank: node.rank } : null;
}

/** The name this node goes by, or null. The rank rule and the identity check. */
export function commonName(
  node: Pick<PathNode, "name" | "rank" | "vernacular">,
): string | null {
  const v = node.vernacular?.trim();
  if (!v || !node.rank || !COMMON_RANKS.has(node.rank)) return null;
  // Not a fallback so much as a refusal to say the same thing twice: PBDB's
  // ColDP carries the binomial itself as a vernacular for thousands of taxa, so
  // "common names" would print *Tyrannosaurus rex* in roman type and claim it
  // is what people call it.
  return v.toLowerCase() === node.name?.toLowerCase() ? null : v;
}

/**
 * The nearest named clade on each branch below `idx`, or null.
 *
 * Returns null for a node that has a name of its own — there is nothing to
 * derive — and for one where no branch reaches a name, which cannot happen for
 * a selection-driven view (selections come from the search index and are named)
 * but is not worth crashing over if it ever does.
 */
export function divergenceFor(
  idx: number,
  ind: Induced,
  nodes: ReadonlyMap<number, PathNode>,
  mode: LabelMode = "scientific",
): Divergence | null {
  if (nodes.get(idx)?.name) return null;

  const kids = childrenOf(ind);
  const branches: PathNode[] = [];
  for (const child of kids.get(idx) ?? []) {
    const found = firstNamed(child, ind, nodes, kids);
    if (found) branches.push(found);
  }
  // One branch names a lineage, not a split. Two is the minimum that describes
  // a divergence, and saying "Homo" alone over a node that is not Homo would be
  // the exact false identity this module exists to avoid.
  if (branches.length < 2) return null;

  // Each branch is named by the same rule a mark is, so a canvas set to common
  // names says "Human / Pan" rather than keeping every derived name in Latin —
  // and *Pan* stays Latin because a genus with no ranked English name has none
  // to offer, not because divergences are exempt.
  const named = branches.map(
    (n) => markName(n, mode) ?? { text: n.name ?? "", rank: n.rank },
  );
  const shown = named.slice(0, MAX_BRANCHES);
  const labels = abbreviateRepeatedGenus(shown);

  const parts: NamePart[] = [];
  labels.forEach((text, i) => {
    if (i > 0) parts.push({ text: SEP, rank: null });
    parts.push({ text, rank: shown[i]!.rank });
  });
  const rest = branches.length - shown.length;
  if (rest > 0) parts.push({ text: ` +${rest}`, rank: null });

  return {
    parts,
    text: parts.map((p) => p.text).join(""),
    branches: named.map((n) => n.text),
  };
}

/**
 * The chosen species that sit *inside* this one, if any.
 *
 * Usually empty: selections are normally tips and nothing hangs below them.
 * OTT makes the exception ordinary, though — *Homo sapiens neanderthalensis* is
 * filed as a child of *Homo sapiens*, so choosing both makes the human node the
 * divergence between them. Readers do not expect that (most people think of
 * Neanderthals as a separate species) and the canvas cannot explain it, so the
 * detail card does.
 */
export function nestedSelections(
  idx: number,
  ind: Induced,
  nodes: ReadonlyMap<number, PathNode>,
): string[] {
  if (!ind.leaves.includes(idx)) return [];
  const out: string[] = [];
  for (const [v, seg] of ind.segments) {
    if (seg.anc !== idx) continue;
    const named = nodes.get(v)?.name ?? divergenceFor(v, ind, nodes)?.text;
    if (named) out.push(named);
  }
  return out;
}

/** "the last common ancestor of Homo and Pan" — the card's prose form. */
export function branchProse(branches: readonly string[]): string {
  if (branches.length <= 1) return branches[0] ?? "";
  return `${branches.slice(0, -1).join(", ")} and ${branches[branches.length - 1]}`;
}

/** Rendered children, keyed by their nearest rendered ancestor. */
function childrenOf(ind: Induced): Map<number, number[]> {
  const kids = new Map<number, number[]>();
  // `rendered` is ascending by idx, which is preorder — so children come out in
  // the same top-to-bottom order the layout puts them in, and the derived name
  // reads in the order the branches are drawn.
  for (const v of ind.rendered) {
    const anc = ind.segments.get(v)?.anc;
    if (anc === null || anc === undefined) continue;
    const list = kids.get(anc);
    if (list) list.push(v);
    else kids.set(anc, [v]);
  }
  return kids;
}

/**
 * The first named node walking from a divergence down one branch. The suppressed
 * run comes before the rendered child, root-ward end first: those degree-2 nodes
 * hold the useful names (`Homo`, `Pan`), and taking the child first would name a
 * genus-level fork after two species.
 */
function firstNamed(
  child: number,
  ind: Induced,
  nodes: ReadonlyMap<number, PathNode>,
  kids: ReadonlyMap<number, number[]>,
): PathNode | null {
  for (const s of ind.segments.get(child)?.suppressed ?? []) {
    const n = nodes.get(s);
    if (n?.name) return n;
  }
  const own = nodes.get(child);
  if (own?.name) return own;
  // An unnamed rendered divergence below an unnamed rendered divergence. Keep
  // descending; the first name found anywhere below is still a true statement
  // about what this branch contains.
  for (const gc of kids.get(child) ?? []) {
    const found = firstNamed(gc, ind, nodes, kids);
    if (found) return found;
  }
  return null;
}

/**
 * `["Homo sapiens", "Homo erectus"]` → `["Homo sapiens", "H. erectus"]`.
 * Scientific-name style only (a `rank: null` common name is skipped), or
 * "Bottlenose dolphin" would become "B. dolphin".
 */
function abbreviateRepeatedGenus(names: readonly MarkName[]): string[] {
  const seen = new Set<string>();
  return names.map(({ text, rank }) => {
    if (rank === null) return text;
    const words = text.split(" ");
    const genus = words[0] ?? "";
    const out =
      words.length > 1 && seen.has(genus)
        ? `${genus.slice(0, 1)}. ${words.slice(1).join(" ")}`
        : text;
    seen.add(genus);
    return out;
  });
}
