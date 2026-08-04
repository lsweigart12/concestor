/**
 * Which document a path names.
 *
 * `routeOf` decides whether `main.tsx` mounts the tree or the about page, and
 * it is the only thing standing between the two: get it wrong in the permissive
 * direction and a shared `?n=…` link renders an about page instead of the tree
 * somebody sent; get it wrong in the strict direction and `/about/` — which is
 * what a server that canonicalises, or a person typing, will produce — renders
 * a canvas with no selection and no explanation.
 *
 * The prefix cases are the ones worth pinning. A `startsWith` implementation
 * passes every test in the first block and fails the second, and the failure is
 * silent: `/about-the-data` would render this page, and so would any future
 * route beginning with those six characters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ABOUT_PATH, requestOpening, routeOf, takeOpening } from "./route";
import { OPENINGS } from "./openings";

describe("routeOf", () => {
  it("routes the about path, with or without a trailing slash", () => {
    expect(routeOf(ABOUT_PATH)).toBe("about");
    expect(routeOf("/about")).toBe("about");
    expect(routeOf("/about/")).toBe("about");
    expect(routeOf("/about///")).toBe("about");
  });

  it("routes the tree everywhere else", () => {
    expect(routeOf("/")).toBe("app");
    expect(routeOf("")).toBe("app");
    expect(routeOf("/index.html")).toBe("app");
  });

  it("does not route a path that merely starts with it", () => {
    expect(routeOf("/aboutface")).toBe("app");
    expect(routeOf("/about-the-data")).toBe("app");
    expect(routeOf("/about/credits")).toBe("app");
  });

  it("is case-sensitive, because pathnames are", () => {
    // Not a preference: the server serves the SPA for any unmatched path, so
    // `/About` reaches the client either way. Rendering the tree there is the
    // safe answer — the reader sees a working app rather than a page whose URL
    // they cannot reproduce.
    expect(routeOf("/About")).toBe("app");
  });
});

/**
 * The about page's request that the canvas draw something.
 *
 * One shot, and the clearing is the whole of it. The failure it prevents is
 * not hypothetical: `leaveAbout` is usually `history.back()`, so the reader
 * who watches a tree build is one gesture away from re-mounting the canvas —
 * and a request that survived being answered would rebuild the demonstration
 * on top of whatever they had assembled since, forever, in that tab.
 */
describe("the opening handoff", () => {
  // `route.ts` reads `window.sessionStorage` where `store.ts` reads the bare
  // global, so this stubs the window rather than the storage — the same
  // `vi.stubGlobal` idiom `store.test.ts` uses, one level out.
  beforeEach(() => {
    const held = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (k: string) => held.get(k) ?? null,
        setItem: (k: string, v: string) => void held.set(k, v),
        removeItem: (k: string) => void held.delete(k),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("answers once and then has nothing to say", () => {
    requestOpening("fish");
    expect(takeOpening()).toBe("fish");
    expect(takeOpening()).toBeNull();
  });

  it("is null when nobody asked", () => {
    expect(takeOpening()).toBeNull();
  });

  it("keeps only the latest request", () => {
    // Two presses on the about page before the navigation lands is one
    // intention, not a queue.
    requestOpening("fish");
    requestOpening("hyena");
    expect(takeOpening()).toBe("hyena");
    expect(takeOpening()).toBeNull();
  });

  it("names an opening that exists", () => {
    // The id is a string crossing a storage boundary, so nothing types it.
    // `App.tsx` looks it up and does nothing when the lookup fails, which is
    // the correct behaviour for a stale key left by an older build — but the
    // id this ships with had better resolve today.
    const first = OPENINGS[0];
    expect(first).toBeTruthy();
    requestOpening(first!.id);
    expect(OPENINGS.find((o) => o.id === takeOpening())).toBe(first);
  });
});
