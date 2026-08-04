/**
 * The empty canvas's light: the geometry, and the contract it reads it through.
 *
 * Two halves, and they fail in completely different ways.
 *
 * {@link lightsFrom} is arithmetic and its failures are visible — a light in
 * the wrong place, or so bright the panel is a white blob. Those get argued
 * about here rather than in a shader, on `tuning.ts`'s standing rule.
 *
 * {@link SOURCES} is the half that fails *silently*. It is a list of CSS
 * selectors resolved against markup three other files own, none of which knows
 * this one exists; rename `.carousel-art` and nothing throws, no test that
 * looks only at this module notices, and what a reader gets is the canvas
 * exactly as dark as it was before the feature was written. So the selectors
 * are matched against those files as text. It is a coarse check and it is the
 * only one available in a runner with no DOM — what it can prove is that every
 * class this file asks for is a class somebody still writes.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SOURCES, lightsFrom, sameLights, type LitBox } from "./bootLight";
import { LANE_HUES } from "../tree/layout";
import { kindle, SCREEN_KINDLE_S } from "./gl/tuning";

const APP = import.meta.glob<string>("../App.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
})["../App.tsx"]!;
const CAROUSEL = import.meta.glob<string>("../chrome/OpeningCarousel.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
})["../chrome/OpeningCarousel.tsx"]!;
/**
 * Three files, not two: `.silhouette` is written by the component the card
 * renders rather than by the card. That is exactly the seam this check is for
 * — the selector spans two authors and neither of them can see the other's
 * half.
 */
const SILHOUETTE = import.meta.glob<string>("./Silhouette.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
})["./Silhouette.tsx"]!;
const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

const box = (kind: LitBox["kind"], over: Partial<LitBox> = {}): LitBox => ({
  kind,
  key: `${kind}:x`,
  x: 400,
  y: 300,
  w: 40,
  h: 40,
  ...over,
});

describe("the DOM contract", () => {
  it("is reading all three files at all", () => {
    // Every check below is a search for a substring, so all of them pass for
    // free on an empty string — a moved file or a changed glob option would
    // leave this whole describe measuring nothing.
    expect(APP.length).toBeGreaterThan(1000);
    expect(CAROUSEL.length).toBeGreaterThan(1000);
    expect(SILHOUETTE.length).toBeGreaterThan(1000);
  });

  /**
   * Every class named in a selector is a class one of those files applies.
   *
   * Matched against `className="…"` rather than against the bare word, because
   * a class name that only ever appears in prose is exactly the failure mode:
   * `.carousel-art` is discussed in three comments in this repo and applied in
   * one place, and the discussion would keep this test green after the
   * application had gone.
   */
  it("names only classes those files still apply", () => {
    const applied = new Set<string>();
    for (const src of [APP, CAROUSEL, SILHOUETTE]) {
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        for (const tok of (m[1] ?? m[2] ?? "").split(/[\s${}]+/)) {
          if (/^[a-z][\w-]*$/.test(tok)) applied.add(tok);
        }
      }
    }
    // The panel itself, which `measureBoot` scopes everything else to.
    expect(applied.has("boot")).toBe(true);
    for (const src of SOURCES) {
      for (const cls of src.sel.match(/(?<=\.)[\w-]+/g) ?? []) {
        expect(applied.has(cls), `${src.sel} names .${cls}, which nothing applies`).toBe(
          true,
        );
      }
    }
  });

  /**
   * The two things the selectors reach for that are not classes.
   *
   * `.boot-inner > h1` is the wordmark and the child combinator is deliberate —
   * the same panel renders an unreachable-API heading, which is an apology
   * rather than an invitation and must not glow. `.carousel-art .silhouette` is
   * every animal on the card, and `Silhouette` is what puts that class on.
   */
  it("reaches a wordmark and a row of silhouettes", () => {
    expect(APP).toMatch(/<h1>/);
    expect(CAROUSEL).toContain("<Silhouette");
    expect(CAROUSEL).toContain('className="carousel-art"');
  });

  /**
   * A silhouette carries the taxon's label, which is the identity everything
   * downstream keys on: the kindle, and the hue.
   */
  it("gives each silhouette a title to be identified by", () => {
    expect(CAROUSEL).toMatch(/<Silhouette[^>]*title=\{/);
  });

  /**
   * **The card has to be glass in this mode, or none of the above is visible.**
   *
   * The brightest lights here sit behind the silhouettes printed on the opening
   * card, and the card is drawn in HTML on top of the water canvas. At
   * `var(--void-2)` it is opaque: every one of those lights is still computed,
   * still blurred into the vicinity field, still lighting the snow *outside*
   * the card's footprint — and hidden behind a rectangle for the whole of its
   * own extent. That failure is a stylesheet declaration two thousand lines
   * away from anything else this feature touches, and it looks exactly like the
   * lights never having been written.
   */
  it("makes the opening card translucent in this mode", () => {
    const rule = CSS.match(/body\.biolum \.carousel-card \{([^}]*)\}/);
    expect(rule, "body.biolum .carousel-card lost its rule").not.toBeNull();
    const alpha = rule![1]!.match(/background:[^;]*\/\s*([0-9.]+)\s*\)/);
    expect(alpha, "the card's biolum background carries no alpha").not.toBeNull();
    expect(Number(alpha![1])).toBeLessThan(1);
  });
});

