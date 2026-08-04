/**
 * The empty canvas's own light sources.
 *
 * **Why the empty canvas earns one and the labels do not.** `Graph.tsx` refuses
 * to draw the labels and ages switches while nothing is on screen, and that
 * refusal is right: those two annotate *marks*, so with no marks they are
 * controls a reader can throw and watch do nothing — the same failure the
 * control bar avoids by disabling fit, isolate and step on the same canvas.
 * Bioluminescence looked like a third member of that set and is not one. Its
 * subject is not a mark; its subject is **the water and what is lit in it**,
 * and something is on this canvas. The wordmark, the opening card and its row
 * of silhouettes are the whole of what a first-time reader can see, and in the
 * one state where there is no graph, *they are the thing on the canvas*. So the
 * rule is not relaxed here, it is applied: **the thing on the canvas is the
 * light source.** Draw a species and these go out; the tree is the only light
 * again, and nothing else ever competes with it.
 *
 * **Chrome does not emit, and that is the boundary.** Not the control bar, not
 * the mode panel that carries the switch, not the axis, not the palette, not
 * the keys column or the about link at the foot of the panel. Those are
 * furniture around the invitation, and a light behind every piece of furniture
 * is decoration sprayed round a room rather than an empty state that glows.
 * Three sources, and each is something the reader is being invited *into*:
 *
 *   wordmark   the app's name — one soft wide light, the app's own cyan
 *   card       the opening on show — broad, and the dimmest of the three,
 *              because it is the water the other two are standing in
 *   art        each silhouette on that card — the bright ones, each in a lane
 *              hue, because these are *animals* and animals are what glow here
 *
 * **The DOM is the contract, and it is read rather than declared.** These are
 * measured out of the live panel by selector: the panel is `App.tsx`'s and the
 * card is `OpeningCarousel.tsx`'s, neither knows this file exists, and adding a
 * `data-` attribute to each would be a second place for the truth to live and a
 * merge conflict every time the copy changes. What it costs is a failure that
 * is silent — a renamed class yields no boxes and the canvas is simply dark, as
 * it was before this existed — so {@link SOURCES} is pinned to both files by
 * `bootLight.test.ts`, which reads their source.
 *
 * The split below is what makes any of this testable at all: {@link measureBoot}
 * touches the DOM and decides nothing, {@link lightsFrom} decides everything and
 * touches no DOM. Every number worth arguing with is in the second one.
 */

import { useEffect, useRef, useState } from "react";
import { hashKey } from "./biolum";
import type { ScreenLight } from "./gl/renderer";
import { LANE_HUES, laneHue } from "../tree/layout";

/** Which of the three a measured element is. Decides its geometry and its power. */
export type LitKind = "wordmark" | "card" | "art";

/** One element that may emit, as measured. Client rect, CSS px. */
export interface LitBox {
  kind: LitKind;
  /**
   * Stable while the same thing is on screen, and different the moment it is
   * not. It is what {@link lightsFrom} keys the kindle on, so a key that
   * changed on every measurement would restart every light sixty times a
   * second, and one that never changed would let a rotated card inherit the
   * previous opening's glow.
   */
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What is read, and in what order.
 *
 * `first` for the two there is only ever one of. The wordmark is matched as a
 * child of `.boot-inner` rather than as a bare `h1` because the same panel
 * renders an unreachable-API message with its own heading, and that one is an
 * apology rather than an invitation.
 */
export const SOURCES: readonly { kind: LitKind; sel: string; first: boolean }[] = [
  { kind: "wordmark", sel: ".boot-inner > h1", first: true },
  { kind: "card", sel: ".carousel-card", first: true },
  { kind: "art", sel: ".carousel-art .silhouette", first: false },
];

/**
 * The panel, as boxes. Decides nothing.
 *
 * A zero-area element is dropped rather than lit: a silhouette that has not
 * finished fetching renders nothing at all, and a light at its collapsed
 * position would be a point of colour sitting beside the row it belongs to.
 */
export function measureBoot(root: ParentNode): LitBox[] {
  const boot = root.querySelector(".boot");
  if (!boot) return [];
  const out: LitBox[] = [];
  for (const src of SOURCES) {
    const found = src.first
      ? [boot.querySelector(src.sel)].filter((e): e is Element => e !== null)
      : [...boot.querySelectorAll(src.sel)];
    found.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return;
      out.push({
        kind: src.kind,
        key: `${src.kind}:${identify(el, i)}`,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        w: r.width,
        h: r.height,
      });
    });
  }
  return out;
}

