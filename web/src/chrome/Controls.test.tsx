/**
 * The control bar, as a reader meets it.
 *
 * The claims here were `expect(CONTROLS).toContain("kbd !== undefined && ")`
 * and `expect(CONTROLS).not.toContain("no-key")` — a test that reads
 * `Controls.tsx` as a string and asserts that a particular expression appears
 * in it. That cannot tell a badge that is printed from one that is computed and
 * thrown away, it passes for a component that renders nothing, and it goes red
 * the moment somebody re-wraps the line. The decisions underneath are worth
 * keeping, so they are asked of the rendered bar.
 *
 * Four of them, and each is a rule the whole key surface stands on:
 *
 * 1. **A badge is printed only where the press would do it.** Share has no row
 *    in `bindings.ts` and must show no key; every other control shows the one
 *    its row claims. A fabricated badge is the key table disagreeing with
 *    itself in the one place a reader can see both.
 * 2. **The keyless control carries its own words**, and needs no class of its
 *    own to do it. `ControlAction`'s union is what makes the words mandatory;
 *    that they are *drawn* is this file's business.
 * 3. **`aria-disabled`, not `disabled`.** A `disabled` button fires no pointer
 *    events and takes no focus, and the five disabled controls this app writes
 *    are the ones whose tooltip is the sentence saying what would make them
 *    work. So it stays a real button that announces itself disabled and does
 *    nothing when pressed, and the reason stays reachable.
 * 4. **The invitation outlines a contiguous run of whole groups**, never a
 *    button, and never a group holding something that cannot be pressed.
 *
 * `is-command` is here too, on another owner's behalf: `canvas/bootLight.ts`
 * resolves `.control.is-command` as a light source on the empty canvas, and
 * `bootLight.test.ts` could only ask whether that string appears in this file.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Controls, type ControlGroup } from "./Controls";
import { TooltipLayer } from "./Tooltip";
import { binding } from "./bindings";
import { CHAIN_MS, OPEN_MS } from "./tip";

const LINE = "Now put something of your own beside it";

const bar = (groups: ControlGroup[], tip?: string) =>
  render(
    <>
      <Controls
        groups={groups}
        idle={false}
        busy={false}
        {...(tip === undefined ? {} : { tip })}
      />
      <TooltipLayer />
    </>,
  );

/**
 * A control by the word printed on it.
 *
 * The badge rides in the same accessible name and nothing separates the two
 * spans, so `Commands` is reached as `PCommands` — matched at the end rather
 * than whole, which is also what tells `Fit` from `Fit here`.
 */
const button = (label: string) =>
  screen.getByRole("button", { name: new RegExp(`${label}$`) });

const lead = (): ControlGroup[] => [
  {
    name: "Concestor",
    slot: "lead",
    brand: true,
    actions: [{ id: "palette", run: () => {} }],
  },
];

describe("a badge is printed only where there is a key to print", () => {
  it("prints the key the row claims", () => {
    bar(lead());
    expect(within(button("Commands")).getByText("P").className).toBe("kbd");
  });

  /**
   * Share is the one button on this bar with no row in the key table, so it has
   * no letter to print — and inventing one is what this refuses.
   */
  it("prints none for the one control with no key", () => {
    bar([
      {
        name: "Canvas",
        slot: "trail",
        actions: [
          { id: "share", label: "Share", hint: "Copy a link", run: () => {} },
        ],
      },
    ]);
    const share = button("Share");
    expect(share.querySelector(".kbd")).toBeNull();
    // And it carries its words anyway, which is what the union guarantees and
    // what a reader needs: a button with no badge and no word is an empty
    // button.
    expect(share.textContent).toBe("Share");
  });

  /**
   * No marker class either. The keyless button had one once, for a 720px rule
   * that hid every label and then had to put share's back; the rule is gone and
   * the class went with it. `swap.test.ts` holds the other half — that no width
   * hides a label — because a stylesheet is where this comes back.
   */
  it("gives the keyless control no class of its own", () => {
    bar([
      {
        name: "Canvas",
        slot: "trail",
        actions: [
          { id: "clear", run: () => {} },
          { id: "share", label: "Share", hint: "Copy a link", run: () => {} },
        ],
      },
    ]);
    expect(button("Share").className).toBe(button("Clear").className);
  });

  /** Under a caption, a verb — so an override wins where one is given. */
  it("lets the caller spend a word differently", () => {
    bar([
      {
        name: "Add species",
        slot: "lead",
        actions: [{ id: "species", label: "Search", run: () => {} }],
      },
    ]);
    expect(button("Search").textContent).toBe(
      `${binding("species").kbd}Search`,
    );
  });
});

/**
 * The hover half, which needs a clock.
 *
 * `Tooltip.tsx` keeps `active` and `lastClosed` at module scope and `openDelay`
 * answers 0 within `CHAIN_MS` of the last close, so one test's tooltip is the
 * next test's initial condition — and merely advancing the timers does not
 * clear it, because `useFakeTimers` resets the clock to system time while the
 * previous test left its timestamp further along a fake one. `Tooltip.test.tsx`
 * §`coldStart` is the account; this is the same trick.
 */
