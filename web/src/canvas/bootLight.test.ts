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
 * exactly as dark as it was before the feature was written.
 *
 * **That half has moved to `App.test.tsx`**, which renders the empty canvas and
 * runs every one of these selectors against the document. It used to be here,
 * matching the class names against `className=` attributes in four files as
 * text — a check that cannot tell a class that is applied from one that is
 * discussed in a comment, could not see a selector's *shape* at all, and was
 * the only one available in a runner with no DOM. There is a DOM now.
 *
 * What is left here is the arithmetic, and the one stylesheet declaration two
 * thousand lines from anything else this feature touches.
 */

import { describe, expect, it } from "vitest";
import { decl } from "../test/css";
import { SOURCES, lightsFrom, sameLights, type LitBox } from "./bootLight";
import { LANE_HUES } from "../tree/layout";
import { kindle, SCREEN_KINDLE_S } from "./gl/tuning";

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
  /**
   * The list is non-empty and every entry is well formed.
   *
   * Whether each selector *matches something* is `App.test.tsx`'s, which has a
   * rendered empty canvas to run them against — and `Controls.test.tsx` holds
   * the one that used to be hardest to see from here, that `is-command` goes on
   * the palette's button and not on the whole lead slot. What is left is the
   * shape: a `SOURCES` that quietly emptied, or an entry scoped to a panel that
   * is not the one it names, would leave that test iterating over nothing and
   * passing.
   */
  it("names four sources, two of them inside the panel", () => {
    expect(SOURCES).toHaveLength(4);
    expect(SOURCES.filter((s) => s.scope === "boot")).toHaveLength(2);
    for (const s of SOURCES) {
      expect(
        s.sel.trim(),
        "an empty selector matches the whole document",
      ).not.toBe("");
      // Every one is anchored on a class. `.boot-inner > h1` is the wordmark and
      // the combinator is deliberate: the same panel renders an unreachable-API
      // heading, which is an apology rather than an invitation and must not glow.
      expect(s.sel.startsWith("."), `${s.sel} is not anchored on a class`).toBe(
        true,
      );
    }
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
    const background = decl("body.biolum .carousel-card", "background");
    const alpha = /\/\s*([0-9.]+)\s*\)/.exec(background);
    expect(
      alpha,
      `the card's biolum background carries no alpha: ${background}`,
    ).not.toBeNull();
    expect(Number(alpha![1])).toBeLessThan(1);
  });
});

describe("boxes become lights", () => {
  it("puts the light on the thing it belongs to", () => {
    const [l] = lightsFrom([box("command", { x: 120, y: 80 })]);
    expect(l!.x).toBe(120);
    expect(l!.y).toBe(80);
  });

  /**
   * Reach is added, not multiplied, and that is the whole reason it is a
   * constant per kind. The card is an order of magnitude wider than the command
   * button; a multiplier gives one of them a light the width of the window and
   * the other nothing. It matters twice over for `command`, whose two elements
   * — a bar button and a 54px circle — differ from each other by a factor of
   * two and must wear the same halo.
   */
  it("gives a wide thing and a small one comparable haloes", () => {
    const bar = lightsFrom([box("command", { w: 90, h: 26 })])[0]!;
    const fab = lightsFrom([box("command", { w: 54, h: 54 })])[0]!;
    const [word] = lightsFrom([box("wordmark", { w: 110, h: 18 })]);
    expect(bar.rx - 45).toBe(fab.rx - 27);
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
    const [cmd] = lightsFrom([box("command")]);
    const [word] = lightsFrom([box("wordmark")]);
    expect(card!.rx).toBeGreaterThan(300);
    expect(card!.power).toBeLessThan(word!.power);
    // The way in is the brightest thing on the panel. It is the ordering the
    // silhouettes used to hold, and moving it here is the point of the change.
    expect(word!.power).toBeLessThan(cmd!.power);
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
    const all = lightsFrom([box("wordmark"), box("card"), box("command")]);
    for (const l of all) expect(l.power).toBeLessThan(0.6);
  });

  /**
   * **One colour, and it is the palette's own first member.**
   *
   * There were two: the silhouettes drew `laneHue` of their own name, on the
   * argument that an animal deserves an animal's hue. With those gone every
   * light here belongs to the *app* rather than standing in for a taxon, and a
   * second hue would now be a colour with nothing to mean. `LANE_HUES[0]` and
   * not a literal 186, so retuning the set moves this with it.
   */
  it("lights everything in the app's own colour", () => {
    for (const kind of ["wordmark", "card", "command"] as const) {
      expect(lightsFrom([box(kind)])[0]!.hue, kind).toBe(LANE_HUES[0]);
    }
  });

  /**
   * Same card, same picture. Everything derived from a key has to survive a
   * re-measurement, because the panel is re-measured on every mutation the
   * observers see: a hue or a breathing phase redrawn from fresh randomness
   * would make the row flicker whenever a silhouette finished loading.
   */
  it("derives the same hue and phase from the same name every time", () => {
    const a = lightsFrom([box("card", { key: "card:Are you a fish?" })])[0]!;
    const b = lightsFrom([box("card", { key: "card:Are you a fish?" })])[0]!;
    expect(a.hue).toBe(b.hue);
    expect(a.seed).toBe(b.seed);
    expect(a.seed).toBeGreaterThanOrEqual(0);
    expect(a.seed).toBeLessThan(1);
  });

  /**
   * Different things breathe on different clocks, or the panel is one pulse.
   * Fewer lights make this *more* load-bearing rather than less: with three on
   * screen a shared phase is not a shimmer, it is a heartbeat.
   */
  it("gives neighbouring lights different phases", () => {
    const set = [
      "wordmark:Concestor",
      "card:Are you a fish?",
      "command:Commands",
    ].map((k) => lightsFrom([box("card", { key: k })])[0]!.seed);
    expect(new Set(set).size).toBe(set.length);
  });

  /**
   * `bornAt` is a lookup and not a computation, because *when a thing appeared*
   * is a fact about the sequence of measurements and `lightsFrom` sees one.
   */
  it("takes each light's birth from the caller, and none by default", () => {
    const born = new Map([["command:Commands", 1234]]);
    const [cmd, word] = lightsFrom(
      [
        box("command", { key: "command:Commands" }),
        box("wordmark", { key: "wordmark:x" }),
      ],
      (k) => born.get(k),
    );
    expect(cmd!.bornAt).toBe(1234);
    expect(word!.bornAt).toBeUndefined();
    expect(lightsFrom([box("command")])[0]!.bornAt).toBeUndefined();
  });
});

/**
 * The still frame downstream redraws on a *change of identity*, so this is what
 * stands between `prefers-reduced-motion` and an animation driven by a carousel
 * measuring itself sixty times a second.
 */
describe("two measurements are the same picture", () => {
  const one = () =>
    lightsFrom([box("command", { key: "command:Commands" })], () => 7);

  it("says so when nothing moved", () => {
    expect(sameLights(one(), one())).toBe(true);
  });

  it("says otherwise when anything at all did", () => {
    expect(sameLights(one(), [])).toBe(false);
    expect(
      sameLights(
        one(),
        lightsFrom([box("command", { key: "command:Commands" })]),
      ),
    ).toBe(false);
    expect(
      sameLights(
        one(),
        lightsFrom(
          [box("command", { key: "command:Commands", x: 401 })],
          () => 7,
        ),
      ),
    ).toBe(false);
    expect(
      sameLights(
        one(),
        lightsFrom([box("card", { key: "command:Commands" })], () => 7),
      ),
    ).toBe(false);
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
