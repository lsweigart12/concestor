/**
 * Every number the bioluminescent renderer decides anything with.
 *
 * **The shaders import from here and interpolate these into their source.**
 * That is the rule, and it exists because GLSL cannot be unit-tested in node —
 * `flow.ts` already records the same argument one level down, where
 * `tierBrightness` was moved out of the stylesheet "because canvas has no
 * cascade — which also makes it directly testable, where the CSS version needed
 * a test that read the stylesheet as text." A shader is that problem again and
 * worse: it runs on a device the test runner has no access to, it fails by
 * drawing something slightly wrong rather than by throwing, and nobody reviews
 * a magic constant sitting in a template literal.
 *
 * So a shader in this directory is a *layout* of tested numbers. Anything that
 * is a judgement — how far the vicinity reaches, how hard the wall reflects,
 * how many pinpoints a branch of a given length carries — is a constant or a
 * pure function here, and `tuning.test.ts` is where the ones with a property
 * worth stating get stated.
 */

import { seeded } from "../biolum";

/* ------------------------------------------------------------- the river -- */

/**
 * Pinpoints per layout px of branch, and the ceiling on any one branch.
 *
 * **Per unit length, not per branch**, and that is the whole reason this is a
 * function rather than a count. One number for every branch draws a
 * nine-hundred-pixel eukaryote stem and a three-pixel hominin split with the
 * same population, which makes the short one a bead of light and the long one
 * dust. The draw is still a single instanced call at {@link MAX_PER_BRANCH};
 * a branch wanting fewer throws the surplus off the clip volume in the vertex
 * shader, which costs a vertex and not one fragment.
 */
export const PINPOINTS_PER_PX = 9;
export const MIN_PER_BRANCH = 90;
export const MAX_PER_BRANCH = 6000;

export function quotaFor(len: number): number {
  return Math.max(MIN_PER_BRANCH, Math.min(MAX_PER_BRANCH, len * PINPOINTS_PER_PX));
}

/**
 * How hard the travelling wave displaces the stream, and the bound on it.
 *
 * The stream advances uniformly and is then displaced by a wave:
 * `s' = s + a·sin(2π(k·s − f·t))`. Its derivative is `1 + 2πka·cos(…)`, so the
 * density goes as the reciprocal — the river compresses where the wave slows it
 * and strings out where it does not. That is the bunching, in closed form, with
 * no integration and therefore no state.
 *
 * **Past `2πka = 1` the derivative changes sign and the map folds.** Every
 * particle in the folded interval lands in the same place, which is a caustic:
 * on screen, a hard-edged white block sitting on the branch. It is not a
 * clipping artefact and no tone map removes it, because the light really is
 * that concentrated. Measured, it took three wrong diagnoses first — the
 * reflection, the vicinity buffer, then the tone map — because a caustic looks
 * exactly like a rendering bug.
 *
 * {@link MAX_FOLD} is held at 0.8 rather than 1, because a derivative
 * *approaching* zero is already a visible pile-up where it never changes sign.
 */
export const WAVE_AMP = 0.085;
export const MAX_FOLD = 0.8;

export function ampFor(waveK: number): number {
  return Math.min(WAVE_AMP, MAX_FOLD / (2 * Math.PI * waveK));
}

/**
 * Floor on a pinpoint's drawn radius, in device px.
 *
 * Not cosmetic. A pinpoint scaled with the tree vanishes when the reader pulls
 * back, taking the river with it — and below about a pixel the core the sprite
 * is built around is averaged away entirely, so the branch is *present in the
 * buffer and invisible on the screen*. That failure has now happened twice in
 * this mode's history, at two different renderers, which is why it is a named
 * constant rather than a number inside a `max`.
 */
export const MIN_PINPOINT_R = 1.35;
export const PINPOINT_R_BASE = 0.85;
export const PINPOINT_R_SPAN = 1.55;

/** Layout px per second the reaction travels, and the bounds on a crossing. */
export const FLOW_SPEED = 78;
export const CROSS_MIN_S = 2.4;
export const CROSS_MAX_S = 9;

/** Half-width of a branch's body, layout px. A branch has an interior now. */
export const HALF_W_MIN = 3.0;
export const HALF_W_SPAN = 2.4;
/** The glass sits a little proud of the river it carries. */
export const GLASS_SCALE = 1.3;

