/**
 * The water, and the one canvas everything luminous in this mode is drawn on.
 *
 * Behind React Flow rather than over it, so the tree's names are always in
 * front and a flake never sits on top of a word. It paints no background of its
 * own beyond the deep water itself: everything visible on it came from
 * something that is *on the canvas*, and nothing in the background emits.
 *
 * This header used to end that sentence differently — *with nothing on the
 * canvas there is nothing lit, because the only things that emit here are the
 * branches and the marks* — and that was a claim about the graph being read as
 * a claim about the canvas. The empty canvas is not blank. It carries the
 * wordmark, an opening and a row of silhouettes, and those are what is on the
 * canvas in the one state where there is no graph, so they emit too. The rule
 * is unchanged and is now stated in its general form: **the thing on the canvas
 * is the light source.** `bootLight.ts` is the list, and the reason the labels
 * and ages switches still have no business on an empty canvas while this one
 * does.
 *
 * **The snow emits nothing at all.** That is the change this mode is built
 * around and it is worth being exact about: the old field's particles left a
 * node and went on shining on their own, drifting away, which is what made the
 * canvas read as sparkly and which was a second light source in all but name.
 * Marine snow is only ever *lit*. It is barely visible over most of the
 * viewport, and where it drifts near a river it catches that river's light,
 * twinkles with it, and takes more of its hue the more of it is nearby. Turn a
 * branch off and the snow beside that branch goes dark.
 *
 * Three refusals:
 *
 *   - **The loop stops when nothing can see it.** Hidden tab or mode off. It
 *     does not idle at sixty frames a second over black.
 *   - **`prefers-reduced-motion` gets a still frame**, not an empty one. The
 *     light is the setting; removing it removes the setting rather than
 *     removing motion from it. The clock is simply held.
 *   - **No WebGL2, no mode.** `BiolumRenderer.supported()` is asked before
 *     anything mounts, and `Graph.tsx` hides the switch rather than offering
 *     one that turns the canvas black.
 */

import { useEffect, useRef } from "react";
import type { Emitter } from "./biolum";
import { flowGeneration, flowSources, surgeOf } from "./flow";
import {
  BiolumRenderer,
  type MarkLight,
  type ScreenLight,
} from "./gl/renderer";

interface WaterProps {
  /** Live viewport transform: the tree's light lives in layout space. */
  tx: number;
  ty: number;
  zoom: number;
  /** The marks currently leaking light. Rebuilt by the layout pass. */
  emitters: readonly Emitter[];
  /**
   * The empty state's lights, in **viewport** CSS px — see `bootLight.ts`.
   *
   * Empty whenever a tree is drawn, which is what keeps the tree the only light
   * source in every state that has one. They are measured against the window,
   * so this component subtracts its own canvas origin below rather than asking
   * the measurement to know where the canvas is.
   */
  lights: readonly ScreenLight[];
  active: boolean;
  reduced: boolean;
}

