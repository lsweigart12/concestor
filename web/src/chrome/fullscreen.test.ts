/**
 * The fullscreen toggle, which fails in four ways that are invisible from here.
 *
 * A browser that refuses the request may **reject a promise**, may **throw
 * where it stands**, or may do the thing this file was originally wrong about
 * and **never answer at all** — return a promise that neither resolves nor
 * rejects while the window quietly does not move. Any of the three without a
 * handler is a button that does nothing and reports nothing, which is precisely
 * the outcome `fullscreen.ts`'s absent-rather-than-disabled argument exists to
 * prevent. And a document that is already fullscreen has to be given back
 * rather than asked again — `requestFullscreen` on the element that is already
 * the fullscreen one resolves happily and leaves the reader stuck.
 *
 * None shows up in a type check or a build, so all four are pinned here. The
 * decision is testable at all because `toggleFullscreen` takes the document
 * rather than reaching for the global — the same move `matchKey` makes with the
 * keyboard event, for the same reason: this project renders into no DOM.
 */
import { describe, expect, it, vi } from "vitest";
import {
  FULLSCREEN_DEADLINE_MS,
  FULLSCREEN_REFUSED,
  toggleFullscreen,
  type FullscreenDoc,
} from "./fullscreen";

/** A document that says yes, with the two calls recorded. */
function doc(over: Partial<FullscreenDoc> = {}): FullscreenDoc & {
  request: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
} {
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
      doc({
        documentElement: {
          requestFullscreen: () => Promise.reject(new Error("no")),
        },
      }),
      (why) => refused.push(why),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(refused).toEqual([FULLSCREEN_REFUSED]);
  });

  it("hands a request that throws where it stands back as the same sentence", () => {
    // The second shape. A `.catch()` on the returned promise never runs,
    // because there is no returned promise — the exception is already on its
    // way up through the keydown handler that asked. One `try` covers it, and
    // covers a `requestFullscreen` that is not a function at all along with it.
    const refused: string[] = [];
    toggleFullscreen(
      doc({
        documentElement: {
          requestFullscreen: () => {
            throw new TypeError("requestFullscreen is not a function");
          },
        },
      }),
      (why) => refused.push(why),
    );
    expect(refused).toEqual([FULLSCREEN_REFUSED]);
  });

  it("says so when the request is never answered at all", async () => {
    // **The bug this file was wrong about**, and it is neither of the shapes
    // above. Measured in an embedded browser that declines fullscreen: asked
    // under a real user gesture, `requestFullscreen` returns a promise that is
    // still pending ten seconds later, the window never moves, and no handler
    // of any kind is called. There is nothing to catch, so the document is
    // asked instead — it is the only witness to whether anything happened.
    vi.useFakeTimers();
    try {
      const refused: string[] = [];
      toggleFullscreen(
        doc({
          documentElement: {
            requestFullscreen: () => new Promise<void>(() => {}),
          },
        }),
        (why) => refused.push(why),
      );
      expect(refused).toEqual([]);
      await vi.advanceTimersByTimeAsync(FULLSCREEN_DEADLINE_MS);
      expect(refused).toEqual([FULLSCREEN_REFUSED]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing when the window went, whether or not it was told so", async () => {
    // The other side of that deadline, and the reason it reads the document
    // rather than counting unsettled promises: a browser that goes fullscreen
    // without ever settling the promise has refused nothing, and a toast
    // saying otherwise over a window that plainly did move is the worse error
    // of the two. `fullscreenElement` is the honest answer in both directions.
    vi.useFakeTimers();
    try {
      const said: string[] = [];
      const went = doc({
        documentElement: {
          requestFullscreen: () => new Promise<void>(() => {}),
        },
      });
      toggleFullscreen(went, (why) => said.push(why));
      went.fullscreenElement = SOMETHING;
      await vi.advanceTimersByTimeAsync(FULLSCREEN_DEADLINE_MS);
      expect(said).toEqual([]);

      // And a plain resolve is trusted on its own, without waiting it out.
      toggleFullscreen(doc(), (why) => said.push(why));
      await vi.advanceTimersByTimeAsync(FULLSCREEN_DEADLINE_MS);
      expect(said).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says it once when a refusal arrives in two shapes at once", async () => {
    // A browser may both reject *and* leave the window where it was, which is
    // one refusal of one press and must be one sentence. Two toasts for one
    // key is the receipt lying about how many things happened.
    vi.useFakeTimers();
    try {
      const refused: string[] = [];
      toggleFullscreen(
        doc({
          documentElement: {
            requestFullscreen: () => Promise.reject(new Error("no")),
          },
        }),
        (why) => refused.push(why),
      );
      await vi.advanceTimersByTimeAsync(FULLSCREEN_DEADLINE_MS);
      expect(refused).toEqual([FULLSCREEN_REFUSED]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing when leaving fails", async () => {
    // Deliberately not symmetric. The only way `exitFullscreen` fails is if
    // the document left between the check and the call, and a warning about
    // failing to un-fullscreen a window that is already windowed is noise.
    // Both of its shapes are silent, for the same reason.
    const said: string[] = [];
    toggleFullscreen(
      doc({
        fullscreenElement: SOMETHING,
        exitFullscreen: () => Promise.reject(new Error("no")),
      }),
      (why) => said.push(why),
    );
    toggleFullscreen(
      doc({
        fullscreenElement: SOMETHING,
        exitFullscreen: () => {
          throw new TypeError("exitFullscreen is not a function");
        },
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
