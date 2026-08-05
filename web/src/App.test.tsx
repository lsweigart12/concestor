/**
 * The app on a browser that can do everything, as a reader meets it.
 *
 * Six claims used to be made about `App.tsx` and `canvas/Graph.tsx` by reading
 * them as strings — an exact spread expression *including its whitespace*, an
 * identifier counted twice with `matchAll`, a regex anchored to end-of-line, and
 * `expect(GRAPH).toMatch(/\{empty \? \(/)`. None of them could tell a component
 * that renders from one that does not, and all of them break on a reformat. The
 * decisions were good; the instrument was wrong. This renders the app.
 *
 * Rendering all of it, rather than mocking the canvas, is deliberate and it is
 * what makes three of these tests possible at all: the invitation's sentence
 * goes to the control bar *and* to the button that replaces it below 620px, and
 * that second surface is drawn inside `Graph`. A stub there would leave the
 * interesting half of the claim untested and looking covered.
 *
 * The browser here says yes to WebGL2 and yes to fullscreen.
 * `App.bare.test.tsx` is the same app on one that says no to both, and the two
 * are separate files because both answers are module-scope constants read once
 * on first import.
 */

import { describe, expect, it, vi } from "vitest";
import { SOURCES } from "./canvas/bootLight";
import {
  dismissAnswer,
  drawOpening,
  openPalette,
  renderApp,
} from "./test/appHarness";

/**
 * A browser with a GPU and a fullscreen API, arranged before anything imports
 * `Graph.tsx` or `chrome/fullscreen.ts`.
 *
 * `BiolumRenderer.supported()` asks a canvas for a `webgl2` context and then
 * for a float colour buffer; jsdom's `getContext` is not implemented at all, so
 * the answer is otherwise always no. Nothing here draws with the context — the
 * mode is off unless a reader turns it on — so it only has to be non-null and
 * to answer `getExtension`.
 */
vi.hoisted(() => {
  Object.defineProperty(document, "fullscreenEnabled", {
    value: true,
    configurable: true,
  });
  HTMLCanvasElement.prototype.getContext = function getContext(kind: string) {
    return kind === "webgl2" ? ({ getExtension: () => ({}) } as never) : null;
  } as typeof HTMLCanvasElement.prototype.getContext;
});

const TIP_LINE = "Now put something of your own beside it";

const chips = () => [...document.querySelectorAll(".canvas-modes .mode-chip")];
const panel = () => document.querySelector(".canvas-modes");

describe("one expression decides that nothing is drawn", () => {
  /**
   * The invitation and the canvas are told the same thing rather than working
   * it out separately — `induced.rendered` is right there in the canvas's props,
   * which is exactly what makes a second count easy to write and impossible to
   * see. What that buys is asserted rather than the wiring: the two surfaces
   * never disagree about whether the canvas is empty.
   */
  it("draws the invitation over an empty canvas, under the short panel", async () => {
    await renderApp();
    expect(document.querySelector(".boot")).not.toBeNull();
    expect(panel()?.className).toBe("canvas-modes is-lone");
  });

  it("takes both away together once there is a tree", async () => {
    await renderApp();
    await drawOpening();
    expect(document.querySelector(".boot")).toBeNull();
    expect(panel()?.className).toBe("canvas-modes");
  });
});

