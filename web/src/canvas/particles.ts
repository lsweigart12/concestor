/**
 * The water, and everything suspended in it.
 *
 * **Every particle here came out of a node.** That is the whole design and it
 * is what makes the effect legal under styles.css's rule that the data is the
 * only light source: this is not a background, it is *fallout*. Marks leak
 * light continuously, a plucked branch sheds a burst, a hovered node puffs one
 * — and what drifts through the volume afterwards is that light, going out
 * slowly. On an empty canvas the water is black.
 *
 * Positions are in **layout coordinates**, not screen. Particles are therefore
 * carried by pan and zoom exactly as the branches are, which is the difference
 * between light suspended in the same volume as the tree and a texture laid
 * over the top of it. It also means their motion is specified once, in the same
 * units the layout uses, and never has to be rescaled.
 *
 * The simulation is a flat array with in-place compaction and no allocation per
 * frame beyond the odd `push`. That is not premature: this is the only
 * per-frame JavaScript on the canvas, and it runs alongside the pump animations
 * the compositor is already paying for.
 */

import type { Emitter, Spill } from "./biolum";

/**
 * The cap, and the budget it stands for.
 *
 * Measured at 120fps with the field full on a twelve-species canvas, so this is
 * headroom rather than a limit anyone will feel. It has to be headroom: a field
 * sitting *on* its cap silently drops every burst, so plucking a branch or
 * pointing at a node would do nothing — the two interactions this mode has —
 * while looking exactly as though the code were wrong. An earlier pairing with
 * a higher emission rate did exactly that, at 591 of 620.
 *
 * Over the cap, spawning stops: the field thins rather than the frame rate
 * dropping, which is the right way round for something nobody is looking at
 * directly. A canvas of thirty species will reach it, and that is the intended
 * behaviour rather than a case to tune for.
 */
export const MAX_PARTICLES = 900;

/**
 * Particles per second from one mark at rest.
 *
 * **This number and {@link LIFE_MAX} move together and cannot be tuned apart**:
 * the steady-state population is rate × mean life, so tripling how long a
 * particle lives while leaving the rate alone triples the field and puts it on
 * the cap. It is deliberately low — a slow leak of long-lived light, rather
 * than a fast leak of short-lived light — which is what makes the water read as
 * *still* and lit rather than as busy.
 *
 * The number that actually decides whether the water looks alive is
 * {@link alphaOf}'s twinkle, not this. Doubling the count doubles the cost and
 * changes the look far less than making each particle legible does — which is
 * the lesson of the first attempt, where the field was populated, invisible,
 * and peaking at alpha 6 out of 255.
 */
export const EMIT_BASE = 0.82;

/**
 * Seconds a particle lives. Long, and very widely spread.
 *
 * Half a minute at the top end. That is not a decorative choice: light shed
 * into water goes out *slowly*, and a field whose members turned over every few
 * seconds read as a shower rather than as a suspension — the eye tracked the
 * births. At this range a particle is drifting and dimming for long enough that
 * the reader loses track of any individual one, which is the point.
 */
const LIFE_MIN = 16;
export const LIFE_MAX = 46;

/** Fraction of a life spent fading in. Short: it *leaves* the node, brightly. */
const FADE_IN = 0.02;
/** …and the fraction spent going out, which is nearly all of it. */
const FADE_OUT = 0.88;
/**
 * The shape of that fade.
 *
 * Below 1 it is concave: the particle holds most of its brightness through the
 * first part of the decline and then trails a long way down. Linear over the
 * same span reads as a dimmer being turned at a constant rate, which is the one
 * thing a chemical reaction running out does not do.
 */
const FADE_CURVE = 0.72;

/**
 * How fast the water takes the speed out of a particle, per second.
 *
 * This is the single number that decides whether the field reads as water or as
 * space. Without drag a particle leaves in a straight line forever and the
 * canvas looks like a starfield exploding; at this value it gets clear of its
 * node in the first second and then hangs, wandering, for the rest of its life.
 */
const DRAG = 0.5;

/**
 * A slow lateral wander, so nothing travels in a straight line.
 *
 * Gentler than it was, because the lives are now three times longer: the same
 * acceleration that read as a drift over ten seconds reads as swimming over
 * forty. What is wanted is a particle that gets clear of its node and then
 * *radiates* — moving the whole time, but slowly enough that the movement is
 * something you notice rather than something you watch.
 */
const CURL_SPEED = 0.4;
const CURL_ACCEL = 2.8;

/**
 * Light rises, slightly. Enough to be a direction, not enough to be a current.
 *
 * **This scales with the lifetime and was quietly wrong once the lives got
 * long.** A constant acceleration against {@link DRAG} settles at a terminal
 * speed, and terminal speed times life is a *displacement*: at the old figure
 * that came to 128 layout px over a full life, which on a tree 700 px tall
 * pooled the whole field above and to one side of the canvas. The water stopped
 * looking like light shed by the marks and started looking like a slick
 * drifting away from them — which loses the one thing the particles are for.
 *
 * A tenth of that keeps the direction and not the transport.
 */
const BUOYANCY = -0.4;

const TAU = Math.PI * 2;

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hue: number;
  /** Seconds lived, and the total it gets. */
  age: number;
  life: number;
  /** Layout px. */
  r: number;
  /** Peak alpha, before the twinkle and the envelope. */
  bright: number;
  /** Seconds per twinkle, and where in one it started. */
  twinkle: number;
  twinklePhase: number;
  /** Its own curl phase, so no two wander together. */
  curl: number;
}