export interface BranchParams {
  /** Normalised arc length per second. */
  u0: number;
  /** Wavenumber, wave travel in wavelengths per second, and phase. */
  waveK: number;
  waveHz: number;
  wavePh: number;
  halfW: number;
}

/**
 * A branch's own constants, derived from its id and its length.
 *
 * Seeded, so a branch is the same river on every render: reseeding from
 * `Math.random` on a React pass would visibly restart the stream every time an
 * unrelated node was added, and the eye reads a restart as an event. Same
 * reasoning `biolum.ts` gives for hashing an edge id rather than parsing it.
 */
export function branchParams(seed: number, len: number): BranchParams {
  const r = seeded(seed);
  const cross = Math.min(CROSS_MAX_S, Math.max(CROSS_MIN_S, len / FLOW_SPEED));
  return {
    u0: (1 / cross) * (0.85 + r() * 0.3),
    waveK: 1.1 + r() * 1.5,
    waveHz: 0.22 + r() * 0.22,
    wavePh: r(),
    halfW: HALF_W_MIN + r() * HALF_W_SPAN,
  };
}

/* ------------------------------------------------------- the entrance -- */

/**
 * The draw-on easing, and why it is duplicated here.
 *
 * `TraceEdge` hands `cubic-bezier(.16,.9,.3,1)` to the Web Animations API to
 * sweep a `stroke-dashoffset`, and the river inside that stroke has to arrive
 * at the same place at the same moment. There is no way to *read* the browser's
 * eased value per frame that does not force a style recalculation on every
 * branch on every frame, so the curve is evaluated here instead — which means
 * this constant and the string in `TraceEdge` are two spellings of one number,
 * and `tuning.test.ts` pins them together by parsing the string.
 *
 * A mismatch does not fail, it *drifts*: the light runs ahead of the line it is
 * supposed to be inside, or trails behind the tip, and the branch reads as two
 * objects rather than one.
 */
export const DRAW_BEZIER: readonly [number, number, number, number] = [0.16, 0.9, 0.3, 1];

/**
 * Evaluate a CSS cubic-bezier timing function at `t ∈ [0, 1]`.
 *
 * Newton on X first, because the curve is given as (x(u), y(u)) and the caller
 * has an x. Four iterations is comfortably inside a pixel for these control
 * points; the bisection fallback is there for the flat regions Newton walks out
 * of rather than because this curve has any.
 */
