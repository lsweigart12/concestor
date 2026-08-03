/**
 * The reaction running down a branch: a stream of light-emitting particles
 * inside a mostly transparent tube.
 *
 * Two earlier cuts are worth recording, because each was wrong in a way the
 * next fixed and this one avoids both.
 *
 * A **`stroke-dasharray` train** swept along the path came first. A dash
 * pattern can only translate rigidly — every swell keeps its length and its
 * spacing forever — so what travelled was a row of solid objects sliding down a
 * tube. No amount of jitter fixes that; the information is not in the pattern.
 *
 * A **variable-width ribbon** driven by a 1-D density solver came second, and it
 * was real fluid: advection, continuity, viscosity, pressure. But it showed the
 * flow by *distending the tube*, and a branch that swells is a branch whose
 * width is saying something — on a canvas where stroke weight is uniform by
 * design and meaning lives in luminance and hue, that is a channel spent on
 * decoration.
 *
 * So: **Lagrangian tracers.** The velocity field is the same travelling
 * peristaltic wave; particles are simply carried by it. Where the field
 * converges they bunch, where it diverges they string out. That is the *same
 * physics* the density solver computed, made visible directly in the spacing of
 * the particles rather than indirectly in the width of a ribbon — and it is
 * both simpler and closer to what a stream of glowing plankton in a tentacle
 * actually is. **The tube itself never moves.**
 *
 * Everything is in **normalised arc length** `s ∈ [0, 1]`, so one flow serves a
 * three-pixel hominin split and a nine-hundred-pixel eukaryote stem without
 * caring which it is. Only the speed is denormalised, so the reaction crosses
 * every branch at the same *physical* rate.
 *
 * The particles are drawn by `Water.tsx` on the same additive canvas as the
 * light the marks spill — see {@link registerFlow}. One layer, one loop, one
 * sprite, so a stream passing a drifting mote genuinely brightens it, and the
 * glass wall of the tube is lit from inside by whatever is passing through it.
 */

import { seeded } from "./biolum";
import {
  TIER_INTERPOLATED,
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
  type Tier,
} from "../api";
import type { StrumPoint } from "./strum";

/** How fast the reaction travels, in layout px per second. */
export const FLOW_SPEED = 74;

/**
 * Bounds on how long it takes to cross a branch, in seconds.
 *
 * Speed is held constant in *px* so a long branch genuinely takes longer, which
 * is the honest reading — but only between these. A three-pixel branch at 74
 * px/s would refill twenty times a second and read as a flicker, and a
 * nine-hundred-pixel one would take twelve seconds during which nothing appears
 * to be happening.
 */
export const CROSS_MIN_S = 1.8;
export const CROSS_MAX_S = 8;

/** Centreline samples per branch, and roughly one per this many layout px. */
export const SAMPLES_MIN = 12;
export const SAMPLES_MAX = 48;
const PX_PER_SAMPLE = 16;

/**
 * Peristalsis: how hard the velocity varies along the tube, and how many waves
 * are on it.
 *
 * `WAVE_AMP` is the whole effect. At zero the field is uniform, every particle
 * moves at the same speed, and the stream is a conveyor belt with evenly spaced
 * dots on it. High, the slow phase nearly stalls while the fast phase overtakes
 * — which is what makes a clump gather, hold, and then draw out again.
 */
const WAVE_AMP = 0.72;
const WAVE_WAVES = 1.5;
/** Wave travel, in wavelengths per second. */
const WAVE_HZ = 0.34;

/**
 * Particles per second entering a branch, at rest and at the peak of a surge.
 *
 * Dense enough that their haloes overlap along a run. That is not a brightness
 * setting — it is what makes the tube read as *lit from inside* rather than as
 * a dotted line: overlapping light sums on the water's additive canvas, so a
 * stretch carrying a clump glows continuously through the glass while a stretch
 * that has strung out shows individual sparks. Too sparse and there is nothing
 * for the wall to catch; measured, at half these rates the branches went dark
 * and the tube's own transparency had nothing to compensate it.
 */
const BASE_RATE = 6.5;
const SURGE_RATE = 15;

/** Hard ceiling per branch, so a long slow tube cannot run away. */
export const MAX_PER_BRANCH = 110;

/** Fractions of the run spent fading in at the top and out at the bottom. */
const FADE_IN = 0.05;
const FADE_OUT = 0.12;

export function samplesFor(len: number): number {
  return Math.max(
    SAMPLES_MIN,
    Math.min(SAMPLES_MAX, Math.round(len / PX_PER_SAMPLE)),
  );
}

