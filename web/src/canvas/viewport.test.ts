/**
 * The canvas against the panel sitting on it.
 *
 * Half of this file is arithmetic and the other half is the reason the
 * arithmetic is right: the card's footprint is declared in styles.css and used
 * here, and nothing in either file would notice the two disagreeing. The tree
 * would simply start sliding a little way back under the card — which is the
 * bug this whole module exists to fix, returning silently.
 */
import { describe, expect, it } from "vitest";
import { cssVar, decl, narrower } from "../test/css";
import {
  CARD_GAP,
  CARD_RESERVE,
  CARD_STACK_MAX_H,
  CARD_STACK_TOP,
  CARD_STACK_W,
  CARD_W,
  COMFORT_MAX,
  COMFORT_SHARE,
  MIN_FREE_W,
  cardReserve,
  comfortRect,
  fitViewport,
  freeRect,
  fitContentPad,
  revealShift,
  toScreenRect,
  union,
  unlaidOut,
} from "./viewport";

/**
 * The stylesheet is read with a parser — `test/css.ts` — rather than with the
 * regex this used to carry. That regex matched a rule body as `\{([^{}]*)\}`,
 * which no nested rule survives, and captured a media block with a `\n\}`
 * terminator, which is a claim about the closing brace being at column zero.
 * It also asserted that *exactly one* `@media (max-width:)` block in the whole
 * file redeclares the card, which fails the day somebody adds a breakpoint for
 * something else. The claim was always narrower than that: at the stacking
 * width, one block moves the card.
 */
describe("the card's footprint is the stylesheet's", () => {
  it("is 360px wide, one --s4 off the edge", () => {
    expect(decl(".detail", "width")).toBe(`${CARD_W}px`);
    // The card's margin from the window edge. The reserve is that twice over —
    // once for the margin the card keeps and once for the gap the tree keeps
    // from the card — so the variable has to be the one this assumes.
    expect(decl(".detail", "right")).toBe("var(--s4)");
    expect(cssVar("--s4")).toBe(`${CARD_GAP}px`);
    expect(CARD_RESERVE).toBe(CARD_W + CARD_GAP * 2);
  });

  it("stacks across the top at the width and the offsets we assume", () => {
    // The `@media` block at the stacking width that redeclares `.detail`, not
    // the others that redeclare something else at that same width.
    const blocks = narrower(CARD_STACK_W).filter((b) => {
      try {
        return decl(".detail", "top", b) !== undefined;
      } catch {
        return false;
      }
    });
    expect(
      blocks,
      `no @media (max-width: ${CARD_STACK_W}px) moves the card`,
    ).toHaveLength(1);
    const block = blocks[0]!;
    expect(decl(".detail", "top", block)).toBe(`${CARD_STACK_TOP}px`);
    expect(decl(".detail", "max-height", block)).toBe(
      `${Math.round(CARD_STACK_MAX_H * 100)}vh`,
    );
    // Spanning the window is what makes the *right* reserve meaningless here.
    expect(decl(".detail", "width", block)).toBe("auto");
  });
});

describe("cardReserve", () => {
  it("takes the card's footprint on a desktop window", () => {
    expect(cardReserve(1600, true)).toBe(CARD_RESERVE);
  });

  it("takes nothing with no card up", () => {
    expect(cardReserve(1600, false)).toBe(0);
  });

  it("takes nothing where the card stacks instead", () => {
    expect(cardReserve(CARD_STACK_W, true)).toBe(0);
    expect(cardReserve(390, true)).toBe(0);
  });

  /**
   * The refusal that matters. Between the stacking width and about a thousand
   * pixels there is a band where the card fits in the corner but honouring it
   * leaves a canvas too narrow to draw a legible tree in — and a tree with no
   * names on it is a worse answer than a tree with a corner covered.
   */
  it("refuses the reserve where too little canvas would be left", () => {
    expect(cardReserve(CARD_RESERVE + MIN_FREE_W - 1, true)).toBe(0);
    expect(cardReserve(CARD_RESERVE + MIN_FREE_W, true)).toBe(CARD_RESERVE);
  });
});

