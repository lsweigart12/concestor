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

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api, type FossilDetail, type FossilTaxon } from "./api";
import { SOURCES } from "./canvas/bootLight";
import { BINDINGS, type ActionId } from "./chrome/bindings";
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

const chips = () => [...document.querySelectorAll(".side-modes .mode-chip")];

describe("one expression decides that nothing is drawn", () => {
  /**
   * The invitation and the canvas are told the same thing rather than working
   * it out separately — `induced.rendered` is right there in the canvas's
   * props, which is exactly what makes a second count easy to write and
   * impossible to see.
   */
  it("draws the invitation over an empty canvas", async () => {
    await renderApp();
    expect(document.querySelector(".boot")).not.toBeNull();
  });

  it("takes it away once there is a tree", async () => {
    await renderApp();
    await drawOpening();
    expect(document.querySelector(".boot")).toBeNull();
  });
});

/**
 * The canvas modes, together in one place.
 *
 * They were chips stacked bottom-left over the axis plus a time-scale switch on
 * the axis footer, and the empty canvas drew only one of them — `labels` and
 * `ages` annotate marks, so with none on screen they were switches a reader
 * could throw and watch do nothing.
 *
 * **That branch is gone, and its argument went with the panel rather than being
 * overruled.** It existed because the panel floated over the canvas, beside the
 * invitation, in a corner the reader's eye was already in; a control doing
 * nothing *there* was noise on the one screen that has to sell the product. In
 * a section captioned CANVAS, below a list captioned TAXA, a switch a reader
 * has not reached the point of using yet is simply further down the panel. What
 * survives is the rule the branch was serving, which is asserted below: every
 * one of them keeps its command.
 */
describe("the canvas modes are one set in one place", () => {
  it("draws all three, in the order the reader meets them", async () => {
    await renderApp();
    await drawOpening();
    expect(chips().map((c) => c.getAttribute("aria-label"))).toEqual([
      "Labels",
      "Dates",
      "Bioluminescence",
    ]);
  });

  /**
   * And the empty canvas draws exactly the same three. The panel is not a
   * canvas-side decoration any more, so there is no collision to dodge and no
   * reason for a control to appear halfway through a session.
   */
  it("draws the same three over an empty canvas", async () => {
    await renderApp();
    expect(chips()).toHaveLength(3);
  });

  /**
   * Every one keeps its command, which is the rule the collapsed panel stands
   * on: with the sidebar shut there is nothing on screen but the canvas, its
   * two corner clusters and the timeline, so a control with no command is a
   * control that cannot be reached at all.
   */
  it("leaves all three reachable from the palette", async () => {
    await renderApp();
    const rows = await openPalette();
    for (const setting of ["labels", "dates", "bioluminescence"]) {
      expect(
        rows.some((t) => t.toLowerCase().includes(setting)),
        `${setting} has no command`,
      ).toBe(true);
    }
  });
});

/**
 * Fullscreen, which is offered on the browser's terms rather than on ours.
 *
 * The standing rule is "unavailable actions are disabled rather than hidden",
 * and this is the exception — a greyed button saying the browser will never do
 * it tells a reader nothing they can act on. The failure that follows from
 * making that call *twice* is the one worth pinning: the button gated on one
 * expression and the palette row on another, so an iPhone gets a command for a
 * thing that cannot happen, or a desktop loses one that can.
 */
describe("fullscreen is offered on both surfaces or on neither", () => {
  it("offers it in the view cluster and in the palette where the browser will", async () => {
    await renderApp();
    expect(
      [...document.querySelectorAll(".viewport-btn")].map((n) =>
        n.getAttribute("aria-label"),
      ),
    ).toContain("Fullscreen");
    const rows = await openPalette();
    expect(rows.some((t) => /fullscreen/i.test(t))).toBe(true);
  });
});

/**
 * The invitation after an opening has been read.
 *
 * It used to be spread into two surfaces — the control bar's tray above 620px
 * and the palette button's flyout below it — and the thing worth pinning was
 * that both got the *same string*, because an invitation worded differently
 * depending on the window is two invitations. There is one surface at every
 * width now, so what is left to check is the timing: it waits for the reader to
 * be done with the answer, and it points at the one door that reaches every
 * other.
 */