/**
 * How bright a branch's stream may be, given what is known about its date.
 *
 * **This is the dash channel's concession, and it moved out of CSS when the
 * stream moved onto the canvas.** The rule it enforces has not changed: the
 * dash pattern says whether anybody has estimated a date, it is the claim this
 * app can least afford to blur, and a bright stream running along a dashed line
 * may not compete with the dashes at the moment they are making their only
 * statement. A stream concedes most where the line concedes most.
 *
 * A plain function rather than a stylesheet rule because canvas has no cascade
 * — which also makes it directly testable, where the CSS version needed a test
 * that read the stylesheet as text.
 */
export function tierBrightness(tier: Tier, unbounded: boolean): number {
  if (unbounded) return 0.22;
  if (tier === TIER_STRUCTURAL || tier === TIER_OCCURRENCE) return 0.32;
  if (tier === TIER_INTERPOLATED) return 0.55;
  return 1;
}

export interface Tracer {
  /** Position along the branch, `0` at the ancestor and `1` at the descendant. */
  s: number;
  /** Offset across the tube, in layout px. A stream has width. */
  lat: number;
  /** Drawn halo radius, layout px. */
  r: number;
  /** Peak alpha, before the tier, the envelope and the twinkle. */
  bright: number;
  twinkle: number;
  twinklePhase: number;
}

/**
 * One branch's stream.
 *
 * No allocation per step beyond the odd `push`: this runs for every branch on
 * the canvas on every frame, alongside the water's own field.
 */
export class Flow {
  readonly tracers: Tracer[] = [];
  private t = 0;
  private owed = 0;

  private readonly u0: number;
  private readonly waveK: number;
  private readonly waveHz: number;
  private readonly wavePhase: number;
  private readonly surgeA: number;
  private readonly surgeB: number;
  private readonly phaseA: number;
  private readonly phaseB: number;
  private readonly rnd: () => number;

  constructor(len: number, seed: number) {
    const r = seeded(seed);
    this.rnd = r;
    const cross = Math.min(CROSS_MAX_S, Math.max(CROSS_MIN_S, len / FLOW_SPEED));
    // ±18% per branch, so no two tubes run at quite the same rate.
    this.u0 = (1 / cross) * (0.82 + r() * 0.36);
    this.waveK = WAVE_WAVES * (0.7 + r() * 0.8);
    this.waveHz = WAVE_HZ * (0.75 + r() * 0.5);
    this.wavePhase = r();
    // Surge periods that are not simple multiples of each other, so the stream
    // never settles into a rhythm a viewer can anticipate.
    this.surgeA = 1.3 + r() * 1.2;
    this.surgeB = 2.6 + r() * 2.4;
    this.phaseA = r();
    this.phaseB = r();
  }

  /**
   * Flow speed at `s`, in normalised arc length per second.
   *
   * Never negative: the reaction is descent, ancestor to descendant, and a
   * velocity that reversed would run light back up a lineage. `WAVE_AMP` is
   * below 1 so this holds by construction; the clamp says so anyway.
   */
  velocityAt(s: number): number {
    const w = Math.sin(
      2 * Math.PI * (this.waveK * s - this.waveHz * this.t + this.wavePhase),
    );
    return Math.max(0, this.u0 * (1 + WAVE_AMP * w));
  }

  /** Particles per second entering right now. Always positive: it is a stream. */
  inflow(): number {
    const a = Math.sin(2 * Math.PI * (this.t / this.surgeA + this.phaseA));
    const b = Math.sin(2 * Math.PI * (this.t / this.surgeB + this.phaseB));
    // Rectified and squared, so surges are occasional and rounded rather than a
    // sine's constant swelling — a pump opening and closing, not a dimmer.
    const s = Math.max(0, a * 0.62 + b * 0.38);
    return BASE_RATE + SURGE_RATE * s * s;
  }

  private born(): void {
    if (this.tracers.length >= MAX_PER_BRANCH) return;
    const r = this.rnd;
    this.tracers.push({
      s: 0,
      // Across the tube, so the stream has body rather than running single
      // file. Biased to the middle — the mean of two uniforms — because flow in
      // a pipe is fastest and densest on its axis.
      lat: (r() + r() - 1) * 2.2,
      // The halo reach, not the spark. Wide enough that neighbours overlap
      // where the stream bunches — see BASE_RATE.
      r: 3.6 + r() * 5.2,
      bright: 0.58 + r() * 0.42,
      twinkle: 0.6 + r() * 1.9,
      twinklePhase: r(),
    });
  }