describe("fitViewport", () => {
  const content = { x: 0, y: 0, w: 1000, h: 400 };
  const base = {
    content,
    vw: 1200,
    vh: 800,
    reserve: 0,
    bottom: 100,
    maxZoom: 4,
  };

  it("centres the content in the container when nothing is on it", () => {
    const v = fitViewport(base);
    expect(v.zoom).toBeCloseTo(1.2, 6);
    // 1000 layout units at 1.2 is 1200px, which is the width exactly.
    expect(v.x).toBeCloseTo(0, 6);
  });

  it("frames into what the card leaves, at a scale that fits it", () => {
    const v = fitViewport({ ...base, reserve: 400 });
    expect(v.zoom).toBeCloseTo(0.8, 6);
    expect(v.x).toBeCloseTo(0, 6);
    // The right edge of the content lands on the card's left edge, not past it.
    expect(content.w * v.zoom + v.x).toBeCloseTo(800, 6);
  });

  it("keeps the height rule and the zoom cap", () => {
    // 700px of usable height against 400 units of content caps at maxZoom.
    expect(fitViewport({ ...base, maxZoom: 1 }).zoom).toBe(1);
    expect(fitViewport({ ...base, vh: 300 }).zoom).toBeCloseTo(0.5, 6);
  });

  it("never collapses when the container reports nothing", () => {
    const v = fitViewport({ ...base, vw: 0, vh: 0, reserve: 400 });
    expect(v.zoom).toBeGreaterThan(0);
    expect(Number.isFinite(v.x)).toBe(true);
  });

  it("pads the content symmetrically", () => {
    expect(fitContentPad({ x: 10, y: 20, w: 100, h: 200 }, 5)).toEqual({
      x: 5,
      y: 15,
      w: 110,
      h: 210,
    });
  });
});

describe("freeRect", () => {
  const base = { vw: 1400, vh: 900, bottom: 100, pad: 10 };

  it("is the whole canvas above the axis with no card up", () => {
    expect(freeRect({ ...base, cardOpen: false })).toEqual({
      x: 10,
      y: 10,
      w: 1380,
      h: 790,
    });
  });

  /**
   * The case the reserve refuses and this must not: at 800px the layout stays
   * centred under the card, so this is the only thing keeping a subject out
   * from under it.
   */
  it("clears the card even at a width the reserve is refused at", () => {
    expect(cardReserve(800, true)).toBe(0);
    const r = freeRect({ ...base, vw: 800, cardOpen: true });
    expect(r.x + r.w).toBe(800 - CARD_RESERVE - 10);
  });

  it("drops below a stacked card rather than left of it", () => {
    const r = freeRect({ ...base, vw: 500, vh: 900, cardOpen: true });
    expect(r.y).toBe(CARD_STACK_TOP + 900 * CARD_STACK_MAX_H + 10);
    expect(r.w).toBe(480);
    expect(r.h).toBeGreaterThan(0);
  });

  it("never reports a negative box, however little is left", () => {
    const r = freeRect({
      vw: 320,
      vh: 200,
      bottom: 104,
      cardOpen: true,
      pad: 10,
    });
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
  });
});

describe("revealShift", () => {
  const free = { x: 0, y: 0, w: 1000, h: 600 };

  it("does nothing to something already in the clear", () => {
    expect(revealShift({ x: 100, y: 100, w: 50, h: 20 }, free)).toEqual({
      dx: 0,
      dy: 0,
    });
  });

  /**
   * The moose. The mark is at 1100 in a free strip ending at 1000, so the
   * content moves left by exactly the overlap and no further — the point is to
   * reveal the subject, not to recentre the view on it.
   */
  it("moves by the overlap and no more", () => {
    expect(revealShift({ x: 1080, y: 10, w: 60, h: 20 }, free)).toEqual({
      dx: -140,
      dy: 0,
    });
  });

  it("pulls something off the left or the top back in", () => {
    expect(revealShift({ x: -30, y: -12, w: 60, h: 20 }, free)).toEqual({
      dx: 30,
      dy: 12,
    });
  });

  it("moves both axes at once", () => {
    const s = revealShift({ x: 1200, y: 700, w: 40, h: 40 }, free);
    expect(s.dx).toBe(-240);
    expect(s.dy).toBe(-140);
  });

  /**
   * A chosen leaf's label can be wider than the strip beside a card. Clamping
   * both of its edges is unsatisfiable, and picking one resolves to whichever
   * the code tests first — so the mark would jump left or right depending on
   * which way it was already overflowing. Centring is stable and is the same
   * answer whichever direction it came from.
   */
  it("centres a subject too big for the space rather than picking an edge", () => {
    const wide = { x: 200, y: 0, w: 1400, h: 20 };
    const a = revealShift(wide, free);
    expect(a.dx).toBe(-400);
    // Same box, approached from the other side: same resting place.
    const b = revealShift({ ...wide, x: -600 }, free);
    expect(-600 + b.dx).toBe(200 + a.dx);
  });
});

