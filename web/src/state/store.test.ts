import { describe, expect, it } from "vitest";
import { decode, encode } from "./store";

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

  it("keeps the selection across the round trip", () => {
    const v = decode("?n=770315,773491,688328&axis=log&sel=770315&iso=1");
    const back = decode(encode(v));
    expect(back.keys).toEqual(["770315", "773491", "688328"]);
    expect(back.axis).toBe("log");
    expect(back.selected).toBe("770315");
    expect(back.isolate).toBe(true);
  });
});