  step(dt: number): void {
    // Clamped: a backgrounded tab must not integrate a minute in one step.
    const h = Math.min(0.05, Math.max(0, dt));
    if (h === 0) return;
    this.t += h;

    // Advect, and drop anything that has reached the descendant. Compacted in
    // place rather than filtered, so a frame allocates nothing.
    const ts = this.tracers;
    let out = 0;
    for (let i = 0; i < ts.length; i++) {
      const p = ts[i]!;
      p.s += this.velocityAt(p.s) * h;
      if (p.s < 1) ts[out++] = p;
    }
    ts.length = out;

    this.owed += this.inflow() * h;
    // A ceiling on the catch-up, so a backgrounded tab does not return and
    // discharge a minute of accumulated stream in one frame.
    if (this.owed > 12) this.owed = 12;
    while (this.owed >= 1) {
      this.owed -= 1;
      this.born();
    }
  }

  /**
   * Fill the tube before its first frame.
   *
   * Not cosmetic: without it every branch starts empty and fills from the top
   * in unison, so adding a species makes the whole tree flush at once — a beat,
   * and a beat reads as an announcement about the data. Stepping the real
   * solver rather than scattering particles evenly is what makes the primed
   * state already show the bunching.
   */
  prime(seconds = 12): void {
    const h = 1 / 40;
    for (let i = 0; i < Math.ceil(seconds / h); i++) this.step(h);
  }

  /** How lit a tracer is now: soft at both ends, twinkling in between. */
  alphaOf(p: Tracer): number {
    const envelope =
      p.s < FADE_IN
        ? p.s / FADE_IN
        : p.s > 1 - FADE_OUT
          ? (1 - p.s) / FADE_OUT
          : 1;
    const w = Math.abs(Math.sin(Math.PI * (this.t / p.twinkle + p.twinklePhase)));
    // A shallower twinkle than the water's. These are the reaction rather than
    // flecks catching light, and a stream whose members keep dropping to near
    // dark loses the very thing it is there to show — the *spacing* between
    // them, which is where the pumping is legible.
    return p.bright * envelope * (0.72 + 0.28 * w * w);
  }
}

/**
 * A branch's stream, and where to draw it.
 *
 * Registered rather than drawn in place, because the particles belong on the
 * water's canvas: it is the additive layer every other light here is
 * composited into, so a stream passing a drifting mote genuinely brightens it,
 * and the light that lands on the tube's glass wall is the light of whatever is
 * inside it at that moment. The alternative — each edge drawing its own — would
 * need a canvas per edge or an SVG circle per particle, and neither composites
 * with anything.
 *
 * It also collapses eighteen animation loops into one.
 */
export interface FlowSource {
  flow: Flow;
  /** The branch's centreline in layout space, sampled once per geometry. */
  pts: readonly StrumPoint[];
  hue: number;
  /** The tier's ceiling on brightness. See {@link tierBrightness}. */
  gain: number;
  /** Live: the strum displacement, so the stream rings with its own branch. */
  bend: () => ((t: number) => number) | null;
}

const sources = new Set<FlowSource>();

export function registerFlow(src: FlowSource): () => void {
  sources.add(src);
  return () => {
    sources.delete(src);
  };
}

export function flowSources(): ReadonlySet<FlowSource> {
  return sources;
}

/**
 * Where a tracer is, in layout space. Written into `out` rather than returned,
 * so drawing a thousand of them allocates nothing.
 *
 * Linear along the sampled centreline. The samples are dense enough that a
 * straight hop between two is well under a pixel — and interpolating the
 * *normal* the same way is what carries the lateral offset around the rounded
 * corner an `orthPath` puts in. A tracer using only its nearest sample's normal
 * visibly kinks sideways as it rounds the bend.
 */
export function tracerXY(
  src: FlowSource,
  p: Tracer,
  out: { x: number; y: number },
): void {
  const pts = src.pts;
  const n = pts.length - 1;
  const at = Math.max(0, Math.min(n, p.s * n));
  const i = Math.min(n - 1, Math.floor(at));
  const f = at - i;
  const a = pts[i]!;
  const b = pts[i + 1]!;
  const nx = a.nx * (1 - f) + b.nx * f;
  const ny = a.ny * (1 - f) + b.ny * f;
  const bend = src.bend();
  const off = (bend ? bend(p.s) : 0) + p.lat;
  out.x = a.x * (1 - f) + b.x * f + nx * off;
  out.y = a.y * (1 - f) + b.y * f + ny * off;
}
