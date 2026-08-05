/**
 * The chrome swap, which is the one thing about this bar that fails silently.
 *
 * Below 620px every control on the canvas is hidden and one round button stands
 * in for all of them. There are four elements in that trade and each is a
 * separate rule in a stylesheet: the bar, the canvas-mode panel, the scale
 * switch on the axis footer, and the button that replaces them. Get three of
 * the four right and nothing anywhere errors — the app just opens on a phone
 * with no way to add a species, or with a floating button *and* the bar it was
 * supposed to replace, and neither shows up in a build or a type check.
 *
 * So this asks the stylesheet what actually happens at that width. It used to
 * ask by regex and it now asks `test/css.ts`, which parses the sheet: a rule
 * body matched as `\{([^{}]*)\}` cannot survive a nested rule, and a media block
 * captured with a `\n\}` terminator depends on the closing brace being at column
 * zero. Neither is a fact about this app.
 *
 * **What used to be here and is not any more** is everything that could be asked
 * of a rendered component. `Controls.test.tsx`, `PaletteFab.test.tsx` and
 * `App.test.tsx` carry those, and they carry them better: whether the button
 * opens the palette, whether the invitation reaches both surfaces, whether the
 * empty canvas draws one chip. This file is left with the half a document
 * cannot answer, because jsdom lays nothing out and applies no stylesheet —
 * which is exactly the half that is worth reading out of the CSS.
 */
import { describe, expect, it } from "vitest";
import { BINDINGS } from "./bindings";
import {
  decl,
  keyframes,
  lineOf,
  narrower,
  narrowerFor,
  ruleFor,
  rules,
} from "../test/css";

/** The `@media (max-width: 620px)` block that carries the swap. */
const swap = () => narrowerFor(620, ".palette-fab");

describe("the narrow window swaps every control for one button", () => {
  it("is reading the stylesheet at all", () => {
    expect(rules().length).toBeGreaterThan(100);
    expect(narrower(620).length).toBeGreaterThan(0);
  });

  /**
   * All three, in one block. Splitting them across blocks would work and is
   * exactly how the second one gets forgotten: the failure is not a broken
   * layout, it is a panel of switches floating beside a button that already
   * switches them.
   */
  it("hides the bar, the mode panel and the scale switch together", () => {
    const hidden = ruleFor(".controls", swap());
    for (const sel of [
      ".controls",
      ".canvas-modes",
      ".axis-foot > .scale-mode",
    ]) {
      expect(hidden.selectors, `${sel} survives below 620px`).toContain(sel);
    }
    expect(hidden.decls.get("display")).toBe("none");
  });

  /**
   * And the button is drawn *only* there. Two doors to the same palette, one of
   * them a circle floating over the tree, is the clutter the swap removes.
   */
  it("draws the button below 620px and nowhere else", () => {
    expect(decl(".palette-fab", "display")).toBe("none");
    expect(decl(".palette-fab", "display", swap())).toBe("inline-flex");
  });

  /**
   * It rides the axis and any open lane, like the panel it replaces on the
   * other side. Pinned because the failure mode is a button that a drill lane
   * quietly opens underneath and covers — visible only to a reader who has
   * opened one, on a phone.
   */
  it("sits above the timeline and above an open lane", () => {
    const bottom = decl(".palette-fab", "bottom");
    expect(bottom).toContain("var(--axis-h)");
    expect(bottom).toContain("var(--lane-h");
    expect(decl(".palette-fab", "right")).toBe("var(--s4)");
  });

  /**
   * **The block has to be the last thing in the file**, and this is the one
   * claim here that is about *position* rather than content. `.canvas-modes` is
   * declared some two thousand lines below the rules the swap hides it with, and
   * at equal specificity the later rule wins — so a block moved up the file
   * draws a permanently hidden button and nothing else, which is what the first
   * draft of this feature did.
   */
  it("comes after every rule it is overriding", () => {
    const block = lineOf(swap());
    const SWAPPED = [
      ".controls",
      ".canvas-modes",
      ".palette-fab",
      ".palette-fab-tip",
    ];
    const overridden = rules().filter(
      (r) => r.at.length === 0 && r.selectors.some((s) => SWAPPED.includes(s)),
    );
    // Every one of the four declares something unconditionally, or this is
    // measuring a list it has stopped being about.
    expect(
      new Set(
        overridden
          .flatMap((r) => r.selectors)
          .filter((s) => SWAPPED.includes(s)),
      ),
    ).toEqual(new Set(SWAPPED));
    for (const r of overridden) {
      expect(r.line, `${r.selector} is declared after the swap`).toBeLessThan(
        block,
      );
    }
  });
});

/**
 * What an opening leaves behind, once the chrome it was designed around is
 * gone.
 *
 * Three things arrive in the seconds after an opening finishes drawing: the
 * answer, the invitation to add your own, and the offer of another question.
 * On a wide window they have three separate homes — a toast above the axis, a
 * tray under the bar, a card in the right-hand corner — and below 620px two of
 * those homes do not exist and the third is 54px of button. Every one of them
 * then lands on the same bottom-right shelf, at four different z-indexes, and
 * nothing about that errors: it is the offer that matters most drawn underneath
 * the offer that matters least, visible only to somebody holding a phone at the
 * one moment in the app this is asking to be got right.
 *
 * That the two surfaces are handed the *same sentence* is `App.test.tsx`'s;
 * where each of them is drawn is here.
 */