/**
 * What to call a measured element.
 *
 * The `title` on a silhouette is the taxon's own label, which is exactly the
 * identity wanted: it survives a re-render, it changes when the carousel turns,
 * and it is what the hue is derived from below. The card falls back to its own
 * text, which is the question and the reveal — the opening's identity, said the
 * only way the DOM says it. Position is the last resort and is deliberately
 * last: keyed on index alone, a rotated card would hand its lights to the next
 * one and nothing would ever kindle.
 */
function identify(el: Element, i: number): string {
  const title = el.getAttribute("title");
  if (title) return title;
  const text = el.textContent?.replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 64);
  return String(i);
}

/**
 * How far each kind's light reaches past the thing it sits on, in CSS px.
 *
 * Added to the half-extent rather than multiplied, because the three differ in
 * size by a factor of ten and a multiplier gives the card a light the width of
 * the viewport while leaving a 30px silhouette with nothing. What a reader
 * should see is a *comparable* halo round each, which is a constant reach.
 */
const REACH: Record<LitKind, readonly [number, number]> = {
  // Wide and low. The first cut reached as far above the word as beside it and
  // drew a round cloud with the wordmark somewhere in it — light *near* the
  // name rather than light *off* it. Held to about the cap height, it reads as
  // the word itself glowing.
  wordmark: [62, 32],
  /*
    Far past the card, and the only one of the three that is not shaped like the
    thing it sits on. It is not drawing the card — the card is drawn, in HTML,
    on top of this — it is the *pool* the other two are standing in, and what a
    pool is for here is giving the marine snow somewhere to be visible over. Held
    to the card's own bounds the lit water was a strip about a fifth of the
    window wide, with the rest of the screen dead black; two hundred pixels of
    reach at a twentieth of the power is the same total light spread over most
    of the viewport, where it reads as depth rather than as a lamp.
  */
  card: [200, 130],
  art: [30, 30],
};

/**
 * What each is worth, before the breathing and the kindle.
 *
 * The ordering is the argument and the numbers only implement it: **the animals
 * are the brightest thing on the panel**, the wordmark is the second, and the
 * card is nearly nothing. The card's light is not there to be seen as a light
 * — it is there so the water immediately around the invitation has enough in it
 * for the marine snow to be visible, which is the effect this whole mode is
 * built to produce and which needs *some* irradiance to produce it against.
 *
 * They are far below a mark's 0.45–1.0 and have to be. A mark is fourteen
 * pixels across; these are sixty to six hundred, so the same number is two
 * orders of magnitude more light in the buffer, and at a mark's power the tone
 * map has the whole panel at white with a straight edge where the ellipse ends.
 */
const POWER: Record<LitKind, number> = {
  wordmark: 0.23,
  card: 0.055,
  art: 0.5,
};

/**
 * The app's own colour, for the two sources that are not an animal.
 *
 * `LANE_HUES[0]` rather than a literal 186: this is the same palette the tree
 * draws in, and a second spelling of one of its members is a number that drifts
 * the day somebody retunes the set. The silhouettes take {@link laneHue} of
 * their own name — the same tight cool set, keyed on the one identity the card
 * publishes. It is deliberately *not* the hue that taxon would carry on the
 * canvas: that one is keyed on `idx`, which is an OTT node index, and a card
 * holding a PhyloPic id and a label has never heard of it. Same palette, its
 * own draw.
 */
const BASE_HUE = LANE_HUES[0]!;

/**
 * Boxes to lights.
 *
 * `bornAt` comes in through a lookup rather than being computed here, because
 * *when a thing appeared* is a fact about the sequence of measurements and this
 * function sees one. Handing back `undefined` means "already on", which is what
 * a still frame wants and what a light whose element merely moved wants.
 */
