/**
 * The induced subtree, computed client-side from ancestor paths.
 *
 * This is architecture §2's load-bearing claim in about eighty lines: given
 * `path(node) → [root, …, node]` for each selection, the minimal connecting
 * subtree is the union of those paths with degree-2 nodes suppressed. The MRCA
 * falls out as the last common element, so there is no MRCA endpoint and no
 * MRCA code path — interaction 1 is just `|selection| = 2`.
 *
 * It is a deliberate port of `pipeline/src/concestor_build/render.py`'s
 * `induced_subtree`, and `induced.test`-style agreement with that reference is
 * what the `2|L| − 1` assertion below is guarding.
 */

export interface Segment {
  /** Nearest rendered ancestor. `null` at the induced root (the MRCA). */
  anc: number | null;
  /**
   * The degree-2 nodes dropped between `anc` and this node, root-ward first.
   * These are interaction 3's content — already computed, already ordered.
   * They are also what the draw-on animation staggers over.
   */
  suppressed: number[];
}

export interface Induced {
  /** The subject of the signature interaction. */
  mrca: number;
  /** Rendered nodes, ascending by idx — which is canonical vertical order. */
  rendered: number[];
  segments: Map<number, Segment>;
  /** Each selection's path, trimmed to start at the MRCA. */
  paths: Map<number, number[]>;
  /** Selections that are rendered leaves, ascending by idx. */
  leaves: number[];
}

const EMPTY: Induced = {
  mrca: -1,
  rendered: [],
  segments: new Map(),
  paths: new Map(),
  leaves: [],
};

/**
 * @param selection  chosen node indices, in any order
 * @param pathOf     root-first ancestor chain for a selection; must be resident
 */
export function induced(
  selection: readonly number[],
  pathOf: (idx: number) => readonly number[] | undefined,
): Induced {
  const chosen = [...new Set(selection)].sort((a, b) => a - b);
  if (chosen.length === 0) return EMPTY;

  const full = new Map<number, readonly number[]>();
  for (const leaf of chosen) {
    const p = pathOf(leaf);
    if (p && p.length) full.set(leaf, p);
  }
  if (full.size === 0) return EMPTY;

  const all = [...full.values()];
  const first = all[0]!;

  // The MRCA is the deepest position at which every path still agrees. With a
  // single selection this degenerates to the selection itself, which is
  // correct: one species induces a subtree of one node.
  let depth = Math.min(...all.map((p) => p.length));
  while (depth > 0) {
    const cand = first[depth - 1];
    if (all.every((p) => p.length >= depth && p[depth - 1] === cand)) break;
    depth -= 1;
  }
  const mrca = first[depth - 1]!;

  // Everything above the MRCA is outside the induced subtree. Keeping it would
  // hang a chain of unary ancestors off the root and break the 2|L|−1 bound.
  const paths = new Map<number, number[]>();
  for (const [leaf, p] of full) paths.set(leaf, p.slice(depth - 1));

  const marked = new Set<number>();
  const childrenInMarked = new Map<number, Set<number>>();
  for (const p of paths.values()) {
    for (let i = 0; i < p.length; i++) {
      const v = p[i]!;
      marked.add(v);
      if (i > 0) {
        const parent = p[i - 1]!;
        let kids = childrenInMarked.get(parent);
        if (!kids) childrenInMarked.set(parent, (kids = new Set()));
        kids.add(v);
      }
    }
  }

  const chosenSet = new Set(paths.keys());
  const rendered = new Set<number>([mrca]);
  for (const v of marked) {
    if (chosenSet.has(v) || (childrenInMarked.get(v)?.size ?? 0) >= 2) {
      rendered.add(v);
    }
  }

  // Nearest rendered ancestor per rendered node, plus the suppressed run
  // between them. One pass down each path is enough because a path visits
  // rendered and suppressed nodes in order.
  const segments = new Map<number, Segment>();
  segments.set(mrca, { anc: null, suppressed: [] });
  for (const p of paths.values()) {
    let lastRendered: number | null = null;
    let run: number[] = [];
    for (const v of p) {
      if (rendered.has(v)) {
        if (!segments.has(v)) segments.set(v, { anc: lastRendered, suppressed: run });
        lastRendered = v;
        run = [];
      } else {
        run.push(v);
      }
    }
  }

  const renderedSorted = [...rendered].sort((a, b) => a - b);
  return {
    mrca,
    rendered: renderedSorted,
    segments,
    paths,
    leaves: [...chosenSet].sort((a, b) => a - b),
  };
}

