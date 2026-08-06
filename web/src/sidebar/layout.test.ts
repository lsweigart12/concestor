/**
 * The sidebar layout, asked of the stylesheet rather than of a rendered tree.
 *
 * This replaces `chrome/swap.test.ts`, which pinned the trade the old layout
 * made below 620px — the control bar, the canvas-mode panel and the axis's
 * scale switch all hidden, one round button standing in for the lot. That trade
 * is gone because all three of those surfaces are gone, but the *reason* the
 * file existed is unchanged and is the reason this one does: a layout built out
 * of one custom property fails silently. Get the property right in three rules
 * and wrong in the fourth and nothing errors — the app simply opens with a
 * strip of void beside the tree, or a control drawn on top of the panel it is
 * supposed to sit beside, and neither shows up in a build or a type check.
 *
 * jsdom lays nothing out and applies no stylesheet, so this is the half a
 * rendered document cannot answer. `test/css.ts` parses the sheet with postcss;
 * everything below is read out of it.
 */

import { describe, expect, it } from "vitest";
import { cssVar, decl, rules } from "../test/css";
import { DOCK_W, FLOAT_GAP, WIDTH } from "./useSidebar";

/** A `12px`-style declaration as a number. */
function px(v: string | undefined): number {
  const n = Number.parseFloat(String(v));
  expect(Number.isFinite(n), `${v} is not a length`).toBe(true);
  return n;
}

describe("one custom property is the whole layout", () => {
  it("is reading the stylesheet at all", () => {
    expect(rules().length).toBeGreaterThan(100);
  });

  /**
   * The canvas is inset by the panel and nothing else is.
   *
   * Everything drawn *on* the canvas — the axis, the drill lane, the marks — is
   * positioned inside this element, so one `left` is the whole of the reflow.
   * It is also what makes `canvas/viewport.ts` correct for free: React Flow
   * measures this container, so `vw` is already the canvas's own width.
   */
  it("insets the canvas by the panel's width", () => {
    expect(decl(".canvas", "left")).toBe("var(--sidebar-w)");
  });

  /**
   * And the two things that are *centred over* the canvas without being inside
   * it. Both were centred on the window and both then sat off to the right of
   * the tree they belong to — the empty canvas's invitation by half the panel's
   * width, and the toast column by the same.
   */
  it("centres the invitation and the toasts on the canvas, not the window", () => {
    expect(decl(".boot", "left")).toBe("var(--sidebar-w)");
    expect(decl(".toasts", "left")).toContain("var(--sidebar-w)");
  });

  /**
   * **Two properties, and the second is the one that is easy to miss.**
   *
   * `--sidebar-w` is what the panel takes *off the canvas* and is zero whenever
   * the panel floats over the canvas instead of sitting beside it.
   * `--chrome-left` is where the panel's right edge *is on screen*, which has a
   * different answer in exactly that case. The toggle and the search pill ride
   * the second, and the first version of this rode the first — which drew both
   * of them on top of the drawer's own wordmark at every width below `DOCK_W`.
   */
  it("rides the chrome off the panel's edge rather than off its cost", () => {
    expect(decl(".side-toggle", "left")).toContain("var(--chrome-left)");
    expect(decl(".side-search", "width")).toContain("var(--chrome-left)");
    expect(decl(".side-search", "width")).not.toContain("var(--sidebar-w)");
    expect(decl(".side-toggle", "left")).not.toContain("var(--sidebar-w)");
  });
});

describe("the search pill collapses to a circle", () => {
  /**
   * The arithmetic that makes the collapsed control a circle rather than a
   * lozenge, and it is the reason those three numbers are custom properties
   * instead of literals.
   *
   * The pill runs from `--rail-pad` to `--chrome-left` plus `--search-out`.
   * Shut, `--chrome-left` is `0px`, so what is left is `--search-out` minus
   * `--rail-pad` — and that has to equal `--search-h` exactly or the one
   * element that survives the panel closing is visibly not round.
   */
  it("leaves exactly its own height behind when the panel shuts", () => {
    const out = px(cssVar("--search-out"));
    const pad = px(cssVar("--rail-pad"));
    const h = px(cssVar("--search-h"));
    expect(out - pad).toBe(h);
  });

  /**
   * And the cap's centre lands under the toggle's. Both are round, both are on
   * the same vertical, and a few pixels out reads as a misalignment rather than
   * as one control below another.
   */
  it("centres the cap under the panel's own switch", () => {
    const capCentre = px(cssVar("--search-out")) - px(cssVar("--search-h")) / 2;
    const toggleLeft = px(
      decl(".side-toggle", "left")?.match(/\+ (\d+)px/)?.[1],
    );
    const toggleW = px(decl(".side-toggle", "width"));
    expect(capCentre).toBe(toggleLeft + toggleW / 2);
  });

  /**
   * The pill is in a fixed layer, so it cannot inherit the column's flow and
   * has to be told where the flow would have put it: the top padding, the
   * wordmark, and one gap. Its slot in the column is exactly `--search-h`, and
   * the two have to be computed from the same three properties or the sections
   * below slide under the pill on any window where the gap resolves
   * differently from the day somebody eyeballed it.
   */
  it("puts the pill exactly where the column's flow would have", () => {
    const top = decl(".side-search", "top");
    for (const v of ["--side-pad-t", "--brand-h", "--side-gap"]) {
      expect(top, `the pill's top does not read ${v}`).toContain(`var(${v})`);
    }
    expect(decl(".side-brand", "height")).toBe("var(--brand-h)");
    expect(decl(".side-search-gap", "height")).toBe("var(--search-h)");
  });

  /**
   * And the invitation's words ride the same line as the pill they point at.
   * They were two literals once and the second was not updated when the first
   * moved, which put the sentence a gap's worth above the ring it explains.
   */
  it("keeps the invitation on the pill's own line", () => {
    expect(decl(".side-search-tip", "top")).toBe(decl(".side-search", "top"));
  });
});

