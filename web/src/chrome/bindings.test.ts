import { describe, expect, it } from "vitest";
import { BINDINGS, kbd, matchKey, type KeyLike } from "./bindings";

function press(key: string, mods: Partial<KeyLike> = {}): KeyLike {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  };
}

describe("matchKey", () => {
  it("binds the letters the reader was told about", () => {
    expect(matchKey(press("p"))).toBe("palette");
    expect(matchKey(press("s"))).toBe("species");
    expect(matchKey(press("f"))).toBe("fit");
    expect(matchKey(press("/"))).toBe("isolate");
    expect(matchKey(press("Tab"))).toBe("step");
    expect(matchKey(press("l"))).toBe("axis");
    expect(matchKey(press("r"))).toBe("random-species");
    expect(matchKey(press("c"))).toBe("clear");
    expect(matchKey(press("b"))).toBe("biolum");
  });

  it("reads a shifted letter by its shifted character", () => {
    // The browser reports "F", not "f", once shift is down. A table keyed on
    // the printed character would miss this and hand the press to `f`.
    expect(matchKey(press("F", { shiftKey: true }))).toBe("fit-selection");
    expect(matchKey(press("Tab", { shiftKey: true }))).toBe("step-back");
  });

  it("leaves ⇧R alone, because a random pick has no second corpus to aim at", () => {
    // `⇧R` drew a random fossil until the two corpora became one search. It is
    // deliberately unbound rather than reassigned: `r` covers both pools now,
    // and a reader whose fingers remember the old key should get nothing
    // rather than something else.
    expect(matchKey(press("R", { shiftKey: true }))).toBeNull();
  });

  it("is case-insensitive, so caps lock does not change what a key does", () => {
    expect(matchKey(press("P"))).toBe("palette");
    expect(matchKey(press("C"))).toBe("clear");
  });

  it("takes `/` with or without shift", () => {
    // Unshifted on a US layout, shifted on several others.
    expect(matchKey(press("/"))).toBe("isolate");
    expect(matchKey(press("/", { shiftKey: true }))).toBe("isolate");
  });

  it("refuses every modified press", () => {
    // The whole reason this surface exists. ⌘R reloads, ⌘L reaches the URL
    // bar, ⌘F opens find, and none of them may reach us.
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
      for (const key of ["p", "s", "f", "l", "r", "c", "/", "Tab"]) {
        expect(matchKey(press(key, { [mod]: true }))).toBeNull();
        expect(matchKey(press(key, { [mod]: true, shiftKey: true }))).toBeNull();
      }
    }
  });

  it("answers nothing for a key nobody claimed", () => {
    expect(matchKey(press("q"))).toBeNull();
    expect(matchKey(press("F5"))).toBeNull();
    expect(matchKey(press(" "))).toBeNull();
  });

  it("still handles the two keys that are not letters", () => {
    expect(matchKey(press("Escape"))).toBe("escape");
    expect(matchKey(press("Backspace"))).toBe("remove");
    expect(matchKey(press("Delete"))).toBe("remove");
  });
});

describe("the table itself", () => {
  it("claims no key twice under the same shift state", () => {
    const seen = new Set<string>();
    for (const b of BINDINGS) {
      // A row with no shift constraint answers both, so it collides with both.
      const states = b.shift === undefined ? [true, false] : [b.shift];
      for (const s of states) {
        const slot = `${b.key}:${s}`;
        // `remove` is the one id with two rows — Backspace and Delete — and
        // they are different keys, so this still holds.
        expect(seen.has(slot), `${slot} is claimed twice`).toBe(false);
        seen.add(slot);
      }
    }
  });

  it("holds no modifier anywhere", () => {
    // Enforced structurally rather than by review: there is no field for a
    // modifier other than shift, and this asserts nobody smuggled one into the
    // printed key either.
    for (const b of BINDINGS) {
      expect(b.kbd).not.toMatch(/⌘|Ctrl|Alt|⌥/);
    }
  });

  it("prints a key for every action the chrome shows", () => {
    expect(kbd("palette")).toBe("P");
    expect(kbd("random-species")).toBe("R");
    expect(kbd("step")).toBe("Tab");
  });
});
