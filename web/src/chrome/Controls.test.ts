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

/** The `@media (max-width: 620px)` block that carries the swap. */
function swapBlock(): string {
  const blocks = [
    ...CSS.matchAll(/@media\s*\(max-width:\s*620px\)\s*\{([\s\S]*?)\n\}/g),
  ]
    .map((m) => m[1]!)
    .filter((b) => b.includes(".palette-fab"));
  expect(blocks, "no 620px block mentions .palette-fab").toHaveLength(1);
  return blocks[0]!;
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
    // And the button says so, because a label hidden at 720px would otherwise
    // leave it empty. See the `.no-key` rule.
    expect(CONTROLS).toContain("no-key");
    expect(rule(".control.no-key .control-label")).toContain("display: inline");
  });
});
