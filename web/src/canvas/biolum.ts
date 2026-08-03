/**
 * Bioluminescence: the shared seeds and the spill bus.
 *
 * **The data is the light source.** That is styles.css's standing rule and this
 * mode does not get to relax it — it gets to take it *literally*. There is no
 * ambient light in this mode. Nothing in the background emits. Every photon on
 * the canvas either is a branch, or is a mark, or **came out of one**: the
 * particles suspended in the water are spilled by the nodes, drift away from
 * them, twinkle, and go out. Turn the mode on over an empty canvas and the
 * water is black, because there is nothing to have lit it.
 *
 * That reframing is what makes the whole thing defensible. An earlier cut had
 * drifting caustics and shafts of surface light, and they were pretty and they
 * were wrong: they were a second light source competing with the graph, exactly
 * what the rule forbids, and at low opacity across the whole viewport they read
 * as astigmatism rather than as depth.
 *
 * Three effects, and each one is a *behaviour of the data*:
 *
 *   flow      a branch is a tentacle with a luminescent reaction being pushed
 *             down it — ancestor to descendant, always that way. `flow.ts`
 *             solves it as an actual one-dimensional fluid
 *   spill     every node leaks light into the water around it
 *   strum     running a pointer across a branch plucks it, and the branch sheds
 *             a burst of light where it was touched
 *
 * The channels the instrument reserves are untouched in both states. The dash
 * pattern and the tier desaturation say what is known and what is guessed, and
 * they say it identically with every light in the room on. `mayPump` and the
 * tier rules in styles.css are where that is enforced.
 */

/* ------------------------------------------------------------- randomness -- */

/**
 * A small deterministic generator.
 *
 * Anything derived from a node or an edge is seeded from its own id, so it is
 * the same on every render. That is not tidiness: a branch whose flow was
 * reseeded from `Math.random` on each React pass would visibly restart every
 * time an unrelated node was added, and the eye reads a restart as an event. Particles are the exception and use `Math.random` freely — they live
 * for seconds and are never re-derived, so there is nothing to keep stable.
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

/* ----------------------------------------------------------------- spill -- */

/**
 * Where a burst of light came from, in **layout coordinates**.
 *
 * Layout and not screen, because the water belongs to the tree: pan and zoom
 * carry the particles with the branches that shed them, which is the whole
 * reason they read as suspended in the same volume rather than as a filter over
 * the top of it.
 */
export interface Spill {
  x: number;
  y: number;
  hue: number;
  count: number;
  /** Initial speed, layout px per second. */
  speed: number;
  /** Radians. `TAU` is an even burst; a smaller arc aimed by `aim` is a spray. */
  spread?: number;
  aim?: number;
}

type SpillListener = (s: Spill) => void;
const listeners = new Set<SpillListener>();

/**
 * A one-line event bus, and it earns its keep.
 *
 * The things that shed light are a trace and a mark; the thing that draws the
 * water is a canvas three levels up. Threading a callback down would mean a new
 * field on `TraceEdgeData` and on `MarkData`, both of which are handed through
 * React Flow's `data` bag as `Record<string, unknown>` — so the callback would
 * be re-created on every layout pass and would defeat the memo on every edge
 * and every node on the canvas, to deliver an event that has nothing to do with
 * React's render at all. A burst of particles is not state. It is a thing that
 * happened.
 */
export function spill(s: Spill): void {
  for (const fn of listeners) fn(s);
}

export function onSpill(fn: SpillListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** A node leaking light into the water around it, continuously. */
export interface Emitter {
  x: number;
  y: number;
  hue: number;
  /** Particles per second. See `EMIT_BASE` in `particles.ts`. */
  rate: number;
}