describe("the column has one rhythm and it scales", () => {
  /**
   * Five blocks, four gaps, and the gap is the *only* spacing between them.
   *
   * Each section used to carry its own padding and a hairline to its
   * neighbour, which under one shared gap is what makes the four gaps unequal:
   * the two around the search pill's slot are the gap alone, and the two around
   * the sections would be the gap plus two paddings. This is the rule that
   * keeps them the same measurement rather than four that happen to look alike.
   */
  it("spaces the column with one gap and gives the sections no padding", () => {
    expect(decl(".side-inner", "gap")).toBe("var(--side-gap)");
    expect(decl(".side-section", "padding")).toBe("0");
  });

  it("draws no rule between the blocks, since the gap is the separation", () => {
    const ruled = rules().filter(
      (r) =>
        r.selectors.some(
          (sel) =>
            sel.includes(".side-section") ||
            sel === ".side-bottom" ||
            sel === ".side-canvas",
        ) && (r.decls.get("border-top") ?? "") !== "",
    );
    expect(ruled.map((r) => r.selector)).toEqual([]);
  });

  /** It scales with the window and is clamped at both ends. */
  it("scales the gap, and floors and ceilings it", () => {
    const gap = cssVar("--side-gap");
    expect(gap).toMatch(/^clamp\(/);
    expect(gap).toContain("vh");
  });
});

describe("a shut panel is genuinely absent", () => {
  /**
   * `transform` rather than `left`, so the slide is compositor-only — and the
   * `inert` attribute on the element, not a rule here, is what takes it out of
   * the tab order. A panel hidden by transform alone is an off-screen focus
   * trap, which is the single most common bug in this whole pattern.
   */
  it("slides out and comes back on a class", () => {
    expect(decl(".sidebar", "transform")).toBe("translateX(-100%)");
    expect(decl(".sidebar.is-open", "transform")).toBe("none");
  });

  /** The overlay variant leaves a strip of canvas showing beside it. */
  it("never lets a floating drawer take the whole window", () => {
    expect(decl(".sidebar.is-floating", "max-width")).toContain("100vw");
  });
});

describe("the two things in the top-right corner stack", () => {
  /**
   * The view cluster and the detail card are both pinned to the same corner,
   * and a card starting at the window's own margin lands on the cluster. This
   * is the arithmetic that keeps them apart, and it is worth pinning because
   * the failure is a card covering three controls rather than anything visibly
   * broken.
   */
  it("starts the card below the view cluster", () => {
    const slotTop = px(decl(".viewport-slot", "top"));
    const btn = px(decl(".viewport-btn", "height"));
    const pad = px(decl(".viewport-controls", "padding"));
    expect(px(decl(".detail", "top"))).toBeGreaterThanOrEqual(
      slotTop + btn + pad * 2,
    );
  });

  /** And it arrives from the edge it belongs to. */
  it("flies the card out of the right-hand edge", () => {
    expect(decl(".detail", "animation")).toContain("detail-in");
  });
});

describe("the widths are derived rather than picked", () => {
  /**
   * `DOCK_W` is the width below which the panel stops taking room off the
   * canvas, and it is not a guess about devices: a docked panel still has to
   * leave the canvas more than `MIN_FREE_W`, which `canvas/viewport.ts`
   * measured as the narrowest strip worth reframing a tree into. Anything under
   * that renders the labels at a size nobody can read.
   */
  it("leaves a canvas worth reframing at the docking threshold", () => {
    // `MIN_FREE_W` is 420 in `canvas/viewport.ts`; importing it would couple
    // two modules that share no runtime, so it is restated with its source.
    expect(DOCK_W - WIDTH).toBeGreaterThanOrEqual(420);
  });

  /**
   * There is one width and the stylesheet has to be holding the same one.
   * The panel's own `width` is a constant in CSS and the variable it publishes
   * is written from TypeScript, so this is the one place the two can drift.
   */
  it("draws the panel at the width the module publishes", () => {
    expect(decl(".sidebar", "width")).toBe(`${WIDTH}px`);
  });

  /**
   * A floating drawer leaves a strip of canvas showing beside it, so a reader
   * can see what they are standing in front of. The clamp is stated in both
   * places because a custom property cannot read the width an element resolved
   * to, which is exactly why it is worth pinning.
   */
  it("keeps the drawer's clamp in step with the module's", () => {
    expect(decl(".sidebar.is-floating", "max-width")).toBe(
      `calc(100vw - ${FLOAT_GAP}px)`,
    );
  });
});

describe("fullscreen is drawn on the element the window hands the compositor", () => {
  /**
   * `body` carries the void and the root has never carried anything, so without
   * this the browser frames a dark instrument in its own default — which is a
   * thing you only ever find out about from a screenshot somebody else took.
   */
  it("paints the root", () => {
    expect(decl(":root:fullscreen", "background")).toContain("var(--void)");
  });
});