/**
 * The band between "on screen" and "in view", which is what keeps a selection
 * quiet. Against the free region alone a reveal fires for a mark one pixel
 * outside and not one a pixel inside, then leaves it flush against the frame.
 * Asking the *same* pulled-in rect both questions is the whole mechanism.
 */
describe("comfortRect", () => {
  const free = { x: 0, y: 0, w: 1000, h: 600 };

  it("takes its share off every side", () => {
    expect(comfortRect(free)).toEqual({
      x: 1000 * COMFORT_SHARE,
      y: 600 * COMFORT_SHARE,
      w: 1000 - 2 * 1000 * COMFORT_SHARE,
      h: 600 - 2 * 600 * COMFORT_SHARE,
    });
  });

  // Of the region, not the window: the strip beside a card gets a band
  // proportional to itself, where a fixed margin would eat a third of it.
  it("scales with the region it is taken from", () => {
    const narrow = comfortRect({ x: 0, y: 0, w: 500, h: 600 });
    expect(narrow.x).toBe(500 * COMFORT_SHARE);
    expect(narrow.w).toBe(500 - 2 * 500 * COMFORT_SHARE);
  });

  // Capped, or a seventh of a very wide canvas forces the large pan the band
  // exists to avoid.
  it("caps the margin on a wide canvas", () => {
    const wide = comfortRect({ x: 0, y: 0, w: 4000, h: 600 });
    expect(wide.x).toBe(COMFORT_MAX);
    expect(wide.w).toBe(4000 - 2 * COMFORT_MAX);
  });

  it("never inverts, however little there is to take from", () => {
    const tiny = comfortRect({ x: 10, y: 10, w: 1, h: 1 });
    expect(tiny.w).toBeGreaterThan(0);
    expect(tiny.h).toBeGreaterThan(0);
  });

  // The pair, which is the only claim that matters.
  it("leaves a comfortable subject alone and seats an uncomfortable one inside", () => {
    const band = comfortRect(free);
    const inside = { x: 400, y: 300, w: 50, h: 20 };
    expect(revealShift(inside, band)).toEqual({ dx: 0, dy: 0 });

    // On screen — inside `free` — but hard against the right-hand edge.
    const edge = { x: 950, y: 300, w: 40, h: 20 };
    const { dx } = revealShift(edge, band);
    expect(dx).toBeLessThan(0);
    expect(edge.x + dx + edge.w).toBe(band.x + band.w);
    // …and still well inside the region it was already technically inside.
    expect(edge.x + dx + edge.w).toBeLessThan(free.x + free.w);
  });
});

describe("the subject a reveal is measured on", () => {
  it("is the mark and its label together", () => {
    const r = union(
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 20, y: -5, w: 100, h: 30 },
    );
    expect(r).toEqual({ x: 0, y: -5, w: 120, h: 30 });
  });

  it("travels with the transform, so a zoomed-out mark is a small one", () => {
    const r = toScreenRect(
      { x: 100, y: 50, w: 40, h: 20 },
      { x: 30, y: 5, zoom: 0.5 },
    );
    expect(r).toEqual({ x: 80, y: 30, w: 20, h: 10 });
  });
});

// --------------------------------------- the canvas a move is made into --

/**
 * The refusal, and the census that keeps it at every call site.
 *
 * `unlaidOut` is one line of arithmetic and the whole of #100 and #117. React
 * Flow files a container measuring zero as a square 500px canvas, so every
 * `vw`/`vh` above can be a number nothing on screen has; hand the resulting
 * move to d3-zoom with a duration and its tween divides by the container's real
 * extent, which is zero, and the store transform is NaN for the length of the
 * animation.
 *
 * #112 fixed that inline inside `fitTarget` and there were three writers. The
 * other two kept producing it — the reveal on every cold load carrying a
 * selection — which is why the rule is a named export now and why the second
 * half of this file counts the call sites rather than trusting one.
 */
