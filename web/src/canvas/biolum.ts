/**
 * Bioluminescence: the shared seeds, and what the marks contribute.
 *
 * **The data is the light source.** That is styles.css's standing rule and this
 * mode does not get to relax it — it gets to take it *literally*. Nothing in
 * the background emits. Every photon on the canvas is a branch or a mark, and
 * the only other thing visible is what *reflects* them: the marine snow, which
 * emits nothing at all and is dark wherever the tree is not.
 *
 * That is a stronger reading of the rule than the mode's first cut managed. It
 * had a field of particles spilled *out* of the nodes, drifting away and going
 * on shining on their own — pretty, and a second light source in all but name,
 * which is what made the canvas read as sparkly. Snow cannot do that. It has no
 * light of its own to carry away.
 *
 * Three effects, and each one is a *behaviour of the data*:
 *
 *   river     a branch is a tentacle with a luminescent reaction running down
 *             it — ancestor to descendant, always that way. `flow.ts` and
 *             `gl/tuning.ts` hold its constants; the motion is closed-form
 *   glow      every mark leaks light into the water around it
 *   touch     running a pointer across a branch plucks it and it surges;
 *             pointing at a mark makes it flare. Neither throws anything out
 *
 * The channels the instrument reserves are untouched in both states. The dash
 * pattern and the tier desaturation say what is known and what is guessed, and
 * they say it identically with every light in the room on. `mayPump` and
 * `tierBrightness` are where that is enforced.
 */

/* ------------------------------------------------------------- randomness -- */

/**
 * A small deterministic generator.
 *
 * Anything derived from a node or an edge is seeded from its own id, so it is
 * the same on every render. That is not tidiness: a branch whose river was
 * reseeded from `Math.random` on each React pass would visibly restart every
 * time an unrelated node was added, and the eye reads a restart as an event.
 *
 * Nothing on the canvas is exempt any more. The old field's motes could use
 * `Math.random` freely because they lived for seconds and were never
 * re-derived; every pinpoint and every flake is now a pure function of its
 * index, so all of them are derived on every frame and none of them may drift.
 * The GPU side has its own hash for that — see `pcg3d` in `gl/shaders.ts`, and
 * why the cheap one was not good enough.
 */
export function seeded(seed: number): () => number {
  let s = (Math.trunc(seed) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A stable integer from a string — edge ids are `"<anc>-<v>"` and `"graft-<idx>"`.
 *
 * Hashed rather than parsed, and that is load-bearing wherever this feeds
 * {@link seeded}: node indices are preorder, so a clade's members are a *run*
 * of consecutive integers and sister taxa land beside each other constantly. A
 * seed taken linearly from an index would give every sibling in a group a
 * near-identical one, and whatever it drove would follow the topology — an
 * effect encoding a data value, which is the one thing this mode may not do.
 * Same reasoning that keeps `laneHue` from handing adjacent indices adjacent
 * colours.
 */
export function hashKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/* ----------------------------------------------------------------- marks -- */

/**
 * When each mark was last pointed at.
 *
 * Module-level rather than carried on the emitter, and for the same reason
 * `flow.ts` keeps its surges outside the source objects: the emitter list is
 * rebuilt from the layout on every pass, so a flare stored on one would be
 * discarded the moment anything else on the canvas changed. Keyed by the node's
 * own key, which survives a re-layout.
 *
 * It replaces a burst of particles puffed out of the mark. Same gesture, same
 * moment, and the light now stays where it was made — which is the whole point
 * of the redesign, and is also why the snow around a pointed-at node brightens
 * without anything here knowing that snow exists.
 */
const flares = new Map<string, number>();

export function flareMark(key: string, at: number = performance.now()): void {
  flares.set(key, at);
}

export function flareOf(key: string): number | undefined {
  return flares.get(key);
}

/**
 * When each mark was last *arrived at* — the taxon a draw ended on.
 *
 * A second clock rather than a second use of the flares above: the two decay
 * over very different times (`ARRIVE_S` against `FLARE_S`). Module-level for
 * the same reason, and more so — an add rebuilds the emitter list by
 * definition, so a bloom held on an emitter would be discarded by the very
 * thing that started it.
 */
const arrivals = new Map<string, number>();

export function arriveMark(key: string, at: number = performance.now()): void {
  arrivals.set(key, at);
}

export function arriveOf(key: string): number | undefined {
  return arrivals.get(key);
}

/**
 * A mark leaking light into the water around it, continuously.
 *
 * `power` is **the selection channel**, which is the one thing luminance is
 * already allowed to encode: a species the reader chose and the common ancestor
 * they came for shine harder than an intermediate divergence. That is the same
 * statement the corona and the label brightness already make, said a third way,
 * rather than a new channel carrying a new fact. It is deliberately *not* keyed
 * to age, tier or tip count — those are data values, and a mark that glowed
 * harder because a clade was large would be exactly the failure this mode is
 * written to avoid.
 */
export interface Emitter {
  x: number;
  y: number;
  hue: number;
  power: number;
  /** Read live, so a flare that starts mid-frame is not lost until re-layout. */
  flareAt?: () => number | undefined;
  /** Likewise for the arrival bloom, which outlives several layout passes. */
  arriveAt?: () => number | undefined;
}