describe("boxes become lights", () => {
  it("puts the light on the thing it belongs to", () => {
    const [l] = lightsFrom([box("art", { x: 120, y: 80 })]);
    expect(l!.x).toBe(120);
    expect(l!.y).toBe(80);
  });

  /**
   * Reach is added, not multiplied, and that is the whole reason it is a
   * constant per kind. The card is an order of magnitude wider than a
   * silhouette; a multiplier gives one of them a light the width of the window
   * and the other nothing.
   */
  it("gives a wide thing and a small one comparable haloes", () => {
    const [art] = lightsFrom([box("art", { w: 30, h: 30 })]);
    const [word] = lightsFrom([box("wordmark", { w: 110, h: 18 })]);
    expect(art!.rx - 15).toBe(art!.ry - 15);
    // The wordmark's own reach is wide and low: light off the word, not a
    // circular cloud with the word somewhere in it.
    expect(word!.rx - 55).toBeGreaterThan(word!.ry - 9);
  });

  /**
   * The pool is not shaped like the card, and it is the one that is not.
   * Its job is to give the marine snow somewhere to be visible over, so it has
   * to be much larger than its element and much dimmer than anything else.
   */
  it("spreads the card far past the card and keeps it the faintest", () => {
    const [card] = lightsFrom([box("card", { w: 400, h: 184 })]);
    const [art] = lightsFrom([box("art")]);
    const [word] = lightsFrom([box("wordmark")]);
    expect(card!.rx).toBeGreaterThan(300);
    expect(card!.power).toBeLessThan(word!.power);
    expect(word!.power).toBeLessThan(art!.power);
  });

  /**
   * **Nothing here is worth what a chosen species is worth.** A mark is about
   * fourteen pixels across at unit zoom; these are sixty to six hundred, so the
   * same number is orders of magnitude more light in the same HDR buffer, and
   * the tone map hands back a white panel with a straight edge where the
   * ellipse ends. The bound is deliberately loose — what it guards against is
   * somebody reaching for a leaf's 0.8 or an MRCA's 1.0 because that is what an
   * emitter's power looks like everywhere else in this directory.
   */
  it("keeps every power below a drawn species'", () => {
    const all = lightsFrom([box("wordmark"), box("card"), box("art")]);
    for (const l of all) expect(l.power).toBeLessThan(0.6);
  });

  /**
   * The app's own colour for the two that are not an animal, and the *palette*
   * — not a hue guessed twice — for the ones that are.
   */
  it("lights the chrome in the app's colour and the animals in lane hues", () => {
    const [word] = lightsFrom([box("wordmark")]);
    const [card] = lightsFrom([box("card")]);
    expect(word!.hue).toBe(LANE_HUES[0]);
    expect(card!.hue).toBe(LANE_HUES[0]);
    for (const name of ["Human", "Blue whale", "Hippopotamus", "Ginkgo", "Bat"]) {
      const [art] = lightsFrom([box("art", { key: `art:${name}` })]);
      expect(LANE_HUES, `${name} drew a hue outside the palette`).toContain(art!.hue);
    }
  });

  /**
   * Same card, same picture. Everything derived from a key has to survive a
   * re-measurement, because the panel is re-measured on every mutation the
   * observers see: a hue or a breathing phase redrawn from fresh randomness
   * would make the row flicker whenever a silhouette finished loading.
   */
  it("derives the same hue and phase from the same name every time", () => {
    const a = lightsFrom([box("art", { key: "art:Hippopotamus" })])[0]!;
    const b = lightsFrom([box("art", { key: "art:Hippopotamus" })])[0]!;
    expect(a.hue).toBe(b.hue);
    expect(a.seed).toBe(b.seed);
    expect(a.seed).toBeGreaterThanOrEqual(0);
    expect(a.seed).toBeLessThan(1);
  });

  /** Different animals breathe on different clocks, or the row is a pulse. */
  it("gives neighbouring animals different phases", () => {
    const row = ["Bat", "Moose", "Mouse", "Hyena"].map(
      (n) => lightsFrom([box("art", { key: `art:${n}` })])[0]!.seed,
    );
    expect(new Set(row).size).toBe(row.length);
  });

  /**
   * `bornAt` is a lookup and not a computation, because *when a thing appeared*
   * is a fact about the sequence of measurements and `lightsFrom` sees one.
   */
  it("takes each light's birth from the caller, and none by default", () => {
    const born = new Map([["art:Bat", 1234]]);
    const [bat, moose] = lightsFrom(
      [box("art", { key: "art:Bat" }), box("art", { key: "art:Moose" })],
      (k) => born.get(k),
    );
    expect(bat!.bornAt).toBe(1234);
    expect(moose!.bornAt).toBeUndefined();
    expect(lightsFrom([box("art")])[0]!.bornAt).toBeUndefined();
  });
});