describe("the empty canvas draws one chip under its invitation", () => {
  /**
   * The stylesheet is why this is worth asserting rather than reading. The
   * narrow-window block measures a panel about 52px tall ending some 110px off
   * the bottom, and drops the invitation's key rows where the two would meet. A
   * second chip in that branch makes the panel half again as tall, moves its top
   * past the bound that was measured, and the overlap comes back at a window
   * size nobody is looking at.
   */
  it("puts one switch in that branch and only one", async () => {
    await renderApp();
    expect(chips()).toHaveLength(1);
    expect(chips()[0]?.className.split(/\s+/)).toContain("biolum-mode");
  });

  /**
   * Two of the three go and one stays, and the split is the argument. `labels`
   * and `ages` annotate marks, and with none on screen they are switches a
   * reader can throw and watch do nothing — which the bar already refuses by
   * disabling `fit`, `isolate` and `step` on this same canvas. Bioluminescence
   * is not in that set: its subject is the water, and the empty canvas's
   * invitation is what lights it.
   */
  it("brings the other two back the moment there is something to annotate", async () => {
    await renderApp();
    await drawOpening();
    expect(chips()).toHaveLength(3);
    expect(chips().map((c) => c.getAttribute("aria-label"))).toEqual([
      "Labels",
      "Ages",
      "Bioluminescence",
    ]);
  });

  /**
   * A swap and not a removal, on the rule the narrow window already stands on:
   * every control has a command. All three keep their rows, so the palette
   * still reaches every setting the shortened panel drops — which is also why
   * nothing here is disabled.
   */
  it("leaves all three reachable while two of them are gone", async () => {
    await renderApp();
    const rows = await openPalette();
    for (const setting of ["labels", "ages", "bioluminescence"]) {
      expect(
        rows.some((t) => t.toLowerCase().includes(setting)),
        `${setting} lost its command with the panel`,
      ).toBe(true);
    }
  });
});

/**
 * Fullscreen, which is offered on the browser's terms rather than on ours.
 *
 * The bar's own rule is "unavailable actions are disabled rather than hidden",
 * and this is the exception — a greyed button saying the browser will never do
 * it tells a reader nothing they can act on. The failure that follows from
 * making that call *twice* is the one worth pinning: the button gated on one
 * expression and the palette row on another, so an iPhone gets a command for a
 * thing that cannot happen, or a desktop loses one that can.
 */
describe("fullscreen is offered on both surfaces or on neither", () => {
  it("offers it on the bar and in the palette where the browser will", async () => {
    await renderApp();
    expect(
      [...document.querySelectorAll(".control-label")].map(
        (n) => n.textContent,
      ),
    ).toContain("Fullscreen");
    const rows = await openPalette();
    expect(rows.some((t) => /fullscreen/i.test(t))).toBe(true);
  });
});

/**
 * The invitation after an opening has been read.
 *
 * One string, spread the same way into two surfaces. The bar's tray and the
 * button's flyout are the same invitation at two widths, and an invitation
 * worded differently depending on the window is two invitations — which is a
 * thing only a rendered app can be asked, because the two are built in
 * different components and the second is inside the canvas.
 */
describe("the invitation says one thing on both surfaces", () => {
  it("says nothing at all until the reader is done with the answer", async () => {
    await renderApp();
    await drawOpening();
    expect(document.querySelector(".control-tip-tray")).toBeNull();
    expect(document.querySelector(".palette-fab-tip")).toBeNull();
  });

  it("sends the same sentence to the bar and to the button", async () => {
    await renderApp();
    await drawOpening();
    await dismissAnswer();
    const tray = document.querySelector(".control-tip-tray");
    const flyout = document.querySelector(".palette-fab-tip");
    expect(tray?.textContent).toBe(TIP_LINE);
    expect(flyout?.textContent).toBe(TIP_LINE);
  });

  /** And the bar outlines the three doors it is pointing at. */
  it("outlines the lead slot while it is making the offer", async () => {
    await renderApp();
    await drawOpening();
    await dismissAnswer();
    expect(document.querySelectorAll(".control-tip")).toHaveLength(1);
  });
});

/**
 * `canvas/bootLight.ts` resolves four CSS selectors against markup three other
 * files own, none of which knows it exists. Rename `.carousel-art` and nothing
 * throws, nothing fails, and the canvas is exactly as dark as it was before the
 * feature was written.
 *
 * That used to be checked by matching the class names against `className=`
 * attributes in four files as text — which cannot tell a class that is applied
 * from one that is discussed in a comment, and could not see a selector's
 * *shape* at all. Here they are run against the document.
 */
describe("the empty canvas's lights find the things they light", () => {
  it("resolves every selector bootLight measures", async () => {
    await renderApp();
    const boot = document.querySelector(".boot");
    expect(boot).not.toBeNull();
    for (const s of SOURCES) {
      const root = s.scope === "boot" ? boot! : document;
      expect(
        root.querySelector(s.sel),
        `${s.sel} matches nothing`,
      ).not.toBeNull();
    }
  });
});
