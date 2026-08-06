/**
 * The tooltip, as a reader meets it.
 *
 * `tip.test.ts` already proves the arithmetic — `place` against three
 * rectangles, `openDelay` against two numbers — and censuses the `.tsx` corpus
 * for a returning `title`. What it cannot reach is the half that only exists in
 * a document, and that half is where both of this component's load-bearing
 * decisions live:
 *
 * 1. **`useTip` is a hook and not a wrapper.** `<Tip><button/></Tip>` is the
 *    friendlier API and it would put an element into `.mode-chip`'s grid, into
 *    `.mode-chip`'s own grid, into a `<g>` inside the drill lane's single
 *    SVG. The claim in the header is that the DOM after this change is the DOM
 *    before it, attribute for attribute — which is a claim about rendered
 *    markup and was, until there was a DOM to render into, unenforced.
 *
 * 2. **`pointerdown` and `keydown` are listened for on the window.** They were
 *    handlers on the trigger first, which cannot see the two cases that
 *    matter: a press on some *other* element, and a keystroke while the pointer
 *    sits still. The anchor is measured once at open time, so anything that
 *    relays out the page leaves a sentence about one control hanging over
 *    another — the exact failure the native `title` had.
 *
 * React derives `onPointerEnter`/`onPointerLeave` from delegated `pointerover`
 * and `pointerout`, so those are what get fired here. Dispatching a
 * `pointerenter` directly reaches nothing, because it does not bubble.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipLayer, useTip } from "./Tooltip";
import { CHAIN_MS, CLOSE_MS, OPEN_MS } from "./tip";

function Trigger({ text }: { text?: string | undefined }) {
  return (
    <>
      <button type="button" className="control" {...useTip(text)}>
        Bioluminescence
      </button>
      <TooltipLayer />
    </>
  );
}

/**
 * Run the timers on, inside `act`.
 *
 * The store opens and closes from `setTimeout` callbacks, and a
 * `useSyncExternalStore` subscriber notified outside `act` has its re-render
 * scheduled and never flushed — so the assertion reads the DOM from before the
 * timer fired. `fireEvent` wraps its own dispatch, which is why a *chained* tip
 * (delay zero, opened synchronously inside the handler) appears to work without
 * this and a delayed one does not. That asymmetry is the trap: it makes the
 * first tip of a run behave differently from the second.
 */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Hover, and wait out the dwell. */
function hover(el: Element): void {
  fireEvent.pointerOver(el, { pointerType: "mouse" });
  advance(OPEN_MS);
}

/**
 * Where this file's clock starts, and how far it moves between tests.
 *
 * An hour ahead of anything real, because `lastClosed` can be written under
 * *real* timers — `cleanup` unmounts the trigger in an `afterEach`, that calls
 * `dismiss`, and whether it lands before or after `useRealTimers` is not
 * something a test should have to reason about. Starting ahead of the wall
 * clock makes every recorded timestamp comparable and every step forward.
 */
const CLOCK_START = Date.now() + 3_600_000;
/** Comfortably past `CHAIN_MS`, which is the only span that has to be cleared. */
const CLOCK_STEP = CHAIN_MS * 10;
let clock = CLOCK_START;

/**
 * A cold start: no tip up, and no chain in progress.
 *
 * `active` and `lastClosed` are module state in `Tooltip.tsx`, so one test's
 * tooltip is the next test's initial condition. `active` is handled for free —
 * `cleanup` unmounts the trigger and `useTip`'s own unmount effect dismisses.
 * `lastClosed` is not: `openDelay` answers **0** within `CHAIN_MS` of the last
 * close, so a chained tip opens instantly and every assertion about the dwell
 * quietly stops meaning anything.
 *
 * Merely advancing the timers does not fix it, and this is the part worth
 * writing down. `vi.useFakeTimers()` resets the clock to the *system* time,
 * while the previous test left `lastClosed` somewhere further along its own
 * fake one — so `now - lastClosed` comes out **negative**, which is `<=
 * CHAIN_MS` and therefore chained. It only shows up when the tests run in a
 * different order, which is what `--sequence.shuffle` is for.
 */
function coldStart(): void {
  vi.useFakeTimers();
  clock += CLOCK_STEP;
  vi.setSystemTime(clock);
}