/**
 * The still frame downstream redraws on a *change of identity*, so this is what
 * stands between `prefers-reduced-motion` and an animation driven by a carousel
 * measuring itself sixty times a second.
 */
describe("two measurements are the same picture", () => {
  const one = () => lightsFrom([box("art", { key: "art:Bat" })], () => 7);

  it("says so when nothing moved", () => {
    expect(sameLights(one(), one())).toBe(true);
  });

  it("says otherwise when anything at all did", () => {
    expect(sameLights(one(), [])).toBe(false);
    expect(sameLights(one(), lightsFrom([box("art", { key: "art:Bat" })]))).toBe(false);
    expect(
      sameLights(one(), lightsFrom([box("art", { key: "art:Bat", x: 401 })], () => 7)),
    ).toBe(false);
    expect(sameLights(one(), lightsFrom([box("card", { key: "art:Bat" })], () => 7))).toBe(
      false,
    );
  });
});

/**
 * The kindle, and the one clause that is not obvious.
 *
 * **Undefined is full, not zero.** A light with no birth recorded is one that
 * was already there — every light on a still frame, and every light whose
 * element merely moved — and starting those dark puts the reduced-motion canvas
 * at zero brightness for the rest of the session.
 */
describe("a light that has just arrived", () => {
  it("is already on when it never announced a birth", () => {
    expect(kindle(undefined, 0)).toBe(1);
    expect(kindle(undefined, 1e9)).toBe(1);
  });

  it("comes up over its own second and then stays", () => {
    expect(kindle(1000, 1000)).toBe(0);
    expect(kindle(1000, 1000 + SCREEN_KINDLE_S * 500)).toBeGreaterThan(0.5);
    expect(kindle(1000, 1000 + SCREEN_KINDLE_S * 1000)).toBe(1);
    expect(kindle(1000, 1e9)).toBe(1);
  });

  /** A clock that ran backwards is a light off, never a light past full. */
  it("is never outside 0..1", () => {
    for (const t of [-1e6, 0, 1, 500, 1049, 1050, 1e6]) {
      const k = kindle(1000, 1000 + t);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(1);
    }
  });
});
