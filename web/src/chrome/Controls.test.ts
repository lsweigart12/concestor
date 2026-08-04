/**
 * The chrome swap, which is the one thing about this bar that fails silently.
 *
 * Below 620px every control on the canvas is hidden and one round button stands
 * in for all of them. There are four elements in that trade and each of them is
 * a separate rule in a stylesheet: the bar, the canvas-mode panel, the scale
 * switch on the axis footer, and the button that replaces them. Get three of
 * the four right and nothing anywhere errors — the app just opens on a phone
 * with no way to add a species, or with a floating button *and* the bar it was
 * supposed to replace, and neither shows up in a build or a type check.
 *
 * So this asks the stylesheet what actually happens at that width, and asks the
 * component whether the button it draws is the door it claims to be. It is text
 * against text, in the style of `styles.test.ts` and `icons.test.ts`, because
 * this project has no DOM to render into — and like both of those it counts
 * what it read before it trusts a search for an absence.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BINDINGS } from "./bindings";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const CSS = read("../styles.css");
const FAB = read("./PaletteFab.tsx");
const CONTROLS = read("./Controls.tsx");
const APP = read("../App.tsx");
const GRAPH = read("../canvas/Graph.tsx");

/** The body of the first rule whose selector matches, comments stripped. */
function rule(sel: string, within: string = CSS): string {
  const bare = within.replace(/\/\*[\s\S]*?\*\//g, "");
  const m = new RegExp(
    `(?:^|[};])\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`,
    "m",
  ).exec(bare);
  expect(m, `no rule for ${sel}`).not.toBeNull();
  return m![1]!;
}

/** Every `@media (max-width: 620px)` block in the stylesheet. */
function narrowBlocks(): string[] {
  const blocks = [
    ...CSS.matchAll(/@media\s*\(max-width:\s*620px\)\s*\{([\s\S]*?)\n\}/g),
  ].map((m) => m[1]!);
  expect(blocks.length, "no 620px blocks at all").toBeGreaterThan(0);
  return blocks;
}

/** The one `@media (max-width: 620px)` block mentioning `sel`. */
function narrowBlock(sel: string): string {
  const hits = narrowBlocks().filter((b) => b.includes(sel));
  expect(hits, `not exactly one 620px block mentions ${sel}`).toHaveLength(1);
  return hits[0]!;
}

/** The `@media (max-width: 620px)` block that carries the swap. */
function swapBlock(): string {
  return narrowBlock(".palette-fab");
}

describe("the narrow window swaps every control for one button", () => {
  it("is reading the stylesheet and the components at all", () => {
    expect(CSS.length).toBeGreaterThan(1000);
    expect(FAB).toContain("palette-fab");
    expect(CONTROLS).toContain("controls-lead");
  });

  /**
   * All three, in one block. Splitting them across blocks would work and is
   * exactly how the second one gets forgotten: the failure is not a broken
   * layout, it is a panel of switches floating beside a button that already
   * switches them.
   */
  it("hides the bar, the mode panel and the scale switch together", () => {
    const block = swapBlock();
    for (const sel of [".controls", ".canvas-modes", ".axis-foot > .scale-mode"]) {
      expect(block, `${sel} survives below 620px`).toContain(sel);
    }
    expect(
      rule(".controls,\n  .canvas-modes,\n  .axis-foot > .scale-mode", block),
    ).toContain("display: none");
  });

  /**
   * And the button is drawn *only* there. Two doors to the same palette, one of
   * them a circle floating over the tree, is the clutter the swap removes.
   */
  it("draws the button below 620px and nowhere else", () => {
    expect(rule(".palette-fab")).toContain("display: none");
    expect(rule(".palette-fab", swapBlock())).toMatch(/display:\s*inline-flex/);
  });

  /**
   * It rides the axis and any open lane, like the panel it replaces on the
   * other side. Pinned because the failure mode is a button that a drill lane
   * quietly opens underneath and covers — visible only to a reader who has
   * opened one, on a phone.
   */
  it("sits above the timeline and above an open lane", () => {
    const body = rule(".palette-fab");
    expect(body).toContain("var(--axis-h)");
    expect(body).toContain("var(--lane-h");
    expect(body).toContain("right: var(--s4)");
  });
});

describe("the button is the door it says it is", () => {
  /**
   * It opens the palette and nothing else, and it reads that action out of the
   * key table rather than restating its words — the same rule every badge on
   * the bar follows. A button captioned by hand is a button that can end up
   * describing a command it does not run.
   */
  it("opens the palette, captioned from the palette's own row", () => {
    expect(FAB).toContain('binding("palette")');
    expect(FAB).toContain("onOpen");
    // The words come off the row. Nothing quoted in here may be a caption.
    const b = BINDINGS.find((x) => x.id === "palette")!;
    expect(FAB).not.toContain(b.hint);
    expect(FAB).not.toContain(`"${b.label}"`);
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
 */
describe("the afterglow fits the one-button layout", () => {
  it("is reading App.tsx at all", () => {
    expect(APP).toContain("TIP_LINE");
  });

  /**
   * One string, spread the same way into both surfaces. The bar's tray and the
   * button's flyout are the same invitation at two widths, and an invitation
   * worded differently depending on the window is two invitations.
   */
  it("sends the same sentence to the bar and to the button", () => {
    const line = /const TIP_LINE = "([^"]+)"/.exec(APP)?.[1];
    expect(line, "TIP_LINE is not a plain string literal").toBeTruthy();
    expect(
      [...APP.matchAll(/\{\.\.\.\(tipShown \? \{ tip: TIP_LINE \} : \{\}\)\}/g)],
      "TIP_LINE does not reach exactly two surfaces",
    ).toHaveLength(2);
    // And neither surface restates it. The words live in one place.
    expect(FAB).not.toContain(line!);
  });

  /**
   * The words, not a flag. A boolean lit a ring on an unlabelled circle, which
   * is a signal a reader cannot read — and it is the type that stops that
   * coming back, because a pulse with no sentence is now unrepresentable.
   */
  it("gives the button the sentence and not a boolean", () => {
    expect(FAB).toContain("tip?: string");
    expect(FAB).not.toContain("tip?: boolean");
    expect(FAB).toContain("palette-fab-tip");
    expect(FAB).toContain("{tip}");
  });

  /** Drawn only where the button it hangs off is drawn. */
  it("draws the flyout below 620px and nowhere else", () => {
    expect(rule(".palette-fab-tip")).toContain("display: none");
    expect(rule(".palette-fab-tip", swapBlock())).toMatch(/display:\s*block/);
  });

  /**
   * And it travels with the button. Both read the same shelf expression, so a
   * drill lane opening under them moves the pair — a flyout counted off
   * `--axis-h` alone would be left behind on the lane's roof.
   */
  it("hangs the flyout off the button's own shelf", () => {
    const body = rule(".palette-fab-tip");
    expect(body).toContain("var(--axis-h)");
    expect(body).toContain("var(--lane-h");
    // Out the left, which is the only side not already spoken for, and clear
    // of the 54px circle it points at.
    expect(body).toMatch(/right:\s*calc\([^;]*54px/);
    expect(body).toContain("pointer-events: none");
  });

  /**
   * The toast stack gets the width and then has to clear the button, and the
   * two belong in one block because the first is what makes the second
   * necessary: `left: 50%` sizes the stack against half the window, and undoing
   * that is what lets a notice reach across the only control there is.
   */
  it("widens the toast stack and lifts it over the button", () => {
    const body = rule(".toasts", narrowBlock(".toasts"));
    expect(body).toMatch(/left:\s*0/);
    expect(body).toMatch(/right:\s*0/);
    expect(body).toMatch(/transform:\s*none/);
    expect(body).toContain("var(--axis-h)");
    expect(body).toContain("var(--lane-h");
  });

  /**
   * And nowhere else. Above this width the half-window ceiling is doing a
   * second job nobody wrote down — holding the stack off the canvas-mode panel
   * in the opposite corner, a control at z-index 6 under a notice at 45 — which
   * is why the fix is confined to the width where that panel is not drawn.
   */
  it("leaves the wide window's stack alone", () => {
    const body = rule(".toasts");
    expect(body).toContain("left: 50%");
    expect(body).toContain("translateX(-50%)");
  });

  /**
   * The next question goes to the top, which is the half of the screen the
   * hidden control bar left empty. Pinned with `bottom: auto` because a fixed
   * box left pinned at both edges stretches the card down the whole window and
   * reports nothing.
   */
  it("moves the next-question card to the top edge", () => {
    const body = rule(".next-up", narrowBlock(".next-up"));
    expect(body).toMatch(/top:\s*var\(--s3\)/);
    expect(body).toMatch(/bottom:\s*auto/);
    // Its entry has to know which edge it is pinned to, or it slides up out of
    // an edge it is no longer leaving from.
    expect(body).toContain("next-up-in-top");
    expect(CSS).toContain("@keyframes next-up-in-top");
  });

  /**
   * The desktop tray comes out of the outline's side rather than dropping from
   * the foot of the bar, and the `width` beside its `max-width` is the trap
   * that goes with anchoring it there: `left: 100%` leaves a shrink-to-fit box
   * no room at all inside its containing block, so the sentence collapsed to
   * its longest word under a cap it could not reach.
   */
  it("brings the bar's tray out of the outline's right edge", () => {
    expect(rule(".control-tip")).toContain("position: relative");
    const body = rule(".control-tip-tray");
    expect(body).toContain("left: 100%");
    expect(body).toContain("width: max-content");
    expect(body).toContain("pointer-events: none");
    // Centred on the outline, like the flyout on the other layout, so it holds
    // the midline whether the copy takes one line or three.
    expect(body).toMatch(/top:\s*50%/);
    expect(body).toContain("translateY(-50%)");
  });
});

/**
 * The other chrome swap, and it fails the same way: silently, in text.
 *
 * The empty canvas is a centred column and the canvas-mode panel is pinned
 * bottom-left, so on a short window a key row was drawn straight through a
 * chip. Nothing errors when that comes back: two pieces of text overlap, at a
 * size nobody is testing at. The stylesheet's own narrow-window block is what
 * keeps them apart now, and it is written against the *one-chip* panel — so
 * what has to hold here is that the empty canvas draws that panel and no other.
 *
 * Two of the three go and one stays, and the split is the argument. With no
 * marks on screen `labels` and `ages` are switches that visibly do nothing —
 * which the bar already refuses by disabling `fit`, `isolate` and `step` on
 * this same canvas. Bioluminescence is not in that set: its subject is the
 * water, the empty canvas's invitation lights it, and `canvas/bootLight.ts`
 * carries that reasoning. So one flag still has to drive both surfaces: a
 * second expression that means *nearly* "nothing is drawn" would put the
 * invitation and the panel into different states and report nothing.
 */
describe("the empty canvas draws one chip under its invitation", () => {
  it("is reading App.tsx and the canvas at all", () => {
    expect(APP).toContain('className="boot"');
    expect(GRAPH).toContain('className="canvas-modes"');
  });

  /**
   * One expression, named once. Both readers below are matched against this
   * name rather than against the shape of the test, so inlining either of them
   * breaks here rather than on somebody's laptop at 700×800.
   */
  it("asks whether anything is drawn in one place", () => {
    expect(APP).toMatch(
      /const nothingDrawn = tree\.induced\.rendered\.length === 0;/,
    );
  });

  /** The invitation is drawn from it… */
  it("gates the invitation on that flag", () => {
    expect(APP).toMatch(
      /\{nothingDrawn && !paletteOpen && \(\s*<div className="boot">/,
    );
  });

  /**
   * …and the canvas is told the same thing rather than working it out again.
   * `induced` is right there in the props, which is exactly what makes the
   * second copy easy to write and impossible to see.
   */
  it("hands the same flag to the canvas", () => {
    expect(APP).toContain("empty={nothingDrawn}");
    expect(GRAPH).toMatch(/\{empty \? \(/);
    expect(GRAPH).toMatch(/<div className="canvas-modes is-lone">/);
    // And works it out from nothing else. A local recount is the divergence
    // this whole arrangement exists to prevent.
    expect(GRAPH).not.toContain("induced.rendered.length === 0");
  });

  /**
   * The one-chip branch holds exactly one chip, and the stylesheet is why this
   * is worth asserting rather than reading.
   *
   * `styles.css`'s narrow-window block measures a panel about 52px tall ending
   * some 110px off the bottom and drops the invitation's keys column where the
   * two would meet. A second chip added to this branch makes that panel half
   * again as tall, moves its top up past the bound that was measured, and the
   * overlap comes back at a window size nobody is looking at — which is the
   * exact failure this whole `describe` exists for.
   */
  it("puts one switch in that branch and only one", () => {
    const lone = GRAPH.slice(
      GRAPH.indexOf('<div className="canvas-modes is-lone">'),
      GRAPH.indexOf("</div>", GRAPH.indexOf('<div className="canvas-modes is-lone">')),
    );
    expect(lone).toContain("<BiolumToggle");
    expect(lone).not.toContain("<LabelsToggle");
    expect(lone).not.toContain("<AgesToggle");
  });

  /**
   * The switch that stays is offered on exactly the terms it is offered on
   * everywhere else. `BiolumRenderer.supported()` is asked once at module
   * scope, and a browser without WebGL2 gets no switch on the empty canvas
   * either — a switch that is offered and then turns the canvas black is worse
   * than one that is not offered, and that is not a rule the empty canvas gets
   * to relax to show off its own light.
   */
  it("gates the empty canvas's chip on WebGL2 too", () => {
    expect([...GRAPH.matchAll(/BIOLUM_AVAILABLE &&/g)].length).toBe(2);
  });

  /**
   * A swap and not a removal, on the rule the narrow window already stands on:
   * every control has a command. All three keep their rows, so the palette and
   * the keyboard still reach every setting the shortened panel drops — which is
   * also why nothing here disables them.
   */
  it("leaves all three reachable while two of them are gone", () => {
    for (const id of ["labels", "ages", "biolum"]) {
      expect(
        BINDINGS.some((b) => (b.id as string) === id),
        `${id} lost its key with the panel`,
      ).toBe(true);
    }
  });
});

describe("share is the one control with no key", () => {
  /**
   * `bindings.ts` is every key this app claims, and share claims none on
   * purpose. That makes it the only button on the bar whose words cannot come
   * from a row — so `Controls` requires it to carry them, and must print no
   * badge for it. A fabricated badge would be the key surface disagreeing with
   * itself in the one place a reader can see both.
   */
  it("has no row in the key table", () => {
    expect(BINDINGS.some((b) => (b.id as string) === "share")).toBe(false);
  });

  it("prints a badge only where there is a key to print", () => {
    expect(CONTROLS).toContain("kbd !== undefined && ");
  });

  /**
   * Share used to need a class of its own, because the bar hid every label
   * below 720px and a button with no badge and no word is an empty button.
   * The hiding is gone — a control carries its word at every width the bar is
   * drawn at — so the exception is gone with it, and the guarantee that share
   * has words sits where it always belonged: in `ControlAction`'s union.
   *
   * Asserted rather than deleted, because a stylesheet is where this comes
   * back silently. A rule hiding `.control-label` at any width is the failure
   * this test exists to catch.
   */
  it("needs no exception, because no width hides a label", () => {
    expect(CONTROLS).not.toContain("no-key");
    // Any selector list reaching `.control-label`, not just that one word on
    // its own — the rule that went was `.control-label { display: none }` and
    // the one that comes back will be spelled slightly differently.
    expect(CSS).not.toMatch(/\.control-label[^{}]*\{[^{}]*display:\s*none/);
  });
});
