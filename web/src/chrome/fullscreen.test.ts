/**
 * The fullscreen toggle, which fails in two ways that are invisible from here.
 *
 * A browser that refuses the request *rejects a promise* rather than throwing,
 * so the version of this code without a `catch` is a button that does nothing,
 * reports nothing, and logs an unhandled rejection into a console the reader
 * does not have open. And a document that is already fullscreen has to be given
 * back rather than asked again — `requestFullscreen` on the element that is
 * already the fullscreen one resolves happily and leaves the reader stuck.
 *
 * Neither shows up in a type check or a build, so both are pinned here. The
 * decision is testable at all because `toggleFullscreen` takes the document
 * rather than reaching for the global — the same move `matchKey` makes with the
 * keyboard event, for the same reason: this project renders into no DOM.
 */
import { describe, expect, it, vi } from "vitest";
import {
  FULLSCREEN_REFUSED,
  toggleFullscreen,
  type FullscreenDoc,
} from "./fullscreen";

/** A document that says yes, with the two calls recorded. */
function doc(
  over: Partial<FullscreenDoc> = {},
): FullscreenDoc & { request: ReturnType<typeof vi.fn>; exit: ReturnType<typeof vi.fn> } {
  const request = vi.fn(() => Promise.resolve());
  const exit = vi.fn(() => Promise.resolve());
  return {
    fullscreenEnabled: true,
    fullscreenElement: null,
    documentElement: { requestFullscreen: request },
    exitFullscreen: exit,
    request,
    exit,
    ...over,
  };
}

/** Something to stand in for the element a fullscreen document reports. */
const SOMETHING = {} as Element;

describe("toggleFullscreen", () => {
  it("asks for the whole document when nothing is fullscreen", () => {
    const d = doc();
    toggleFullscreen(d, () => expect.unreachable("nothing was refused"));
    expect(d.request).toHaveBeenCalledTimes(1);
    expect(d.exit).not.toHaveBeenCalled();
  });

  it("gives it back when something already is", () => {
    // The half that a naive "call request again" implementation gets wrong,
    // and it fails silently: the promise resolves and the window does not move.
    const d = doc({ fullscreenElement: SOMETHING });
    toggleFullscreen(d, () => expect.unreachable("nothing was refused"));
    expect(d.exit).toHaveBeenCalledTimes(1);
    expect(d.request).not.toHaveBeenCalled();
  });

  it("does nothing at all where the browser has said it will not", () => {
    // Belt to the control's braces. `App.tsx` draws neither the button nor the
    // command in this case, but the key's row still exists — the table is every
    // key this app claims — so the press has to arrive somewhere harmless.
    const d = doc({ fullscreenEnabled: false });
    toggleFullscreen(d, () => expect.unreachable("nothing was refused"));
    expect(d.request).not.toHaveBeenCalled();
    expect(d.exit).not.toHaveBeenCalled();
  });

  it("hands a refused request back as a sentence", async () => {
    // The failure this file exists for. A browser may decline a request it was
    // asked for by a real keypress — a spent gesture, an iframe policy, a
    // window manager — and the reader is owed the reason rather than silence.
    const refused: string[] = [];
    toggleFullscreen(
      doc({ documentElement: { requestFullscreen: () => Promise.reject(new Error("no")) } }),
      (why) => refused.push(why),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(refused).toEqual([FULLSCREEN_REFUSED]);
  });

  it("says nothing when leaving fails", async () => {
    // Deliberately not symmetric. The only way `exitFullscreen` rejects is if
    // the document left between the check and the call, and a warning about
    // failing to un-fullscreen a window that is already windowed is noise.
    const said: string[] = [];
    toggleFullscreen(
      doc({
        fullscreenElement: SOMETHING,
        exitFullscreen: () => Promise.reject(new Error("no")),
      }),
      (why) => said.push(why),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(said).toEqual([]);
  });
});

/**
 * And whether the control is offered at all, which is asked once at module
 * scope — so each case needs the module loaded again against a different
 * global.
 */
describe("FULLSCREEN_AVAILABLE", () => {
  async function askWith(stub: unknown): Promise<boolean> {
    const g = globalThis as { document?: unknown };
    const had = "document" in g;
    const prev = g.document;
    if (stub === undefined) delete g.document;
    else g.document = stub;
    try {
      vi.resetModules();
      return (await import("./fullscreen")).FULLSCREEN_AVAILABLE;
    } finally {
      if (had) g.document = prev;
      else delete g.document;
    }
  }

  it("is false where there is no document at all", async () => {
    // This module is imported by `App.tsx` and so by anything that imports it.
    // Reading `document.fullscreenEnabled` at module scope in a node process
    // would throw on load rather than return false.
    expect(await askWith(undefined)).toBe(false);
  });

  it("is false where the browser says the page may not", async () => {
    // An iframe without `allow="fullscreen"` answers exactly this way, and so
    // does a browser that only ever had the webkit-prefixed API.
    expect(await askWith({ fullscreenEnabled: false })).toBe(false);
    expect(await askWith({})).toBe(false);
  });

  it("is true only on an explicit yes", async () => {
    expect(await askWith({ fullscreenEnabled: true })).toBe(true);
  });
});
