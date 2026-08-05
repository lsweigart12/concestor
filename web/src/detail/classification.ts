/**
 * A node's classification, read off its own ancestry.
 *
 * There is no taxonomy table to consult and there does not need to be: the
 * ancestor path *is* the classification, and the server already sends it with a
 * rank on every entry. What this module does is choose which of those ancestors
 * a card should show, which is a real question — the path to *Homo sapiens* is
 * 45 nodes, 20 of them named.
 *
 * Two answers, because readers ask two different questions. **The ladder** is
 * "what family is it in" — the major Linnaean ranks and nothing else, short
 * enough to read at a glance. **The lineage** is "what is it, all the way down"
 * — every named ancestor, which is where *Primates*, *Tetrapoda* and *Bilateria*
 * live, and which is the more interesting list for this audience even though it
 * is not what they asked for.
 *
 * ## The gaps are real and are not to be filled
 *
 * A ladder is frequently incomplete, and *Homo sapiens* is the case that proves
 * it: the Open Tree synthesis puts no ranked **order** and no ranked **family**
 * on the human lineage at all. *Primates* is filed `no rank`, and *Hominidae* is
 * not a node — it did not survive synthesis. Every other source a reader has
 * seen says humans are primates and hominids, so a card that silently prints
 * five rungs and stops looks broken.
 *
 * So the missing rungs are **named** rather than papered over. Reaching for a
 * second taxonomy to fill them in would put a claim on the card that the tree
 * behind it does not make, and the tree is the thing this product is about.
 */

import type { PathNode } from "../api";

/**
 * The rungs, broad to narrow.
 *
 * `species` is deliberately absent: the node's own rank is already printed
 * under its name, and a ladder that ends by repeating the heading wastes the
 * one row a reader is most likely to read.
 *
 * `domain` is included and `kingdom` kept beside it even though the two say
 * overlapping things in the Open Tree taxonomy, because both appear and
 * dropping either loses a rung on some lineage.
 */
export const LADDER_RANKS = [
  "domain",
  "kingdom",
  "phylum",
  "class",
  "order",
  "family",
  "genus",
] as const;

export type LadderRank = (typeof LADDER_RANKS)[number];

const LADDER = new Set<string>(LADDER_RANKS);

/**
 * Ranks that carry no information a reader wants in a lineage.
 *
 * `no rank` and `no rank - terminal` are what the Open Tree taxonomy files a
 * clade under when it has a name and no Linnaean rung — *Bilateria*,
 * *Eutheria*, *Primates*. The clade belongs in the lineage; the words do not,
 * and printing "NO RANK" beside *Primates* says something false-sounding about
 * one of the most familiar names on the list.
 */
const UNRANKED = new Set(["no rank", "no rank - terminal", "unranked", ""]);

/** True when this rank is worth printing beside a name. */
export function rankIsInformative(rank: string | null | undefined): boolean {
  return (
    rank !== null && rank !== undefined && !UNRANKED.has(rank.toLowerCase())
  );
}

export interface Lineage {
  /**
   * Every named ancestor, root-first, excluding the node itself.
   *
   * The unnamed `mrcaott…` nodes are dropped. They are perfectly real — they
   * are most of the path — but a classification is a list of names and they
   * have none, so a row for one would be a row saying nothing.
   */
  full: PathNode[];
  /** The major ranks that *are* on this lineage, root-first. A subset of `full`. */
  ladder: PathNode[];
  /**
   * The major ranks that are not, in ladder order.
   *
   * Empty for most lineages and `["order", "family"]` for our own. It exists so
   * the card can say which rungs the tree does not have, rather than leaving a
   * reader to infer that humans have been declassified.
   */
  missing: LadderRank[];
}

const EMPTY: Lineage = { full: [], ladder: [], missing: [] };

/**
 * Split an ancestry path into the two lists a card shows.
 *
 * `path` is a `/v1/path` response, root-first, with the node itself last — the
 * shape the API already sends. The node itself is excluded from both lists: it
 * is the subject of the card, not part of its own classification.
 *
 * `subjectIsLast: false` keeps it, and exists for the one caller whose subject
 * is not on the path at all. A fossil is not a node, so what a fossil card can
 * classify is the node it *hangs below* — and that node is then part of the
 * answer rather than the thing being answered about.
 *
 * A rank appearing twice on one lineage keeps its **narrowest** node, which is
 * the one a reader means. It happens: the Open Tree taxonomy has nested
 * `subphylum` entries (*Craniata* inside *Chordata*, then *Vertebrata* inside
 * *Craniata*), and while no major rung repeats today, nothing in the data
 * promises that, and picking the broader one would answer "what family" with a
 * superfamily's contents.
 */
export function lineageOf(
  path: readonly PathNode[],
  { subjectIsLast = true }: { subjectIsLast?: boolean } = {},
): Lineage {
  if (path.length === 0 || (subjectIsLast && path.length <= 1)) return EMPTY;
  const ancestors = subjectIsLast ? path.slice(0, -1) : path;
  const full = ancestors.filter((n) => n.name !== null && n.name !== "");

  const byRank = new Map<string, PathNode>();
  for (const n of full) {
    const r = n.rank?.toLowerCase();
    if (r && LADDER.has(r)) byRank.set(r, n);
  }
  const ladder: PathNode[] = [];
  const missing: LadderRank[] = [];
  for (const r of LADDER_RANKS) {
    const n = byRank.get(r);
    if (n) ladder.push(n);
    else missing.push(r);
  }
  // A rung above the highest one present is not missing, it is off the top of
  // this lineage — a fungus has no `domain` node above it in this tree and
  // saying so would be noise. Only gaps *inside* the ladder are reported.
  const firstIdx =
    ladder.length > 0 ? LADDER_RANKS.indexOf(rankOf(ladder[0]!)) : -1;
  const lastIdx =
    ladder.length > 0
      ? LADDER_RANKS.indexOf(rankOf(ladder[ladder.length - 1]!))
      : -1;
  const inner = missing.filter((r) => {
    const i = LADDER_RANKS.indexOf(r);
    return i > firstIdx && i < lastIdx;
  });
  return { full, ladder, missing: inner };
}

function rankOf(n: PathNode): LadderRank {
  return (n.rank ?? "").toLowerCase() as LadderRank;
}

/**
 * "order or family", "phylum, class or order" — for the missing-rungs note.
 *
 * A list, not a count: "two ranks are missing" makes a reader go looking for
 * which, and the answer is two words long.
 *
 * The conjunction defaults to "or" because the only sentence this appears in is
 * a negative one, and "no ranked order and family" reads as a complaint about a
 * pair rather than about each of them.
 */
export function rankProse(
  ranks: readonly string[],
  conjunction = "or",
): string {
  if (ranks.length === 0) return "";
  if (ranks.length === 1) return ranks[0]!;
  return `${ranks.slice(0, -1).join(", ")} ${conjunction} ${ranks[ranks.length - 1]}`;
}
