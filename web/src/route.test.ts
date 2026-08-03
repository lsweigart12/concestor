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
import { describe, expect, it } from "vitest";
import { ABOUT_PATH, routeOf } from "./route";

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