describe("an unavailable control explains itself and does nothing", () => {
  let clock = Date.now() + 3_600_000;
  beforeEach(() => {
    vi.useFakeTimers();
    clock += CHAIN_MS * 10;
    vi.setSystemTime(clock);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const hover = (el: Element) => {
    // React derives `onPointerEnter` from a delegated `pointerover`; a
    // `pointerenter` dispatched directly does not bubble and reaches nothing.
    fireEvent.pointerOver(el, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(OPEN_MS);
    });
  };

  const off: ControlGroup[] = [
    {
      name: "Navigate",
      slot: "rest",
      actions: [
        {
          id: "fit",
          run: () => {
            throw new Error("a disabled control ran its action");
          },
          disabledBecause: "Nothing on the canvas to frame yet",
        },
      ],
    },
  ];

  /**
   * `disabled` would be the obvious attribute and it is the wrong one: it fires
   * no pointer events in any browser, which puts the reason out of reach of the
   * pointer *and* of the keyboard. The reason is the whole point of the state.
   */
  it("announces itself disabled without becoming unreachable", () => {
    bar(off);
    const fit = button("Fit");
    expect(fit.getAttribute("aria-disabled")).toBe("true");
    expect(fit.hasAttribute("disabled")).toBe(false);
  });

  it("runs nothing when pressed", () => {
    bar(off);
    expect(() => button("Fit").click()).not.toThrow();
  });

  it("says what would make it work, in place of its usual hint", () => {
    bar(off);
    hover(button("Fit"));
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Nothing on the canvas to frame yet",
    );
  });

  /** And an available one says what it does, in the key table's own words. */
  it("takes an available control's tooltip from its row", () => {
    bar([
      {
        name: "Navigate",
        slot: "rest",
        actions: [{ id: "fit", run: () => {} }],
      },
    ]);
    hover(button("Fit"));
    expect(screen.getByRole("tooltip").textContent).toBe(binding("fit").hint);
  });
});

describe("the invitation outlines whole groups, and only pressable ones", () => {
  const marked = (over: Partial<ControlGroup>[] = [{}, {}]): ControlGroup[] => [
    {
      name: "Concestor",
      slot: "lead",
      brand: true,
      actions: [{ id: "palette", run: () => {}, tip: true }],
      ...over[0],
    },
    {
      name: "Add species",
      slot: "lead",
      actions: [
        { id: "species", label: "Search", run: () => {}, tip: true },
        { id: "random-species", run: () => {}, tip: true },
      ],
      ...over[1],
    },
  ];

  it("draws no outline and no tray when nothing is being pointed at", () => {
    bar(lead(), LINE);
    expect(document.querySelector(".control-tip")).toBeNull();
    expect(document.querySelector(".control-tip-tray")).toBeNull();
  });

  /**
   * One outline round both groups, not one each: it is a single invitation with
   * three doors, and three separately decorated buttons said there were three.
   */
  it("wraps a contiguous run of marked groups in one outline", () => {
    bar(marked(), LINE);
    const outlines = document.querySelectorAll(".control-tip");
    expect(outlines).toHaveLength(1);
    expect(
      within(outlines[0] as HTMLElement).getAllByRole("group"),
    ).toHaveLength(2);
  });

  it("hangs the tray inside the outline it is pointing at", () => {
    bar(marked(), LINE);
    const tray = document.querySelector(".control-tip-tray")!;
    expect(tray.textContent).toBe(LINE);
    expect(tray.closest(".control-tip")).not.toBeNull();
  });

  /**
   * A box around something that cannot be pressed says the opposite of what the
   * invitation says, so one disabled action takes its whole group out of the
   * run.
   */
  it("refuses a group holding an action that cannot be pressed", () => {
    bar(
      marked([
        {},
        {
          actions: [
            {
              id: "species",
              run: () => {},
              tip: true,
              disabledBecause: "not yet",
            },
          ],
        },
      ]),
      LINE,
    );
    const outlines = document.querySelectorAll(".control-tip");
    expect(outlines).toHaveLength(1);
    expect(
      within(outlines[0] as HTMLElement).getAllByRole("group"),
    ).toHaveLength(1);
  });
});

/**
 * The class `canvas/bootLight.ts` resolves as a light on the empty canvas.
 *
 * Every control on the bar is drawn by one component, so the obvious selector —
 * `.controls-lead .control` — reaches three buttons and would light the whole
 * group. The class is conditional on the action's own id, and a refactor
 * applying it unconditionally left every string in `bootLight.test.ts` intact.
 */
describe("the command button is marked, and it alone", () => {
  it("puts is-command on the palette and on nothing else", () => {
    bar([
      ...lead(),
      {
        name: "Add species",
        slot: "lead",
        actions: [
          { id: "species", label: "Search", run: () => {} },
          { id: "random-species", run: () => {} },
        ],
      },
    ]);
    const lit = [...document.querySelectorAll(".control.is-command")];
    expect(lit).toHaveLength(1);
    expect(lit[0]).toBe(button("Commands"));
  });
});
