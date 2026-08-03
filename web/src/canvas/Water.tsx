/**
 * The canvas the spilled light drifts in.
 *
 * It has no content of its own — no gradient, no texture, no ambient anything.
 * It is a transparent additive layer holding {@link Field}'s particles, every
 * one of which was shed by a mark or by a plucked branch. With nothing on the
 * tree it draws nothing at all, which is the property that keeps this mode
 * honest about where the light comes from.
 *
 * Behind React Flow rather than over it, so the tree is always the brightest
 * thing and a mote never sits in front of a name. Additive compositing, so
 * overlapping particles genuinely sum — which is what a suspension of scattering
 * flecks does, and is why this is a canvas and not six hundred DOM nodes.
 *
 * Three refusals:
 *
 *   - **The loop stops when nothing can see it.** Hidden tab, mode off, or an
 *     empty field. It does not idle at sixty frames a second over black.
 *   - **`prefers-reduced-motion` gets a still field**, not an empty one. The
 *     particles are the setting; removing them removes the setting rather than
 *     removing motion from it. They are drawn once, from a single seeded burst,
 *     and never move.
 *   - **Device pixel ratio is capped.** Every pixel here is a soft radial with
 *     no edge in it, so a retina buffer costs 78% more fill for a difference
 *     nobody can point at.
 */

import { useEffect, useRef } from "react";
import { onSpill, type Emitter } from "./biolum";
import { alphaOf, Field, LIFE_MAX } from "./particles";
import { flowSources, tracerXY } from "./flow";

const MAX_DPR = 1.5;
/** Sprite tints are bucketed; `laneHue` only ever returns seven values anyway. */
const HUE_BUCKET = 8;
/**
 * Screen px, floor on the *halo* radius.
 *
 * Not a cosmetic minimum: the bright core is a fixed fraction of whatever this
 * ends up being, so a halo allowed to shrink takes its own pinpoint below one
 * pixel and the particle stops being drawn at all. Pulled right back, the water
 * thins because the tree is small, not because its light stopped rendering.
 */
const MIN_SCREEN_R = 5;

/**
 * Two light profiles, and the difference is not decoration.
 *
 * `mote` is scattered fallout — a hard pinpoint inside a wide faint halo, which
 * is what a fleck catching light in open water looks like. `spark` is a *source*:
 * the reaction itself, seen through the glass of a tube, so it carries a much
 * larger bright centre.
 *
 * They cannot share one profile, and the reason is the downscale. A mote's core
 * is 7% of its radius, which is right at the sprite's own 128px and right on
 * screen where a mote is drawn 8–22px across. A tracer inside a branch is drawn
 * at the floor, ~10px, so 7% is a third of a pixel — the core is averaged away
 * and all that survives is the faint halo. Measured, that left every branch's
 * stream present in the buffer and invisible on screen, which is the same
 * failure the water's own particles had at their first numbers.
 */
export type Glow = "mote" | "spark";

const spriteCache = new Map<string, HTMLCanvasElement>();

/**
 * One soft light, pre-rendered per hue and blitted.
 *
 * A hot near-white core inside a coloured falloff. That two-part shape is what
 * makes a fleck read as *scattering* rather than as a coloured dot: real
 * biological light is white where it is dense enough to saturate and takes its
 * colour in the halo.
 */
