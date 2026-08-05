/**
 * The narrow window's one control, as a reader meets it.
 *
 * This used to be four `expect(FAB).toContain(…)` calls in `Controls.test.ts`,
 * reading `PaletteFab.tsx` as a string: it contained `binding("palette")`, it
 * contained `onOpen`, it contained `tip?: string` and not `tip?: boolean`. Every
 * one of those is satisfied by a component that renders nothing at all, and none
 * of them survives an author moving a prop onto the next line. What they were
 * *about* is worth keeping, so it is asked of the rendered button instead.
 *
 * The claim under all of them is the same one: **below 620px this button is the
 * whole of the chrome**, so it has to be a real door to the palette, it has to
 * say what it is to a reader who cannot see a label, and when the invitation is
 * made it has to carry the words rather than a glow. Where the stylesheet is
 * what makes a claim true — that the button and its flyout are drawn at this
 * width and nowhere else — the assertion is in `swap.test.ts`, which reads the
 * stylesheet with a parser.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaletteFab } from "./PaletteFab";
import { binding } from "./bindings";

const PALETTE = binding("palette");
const LINE = "Now put something of your own beside it";

describe("the button is the door it says it is", () => {
  it("opens the palette when pressed", () => {
    const onOpen = vi.fn();
    render(<PaletteFab onOpen={onOpen} />);
    screen.getByRole("button").click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  /**
   * The words come off the key table's own row, which is the rule every badge
   * on the bar follows. There is no label to read here — the button is the
   * app's mark in a 54px circle — so the accessible name is the only thing a
   * screen reader has, and a name written by hand is one that can end up
   * describing a command it does not run.
   */
  it("is named from the palette's own row and not by hand", () => {
    render(<PaletteFab onOpen={() => {}} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      `${PALETTE.label} — ${PALETTE.hint}`,
    );
  });

  /** The mark, and nothing else inside the circle. */
  it("wears the app's mark and no word", () => {
    render(<PaletteFab onOpen={() => {}} />);
    expect(screen.getByRole("button").textContent).toBe("");
    expect(document.querySelector(".palette-fab .brand-mark")).not.toBeNull();
  });
});

describe("the invitation is words and not a glow", () => {
  /**
   * `tip` was a boolean once, and the sentence lived only in the bar's props —
   * so a ring was lit on an unlabelled circle, which is a signal a reader
   * cannot read. Asserted on the rendered text rather than on the prop's type,
   * because a `string` prop that is never drawn satisfies `tsc` and fails this.
   */
  it("prints the sentence it was handed", () => {
    render(<PaletteFab onOpen={() => {}} tip={LINE} />);
    expect(screen.getByText(LINE).className).toBe("palette-fab-tip");
  });

  it("says nothing, and does not pulse, when there is nothing to say", () => {
    render(<PaletteFab onOpen={() => {}} />);
    expect(document.querySelector(".palette-fab-tip")).toBeNull();
    expect(screen.getByRole("button").className).toBe("palette-fab");
  });

  it("pulses only while it is carrying the words", () => {
    render(<PaletteFab onOpen={() => {}} tip={LINE} />);
    expect(screen.getByRole("button").className.split(/\s+/)).toContain(
      "is-tip",
    );
  });

  /**
   * Before the button in the DOM, so a screen reader meets the invitation and
   * then the door it is about — which is the order the eye takes them in, the
   * line being out the button's left. Source order is the whole of that
   * guarantee and it is invisible on screen, so it is worth pinning.
   */
  it("comes before the button a reader is being pointed at", () => {
    render(<PaletteFab onOpen={() => {}} tip={LINE} />);
    const line = document.querySelector(".palette-fab-tip")!;
    const button = screen.getByRole("button");
    expect(
      line.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  /** And the caption is never the target. The button is. */
  it("draws the line as a caption rather than a second control", () => {
    render(<PaletteFab onOpen={() => {}} tip={LINE} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
