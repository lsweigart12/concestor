import { afterEach, describe, expect, it, vi } from "vitest";
import { decode, encode, loadBiolum } from "./store";

/**
 * `encode` and `decode` each name the *non-default* axis explicitly, in
 * opposite directions, so flipping the default means editing both. Getting one
 * and not the other is silent and expensive: every shared link would either
 * carry a redundant `axis=` or, worse, drop the caller's choice and open on the
 * other scale. These pin the pair together.
 */
describe("axis in the URL", () => {
  it("omits the default so a plain link is the default view", () => {
    expect(encode({ ...decode(""), axis: "linear" })).toBe("/");
  });

  it("names the non-default", () => {
    expect(encode({ ...decode(""), axis: "log" })).toBe("?axis=log");
  });

  it("reads an absent axis as the default", () => {
    expect(decode("").axis).toBe("linear");
    expect(decode("?n=770315").axis).toBe("linear");
  });

  it("round-trips both modes", () => {
    for (const axis of ["linear", "log"] as const) {
      const v = { ...decode("?n=770315,417950"), axis };
      expect(decode(encode(v)).axis, axis).toBe(axis);
    }
  });

  it("keeps bioluminescence out of the link entirely", () => {
    // The inverse of the axis rule above, and deliberately so. Every other
    // member of ViewState is a claim about taxa and belongs in a link; the
    // lighting is a claim about nothing, and a reader who shares a tree should
    // not be imposing a moving canvas on whoever opens it. So it is not in
    // ViewState, `encode` cannot write it, and `decode` will not read it back —
    // including from an old link that still carries `bio=1`.
    expect(encode(decode("?bio=1"))).toBe("/");
    expect(encode(decode("?n=770315&bio=1"))).toBe("?n=770315");
    expect("biolum" in decode("?bio=1")).toBe(false);
  });

  it("keeps the selection across the round trip", () => {
    const v = decode("?n=770315,773491,688328&axis=log&sel=770315&iso=1");
    const back = decode(encode(v));
    expect(back.keys).toEqual(["770315", "773491", "688328"]);
    expect(back.axis).toBe("log");
    expect(back.selected).toBe("770315");
    expect(back.isolate).toBe(true);
  });
});

/**
 * The mode is off unless this tab's own session says otherwise, and these pin
 * the two halves of that.
 *
 * Worth its own block because the failure is silent and it is the one the whole
 * design is arranged to prevent: a reader who never asked for it arriving at a
 * canvas that moves. Nothing here can be satisfied by a value that leaks in
 * from a link, from another tab, or from a previous visit — only from a
 * deliberate `sessionStorage` write in this one.
 */
describe("bioluminescence is off by default", () => {
  const stub = (store: Record<string, string>) =>
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store[k] ?? null,
    });

  afterEach(() => vi.unstubAllGlobals());

  it("is off for a session that has stored nothing", () => {
    stub({});
    expect(loadBiolum()).toBe(false);
  });

  it("is on only for an exact stored '1'", () => {
    // Anything else is a value this app did not write, and the benefit of the
    // doubt goes to the plain instrument rather than to the light show.
    stub({ "concestor.biolum": "1" });
    expect(loadBiolum()).toBe(true);
    for (const v of ["0", "", "true", "yes"]) {
      stub({ "concestor.biolum": v });
      expect(loadBiolum(), v).toBe(false);
    }
  });

  it("is off where storage throws, rather than undefined", () => {
    // Private browsing and blocked-storage settings throw on access. The mode
    // is optional, so losing it is free; guessing `true` here would light the
    // canvas for exactly the readers who have asked for the least.
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(loadBiolum()).toBe(false);
  });
});