/**
 * How lit a particle is right now: born bright, long slow death, twinkling
 * throughout.
 *
 * The twinkle is `|sin|` raised to a power rather than a plain sine, because a
 * sine spends half its time near full and reads as a steady lamp dimming. The
 * power pushes it to *mostly dark with a rise*, which is what a scattering
 * fleck of light in water actually does — and it is why the field looks like it
 * is made of individuals rather than of dots on one dimmer.
 */
export function alphaOf(p: Particle): number {
  const t = p.age / p.life;
  if (t >= 1) return 0;
  const envelope =
    t < FADE_IN
      ? t / FADE_IN
      : t > 1 - FADE_OUT
        ? ((1 - t) / FADE_OUT) ** FADE_CURVE
        : 1;
  const s = Math.abs(Math.sin(Math.PI * (p.age / p.twinkle + p.twinklePhase)));
  // The sixth power is not arbitrary: it puts a particle over half brightness
  // for about a third of its cycle. A plain sine is over half for two thirds,
  // which reads as a field of lamps on one dimmer rather than as flecks
  // catching light one at a time. The floor is small and not zero so a particle
  // never fully disappears and reappears — that reads as two particles.
  return p.bright * envelope * (0.12 + 0.88 * s ** 6);
}

export class Field {
  readonly particles: Particle[] = [];
  /** Fractional particles owed to the emitters, carried between frames. */
  private owed = 0;
  /** Seconds since the field started; drives the curl. */
  private clock = 0;

  get size(): number {
    return this.particles.length;
  }

  /** One particle, aimed and launched. */
  private born(
    x: number,
    y: number,
    hue: number,
    speed: number,
    angle: number,
  ): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    const s = speed * (0.35 + Math.random() * 0.95);
    this.particles.push({
      x,
      y,
      vx: Math.cos(angle) * s,
      vy: Math.sin(angle) * s,
      hue,
      age: 0,
      life: LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN),
      // The **halo** radius in layout px — the light thrown into the water,
      // not the point that throws it. The bright core is a fixed small
      // fraction of it (see `sprite` in `Water.tsx`), so a particle is a
      // pinpoint inside a wide faint glow whatever this is set to, and this
      // controls how far that glow reaches rather than how big the dot looks.
      //
      // The range is narrow and high on purpose. Wide and low, the small end
      // scales its own core below a pixel and the downscale averages it away —
      // measured, at the first numbers here the whole field peaked at alpha 6
      // out of 255, present in the buffer and invisible on the screen.
      r: 7 + Math.random() * 11,
      // A long tail rather than a range: most are faint and a few are not, so
      // the eye finds individuals in the field instead of an even haze.
      bright: 0.3 + Math.random() ** 1.8 * 0.7,
      // Slower than it was, to match the longer lives: a field turning over in
      // forty seconds should not be flickering on a half-second cycle.
      twinkle: 1.1 + Math.random() * 3.4,
      twinklePhase: Math.random(),
      curl: Math.random() * TAU,
    });
  }

  /** A burst: a pluck, a hover, anything that happened at a moment. */
  emit(s: Spill): void {
    const spread = s.spread ?? TAU;
    const aim = s.aim ?? 0;
    for (let i = 0; i < s.count; i++) {
      this.born(
        s.x,
        s.y,
        s.hue,
        s.speed,
        aim + (Math.random() - 0.5) * spread,
      );
    }
  }

  /**
   * The continuous leak, over `dt` seconds.
   *
   * The whole set is spent from one fractional budget rather than each emitter
   * keeping its own. Two reasons, and the second is the real one: emitters are
   * rebuilt from the layout on every pass, so per-emitter state would be thrown
   * away constantly and every node would round its own fraction down to nothing
   * at these rates. Spending one budget on a weighted random emitter gives the
   * same long-run distribution with no state to lose.
   */
  trickle(emitters: readonly Emitter[], dt: number): void {
    if (emitters.length === 0) return;
    let total = 0;
    for (const e of emitters) total += e.rate;
    this.owed += total * dt;
    // A ceiling on the catch-up, so a backgrounded tab does not return and
    // discharge a minute of accumulated light in one frame.
    if (this.owed > 24) this.owed = 24;
    while (this.owed >= 1) {
      this.owed -= 1;
      let pick = Math.random() * total;
      let chosen = emitters[emitters.length - 1]!;
      for (const e of emitters) {
        pick -= e.rate;
        if (pick <= 0) {
          chosen = e;
          break;
        }
      }
      // Off the mark itself, not out of its centre: a particle starting exactly
      // on the dot spends its first half-second inside the glow that made it
      // and appears from nowhere a moment later.
      const a = Math.random() * TAU;
      const d = 3 + Math.random() * 7;
      this.born(
        chosen.x + Math.cos(a) * d,
        chosen.y + Math.sin(a) * d,
        chosen.hue,
        13,
        a,
      );
    }
  }

  step(dt: number): void {
    this.clock += dt;
    const decay = Math.exp(-DRAG * dt);
    const ps = this.particles;
    let out = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      p.age += dt;
      if (p.age >= p.life) continue;
      // Wander: a slow rotation of a small acceleration, per particle, so the
      // paths curve instead of running straight out and stopping.
      const w = this.clock * CURL_SPEED + p.curl;
      p.vx += Math.cos(w) * CURL_ACCEL * dt;
      p.vy += (Math.sin(w) * CURL_ACCEL + BUOYANCY) * dt;
      p.vx *= decay;
      p.vy *= decay;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ps[out++] = p;
    }
    ps.length = out;
  }

  clear(): void {
    this.particles.length = 0;
    this.owed = 0;
  }
}