export function bezierEase(t: number, c: readonly [number, number, number, number] = DRAW_BEZIER): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  const [x1, y1, x2, y2] = c;
  const cx = (u: number) => 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u * u * x2 + u ** 3;
  const cy = (u: number) => 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u * u * y2 + u ** 3;
  const dx = (u: number) =>
    3 * (1 - u) ** 2 * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
  let u = t;
  for (let i = 0; i < 4; i++) {
    const d = dx(u);
    if (Math.abs(d) < 1e-6) break;
    const next = u - (cx(u) - t) / d;
    if (!(next >= 0 && next <= 1)) break;
    u = next;
  }
  if (Math.abs(cx(u) - t) > 1e-4) {
    let lo = 0;
    let hi = 1;
    u = t;
    for (let i = 0; i < 24; i++) {
      const x = cx(u);
      if (Math.abs(x - t) < 1e-5) break;
      if (x < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
  }
  return cy(u);
}

/**
 * How much of a branch is lit, `now` ms into a draw that began at `start`.
 *
 * The river grows out of the ancestor end at exactly the rate the stroke does,
 * which is what makes the entrance read as *one* thing reaching outward rather
 * than as a line being drawn and a light being switched on inside it.
 *
 * Returns 1 for a branch that is not drawing — a settled canvas, or the mode
 * being turned on over a tree that is already there. Nothing about the
 * entrance may leave a branch permanently dark.
 */
export function revealAt(
  now: number,
  start: number | null,
  delayMs: number,
  drawMs: number,
): number {
  if (start === null) return 1;
  return bezierEase((now - start - delayMs) / drawMs);
}

/**
 * Softness of the river's leading edge, in normalised arc length.
 *
 * A hard cut at the reveal front is a line of light with a *end*, which reads
 * as a mask sliding along the branch — which is what it is. A short fade is
 * what turns it into a reaction spreading into the tube ahead of itself.
 */
export const REVEAL_FEATHER = 0.07;

/**
 * The landing: one ring, every branch at once, when the last one arrives.
 *
 * The draw reaches out from the root and then the whole tree **locks in** — a
 * single pluck across every branch on the canvas, with the rivers surging into
 * it. It is the same physics a pointer gets, fired from a clock instead, and
 * it is deliberately *simultaneous* where the draw is staggered: a staggered
 * settle would read as the animation continuing, and the point of this beat is
 * that it has stopped.
 *
 * The amplitude is larger than a pointer's and the antinode is at the middle,
 * because the whole branch is what arrived — not a place somebody touched.
 */
export const LANDING_AMP = 11;
export const LANDING_AT = 0.5;

/* -------------------------------------------------------------- the snow -- */

/**
 * How many flakes, and the base almost nobody notices.
 *
 * The snow **emits nothing**. {@link SNOW_AMBIENT} is the whole of what it is
 * worth when no light falls on it. It is deliberately at the threshold of
 * visible — but it is on the *visible* side of that threshold, because this
 * field replaces the grid and the grid was drawn on an empty canvas too. Set
 * lower it vanishes entirely below about 4/255, which is not "barely visible",
 * it is a background that only exists next to the tree. Everything above the
 * base is the tree's light coming back off it.
 *
 * The count is **per unit area**, not a number. A field sized for a laptop is
 * a quarter as dense on a large display, which is exactly where a slow rain
 * stops reading as weather and starts reading as dust on the screen.
 */
export const SNOW_PER_PX2 = 1 / 32;
export const SNOW_MIN = 8000;
export const SNOW_MAX = 30000;
export const SNOW_AMBIENT = 0.07;

export function snowCountFor(w: number, h: number): number {
  return Math.round(Math.max(SNOW_MIN, Math.min(SNOW_MAX, w * h * SNOW_PER_PX2)));
}

/**
 * How fast a lit flake saturates, in the vicinity field's own units.
 *
 * `lit = 1 − exp(−amount · k)`. Saturating rather than linear, so a flake
 * crossing a bright river reaches full and stays there instead of continuing to
 * climb into a white dot — the *hue* keeps changing after the brightness has
 * stopped, which is what "increasing hue with more particles in the vicinity"
 * actually looks like.
 */
export const SNOW_RESPONSE = 9;

/**
 * How bright a fully lit flake gets.
 *
 * Bounded by a rule this canvas already had: **the tree is the brightest thing
 * on it.** Snow that out-shines the branch lighting it inverts the whole point
 * — the reader's eye goes to the water instead of to the lineages, and the
 * effect stops reading as reflection and starts reading as a second light
 * source, which is the exact failure the drifting particle field was retired
 * for.
 */
export const SNOW_LIT_GAIN = 1.5;

/** Screen px per second at unit depth, and the depth range itself. */
export const SNOW_FALL_MIN = 5.5;
export const SNOW_FALL_SPAN = 9.5;
export const SNOW_Z_MIN = 0.3;
export const SNOW_Z_SPAN = 0.7;

/* ------------------------------------------- the light with no tree in it -- */

/**
 * The empty canvas's own light, and why it is allowed to exist at all.
 *
 * `Water.tsx` used to record, as the property that kept this mode honest, that
 * *with nothing on the canvas there is nothing lit*. That was a claim about the
 * **graph** and it was being read as a claim about the **canvas**, which is
 * where it went wrong: the empty canvas is not blank. It carries the wordmark,
 * an opening card and a row of silhouettes, and in the one state where there is
 * no graph, those are the thing on the canvas. So they emit, under the same
 * rule rather than a relaxation of it — *the thing on the canvas is the light
 * source* — and the moment a species is drawn they are gone and the tree is the
 * only light again.
 *
 * That is also the whole of the boundary. **Chrome does not emit.** Not the
 * control bar, not this panel's own switch, not the axis, not the palette. A
 * light behind every piece of furniture is decoration sprayed around a room;
 * what is legal here is exactly the surface a reader is being invited *into*,
 * and `bootLight.ts` is the list, the geometry and the argument for each entry.
 *
 * These lights are in **screen space** and carry a radius of their own, which
 * is the one way they differ from a mark: a mark is at a place in the tree and
 * pans with it, and a wordmark is at a place on the glass. They go into the
 * same HDR light buffer as everything else, so the snow, the bloom and the tone
 * map pick them up without being told they exist — which is the same reason a
 * pluck brightens the water beside a branch.
 */
/**
 * Saturation, and it is high for the reason `laneRGB` gives.
 *
 * These are area lights and they overlap — the four animals on a card are a
 * hand's width apart with a pool under all of them — so an additive stack of
 * three or four sums past white long before any one of them is bright. Set at a
 * sensible-looking 0.66 the whole panel came out grey with a colour fringe. It
 * sits where the river's does, and for the same reason.
 */
export const SCREEN_SAT = 0.82;
/** A bright middle inside a wide soft field — the mark's profile, spread out. */
export const SCREEN_CORE = 3.2;
export const SCREEN_HALO = 1.5;
export const SCREEN_HALO_GAIN = 0.34;
/**
 * How far the core mixes toward white, against a mark's 0.45.
 *
 * Lower, because these are *area* lights: a mark is fourteen pixels across and
 * its white centre is a highlight, where a light seventy pixels across mixed
 * that far is a grey disc with a colour fringe. The hue is most of what these
 * are for — the row of silhouettes glows in the palette the tree uses — so the
 * colour survives the middle.
 */
export const SCREEN_CORE_WHITE = 0.20;

/**
 * The breathing, and why every light gets its own rate.
 *
 * One rate across the set is a *pulse*, and a pulse is a signal — the reader
 * looks for what it is counting. Incommensurate rates never line up, so the
 * panel is alive without anything on it appearing to mean something. It is
 * subtractive (`1 − depth·(0…1)`) rather than centred, so `power` stays a
 * ceiling: nothing here is ever brighter than the number `bootLight.ts` gave
 * it, which is what makes those numbers tunable against a still frame.
 *
 * Periods run from about 12 to 29 seconds. That is slower than it sounds — at
 * anything under a few seconds the panel is twinkling, and the marine snow
 * drifting past is already the fast element in this picture.
 */
export const SCREEN_BREATHE = 0.24;
export const SCREEN_RATE_MIN = 0.034;
export const SCREEN_RATE_SPAN = 0.048;

/**
 * How long a light that has just arrived takes to reach full, in seconds.
 *
 * The carousel turns and three new animals are on the card. Snapping their
 * lights on is a flash — the eye reads a step in brightness as an event and
 * there is no event, only a rotation the reader may not even be watching. A
 * kindle over a second is the same rotation happening in the water.
 *
 * Applied on the CPU, in {@link kindle}, because it is keyed to *when a
 * particular thing appeared* and the shader has no identity to hang that on.
 * It is skipped entirely under `prefers-reduced-motion`, where the clock is
 * held and a ramp would freeze part-way up.
 */
export const SCREEN_KINDLE_S = 1.05;

/**
 * A rising 0→1, given when something appeared. The complement of {@link decay}.
 *
 * **Undefined is full, not zero.** A light with no birth recorded is one that
 * was already there — the still frame, a light whose element merely moved — and
 * the first cut had it start dark, which put the reduced-motion canvas at zero
 * brightness forever.
 */
export function kindle(bornMs: number | undefined, nowMs: number, seconds = SCREEN_KINDLE_S): number {
  if (bornMs === undefined) return 1;
  const t = (nowMs - bornMs) / 1000 / seconds;
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  // Ease out: a light comes up fast and settles, which is how a chemical
  // reaction reaches its plateau and is the same curve the flare decays on.
  return 1 - (1 - t) ** 2;
}

/* ------------------------------------------------------------- the glass -- */

/**
 * The wall, and why every term in the tube varies across it.
 *
 * The first cut gave the body an even wash and a broad reflection, and what it
 * drew was a **bar**: a filled rectangle with cut ends sitting behind the river
 * like a rail. Anything constant across the tube has no shape, and shape is the
 * only thing that makes a transparent object read as a tube rather than as a
 * smudge. So: a thin lit edge, a reflection confined to near the walls, ends
 * that taper, and a body carrying a trace.
 *
 * {@link REFLECT_PEAK} is where the reflection is strongest, and it is inside
 * the wall rather than on it. Peaking at the boundary put the term's maximum
 * exactly on the quad's own edge, so where one branch's glass caught a
 * neighbour's river the result had a straight edge — a bright bar again, from a
 * different direction.
 */
export const WALL_INNER = 0.55;
export const WALL_OUTER = 0.99;
export const WALL_FADE = 1.03;
export const REFLECT_PEAK = 0.86;
export const REFLECT_GAIN = 2.6;
export const WALL_GAIN = 16;
export const BODY_TRACE = 0.004;
export const END_TAPER = 0.04;

/* ----------------------------------------------------------- the picture -- */

/**
 * Exposure, and why there is a tone map at all.
 *
 * Everything accumulates into an HDR buffer and only the last pass decides what
 * a pixel is. Without it the canvas clips, and a clip is not merely "bright":
 * a region summing past 1 goes flat white, and where the thing doing the
 * summing has straight edges — as a glass tube does — what lands on screen is a
 * white rectangle. `1 − exp(−c)` has no knee to tune and nowhere to clip;
 * brightness past the top turns into colour going toward white, which is what
 * an over-exposed light does and is the only part of this mode allowed to be
 * white at all.
 */
export const EXPOSURE = 1.15;
export const BLOOM = 0.55;

/**
 * The deep water. Not a darker void — a bluer one.
 *
 * The sea absorbs red first, so everything not emitting settles toward
 * blue-green. Two near-black steps, shifted along that axis — `#03090e` at the
 * centre falling to `#010406` at the edge.
 *
 * **Darker than the stylesheet's original pair by about half**, and the depth
 * is the reason rather than the taste. At `#05101a` the water was lit: a
 * background that bright reads as shallow, because in shallow water there is
 * still surface light to scatter, and the mode's whole subject is that there is
 * none. Taking it down to near-black is what makes the tree the only thing
 * emitting anything — and it costs nothing in legibility, because the two
 * things that have to survive against it are a river and a snowflake, and both
 * gained contrast.
 *
 * The ratio between the channels is held. This is a *hue*, not a brightness:
 * scaled toward grey it stops being water and becomes a dark grey card.
 */
export const VOID_NEAR: readonly [number, number, number] = [0.0118, 0.0353, 0.0549];
export const VOID_FAR: readonly [number, number, number] = [0.0039, 0.0137, 0.0235];

/**
 * Device pixel ratio ceiling.
 *
 * Every pixel here is soft. A retina buffer costs 78% more fill for a
 * difference nobody can point at — the same trade the 2-D renderer made, at the
 * same number, for the same reason.
 */
export const MAX_DPR = 1.25;

/**
 * How far down the vicinity field is built, as a power of two.
 *
 * It is a *neighbourhood*, so it wants to be blurry — but it must be built by
 * halving, not by point-sampling. Running one separable blur straight from full
 * resolution to an eighth is five taps spanning eight columns: a pinpoint
 * landing on a tap contributes its whole self to the texel and a pinpoint
 * between taps contributes nothing. One texel takes a clump, its neighbours
 * take none, and bilinear filtering spreads that texel across its own footprint
 * as a hard bright square. {@link DOWN_STEPS} 2×2 box passes account for every
 * source pixel exactly once.
 */
export const DOWN_STEPS = 3;

/* ------------------------------------------------------- the two touches -- */

/**
 * A plucked branch surges, and a pointed-at mark flares. Seconds to decay.
 *
 * Both replace a burst of particles thrown *out* of the tree. Light leaving an
 * organism and going on shining on its own was the old mode's central image and
 * it is the one this design refuses: the light stays inside, the branch simply
 * fires harder, and the snow around it brightens on its own because the
 * vicinity field brightened. It is a stronger response than the burst was, not
 * a weaker one — and it costs one float.
 */
export const SURGE_S = 1.1;
export const SURGE_GAIN = 2.2;
export const FLARE_S = 0.9;
export const FLARE_GAIN = 2.6;

/** A decaying 0→1, given when it started and how long it lasts. */
export function decay(startedMs: number | undefined, nowMs: number, seconds: number): number {
  if (startedMs === undefined) return 0;
  const t = (nowMs - startedMs) / 1000 / seconds;
  if (!(t >= 0) || t >= 1) return 0;
  // Fast attack, long tail: a pluck is an impulse, not a fade in and out.
  return (1 - t) ** 2;
}