export function lightsFrom(
  boxes: readonly LitBox[],
  bornAt: (key: string) => number | undefined = () => undefined,
): ScreenLight[] {
  return boxes.map((b) => {
    const reach = REACH[b.kind];
    return {
      x: b.x,
      y: b.y,
      rx: b.w / 2 + reach[0],
      ry: b.h / 2 + reach[1],
      hue: b.kind === "art" ? laneHue(hashKey(b.key)) : BASE_HUE,
      power: POWER[b.kind],
      // A fraction, and stable across measurements for the same thing: a seed
      // redrawn on every pass would reset that light's breathing every time
      // anything on the panel changed, and a reset reads as a flicker.
      seed: (hashKey(b.key) % 1024) / 1024,
      bornAt: bornAt(b.key),
    };
  });
}

/**
 * The live set, measured off the panel as it changes.
 *
 * **Nothing polls.** The panel is quiet — a card every seven and a half
 * seconds, a silhouette arriving from the mirror, a window resize — so what
 * this wants is to be told, and three observers between them cover every way
 * the picture can change:
 *
 *   - a `MutationObserver` on the body for `childList` alone, which catches the
 *     carousel's keyed swap, each silhouette's markup landing, and the panel
 *     itself mounting and unmounting. `attributes` is deliberately **not**
 *     watched: React Flow writes a transform on every frame of a pan, and this
 *     would then re-measure the whole panel sixty times a second to discover it
 *     had not moved
 *   - a `ResizeObserver` on the panel, for a card that changes height under a
 *     longer opening
 *   - `resize` on the window, because a panel that is centred moves without
 *     either of the above firing
 *
 * All three land in one `requestAnimationFrame`, so a burst of mutations costs
 * one measurement, and that measurement is compared before it is published:
 * `getBoundingClientRect` is cheap but a new array identity is not, since the
 * still frame downstream redraws on exactly that.
 */
export function useBootLights(active: boolean, reduced: boolean): readonly ScreenLight[] {
  const [lights, setLights] = useState<readonly ScreenLight[]>(NONE);
  /**
   * When each key was first seen. A ref rather than state: it is read inside
   * the measurement and never rendered, and putting it in state would make
   * every kindle a second render pass.
   */
  const born = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!active || typeof document === "undefined") {
      born.current.clear();
      setLights((prev) => (prev.length === 0 ? prev : NONE));
      return;
    }
    let raf = 0;
    let watched: Element | null = null;
    const ro = new ResizeObserver(() => schedule());
    const measure = () => {
      raf = 0;
      /*
        The panel comes and goes — a link resolving, the palette opening over it
        — so the size observer is re-pointed here rather than attached once. The
        first cut bound it in setup, which meant a panel that mounted after this
        effect ran was watched by nothing but the mutation observer, and a card
        that grew a line without gaining a child went unmeasured.
      */
      const boot = document.querySelector(".boot");
      if (boot !== watched) {
        ro.disconnect();
        watched = boot;
        if (boot) ro.observe(boot);
      }
      const boxes = measureBoot(document);
      const now = performance.now();
      const seen = new Set<string>();
      for (const b of boxes) {
        seen.add(b.key);
        if (!born.current.has(b.key)) born.current.set(b.key, now);
      }
      // A key that has left takes its birth with it, or a carousel returning to
      // an opening it has already shown would arrive at full brightness while
      // its neighbours kindled.
      for (const k of [...born.current.keys()]) if (!seen.has(k)) born.current.delete(k);
      /*
        Under `prefers-reduced-motion` there is no kindle at all, and it has to
        be dropped here rather than clamped downstream. The still frame redraws
        only when something changes, so a ramp would be sampled once and left
        frozen at whatever fraction that draw caught.
      */
      const next = lightsFrom(boxes, (k) => (reduced ? undefined : born.current.get(k)));
      setLights((prev) => (sameLights(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(measure);
    };

    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    measure();

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [active, reduced]);

  return lights;
}

/** One frozen empty array, so "no lights" is never a new identity. */
const NONE: readonly ScreenLight[] = Object.freeze([]);

/** Whether two published sets are the same picture, field for field. */
export function sameLights(a: readonly ScreenLight[], b: readonly ScreenLight[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (
      p.x !== q.x ||
      p.y !== q.y ||
      p.rx !== q.rx ||
      p.ry !== q.ry ||
      p.hue !== q.hue ||
      p.power !== q.power ||
      p.seed !== q.seed ||
      p.bornAt !== q.bornAt
    ) {
      return false;
    }
  }
  return true;
}
