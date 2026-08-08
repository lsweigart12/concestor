/**
 * The same app on a browser that will do neither.
 *
 * `BIOLUM_AVAILABLE` and `FULLSCREEN_AVAILABLE` are both `const`s at module
 * scope — asked once, before anything is drawn, because a control that appears
 * halfway through a session is worse than one that was never there. That is the
 * right design and it is why this is a second file: a module graph is evaluated
 * once per test file, so the two answers cannot be changed inside one.
 *
 * Nothing is stubbed here. jsdom implements no WebGL2 and reports
 * `document.fullscreenEnabled` false, so this *is* the bare browser, and the
 * app has to be honest with it. `App.test.tsx` is the same app with both.
 *
 * The rule being pinned is one the app deliberately breaks its own rule for.
 * Unavailable actions are normally **disabled rather than hidden** — a greyed
 * `fit` says "add a species and this works". These two are **absent**, because
 * a greyed button saying the browser will never do it tells the reader nothing
 * they can act on. And the failure that follows is from making that call
 * *twice*: gate the button on one expression and the palette row on another,
 * and an iPhone gets a command for a thing that cannot happen.
 */

import { describe, expect, it } from "vitest";
import { drawOpening, openPalette, renderApp } from "./test/appHarness";

describe("fullscreen is offered on both surfaces or on neither", () => {
  it("draws no button where the browser has no fullscreen", async () => {
    await renderApp();
    // The cluster is drawn: this is an absence inside something, not an empty
    // page. Two survive it — the fit and the isolate — and both are about the
    // view rather than about the browser.
    const view = [...document.querySelectorAll(".viewport-btn")].map((n) =>
      n.getAttribute("aria-label"),
    );
    expect(view.length).toBeGreaterThan(1);
    expect(view).not.toContain("Fullscreen");
  });

  it("offers no command for it either", async () => {
    await renderApp();
    const rows = await openPalette();
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.some((t) => /fullscreen/i.test(t))).toBe(false);
  });
});

/**
 * And the light, on the same terms.
 *
 * The mode is one instanced draw call and six passes on the GPU; there is no
 * software path. A switch that is offered and then turns the canvas black is
 * worse than a switch that is not offered — and the empty canvas does not get
 * to relax that rule to show off its own light, which is why the question is
 * asked in both of the canvas's branches.
 */
describe("bioluminescence is offered on every canvas or on none", () => {
  it("draws the other two and not the light", async () => {
    await renderApp();
    await drawOpening();
    const chips = [...document.querySelectorAll(".side-modes .mode-chip")];
    expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Labels",
      "Dates",
    ]);
  });

  /**
   * And the section they are in is still drawn, which is the half that would
   * fail silently. A capability check that took the caption with it would leave
   * a heading over nothing on one browser and two switches on another.
   */
  it("keeps the section the missing switch would have been in", async () => {
    await renderApp();
    await drawOpening();
    expect(document.querySelector(".side-modes")).not.toBeNull();
  });

  /** The command goes on being offered, because the palette is not a control. */
  it("keeps the command, which is the only surface that can explain itself", async () => {
    await renderApp();
    const rows = await openPalette();
    expect(rows.some((t) => /bioluminescence/i.test(t))).toBe(true);
  });
});
