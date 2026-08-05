/**
 * That a reader with a keyboard and no pointer can reach the chrome at all.
 *
 * This is the half of the keyboard surface `bindings.test.ts` cannot see. That
 * file proves what {@link matchKey} answers, one press at a time, and it passed
 * every day of the year the app was unusable: `step` was on bare `Tab`, `App`
 * calls `preventDefault` on everything it matches, and so the focus ring did
 * not move. Every button the bar draws, every segment of the canvas-mode panel
 * and every link on the detail card was unreachable without a mouse. The names
 * and the landmarks were all there — they were just behind a key the app was
 * eating.
 *
 * **The window handler is transcribed rather than imported, and that is the
 * one thing to know before trusting this file.** The behaviour under test is
 * two lines deep inside a 2,400-line `App`, downstream of a store, a canvas and
 * a live API, and mounting all of that to observe a `defaultPrevented` flag
 * would be testing the mock. What is transcribed is small enough to check by
 * eye against `App.tsx` — `matchKey(e)`, return on null, `preventDefault()` —
 * and it imports the *real* `matchKey`, which is where the bug was and where a
 * regression would be. Adding a `Tab` row back to `BINDINGS` fails this file.
 *
 * **What jsdom cannot do, and why nothing here pretends otherwise.** jsdom
 * implements no tab order: `Tab` moves focus nowhere and a focused `<button>`
 * receiving Enter fires no click, because both are the *browser's* default
 * action for a press nobody cancelled. Neither is the app's to get wrong. What
 * is the app's is whether the press survives to reach that default, and that is
 * exactly what these assert. The order itself was walked by hand in Chrome
 * against the running app and reads: the marks on the canvas, the canvas-mode
 * panel, the time scale, the axis links, the detail card, the control bar.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BINDINGS, matchKey } from "./bindings";
import { Controls, type ControlGroup } from "./Controls";
import { ModeChip } from "./ModeChip";

/**
 * `App.tsx`'s global handler, reduced to the part that decides a press's fate.
 *
 * The three guards above it there — a focused text field, an open palette, an
 * open dialog — all *return early*, so none of them can turn an unprevented
 * press into a prevented one. They are omitted for that reason and no other.
 */
function installGlobalHandler(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const action = matchKey(e);
    if (action === null) return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/** A press at the window, and whether the app let it through. */
function press(key: string, shiftKey = false): boolean {
  const e = new KeyboardEvent("keydown", {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

/** The Navigate group, which is where `step` lives. */
function navigateGroup(run = vi.fn()): ControlGroup {
  return {
    name: "Navigate",
    slot: "rest",
    actions: [
      { id: "fit", run },
      { id: "isolate", run },
      { id: "step", run },
    ],
  };
}

describe("the keys the browser needs back", () => {
  it("lets Tab through, so the focus ring can move at all", () => {
    const off = installGlobalHandler();
    try {
      expect(press("Tab")).toBe(false);
      expect(press("Tab", true)).toBe(false);
    } finally {
      off();
    }
  });

  it("lets Enter and Space through, so focus can activate what it lands on", () => {
    // Enter is in the table under the `surface` scope and Space is in no row at
    // all; both must survive the global handler, because both are how a button
    // is pressed without a pointer. Enter's half has a companion in
    // `bindings.test.ts` asserting the scope that makes it structural.
    const off = installGlobalHandler();
    try {
      expect(press("Enter")).toBe(false);
      expect(press(" ")).toBe(false);
    } finally {
      off();
    }
  });

  it("still eats the letters it claims, which is what makes the above a result", () => {
    // Without this the file above would pass just as well against a handler
    // that had been deleted.
    const off = installGlobalHandler();
    try {
      expect(press("n")).toBe(true);
      expect(press("N", true)).toBe(true);
      expect(press("f")).toBe(true);
      expect(press("/")).toBe(true);
      expect(press("l")).toBe(true);
      expect(press("a")).toBe(true);
      expect(press("b")).toBe(true);
    } finally {
      off();
    }
  });

  it("holds no row that could put Tab back", () => {
    // The same claim from the table's side rather than the handler's, because
    // the two failures look identical from a reader's chair and only one of
    // them is visible in a diff of `App.tsx`.
    expect(BINDINGS.filter((b) => b.key === "Tab")).toEqual([]);
  });
});

describe("what Tab arrives at", () => {
  it("gives the control bar a focusable button per action, badge and all", () => {
    render(<Controls groups={[navigateGroup()]} idle={false} busy={false} />);
    // Named from the table, so a row moving letter takes the name with it —
    // `step` printed "Tab" and "Step" here until the key moved to `n`.
    for (const name of ["Fit", "Isolate", "Next"]) {
      const b = screen.getByRole("button", { name: new RegExp(name) });
      b.focus();
      expect(document.activeElement).toBe(b);
    }
  });

  it("keeps a disabled control focusable, because its hint is the useful part", () => {
    // `aria-disabled` rather than `disabled` — a disabled button takes neither
    // focus nor pointer events, and the five disabled controls on this bar
    // carry the tooltips most worth reaching. `Tooltip.tsx` is the account.
    const run = vi.fn();
    render(
      <Controls
        groups={[
          {
            name: "Navigate",
            slot: "rest",
            actions: [{ id: "step", run, disabledBecause: "Nothing to step" }],
          },
        ]}
        idle={false}
        busy={false}
      />,
    );
    const b = screen.getByRole("button", { name: /Next/ });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    b.focus();
    expect(document.activeElement).toBe(b);
  });

  it("gives every canvas-mode segment its own stop", () => {
    render(
      <ModeChip
        className="labels-mode"
        ariaLabel="Labels"
        name="labels"
        kbd="L"
        value="common"
        segments={[
          { value: "off", label: "off", tip: "No words" },
          { value: "common", label: "common", tip: "Common names" },
          { value: "scientific", label: "scientific", tip: "Scientific names" },
        ]}
        onChange={vi.fn()}
      />,
    );
    for (const label of ["off", "common", "scientific"]) {
      const b = screen.getByRole("button", { name: label });
      b.focus();
      expect(document.activeElement).toBe(b);
    }
  });
});