describe("the afterglow fits the one-button layout", () => {
  /** Drawn only where the button it hangs off is drawn. */
  it("draws the flyout below 620px and nowhere else", () => {
    expect(decl(".palette-fab-tip", "display")).toBe("none");
    expect(decl(".palette-fab-tip", "display", swap())).toBe("block");
  });

  /**
   * And it travels with the button. Both read the same shelf expression, so a
   * drill lane opening under them moves the pair — a flyout counted off
   * `--axis-h` alone would be left behind on the lane's roof.
   */
  it("hangs the flyout off the button's own shelf", () => {
    const bottom = decl(".palette-fab-tip", "bottom");
    expect(bottom).toContain("var(--axis-h)");
    expect(bottom).toContain("var(--lane-h");
    // Out the left, which is the only side not already spoken for, and clear
    // of the 54px circle it points at.
    expect(decl(".palette-fab-tip", "right")).toMatch(/^calc\(.*54px/);
    expect(decl(".palette-fab-tip", "pointer-events")).toBe("none");
  });

  /**
   * The toast stack gets the width and then has to clear the button, and the
   * two belong in one block because the first is what makes the second
   * necessary: `left: 50%` sizes the stack against half the window, and undoing
   * that is what lets a notice reach across the only control there is.
   */
  it("widens the toast stack and lifts it over the button", () => {
    const narrow = ruleFor(".toasts", narrowerFor(620, ".toasts"));
    expect(narrow.decls.get("left")).toBe("0");
    expect(narrow.decls.get("right")).toBe("0");
    expect(narrow.decls.get("transform")).toBe("none");
    expect(narrow.decls.get("bottom")).toContain("var(--axis-h)");
    expect(narrow.decls.get("bottom")).toContain("var(--lane-h");
  });

  /**
   * And nowhere else. Above this width the half-window ceiling is doing a
   * second job nobody wrote down — holding the stack off the canvas-mode panel
   * in the opposite corner, a control at z-index 6 under a notice at 45 — which
   * is why the fix is confined to the width where that panel is not drawn.
   */
  it("leaves the wide window's stack alone", () => {
    expect(decl(".toasts", "left")).toBe("50%");
    expect(decl(".toasts", "transform")).toContain("translateX(-50%)");
  });

  /**
   * The next question goes to the top, which is the half of the screen the
   * hidden control bar left empty. Pinned with `bottom: auto` because a fixed
   * box left pinned at both edges stretches the card down the whole window and
   * reports nothing.
   */
  it("moves the next-question card to the top edge", () => {
    const narrow = ruleFor(".next-up", narrowerFor(620, ".next-up"));
    expect(narrow.decls.get("top")).toBe("var(--s3)");
    expect(narrow.decls.get("bottom")).toBe("auto");
    // Its entry has to know which edge it is pinned to, or it slides up out of
    // an edge it is no longer leaving from.
    expect(narrow.decls.get("animation-name")).toBe("next-up-in-top");
    expect(keyframes()).toContain("next-up-in-top");
  });

  /**
   * The desktop tray comes out of the outline's side rather than dropping from
   * the foot of the bar, and the `width` beside its `max-width` is the trap
   * that goes with anchoring it there: `left: 100%` leaves a shrink-to-fit box
   * no room at all inside its containing block, so the sentence collapsed to
   * its longest word under a cap it could not reach.
   */
  it("brings the bar's tray out of the outline's right edge", () => {
    expect(decl(".control-tip", "position")).toBe("relative");
    expect(decl(".control-tip-tray", "left")).toBe("100%");
    expect(decl(".control-tip-tray", "width")).toBe("max-content");
    expect(decl(".control-tip-tray", "pointer-events")).toBe("none");
    // Centred on the outline, like the flyout on the other layout, so it holds
    // the midline whether the copy takes one line or three.
    expect(decl(".control-tip-tray", "top")).toBe("50%");
    expect(decl(".control-tip-tray", "transform")).toContain(
      "translateY(-50%)",
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

describe("share is the one control with no key", () => {
  /**
   * `bindings.ts` is every key this app claims, and share claims none on
   * purpose. That makes it the only button on the bar whose words cannot come
   * from a row, which is what `ControlAction`'s union exists to require and
   * what `Controls.test.tsx` proves is drawn.
   */
  it("has no row in the key table", () => {
    expect(BINDINGS.some((b) => (b.id as string) === "share")).toBe(false);
  });

  /**
   * Share used to need a class of its own, because the bar hid every label
   * below 720px and a button with no badge and no word is an empty button.
   * The hiding is gone — a control carries its word at every width the bar is
   * drawn at — so the exception is gone with it.
   *
   * Asserted rather than deleted, because a stylesheet is where this comes
   * back silently. A rule hiding `.control-label` at any width is the failure
   * this test exists to catch, and "at any width" is why it is asked of every
   * rule in the sheet rather than of one selector.
   */
  it("needs no exception, because no width hides a label", () => {
    const hiding = rules().filter(
      (r) =>
        r.selectors.some((s) => s.includes(".control-label")) &&
        r.decls.get("display") === "none",
    );
    expect(hiding.map((r) => `${r.at.join(" ")} ${r.selector}`)).toEqual([]);
  });
});
