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
import { decl, ruleFor, rules } from "../test/css";
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
   * different answer in exactly that case. Nothing rides `--chrome-left` today
   * — the toggle and the search are in the panel's own flow while it is open
   * and in a corner cluster while it is shut — but the two are still different
   * questions, and the drawer is why.
   */
  it("insets nothing but the canvas by what the panel costs it", () => {
    expect(decl(".canvas", "left")).toBe("var(--sidebar-w)");
    expect(decl(".sidebar", "width")).toBe(`${WIDTH}px`);
  });
});

describe("the search is a field in the column, not a pill over the canvas", () => {
  /**
   * The overhang is gone and this is what replaced it.
   *
   * It used to be `position: fixed` in a layer of its own, spanning the panel
   * and continuing past its right edge to a round cap — the collapsed diameter
   * falling out of `--search-out − --rail-pad = --search-h`. It read as a bulge,
   * so it is an ordinary control the column's flow places. Pinned from three
   * directions because every one of them is a way the overhang could come back
   * without anything erroring.
   */
  it("is placed by the flow rather than by a fixed layer", () => {
    const pos = rules()
      .filter((r) => r.selectors.includes(".side-search"))
      .map((r) => r.decls.get("position"))
      .filter((v) => v !== undefined);
    expect(pos).not.toContain("fixed");
    expect(decl(".side-search-btn", "width")).toBe("100%");
    // The overhang's own number, which existed only to compute where the cap
    // ended. A rule still reading it is a rule still drawing a bulge.
    expect(ruleFor(":root").decls.has("--search-out")).toBe(false);
  });

  /**
   * **And it does not glow.** It had a resting bloom while it was a lit pill
   * floating half over the canvas with nothing else to find it by. In a column
   * under the app's own name a field that looks like a field is found, and the
   * standing rule is that the graph is the only light source — with the
   * bioluminescence switch as the single exception, because glowing is what
   * *it* does.
   */
  it("takes no resting glow, which is the app's own standing rule", () => {
    const resting = rules()
      .filter((r) => r.selectors.includes(".side-search-btn"))
      .map((r) => r.decls.get("box-shadow") ?? "")
      .join(" ");
    expect(resting).toBe("");
  });
});

describe("the two canvas clusters are one family", () => {
  /**
   * The pair top left is drawn by the same component as the trio top right, and
   * sits the same distance from its own corner. That parity is the whole reason
   * the pill and the floating toggle went: two ordinary controls in a cluster
   * beat one clever object and one bordered tile.
   */
  it("puts the left pair at the same offset as the right trio", () => {
    expect(decl(".viewport-slot", "top")).toBe(decl(".viewport-slot", "top"));
    expect(decl(".viewport-slot", "right")).toBe("var(--s4)");
    expect(decl(".viewport-slot.is-left", "left")).toBe("var(--s4)");
    expect(decl(".viewport-slot.is-left", "right")).toBe("auto");
  });

  /**
   * And the left pair never fades. Chrome auto-hides because the canvas is the
   * page, and that rule was written for a bar of nine buttons — a control that
   * puts the whole panel back has to be findable by somebody who has just
   * realised they want it.
   */
  it("fades the right trio and never the left pair", () => {
    expect(decl(".viewport-slot.idle", "opacity")).not.toBe("1");
    const leftIdle = rules().filter(
      (r) =>
        r.selectors.some((sel) => sel.includes(".is-left")) &&
        (r.decls.get("opacity") ?? "1") !== "1",
    );
    expect(leftIdle.map((r) => r.selector)).toEqual([]);
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
