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
 * Four files, because the selectors span four authors and none of them can see
 * this one. The panel and the card were always two; the command control is two
 * more, and it is the seam most worth checking — `is-command` is written by
 * `Controls.tsx` for one button out of a dozen it draws with the same
 * component, so it is a class that could plausibly be tidied away by somebody
 * who greps for it and finds only a stylesheet rule.
 */
const CONTROLS = import.meta.glob<string>("../chrome/Controls.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
})["../chrome/Controls.tsx"]!;
const FAB = import.meta.glob<string>("../chrome/PaletteFab.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
})["../chrome/PaletteFab.tsx"]!;
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
  it("is reading all four files at all", () => {
    // Every check below is a search for a substring, so all of them pass for
    // free on an empty string — a moved file or a changed glob option would
    // leave this whole describe measuring nothing.
    expect(APP.length).toBeGreaterThan(1000);
    expect(CAROUSEL.length).toBeGreaterThan(1000);
    expect(CONTROLS.length).toBeGreaterThan(1000);
    expect(FAB.length).toBeGreaterThan(1000);
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
    for (const src of [APP, CAROUSEL, CONTROLS, FAB]) {
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        // Quotes are separators too, and leaving them out is what this check
        // could not see: a class applied conditionally *inside* a template —
        // `${cond ? " is-command" : ""}` — tokenises as `is-command"` with the
        // closing quote still on it, which fails the shape test below and is
        // therefore invisible. Every conditional class in this repo is written
        // that way, so the check was silently blind to all of them.
        for (const tok of (m[1] ?? m[2] ?? "").split(/[\s${}"']+/)) {
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
   * The one thing a selector reaches for that is not a class.
   *
   * `.boot-inner > h1` is the wordmark and the child combinator is deliberate —
   * the same panel renders an unreachable-API heading, which is an apology
   * rather than an invitation and must not glow.
   */
  it("reaches a wordmark", () => {
    expect(APP).toMatch(/<h1>/);
  });

  /**
   * **`is-command` goes on one button and not on the lead slot.**
   *
   * `Controls.tsx` draws every control through one function, so the obvious
   * selector — `.controls-lead .control` — reaches three buttons, `P`, `S` and
   * `R`, and would light the whole group. The class is conditional on the
   * action's own id, which is the only thing that distinguishes them, and this
   * asserts the condition rather than the class: a refactor that applied it
   * unconditionally would leave every string in this file intact.
   */
  it("marks the command button alone, by its action id", () => {
    expect(CONTROLS).toMatch(/is-command/);
    expect(CONTROLS).toMatch(/a\.id === "palette"[^;]*is-command/s);
  });

  /** The narrow window's stand-in for it, which is a different element. */
  it("reaches the circle that replaces it below 620px", () => {
    expect(FAB).toContain('className={`palette-fab');
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
    const set = ["wordmark:Concestor", "card:Are you a fish?", "command:Commands"].map(
      (k) => lightsFrom([box("card", { key: k })])[0]!.seed,
    );
    expect(new Set(set).size).toBe(set.length);
  });

  /**
   * `bornAt` is a lookup and not a computation, because *when a thing appeared*
   * is a fact about the sequence of measurements and `lightsFrom` sees one.
   */
  it("takes each light's birth from the caller, and none by default", () => {
    const born = new Map([["command:Commands", 1234]]);
    const [cmd, word] = lightsFrom(
      [box("command", { key: "command:Commands" }), box("wordmark", { key: "wordmark:x" })],
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
  const one = () => lightsFrom([box("command", { key: "command:Commands" })], () => 7);

  it("says so when nothing moved", () => {
    expect(sameLights(one(), one())).toBe(true);
  });

  it("says otherwise when anything at all did", () => {
    expect(sameLights(one(), [])).toBe(false);
    expect(
      sameLights(one(), lightsFrom([box("command", { key: "command:Commands" })])),
    ).toBe(false);
    expect(
      sameLights(
        one(),
        lightsFrom([box("command", { key: "command:Commands", x: 401 })], () => 7),
      ),
    ).toBe(false);
    expect(
      sameLights(one(), lightsFrom([box("card", { key: "command:Commands" })], () => 7)),
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
