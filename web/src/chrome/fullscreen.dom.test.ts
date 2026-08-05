/**
 * The half of fullscreen that only a document can answer.
 *
 * `fullscreen.test.ts` is the pure half — `toggleFullscreen` against a
 * hand-written `FullscreenDoc`, which is testable precisely because it takes the
 * document rather than reaching for the global. What it cannot reach is the
 * hook, and the hook carries the decision this file exists for:
 *
 * **The state is asked of the browser, never remembered.** Escape and F11 both
 * leave fullscreen without passing through this app, so a boolean flipped on
 * each press says "on" over a window that is not — and there is nothing on
 * screen to contradict it, because the window looks exactly like a window. That
 * used to be asserted by reading `fullscreen.ts` as a string and checking it did
 * not contain `setOn(!on)`, which is satisfied by `setOn(!x)`.
 *
 * A `.dom.test.ts` rather than a `.tsx`: it renders no component of this app,
 * only the hook, and calling the file a component test would be a lie about what
 * it is. See `vitest.config.ts`.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * A browser that will do it, arranged before `fullscreen.ts` is imported.
 *
 * `FULLSCREEN_AVAILABLE` is a module-scope const — asked once, before anything
 * is drawn — and `useFullscreen` subscribes to nothing where it is false. jsdom
 * reports `false`, so without this the hook is inert and every test below passes
 * for the wrong reason.
 */
vi.hoisted(() => {
  Object.defineProperty(document, "fullscreenEnabled", {
    value: true,
    configurable: true,
  });
});

const { FULLSCREEN_REFUSED, useFullscreen } = await import("./fullscreen");

/** Say what the browser would say, and tell the page it changed. */
function browserWent(fullscreen: boolean): void {
  Object.defineProperty(document, "fullscreenElement", {
    value: fullscreen ? document.documentElement : null,
    configurable: true,
  });
  act(() => {
    document.dispatchEvent(new Event("fullscreenchange"));
  });
}

describe("useFullscreen reads the state from the browser", () => {
  it("starts from what the document already says", () => {
    browserWent(false);
    const { result } = renderHook(() => useFullscreen(() => {}));
    expect(result.current.on).toBe(false);
  });

  /**
   * A reload inside an already-fullscreen window fires no change event, so the
   * mount has to ask as well or the button opens lit-side-down.
   */
  it("asks once on mount, with no event to prompt it", () => {
    browserWent(true);
    const { result } = renderHook(() => useFullscreen(() => {}));
    expect(result.current.on).toBe(true);
    browserWent(false);
  });

  /**
   * The whole point: the window left fullscreen without this app being told,
   * which is what Escape and F11 do, and the state follows the window.
   */
  it("follows the window out when the reader leaves by the browser's own route", () => {
    browserWent(true);
    const { result } = renderHook(() => useFullscreen(() => {}));
    expect(result.current.on).toBe(true);
    browserWent(false);
    expect(result.current.on).toBe(false);
  });

  /**
   * And a press on its own changes nothing.
   *
   * A browser that refuses the request *rejects a promise* rather than throwing,
   * and this is the case a remembered boolean gets wrong: the button would
   * report "on" over a window that never moved, with nothing on screen to
   * contradict it. The reader is told instead, and the state stays where the
   * document left it.
   */
  it("does not flip on the press itself when the browser refuses", async () => {
    browserWent(false);
    document.documentElement.requestFullscreen = () =>
      Promise.reject(new Error("no user gesture"));
    const refused = vi.fn();
    const { result } = renderHook(() => useFullscreen(refused));
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    expect(refused).toHaveBeenCalledWith(FULLSCREEN_REFUSED);
    expect(result.current.on).toBe(false);
  });

  /**
   * `toggle` keeps one identity for the life of the app: it is a dependency of
   * the control bar's memo and of the key handler, and a callback that changed
   * on every render would walk all the way up through both.
   */
  it("hands back the same toggle across renders", () => {
    browserWent(false);
    const { result, rerender } = renderHook(() => useFullscreen(() => {}));
    const first = result.current.toggle;
    rerender();
    expect(result.current.toggle).toBe(first);
  });
});