describe("a viewport move is refused into a canvas that is not there", () => {
  it("refuses a container measured at zero on either axis", () => {
    expect(unlaidOut({ clientWidth: 0, clientHeight: 0 })).toBe(true);
    expect(unlaidOut({ clientWidth: 1280, clientHeight: 0 })).toBe(true);
    expect(unlaidOut({ clientWidth: 0, clientHeight: 800 })).toBe(true);
  });

  it("allows a container that has been laid out", () => {
    expect(unlaidOut({ clientWidth: 1280, clientHeight: 800 })).toBe(false);
    // The smallest thing that is still a canvas. The threshold is zero and not
    // a judgement about how much room is enough — `cardReserve` and
    // `MIN_USABLE` are where that judgement lives, and duplicating it here
    // would give the two a way to disagree.
    expect(unlaidOut({ clientWidth: 1, clientHeight: 1 })).toBe(false);
  });

  /**
   * A ref reads `null` before it attaches, and that is not a refusal: there is
   * nothing to measure, so there is nothing to disagree with. Refusing here
   * would block the first fit of every load rather than the wrong ones.
   */
  it("does not refuse when there is nothing to measure", () => {
    expect(unlaidOut(null)).toBe(false);
    expect(unlaidOut(undefined)).toBe(false);
  });

  /**
   * The arithmetic under the refusal, for the case the refusal exists to stop
   * reaching d3-zoom. None of it divides by a span that can be zero, so all of
   * it is finite even against the invented 500 and against a literal 0×0 — the
   * NaN was never ours, which is why a `|| 0` at the render boundary would have
   * silenced the console and left the wrong pan in place.
   */
  it("computes a finite move even for the viewport it refuses", () => {
    const viewports: { vw: number; vh: number }[] = [
      { vw: 0, vh: 0 },
      { vw: 500, vh: 500 },
    ];
    for (const { vw, vh } of viewports) {
      const free = freeRect({ vw, vh, bottom: 104, cardOpen: true, pad: 18 });
      expect(Number.isFinite(free.w) && Number.isFinite(free.h)).toBe(true);
      const { dx, dy } = revealShift({ x: 4000, y: 3000, w: 40, h: 20 }, free);
      expect(Number.isFinite(dx) && Number.isFinite(dy)).toBe(true);
      const fit = fitViewport({
        content: { x: 0, y: 0, w: 0, h: 0 },
        vw,
        vh,
        reserve: 0,
        bottom: 104,
        maxZoom: 1.4,
      });
      expect(Number.isFinite(fit.x)).toBe(true);
      expect(Number.isFinite(fit.y)).toBe(true);
      expect(Number.isFinite(fit.zoom)).toBe(true);
    }
  });
});

/**
 * The half that would have caught #117.
 *
 * A rule enforced at one of three call sites is not enforced, and nothing about
 * `fitTarget` said so — the other two writers sit six hundred lines away and
 * were found only by patching `setAttribute` in a browser. This is a lint over
 * the source, in the style of `chrome/tip.test.ts`: every call that hands the
 * viewport to React Flow must be reachable only past the refusal.
 *
 * Deliberately a count and a token search rather than a shape: it must survive
 * a reformat — `#84` adds Prettier — and it must fail for a *new* writer added
 * without the guard, which is the case that costs the console another issue.
 */
describe("every viewport writer on the canvas asks first", () => {
  const GRAPH: string =
    Object.entries(
      import.meta.glob<string>("./Graph.tsx", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    )[0]?.[1] ?? "";

  /** A search for an absence passes for free against a file nobody read. */
  it("is reading Graph.tsx at all", () => {
    expect(GRAPH.length).toBeGreaterThan(1000);
    expect(GRAPH).toContain("useReactFlow");
  });

  it("guards each of them with unlaidOut", () => {
    const writers = GRAPH.match(/\brf\.(setViewport|fitView)\s*\(/g) ?? [];
    // Three today: the fit, the selection fit, and the reveal. A fourth is
    // welcome and must bring its own refusal.
    expect(writers.length).toBeGreaterThanOrEqual(3);
    const guards = GRAPH.match(/\bunlaidOut\s*\(/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(writers.length);
  });
});