describe("useTip", () => {
  beforeEach(coldStart);
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens on hover after the dwell, and not before it", () => {
    render(<Trigger text="Draw the tree as it looks in the deep sea." />);
    const button = screen.getByRole("button");

    fireEvent.pointerOver(button, { pointerType: "mouse" });
    // Crossing a row of controls on the way somewhere else must open nothing.
    advance(OPEN_MS - 1);
    expect(screen.queryByRole("tooltip")).toBeNull();

    advance(1);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Draw the tree as it looks in the deep sea.",
    );
    // The reader is told, not just shown.
    expect(button.getAttribute("aria-describedby")).toBe(
      screen.getByRole("tooltip").id,
    );
  });

  it("adds no element and no attribute of its own to the trigger", () => {
    const withTip = render(<Trigger text="A sentence." />);
    const tipped = screen.getByRole("button").outerHTML;
    withTip.unmount();

    const bare = render(
      <button type="button" className="control">
        Bioluminescence
      </button>,
    );
    const plain = screen.getByRole("button").outerHTML;
    bare.unmount();

    // Attribute for attribute. Handlers are properties React holds, not markup,
    // so an idle tipped trigger is indistinguishable from an untipped one —
    // which is what lets `.mode-chip`'s grid and the drill lane's SVG keep
    // counting their children.
    expect(tipped).toBe(plain);
  });

  it("takes `aria-describedby` back when it closes", () => {
    render(<Trigger text="A sentence." />);
    const button = screen.getByRole("button");

    hover(button);
    expect(button.getAttribute("aria-describedby")).not.toBeNull();

    fireEvent.pointerOut(button, { pointerType: "mouse" });
    advance(CLOSE_MS);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });

  it("ignores touch, because a finger cannot dismiss what it raised", () => {
    render(<Trigger text="A sentence." />);
    // `pointerenter` fires for touch too, so a tapped control on a phone would
    // raise a tip that nothing can dismiss — the finger is already gone.
    fireEvent.pointerOver(screen.getByRole("button"), { pointerType: "touch" });
    advance(OPEN_MS);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders no props at all when there is no text to show", () => {
    render(<Trigger text={undefined} />);
    const button = screen.getByRole("button");
    hover(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("TooltipLayer's window listeners", () => {
  beforeEach(coldStart);
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dismisses on a press somewhere else entirely", () => {
    render(
      <>
        <Trigger text="A sentence." />
        <a href="/about">About</a>
      </>,
    );
    hover(screen.getByRole("button"));
    expect(screen.queryByRole("tooltip")).not.toBeNull();

    // The case a handler on the trigger cannot see. The anchor was measured
    // once; this press is the app re-laying itself out under a tip that still
    // points at where the control used to be.
    fireEvent.pointerDown(screen.getByRole("link"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("dismisses on any key, and lets every key but Escape travel on", () => {
    render(<Trigger text="A sentence." />);
    // Standing in for the app's own key handler, which is what `l` and `escape`
    // would otherwise reach. The listener is on the body and the window's is in
    // the capture phase, so `stopPropagation` up there is visible down here as
    // silence.
    const heard: string[] = [];
    const listen = (e: Event) => heard.push((e as KeyboardEvent).key);
    document.body.addEventListener("keydown", listen);

    hover(screen.getByRole("button"));
    // `L` reprints every label on the canvas, so the anchor is stale even
    // though nothing was pressed with a pointer. The tip goes; the keystroke
    // still has a canvas to change.
    fireEvent.keyDown(document.body, { key: "l" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(heard).toEqual(["l"]);

    hover(screen.getByRole("button"));
    expect(screen.queryByRole("tooltip")).not.toBeNull();
    // Escape *is* swallowed, and only here — which is what makes the tooltip
    // the innermost thing in the app's escape chain rather than a fourth thing
    // competing with the palette, the card and the dialog.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(heard).toEqual(["l"]);

    // With no tip up there is nothing to dismiss, so Escape belongs to whoever
    // else wants it.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(heard).toEqual(["l", "Escape"]);

    document.body.removeEventListener("keydown", listen);
  });

  it("dismisses when the trigger itself leaves", () => {
    // A mark the reader has just taken off the canvas, a palette row filtered
    // away by the next keystroke: there is then nothing left to fire
    // `pointerleave`, and the tip would otherwise sit there for ever.
    const view = render(<Trigger text="A sentence." />);
    hover(screen.getByRole("button"));
    expect(screen.queryByRole("tooltip")).not.toBeNull();

    view.rerender(<TooltipLayer />);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