describe("the invitation waits for the answer to be read", () => {
  it("says nothing at all until the reader is done with the answer", async () => {
    await renderApp();
    await drawOpening();
    expect(document.querySelector(".side-search-tip")).toBeNull();
    expect(document.querySelector(".side-search.is-tip")).toBeNull();
  });

  it("puts the sentence beside the search, and rings it", async () => {
    await renderApp();
    await drawOpening();
    await dismissAnswer();
    expect(document.querySelector(".side-search-tip")?.textContent).toBe(
      TIP_LINE,
    );
    expect(document.querySelectorAll(".side-search.is-tip")).toHaveLength(1);
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
    /*
      The panel is shut first, and that is the state the `page`-scoped source
      is *about* rather than a convenience.

      Every light is measured with `getBoundingClientRect` and brought back into
      canvas space through the canvas's own left offset, which is the panel's
      width while it is docked and open. So a source inside the panel resolves
      to a negative x and lights nothing — the panel is opaque and beside the
      canvas, not over it. The only chrome genuinely over the water is the
      left-hand cluster, and it is drawn only while the panel is shut.
    */
    const toggle = document.querySelector<HTMLElement>(".side-toggle");
    expect(
      toggle,
      "the panel is drawing no switch to close it with",
    ).not.toBeNull();
    await act(async () => {
      toggle!.click();
      await new Promise((r) => {
        setTimeout(r, 10);
      });
    });

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

/**
 * The claim the collapsed layout is licensed by, checked against the whole
 * table.
 *
 * With the sidebar shut there is nothing on screen but the canvas, its two
 * corner clusters and the timeline. What makes that a *state* rather than a
 * loss of function is one rule — **every control has a command** — and the rule
 * was being read rather than checked. `step` had a binding and a button and no
 * palette row, so on a touch device it could not be reached at all: no key to
 * press, no button drawn, and nothing to search for.
 *
 * So this walks `bindings.ts`, which is the single table by design, and asks
 * the rendered palette whether each row's key is printed on a command. That
 * closes the next hole as well as this one, which a row for `step` on its own
 * would not have done.
 *
 * It is deliberately **not** a symmetry. `share` is the exception in the other
 * direction — a control and a palette row and no key, because the letters that
 * would be honest for it are the two most-used bindings in the app — so the
 * assertion runs one way only, and the exemptions below are named one at a time
 * with the reason each is allowed to be missing.
 */
const NO_COMMAND: Partial<Record<ActionId, string>> = {
  // The surface the whole rule is about. The search pill is what opens it, and
  // the pill survives the panel closing rather than being hidden with it.
  search: "is the palette",
  // A filter *on* the palette rather than a thing behind it: the unfiltered
  // list already searches taxa, and `A` only puts the commands away. Reached
  // from inside, by typing `s` then space.
  "add-taxon": "filters the palette from within it",
  // The panel's own switch, which is drawn on the canvas at every width and is
  // therefore never behind the thing it opens. A command for it would be a row
  // in a list you can only reach through the panel or the pill beside it.
  sidebar: "is the switch for the panel itself, drawn on the canvas",
  // Not a control on any bar. It activates the carousel's front card, which is
  // drawn at every width and is a tap target already.
  "open-opening": "activates a card that is drawn at every width",
  // Likewise: it closes whatever is open, and every closable surface here draws
  // its own way out.
  escape: "closes what is open, which each surface also offers",
  // The shifted half of `step`. The bar draws one button for the pair and so
  // does the palette, because `stepSelection` wraps — going forward alone
  // reaches every leaf, so `⇧N` is a shortcut round the cycle rather than the
  // only way anywhere.
  "step-back": "is the shifted half of step, and stepping wraps",
};

describe("every control the bar draws has a command behind it", () => {
  /** Select a leaf, so the contextual rows are in the list too. */
  async function selectLeaf(): Promise<void> {
    const leaf = document.querySelector<HTMLElement>(".mark.is-leaf");
    if (!leaf) throw new Error("the canvas is drawing no leaf to select");
    await act(async () => {
      leaf.click();
      await new Promise((r) => {
        setTimeout(r, 60);
      });
    });
  }

  it("prints every binding's key on a palette row, or names why it need not", async () => {
    await renderApp();
    await drawOpening();
    await dismissAnswer();
    // With a leaf selected, because three of these rows are contextual — the
    // isolate, the fit-to and the remove all belong to a chosen node, and a
    // reader on a phone reaches them the same way, by tapping a mark first.
    await selectLeaf();
    await openPalette();
    const printed = new Set(
      [...document.querySelectorAll(".palette .row .kbd")].map(
        (k) => k.textContent,
      ),
    );
    for (const b of BINDINGS) {
      if (NO_COMMAND[b.id]) continue;
      expect(
        printed.has(b.kbd),
        `${b.id} has the key ${b.kbd} and no command — a reader below 620px cannot reach it at all`,
      ).toBe(true);
    }
  });

  it("keeps the exemption list from outliving the rows it excuses", () => {
    // An id that leaves the table takes its excuse with it. Without this the
    // list quietly becomes somewhere a real hole can be parked.
    for (const id of Object.keys(NO_COMMAND)) {
      expect(
        BINDINGS.some((b) => b.id === id),
        `${id} is excused from a table it is no longer in`,
      ).toBe(true);
    }
  });

  it("keeps share the other way round — a row, and no key on it", async () => {
    // The reason the rule above is not a symmetry, asserted so that making it
    // one has to fail here first.
    await renderApp();
    await openPalette();
    const row = [...document.querySelectorAll(".palette .row")].find((r) =>
      /shareable link/i.test(r.textContent ?? ""),
    );
    expect(row, "share lost the one surface it has").toBeDefined();
    expect(row?.querySelector(".kbd")).toBeNull();
  });
});

/**
 * A fossil row in the drill-down lane opens the fossil's card.
 *
 * It used to push a *scope* onto the palette and offer three commands — draw
 * it, show the clade it hangs below, add that clade — which predates the fossil
 * card by some months. Every one of those actions is on the card now, and the
 * card also carries the range, the occurrence count, the encyclopedia entry and
 * the drawing's credit, none of which a command row can say. So the lane row
 * does what a mark on the canvas does: it selects.
 *
 * Rendered rather than read, because the claim is about three components that
 * do not import each other. `DrillLane` calls a prop, `App` decides what that
 * means, and the card is a sibling of the canvas that is chosen by the URL —
 * and the failure this is guarding against is precisely that the press goes
 * somewhere else instead.
 */
describe("a fossil in the lane opens its card", () => {
  const TAXON_NO = 108454;

  /** One placed row: a name, a bracket, and the key a card is addressed by. */
  const ROW: FossilTaxon = {
    name: "Tyrannosaurus rex",
    pbdb_taxon_no: TAXON_NO,
    rank: "species",
    attach_idx: 1,
    attach_walk: 3,
    n_occs: 41,
    is_extant: false,
    fea: 72.1,
    fla: 68.0,
    lea: 68.0,
    lla: 66.0,
  };

  /** What `/v1/fossil` answers with once the row is pressed. */
  const DETAIL: FossilDetail = { ...ROW, attach: null };

  function stubFossilApi(): void {
    vi.spyOn(api, "segment").mockResolvedValue({
      upper_idx: 1,
      lower_idx: 101,
      intermediates: [],
      fossils: [ROW],
      fossils_available: true,
      fossils_total: 1,
    });
    vi.spyOn(api, "fossil").mockResolvedValue(DETAIL);
  }

  // `fireEvent` rather than `el.click()`, because a lane row is an SVG `<g>`
  // and jsdom's `SVGElement` has no `click` method at all — only `HTMLElement`
  // does. The event is the same one React handles either way.
  async function click(el: Element | null | undefined, what: string) {
    if (!el) throw new Error(`nothing to click: ${what}`);
    await act(async () => {
      fireEvent.click(el);
      await new Promise((r) => {
        setTimeout(r, 60);
      });
    });
  }

  /**
   * Draw a tree, choose a leaf, and open the lane on the branch above it.
   *
   * Through the palette's own row rather than by setting `seg=` in the URL, so
   * the lane arrives the way a reader opens it and the segment the app asks
   * about is the one it worked out for itself.
   */
  async function openLane(): Promise<void> {
    await renderApp();
    stubFossilApi();
    await drawOpening();
    await dismissAnswer();
    await click(document.querySelector(".mark.is-leaf"), "a leaf to select");
    await openPalette();
    const row = [...document.querySelectorAll(".palette .row")].find((r) =>
      /fossil occurrences along/i.test(r.textContent ?? ""),
    );
    await click(row, "the command that opens the lane");
  }

  it("selects the fossil, and leaves the palette out of it", async () => {
    await openLane();
    const lane = document.querySelector(".drill-row.is-actionable");
    expect(lane, "the lane is drawing no pressable row").not.toBeNull();

    await click(lane, "the fossil row");

    // The URL is the selection, exactly as it is for a mark: `pbdb108454`
    // cannot collide with an OTT id, which is what lets the two share `sel=`.
    expect(new URL(window.location.href).searchParams.get("sel")).toBe(
      `pbdb${TAXON_NO}`,
    );
    expect(document.querySelector(".palette")).toBeNull();
    expect(api.fossil).toHaveBeenCalledWith(TAXON_NO);
    expect(document.querySelector(".detail h2")?.textContent).toBe(ROW.name);
  });

  /**
   * And the lane stays open under it. `drill` is separate state from `selected`
   * — a reader comparing four taxa along one branch reads them one after
   * another, and a lane that closed on the first press would make that four
   * round trips through the canvas.
   */
  it("leaves the lane open under the card, so the next row is one press away", async () => {
    await openLane();
    await click(document.querySelector(".drill-row"), "the fossil row");
    expect(document.querySelector(".detail")).not.toBeNull();
    expect(document.querySelector(".drill")).not.toBeNull();
    expect(document.querySelectorAll(".drill-row")).toHaveLength(1);
  });
});