/**
 * Which rendered nodes are new relative to a previous induced subtree, and in
 * what order they should be drawn on.
 *
 * The signature interaction draws *from the MRCA outward*, not from the root
 * of life and not inward from the leaf, because the point of the animation is
 * to show where the new species joins. That makes "which MRCA" and "which
 * segments are new" the two facts the animation needs, and both are cheap set
 * differences over data already in memory.
 *
 * The draw is **breadth-first**, in waves. A depth-first chain to one leaf was
 * indistinguishable from it while a single species was being added — the new
 * nodes form a single chain then — but on a restored selection every node is
 * new, and tracing one leaf's ancestry made the tree appear to grow down one
 * arbitrary route while every other branch simply materialised beside it.
 * Siblings share a wave, so the whole subtree grows outward from the MRCA at
 * once, which is what the topology actually claims: those lineages parted at
 * the same node, at the same moment.
 */
export interface AddDelta {
  /** The node that flares at t=80. The subject. */
  flare: number;
  /**
   * New rendered nodes in waves, root-ward first. Everything in one wave draws
   * simultaneously; the stagger is between waves. A node stands for the
   * segment *above* it, so the subtree root is not here: it is where the first
   * wave leaves from, not something that is drawn.
   */
  drawOrder: number[][];
  /** Rendered nodes that existed before and are simply moving. */
  reflowing: number[];
}

export function addDelta(
  before: Induced | null,
  after: Induced,
  addedLeaf: number,
): AddDelta {
  const prior = new Set(before?.rendered ?? []);

  // The flare belongs on the node the new lineage joins at — the nearest
  // already-present ancestor of the leaf that was just added. On the very
  // first selection there is none, so the MRCA of the new subtree is the
  // honest subject.
  let join: number | undefined = addedLeaf;
  while (join !== undefined && !prior.has(join)) {
    const seg: Segment | undefined = after.segments.get(join);
    join = seg?.anc ?? undefined;
  }
  const flare = join !== undefined ? join : after.mrca;

  // Hops from the join point. What a node contributes to the animation is the
  // segment *above* it, so the subtree root is not drawn at all — it has no
  // ancestor here to be drawn from, and giving it a wave of its own spent a
  // beat of the sequence on nothing. It is the point the first wave leaves
  // from, which is why it gets ROOT and its children get 0, exactly as an
  // already-on-screen join point would.
  const ROOT = -1;
  const wave = new Map<number, number>();
  const waveOf = (v: number): number => {
    const seen = wave.get(v);
    if (seen !== undefined) return seen;
    const anc = after.segments.get(v)?.anc ?? null;
    const w = anc === null ? ROOT : prior.has(anc) ? 0 : Math.max(waveOf(anc) + 1, 0);
    wave.set(v, w);
    return w;
  };

  const waves: number[][] = [];
  for (const v of after.rendered) {
    if (prior.has(v)) continue;
    const w = waveOf(v);
    if (w !== ROOT) (waves[w] ??= []).push(v);
  }

  return {
    flare,
    // A wave can only exist if its parent wave does, so there are no holes —
    // but an empty array is a cheaper contract than a caller that has to know.
    drawOrder: waves.map((w) => w ?? []),
    reflowing: after.rendered.filter((v) => prior.has(v)),
  };
}
