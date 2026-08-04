/**
 * The placement arithmetic, and the census that keeps the native tooltip out.
 *
 * The second half is the one worth having. `title` is an attribute every
 * element accepts, no linter objects to, and no test notices — which is how
 * this app came to explain its bioluminescence switch in 101 characters of
 * documentation prose, drawn by the OS over the timeline, and its label modes
 * in 372. Nothing failed. Nothing could fail: a `title` renders, it just
 * renders as somebody else's widget, wherever the pointer happens to be, a
 * second late, and never at all on a touch screen.
 *
 * So the guard is a census in the style of `styles.test.ts` and
 * `Controls.test.ts` — text against text, this project having no DOM to render
 * into — and it counts what it read before trusting a search for an absence.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EDGE, GAP, MAX_W, OPEN_MS, openDelay, place } from "./tip";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** Every `.tsx` that renders something, as source text. */
const SOURCES: [string, string][] = Object.entries(
  import.meta.glob<string>("../**/*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).filter(([f]) => !f.includes(".test."));

// ------------------------------------------------------------- the census --

/** Comments stripped, so this file's own prose cannot trip its own check. */
function bare(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The tag an attribute belongs to.
 *
 * Attributes live between `<Tag` and the `>` that closes it, so the nearest
 * `<` behind one is its own tag's — which is all this needs to tell
 * `<Confirm title=…>`, a component prop and perfectly fine, from
 * `<span title=…>`, which is the browser's tooltip and is not.
 */
function tagBefore(src: string, at: number): string | null {
  const open = src.lastIndexOf("<", at);
  if (open < 0) return null;
  return /^<\s*([A-Za-z][\w.]*)/.exec(src.slice(open, at))?.[1] ?? null;
}

const intrinsic = (tag: string) => /^[a-z]/.test(tag);

describe("no element in this app carries a native tooltip", () => {
  /**
   * Both checks below are searches for an absence and pass for free against an
   * empty corpus — a moved file or a changed Vite option would leave them green
   * and measuring nothing, which is the failure `docs/ci.md` §2 is about.
   */
  it("is reading the components at all", () => {
    expect(SOURCES.length).toBeGreaterThan(10);
    expect(SOURCES.every(([, s]) => s.length > 0)).toBe(true);
    // And reading the thing that replaced them, so a wholesale revert of this
    // change fails here rather than passing quietly.
    const users = SOURCES.filter(([, s]) => s.includes("useTip("));
    expect(users.length).toBeGreaterThan(8);
  });

  /**
   * The check itself. A `title` on a component is a prop and its business —
   * `Confirm` takes one for its heading — so only the lowercase tags, which are
   * the ones the browser will act on.
   */
  it("sets no title attribute on a DOM element", () => {
    const found: string[] = [];
    for (const [file, src] of SOURCES) {
      const text = bare(src);
      for (const m of text.matchAll(/\stitle\s*=/g)) {
        const tag = tagBefore(text, m.index);
        if (tag && intrinsic(tag)) {
          found.push(`${file}: <${tag} title=…>`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  /**
   * And the SVG half of the same thing, which is the one that hides. A `<title>`
   * child is the platform tooltip by another route, it is what `Bracket` and
   * `SilhouetteSvg` used, and grepping for `title=` would never have found
   * either of them.
   */
  it("renders no SVG title element", () => {
    const found: string[] = [];
    for (const [file, src] of SOURCES) {
      if (/<title[\s>]/.test(bare(src))) found.push(file);
    }
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------- the placement --

const VP = { w: 1000, h: 800 };
/** A switch on the mode panel: small, bottom left. */
const CHIP = { x: 24, y: 700, w: 44, h: 20 };
const TIP = { w: 260, h: 48 };

describe("a tip is placed against its trigger and inside the window", () => {
  it("sits under a trigger in the upper half", () => {
    const p = place({ x: 400, y: 100, w: 44, h: 20 }, TIP, VP);
    expect(p.side).toBe("bottom");
    expect(p.y).toBe(100 + 20 + GAP);
    // Centred: 400 + 22 - 130.
    expect(p.x).toBe(292);
  });

  /**
   * The case in the bug report, and the reason "flip when it does not fit" is
   * not the rule. The bioluminescence switch sits ~100px off the foot of the
   * window; a 48px tip below it *fits*, at 728–776, straight across a timeline
   * whose band starts at 716. Fitting was never the test — the tip goes towards
   * the middle of the window because that is where the room is.
   */
  it("opens upward from a trigger in the lower half, though below would fit", () => {
    expect(VP.h - EDGE - (CHIP.y + CHIP.h + GAP + TIP.h)).toBeGreaterThan(0);
    const p = place(CHIP, TIP, VP);
    expect(p.side).toBe("top");
    expect(p.y).toBe(700 - GAP - 48);
  });

  /**
   * The side chosen is always the side with more room, which is the identity
   * `place` is written on — checked here over the whole column rather than
   * asserted twice, because it is what lets that function have no flip in it.
   */
  it("always picks the side with more room", () => {
    for (let y = -40; y <= VP.h + 40; y += 20) {
      const a = { x: 400, y, w: 44, h: 20 };
      const roomAbove = a.y - GAP - TIP.h - EDGE;
      const roomBelow = VP.h - EDGE - (a.y + a.h + GAP + TIP.h);
      expect(place(a, TIP, VP).side, `at y=${y}`).toBe(
        roomAbove >= roomBelow ? "top" : "bottom",
      );
    }
  });

  /** And whichever side it picked, the tip is inside the window. */
  it("keeps the tip on screen for a trigger scrolled off either edge", () => {
    for (const y of [-200, -20, VP.h - 4, VP.h + 200]) {
      const p = place({ x: 400, y, w: 44, h: 20 }, TIP, VP);
      expect(p.y, `at y=${y}`).toBeGreaterThanOrEqual(EDGE);
      expect(p.y + TIP.h, `at y=${y}`).toBeLessThanOrEqual(VP.h - EDGE);
    }
  });

  /**
   * The half that gets forgotten, and the mode panel is pinned to the left
   * edge, so it is the half this app needs most. Centring a 260px tip on a
   * 44px switch at x=24 puts it at −87.
   */
  it("shifts back inside the left edge", () => {
    expect(place(CHIP, TIP, VP).x).toBe(EDGE);
  });

  it("shifts back inside the right edge", () => {
    const p = place({ x: 960, y: 100, w: 30, h: 20 }, TIP, VP);
    expect(p.x).toBe(VP.w - EDGE - TIP.w);
  });

  /**
   * Degenerate, and it still has to answer. A tip wider than the window is
   * pinned to the left edge rather than to a negative x — the words start where
   * the reader's eye starts, and the alternative loses the beginning of the
   * sentence instead of the end.
   */
  it("pins a tip wider than the window to the left edge", () => {
    expect(place(CHIP, { w: 2000, h: 40 }, VP).x).toBe(EDGE);
  });

  /** Taller than the window: the roomier side, clamped so the first line shows. */
  it("keeps a tip taller than the window on screen", () => {
    const p = place({ x: 400, y: 380, w: 44, h: 20 }, { w: 260, h: 900 }, VP);
    expect(p.y).toBeGreaterThanOrEqual(EDGE);
  });

  /** Nothing here reads a scroll offset: the layer is `position: fixed`. */
  it("returns viewport coordinates, so a trigger above the fold goes below", () => {
    expect(place({ x: 400, y: 0, w: 44, h: 20 }, TIP, VP).side).toBe("bottom");
  });
});

describe("the delay is skipped for a neighbour and not otherwise", () => {
  it("waits when nothing has been shown", () => {
    expect(openDelay(10_000, null)).toBe(OPEN_MS);
  });

  it("opens at once just inside the chain window", () => {
    expect(openDelay(10_000, 9_700)).toBe(0);
  });

  it("waits again once the chain has lapsed", () => {
    expect(openDelay(10_000, 9_000)).toBe(OPEN_MS);
  });
});

describe("the measure the copy was written to is the measure it is drawn at", () => {
  /**
   * `place` measures the box the stylesheet produced, so a `max-width` that
   * drifted from `MAX_W` would not error — it would quietly widen every tip
   * past the line length the sentences were cut to fit, and the arithmetic
   * would keep agreeing with itself. Pinned by reading the rule, the way
   * `labels.ts`'s font constants are.
   */
  it("pins MAX_W to the stylesheet", () => {
    const body = /(?:^|[};])\s*\.tip\s*\{([^{}]*)\}/m.exec(
      CSS.replace(/\/\*[\s\S]*?\*\//g, ""),
    )?.[1];
    expect(body, "no .tip rule").toBeTruthy();
    expect(body).toContain(`max-width: ${MAX_W}px`);
  });

  /**
   * The layer is drawn over the canvas, the card, the palette and the dialog —
   * it is the one surface in the app whose whole job is to sit on top of
   * whatever raised it. The highest z-index anything else claims is the toast
   * stack's 50.
   */
  it("draws above every other surface", () => {
    const zs = [...CSS.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...zs)).toBe(60);
  });
});
