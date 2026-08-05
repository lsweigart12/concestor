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
  MIN_FREE_W,
  cardReserve,
  fitViewport,
  freeRect,
  fitContentPad,
  revealShift,
  toScreenRect,
  union,
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
    expect(blocks, `no @media (max-width: ${CARD_STACK_W}px) moves the card`)
      .toHaveLength(1);
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
  const base = { content, vw: 1200, vh: 800, reserve: 0, bottom: 100, maxZoom: 4 };

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
    const r = freeRect({ vw: 320, vh: 200, bottom: 104, cardOpen: true, pad: 10 });
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

describe("the subject a reveal is measured on", () => {
  it("is the mark and its label together", () => {
    const r = union({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: -5, w: 100, h: 30 });
    expect(r).toEqual({ x: 0, y: -5, w: 120, h: 30 });
  });

  it("travels with the transform, so a zoomed-out mark is a small one", () => {
    const r = toScreenRect({ x: 100, y: 50, w: 40, h: 20 }, { x: 30, y: 5, zoom: 0.5 });
    expect(r).toEqual({ x: 80, y: 30, w: 20, h: 10 });
  });
});
