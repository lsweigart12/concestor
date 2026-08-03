/**
 * What to call a divergence the taxonomy has no name for.
 *
 * Most internal nodes of the Open Tree synthesis are unnamed. Their keys look
 * like `mrcaott83926ott84217`, they carry no `name` and no `rank`, and until now
 * every one of them rendered as the literal string "unnamed divergence" — so a
 * four-species hominin view showed two identical grey labels where its two most
 * interesting events are. That is not a data gap we can fill: the synthesis
 * genuinely has no label for that node, because the taxon a reader would name it
 * after (Hominini) has a different membership in the taxonomy than the node has
 * in the tree, and asserting the name would be asserting the identity.
 *
 * What we *can* say without asserting anything is what the node separates. It is
 * the last common ancestor of its branches by construction, so naming it after
 * the nearest named clade down each branch is true for the same reason the node
 * exists. `mrcaott83926ott84217` becomes **Homo / Pan**, which is what a reader
 * wanted from "Hominini" anyway.
 *
 * The named clades are usually already in memory and already thrown away:
 * `Homo` and `Pan` are both degree-2 nodes on the suppressed runs either side of
 * that divergence. This module reads them back out.
 *
 * Nothing here invents a rank, an age or an identity. A derived name is marked
 * as derived everywhere it appears — `DIVERGENCE` on the canvas, an explicit
 * note on the detail card — because a reader who sees "Homo / Pan" in the same
 * position where every other node shows a taxon name is owed the difference.
 */

import type { PathNode } from "../api";
import type { Induced } from "./induced";

/**
 * One run of a derived name.
 *
 * Punctuation is a part like any other so the renderer can map straight over
 * the list, and each taxon run carries the rank it came from rather than a
 * boolean, because italicisation is the caller's rule (`isScientificItalic`)
 * and importing it here would point `tree/` back at `canvas/`.
 */
export interface NamePart {
  text: string;
  /** Rank of the taxon this run names; null for punctuation. */
  rank: string | null;
}

export interface Divergence {
  /** Runs to render, punctuation included. */
  parts: NamePart[];
  /** The same string, for measurement, tooltips and plain-text contexts. */
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
 * What the canvas puts on a label: nothing, the scientific name, or the name
 * people use.
 *
 * `off` is a real state and not an absence of one. A tree read for its *shape*
 * — where the forks are, how far apart, what the pictures look like — is a
 * different reading from a tree read for its names, and the words are what make
 * the first one hard to see. It is also what the old semantic-zoom tiering was
 * reaching for and never delivered: that made the choice on the reader's behalf
 * from how far they had zoomed, so pulling back to see the whole tree took the
 * names with it and reading one name meant zooming into it.
 */
export type LabelMode = "off" | "scientific" | "common";

/**
 * The ranks a common name may be drawn for, matching the server's own filter.
 *
 * A duplicate of `api.vernacularRanks`, and the duplication is not the usual
 * mistake: the server refuses to *send* a name outside these ranks and this
 * refuses to *draw* one, so a build whose payload predates the restriction
 * cannot leak "animals" onto Metazoa. Neither is load-bearing alone; both being
 * the same three words is what the tests check.
 */
const COMMON_RANKS = new Set(["genus", "species", "subspecies"]);

/**
 * A name and the rank to italicise it by — null where the string is not a
 * scientific name and so must be set roman.
 *
 * `rank: null` is the same signal {@link NamePart} carries for punctuation,
 * which is what lets a derived name mix the two: `Human / Pan` sets one run
 * roman and the other italic, from one rule, in both the canvas's renderer and
 * the card's.
 */
export interface MarkName {
  text: string;
  rank: string | null;
}

/**
 * The one string a mark may show, and the one place that decides it.
 *
 * Two callers, and they have to agree exactly: `describeLabel` measures the
 * label to reserve space for it, and `NodeMark` draws it. A name measured at
 * one width and drawn at another collides exactly as badly as no placement pass
 * at all — `labels.ts` says so about fonts, and a switch that changes every
 * string on the canvas is the same failure with a bigger lever.
 *
 * The common name is used where three things hold, and the fallback is the
 * scientific name in every other case:
 *
 *   - the node is a genus, species or subspecies. Above that a common name
 *     names a group rather than a kind of thing, and the group's word usually
 *     belongs to something else — `bug`, `man`, `moth`;
 *   - the ranking put a name first. Where nothing was ranked there is no claim
 *     that any of the strings is *the* name, and a canvas that swapped the
 *     scientific name for an unranked one would be trading a name that is never
 *     wrong for one that might be;
 *   - it is not the scientific name over again, which PBDB's ColDP rows
 *     routinely are.
 *
 * Falling back is silent on purpose. A tree drawn in common names is going to
 * be mixed — 110,794 nodes carry an English name against 2.7M — so a marker on
 * every fallback would decorate most of the canvas to say what the italics
 * already say.
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
 * The first named node walking from a divergence down one of its branches.
 *
 * Order matters and it is not the obvious one: the suppressed run comes first,
 * root-ward end first, *then* the rendered child. Those suppressed degree-2
 * nodes are where the useful names live — `Homo` and `Pan` are both suppressed
 * in the four-species hominin view — and taking the child first would answer
 * "Homo sapiens / Pan troglodytes" for a node that separates the whole genera.
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
 *
 * Standard scientific style, and here it is also the difference between a label
 * that fits beside its node and one that wraps to three rows: the divergences
 * worth looking at are usually the ones inside a single genus, which is exactly
 * when both halves of the name repeat the same word.
 *
 * It is a convention of *scientific* names and applies to nothing else, so a
 * common name neither gets abbreviated nor contributes a genus to abbreviate
 * against — "Human" beside "Homo erectus" would otherwise abbreviate neither
 * and "Bottlenose dolphin" would become "B. dolphin".
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