export function Water({
  tx,
  ty,
  zoom,
  emitters,
  lights,
  active,
  reduced,
}: WaterProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  /*
    The transform and the emitter list are read from refs inside the loop rather
    than closed over. Both change constantly — the transform on every frame of a
    drag, the emitters on every layout pass — and closing over them would tear
    the animation down and rebuild it that often, which is a stutter and a
    renderer that reallocates its buffers mid-gesture.
  */
  const view = useRef({ tx, ty, zoom });
  view.current = { tx, ty, zoom };
  const emit = useRef(emitters);
  emit.current = emitters;
  const lit = useRef(lights);
  lit.current = lights;

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !active) return;

    let renderer: BiolumRenderer;
    try {
      renderer = new BiolumRenderer(cv);
    } catch (err) {
      /*
        A swallowed failure here is an empty canvas and nothing else — no
        error, no fallback, no clue. Every way this throws is a *build* fault
        rather than a runtime one (a shader that does not compile, a uniform
        renamed on one side only), so it will be the same on every machine and
        it needs to be loud the first time somebody sees it.
      */
      console.error("bioluminescence: renderer failed to start", err);
      return;
    }

    let raf = 0;
    let seen = -1;
    let clock = 0;
    let last = performance.now();

    /*
      Where this canvas sits in the window.

      It was zero for this file's whole life — `.canvas` was `position: fixed;
      inset: 0` — and it was read anyway, because the empty state's lights are
      measured with `getBoundingClientRect`, which is viewport-relative, and a
      renderer that assumed the two origins coincide would be wrong silently
      "and only on the day somebody insets the canvas".

      **That day arrived.** The canvas is `left: var(--sidebar-w)`, so this is
      the panel's width whenever the panel is open, and every light measured off
      a DOM element has to be brought back into canvas space through it. What
      the note did not anticipate is the *other* half of the same change — the
      element resizing without the window resizing — which is the `ResizeObserver`
      below, and which is what actually broke.
    */
    let originX = 0;
    let originY = 0;

    const resize = () => {
      const r = cv.getBoundingClientRect();
      originX = r.left;
      originY = r.top;
      renderer.resize(Math.max(1, r.width), Math.max(1, r.height));
    };
    resize();

    const marks: MarkLight[] = [];
    const syncMarks = () => {
      marks.length = 0;
      for (const e of emit.current) {
        marks.push({
          x: e.x,
          y: e.y,
          hue: e.hue,
          power: e.power,
          flareAt: e.flareAt?.(),
        });
      }
    };

    const screen: ScreenLight[] = [];
    const syncScreen = () => {
      screen.length = 0;
      for (const l of lit.current)
        screen.push({ ...l, x: l.x - originX, y: l.y - originY });
    };

    const draw = () => {
      // The branch set is rebuilt by the layout, not by the frame. Adopting it
      // only when it actually changed is what keeps the glass geometry and the
      // centreline texture off the per-frame path.
      const gen = flowGeneration();
      if (gen !== seen) {
        seen = gen;
        renderer.setBranches(
          flowSources().map((s) => ({ ...s, surgeAt: () => surgeOf(s.id) })),
        );
      }
      syncMarks();
      syncScreen();
      renderer.frame(clock, performance.now(), view.current, marks, screen);
    };

    const tick = (now: number) => {
      // Clamped, so returning to a backgrounded tab advances one plausible
      // frame rather than a minute of river in a single step.
      clock += Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      draw();
      raf = window.requestAnimationFrame(tick);
    };

    const onLost = (e: Event) => {
      e.preventDefault();
      renderer.onContextLost();
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    };
    cv.addEventListener("webglcontextlost", onLost);

    const start = () => {
      // A lost context never comes back, and a loop over a dead renderer is
      // sixty wake-ups a second to return immediately.
      if (!raf && !reduced && !renderer.isLost) {
        last = performance.now();
        raf = window.requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onResize = () => {
      resize();
      if (reduced) draw();
    };
    /*
      **The canvas resizes without the window resizing**, and until the sidebar
      arrived it never did — `.canvas` was `position: fixed; inset: 0`, so its
      box and the window's changed together and a `resize` listener caught
      everything.

      It is `left: var(--sidebar-w)` now. Toggling the panel changes this
      element's width and its origin, the window is untouched, and the drawing
      buffer keeps whatever size it was given last: measured, a 1020px canvas
      still holding a 756px buffer, stretched over it by CSS. Every river was
      drawn a fifth of a screen to the right of the branch it belongs to.
      Nothing errors and the mode looks broken.

      A `ResizeObserver` on the element is the honest signal — it is the
      element's own box that this needs, not the window's — and it fires on
      every frame of the panel's transition, so the buffer tracks the slide
      rather than snapping at the end of it. The window listener stays beside
      it: the observer reports a *size*, and `resize()` also reads the origin,
      which a window change can move without the size changing.
    */
    const ro = new ResizeObserver(onResize);
    ro.observe(cv);
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);

    if (reduced) {
      /*
        A still frame, redrawn whenever the *canvas* changes but never
        because time passed.

        `prefers-reduced-motion` asks for no motion. It does not ask for a
        picture of a tree that is no longer on screen — and the first version
        of this drew once, latched, and then showed the previous selection's
        rivers for the rest of the session, because everything it reads arrives
        through refs and none of it re-enters the effect. Adding a species left
        its branch unlit; removing one left a river hanging in the water. Only
        resizing the window recovered it.

        So the poll never stops. It compares the three things that can change
        what should be drawn — which branches are registered, which marks are
        emitting, and what the empty state has put in the water — and redraws on
        a change and on nothing else. The clock never advances, so the picture is
        identical each time: still, and current.

        The third of those is why `bootLight.ts` publishes a *stable identity*
        when nothing has moved: a fresh array every measurement would make this
        comparison always false and turn the still frame back into an animation
        driven by a carousel.

        It also has to be a *retry* rather than a single draw, because on a cold
        load carrying the mode on the paths are still in flight when this effect
        runs and there is nothing registered yet. The clock is held at a figure
        that puts the rivers mid-branch rather than at zero, where every branch
        would be empty at its descendant end — and which also settles the
        empty state's breathing somewhere other than the bottom of its stroke.
      */
      clock = 7.3;
      let lastGen = -1;
      let lastMarks: readonly Emitter[] | null = null;
      let lastLights: readonly ScreenLight[] | null = null;
      const settle = () => {
        const gen = flowGeneration();
        if (
          gen === lastGen &&
          emit.current === lastMarks &&
          lit.current === lastLights
        )
          return;
        if (
          flowSources().length === 0 &&
          emit.current.length === 0 &&
          lit.current.length === 0
        ) {
          return;
        }
        lastGen = gen;
        lastMarks = emit.current;
        lastLights = lit.current;
        draw();
      };
      const poll = window.setInterval(settle, 250);
      settle();
      return () => {
        window.clearInterval(poll);
        ro.disconnect();
        window.removeEventListener("resize", onResize);
        document.removeEventListener("visibilitychange", onVisibility);
        cv.removeEventListener("webglcontextlost", onLost);
        renderer.dispose();
      };
    }

    start();
    return () => {
      stop();
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      cv.removeEventListener("webglcontextlost", onLost);
      renderer.dispose();
    };
  }, [active, reduced]);

  if (!active) return null;
  return <canvas className="water" ref={ref} aria-hidden="true" />;
}