function sprite(hue: number, kind: Glow = "mote"): HTMLCanvasElement {
  const key = `${kind}:${hue}`;
  const hit = spriteCache.get(key);
  if (hit) return hit;
  // 128 and not 48, and the reason is the core below. At a tenth of the radius
  // a 48px sprite gives the point 2.4 source pixels to be drawn in, which is
  // already mush before the downscale to screen touches it. Seven of these
  // exist — `laneHue` returns seven values — so the whole cache is 448 KB of
  // texture, once, for the life of the page.
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    /*
      A pinpoint, and the light it puts into the water.

      The two are one gradient but they are doing separate jobs, and the ratio
      between them is the whole look. The first tenth of the radius is the
      *source* — near-white, effectively opaque, and small enough on screen to
      read as a point rather than as a dot. Everything past it is what that
      point is throwing into the water: an order of magnitude fainter, and
      reaching most of the way out, so a particle is a hard spark inside a soft
      volume rather than a blob with a bright middle.

      A wider core was the previous shape, and it was wrong for the same reason
      a wide bloom on the branches was wrong: it turned every point into an
      area, and an area has no position. The floor on the halo radius in
      `MIN_SCREEN_R` is what keeps this ratio affordable — shrink the halo and
      the core goes subpixel with it.
    */
    if (kind === "spark") {
      grad.addColorStop(0, `hsl(${hue} 100% 97% / 1)`);
      grad.addColorStop(0.15, `hsl(${hue} 100% 90% / 0.92)`);
      grad.addColorStop(0.28, `hsl(${hue} 100% 76% / 0.4)`);
      grad.addColorStop(0.52, `hsl(${hue} 100% 66% / 0.12)`);
      grad.addColorStop(1, `hsl(${hue} 100% 60% / 0)`);
    } else {
      grad.addColorStop(0, `hsl(${hue} 100% 96% / 1)`);
      grad.addColorStop(0.07, `hsl(${hue} 100% 88% / 0.95)`);
      grad.addColorStop(0.11, `hsl(${hue} 100% 74% / 0.34)`);
      grad.addColorStop(0.22, `hsl(${hue} 100% 64% / 0.1)`);
      grad.addColorStop(0.5, `hsl(${hue} 100% 58% / 0.028)`);
      grad.addColorStop(1, `hsl(${hue} 100% 55% / 0)`);
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  spriteCache.set(key, c);
  return c;
}

export interface WaterProps {
  /** Live viewport transform: particles live in layout space. */
  tx: number;
  ty: number;
  zoom: number;
  /** The marks currently leaking light. Rebuilt by the layout pass. */
  emitters: readonly Emitter[];
  active: boolean;
  reduced: boolean;
}

export function Water({ tx, ty, zoom, emitters, active, reduced }: WaterProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  /*
    The transform and the emitter list are read from refs inside the loop rather
    than closed over. Both change constantly — the transform on every frame of a
    drag, the emitters on every layout pass — and closing over them would tear
    the animation down and rebuild it that often, which is both a stutter and a
    field that resets to empty mid-gesture.
  */
  const view = useRef({ tx, ty, zoom });
  view.current = { tx, ty, zoom };
  const emit = useRef(emitters);
  emit.current = emitters;

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !active) return;
    const ctx = cv.getContext("2d", { alpha: true });
    if (!ctx) return;

    const field = new Field();
    let w = 0;
    let h = 0;
    let raf = 0;
    let last = performance.now();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    const resize = () => {
      const rect = cv.getBoundingClientRect();
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    // Reused across every tracer on every frame, so projecting a thousand of
    // them allocates nothing.
    const at = { x: 0, y: 0 };

    /**
     * The streams inside the branches.
     *
     * On this canvas rather than in each edge's SVG, and that is what makes the
     * tubes read as *lit from inside*: the wall is a mostly transparent stroke
     * over the top, so what a reader sees through it is this layer, summed.
     * Where tracers bunch the tube brightens; where the stream has strung out
     * it goes almost dark. A per-edge renderer could not do that — it would
     * have nothing to sum against.
     */
    const drawStreams = (px: number, py: number, z: number) => {
      for (const src of flowSources()) {
        if (src.pts.length < 2) continue;
        const spr = sprite(Math.round(src.hue / HUE_BUCKET) * HUE_BUCKET, "spark");
        for (const p of src.flow.tracers) {
          const a = src.flow.alphaOf(p) * src.gain;
          if (a <= 0.005) continue;
          tracerXY(src, p, at);
          const sx = at.x * z + px;
          const sy = at.y * z + py;
          const box = Math.max(MIN_SCREEN_R * 2, p.r * z * 2);
          if (sx < -box || sy < -box || sx > w + box || sy > h + box) continue;
          ctx.globalAlpha = Math.min(1, a);
          ctx.drawImage(spr, sx - box / 2, sy - box / 2, box, box);
        }
      }
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      const { tx: px, ty: py, zoom: z } = view.current;
      drawStreams(px, py, z);
      for (const p of field.particles) {
        const a = alphaOf(p);
        if (a <= 0.005) continue;
        const sx = p.x * z + px;
        const sy = p.y * z + py;
        // A particle scaled with the tree would vanish when the reader pulls
        // back, taking the water with it. The floor keeps the volume present at
        // any zoom while the *positions* still travel with the branches.
        const box = Math.max(MIN_SCREEN_R * 2, p.r * z * 2);
        if (sx < -box || sy < -box || sx > w + box || sy > h + box) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(
          sprite(Math.round(p.hue / HUE_BUCKET) * HUE_BUCKET),
          sx - box / 2,
          sy - box / 2,
          box,
          box,
        );
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };

    const unsubscribe = onSpill((s) => {
      if (reduced) return;
      field.emit(s);
    });

    if (reduced) {
      // A still field, run out to the same steady state and then stopped.
      // Enough light in the water to say what the mode is, and none of it
      // moving. Deferred rather than run here for the same reason the live
      // priming is: on a cold load the marks have not arrived yet.
      let drawn = false;
      const settle = () => {
        if (drawn || emit.current.length === 0) return;
        const step = 1 / 8;
        const steps = Math.ceil(LIFE_MAX * 1.15 * 8);
        for (let i = 0; i < steps; i++) {
          field.trickle(emit.current, step);
          field.step(step);
        }
        // The streams prime themselves on registration, so they already hold a
        // plausible still frame; nothing here has to advance them.
        draw();
        drawn = true;
      };
      const poll = window.setInterval(settle, 250);
      const onResize = () => {
        resize();
        draw();
      };
      window.addEventListener("resize", onResize);
      return () => {
        window.clearInterval(poll);
        unsubscribe();
        window.removeEventListener("resize", onResize);
      };
    }

    /**
     * Fast-forward the water to a steady state before the first frame is shown.
     *
     * Without it, switching the mode on gives a black volume that takes the
     * best part of a particle lifetime to fill — so the effect a reader just
     * asked for arrives, invisibly, about ten seconds after they asked. Priming
     * runs the same simulation at a coarse step until the field is as full as it
     * is ever going to be, and costs a few hundred iterations over an array that
     * tops out in the hundreds.
     *
     * Lazily, on the first tick that has emitters, and not at mount. On a cold
     * load carrying `bio=1` the paths are still in flight when this effect
     * runs, so there is nothing on the canvas to have spilled anything yet —
     * priming then would prime an empty tree and the flag would say it was
     * done.
     */
    let primed = false;
    const prime = () => {
      // Long enough to cover a full lifetime, or the field arrives half full
      // and goes on filling for the next half minute in front of the reader.
      // Coarse steps: this is a fast-forward, not a simulation anybody sees.
      const step = 1 / 8;
      const steps = Math.ceil(LIFE_MAX * 1.15 * 8);
      for (let i = 0; i < steps; i++) {
        field.trickle(emit.current, step);
        field.step(step);
      }
      primed = true;
    };

    const tick = (now: number) => {
      // Clamped, so returning to a backgrounded tab integrates one plausible
      // frame rather than a minute of drift in a single step.
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      if (!primed && emit.current.length > 0) prime();
      field.trickle(emit.current, dt);
      field.step(dt);
      // One loop for everything suspended in the water, the branches' own
      // streams included. Eighteen edges each running their own would be
      // eighteen callbacks a frame to advance eighteen tiny solvers.
      for (const src of flowSources()) src.flow.step(dt);
      draw();
      raf = window.requestAnimationFrame(tick);
    };
    const start = () => {
      if (!raf) {
        last = performance.now();
        raf = window.requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    };

    const onVisibility = () => (document.hidden ? stop() : start());
    const onResize = () => resize();
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    start();

    return () => {
      stop();
      unsubscribe();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, reduced]);

  if (!active) return null;
  return <canvas className="water" ref={ref} aria-hidden="true" />;
}
