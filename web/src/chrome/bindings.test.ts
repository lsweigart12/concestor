import { describe, expect, it } from "vitest";
import { binding, BINDINGS, kbd, matchKey, type KeyLike } from "./bindings";

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
    expect(matchKey(press("s"))).toBe("sidebar");
    expect(matchKey(press("/"))).toBe("search");
    expect(matchKey(press("a"))).toBe("add-taxon");
    expect(matchKey(press("f"))).toBe("fit");
    expect(matchKey(press("i"))).toBe("isolate");
    expect(matchKey(press("n"))).toBe("step");
    expect(matchKey(press("r"))).toBe("random-species");
    expect(matchKey(press("c"))).toBe("clear");
    expect(matchKey(press("b"))).toBe("biolum");
    expect(matchKey(press("e"))).toBe("fullscreen");
  });

  it("puts search on the one key nobody had to be taught", () => {
    // The only row in this table whose letter was not argued for against a
    // word. It cost `isolate` the key it had held for as long as `/` was free,
    // and that trade is free in both directions: `i` names isolate exactly
    // where `/` named nothing at all.
    expect(matchKey(press("/"))).toBe("search");
    expect(binding("search").label).toBe("Search");
    expect(matchKey(press("i"))).toBe("isolate");
    // And `p` is unbound rather than kept as an alias. Two keys for one action
    // is two things to learn and one of them is printed on nothing.
    expect(matchKey(press("p"))).toBeNull();
  });

  it("gives `s` to the panel and `a` to the row inside it", () => {
    // The knock-on, and the order it happened in. `s` went to the **sidebar**
    // the search now lives in — so a finger that remembers the old `S` lands on
    // the panel holding the thing it was reaching for rather than on nothing —
    // which sent *add* to `a`, and `ages` to `d` under the name it always
    // should have had.
    expect(matchKey(press("s"))).toBe("sidebar");
    expect(matchKey(press("a"))).toBe("add-taxon");
    expect(matchKey(press("d"))).toBe("ages");
    expect(binding("ages").label).toBe("Dates");
  });

  it("leaves `f` on the fit, with fullscreen beside it on `e`", () => {
    // The collision that would be easiest to make and hardest to see. `f` is
    // the obvious letter for fullscreen and it is spent — on an action `f`
    // names just as exactly. What must never come back is `F` printed on a
    // button that does something else, which is the failure the whole table
    // exists to make impossible.
    expect(matchKey(press("f"))).toBe("fit");
    expect(matchKey(press("F", { shiftKey: true }))).toBe("fit-selection");
    expect(matchKey(press("e"))).toBe("fullscreen");
    expect(kbd("fullscreen")).toBe("E");
    expect(kbd("fullscreen")).not.toBe(kbd("fit"));
  });

  it("keeps the word on the fullscreen button, though the letter cannot match it", () => {
    // A label says what the press *gets you*, and it is allowed to be a
    // different word from the one the letter came from. `P` has printed
    // **Commands** since the bar was built — `p` names the palette, the word
    // names what opening it is for — so this is a second instance of a rule
    // the table already had rather than an exception to one.
    //
    // It has to be asserted because the tidy-minded fix is so easy to reach
    // for: rename the odd one out to something starting with E. That is how
    // **Expand** arrived and why it was wrong — it names the gesture rather
    // than the result, and on a canvas that already opens drill lanes and
    // isolates lineages, a reader can fairly read it as being about a clade.
    // A badge teaches the key and a label teaches the action; where they
    // cannot be the same word the label wins, because a reader who cannot find
    // the control never gets as far as learning its letter.
    expect(binding("fullscreen").label).toBe("Fullscreen");
    expect(binding("fullscreen").label).not.toMatch(/^E/i);
    // And these are the only two, so a third arriving is a drift somebody
    // should have to argue for here. Letters only: `/` and `⌫` are keys with
    // no word in them at all and were never in this question.
    const named = BINDINGS.filter((b) => /^[A-Z]$/.test(b.kbd));
    expect(named.length).toBeGreaterThan(8);
    // **One, where there were two.** `P` printed **Commands** for as long as
    // the palette was captioned by what it is rather than by what it does; the
    // row is `/` and **Search** now, which is not a letter at all and so is not
    // in this census. Fullscreen is the only survivor, and a second arriving is
    // a drift somebody should have to argue for here.
    expect(
      named
        .filter((b) => !b.label.toUpperCase().startsWith(b.kbd))
        .map((b) => b.id),
    ).toEqual(["fullscreen"]);
  });

  it("gives the four canvas modes one section and four letters", () => {
    // `t` for time, `l` for labels, `d` for dates, `b` for the light. Two of
    // the four have moved a letter and both moved the same way — the letter
    // stayed the one that names the control, by changing which word names it.
    // The axis gave `l` up when the labels arrived; `ages` gave `a` up when the
    // Taxa list needed *add*, and became **Dates**, which is the better word
    // for this audience anyway: an age is a duration in ordinary English and a
    // position here.
    expect(matchKey(press("t"))).toBe("axis");
    expect(matchKey(press("l"))).toBe("labels");
    expect(matchKey(press("d"))).toBe("ages");
    expect(matchKey(press("b"))).toBe("biolum");
  });

  it("reads a shifted letter by its shifted character", () => {
    // The browser reports "F", not "f", once shift is down. A table keyed on
    // the printed character would miss this and hand the press to `f`.
    expect(matchKey(press("F", { shiftKey: true }))).toBe("fit-selection");
    expect(matchKey(press("N", { shiftKey: true }))).toBe("step-back");
  });

  it("leaves ⇧R alone, because a random pick has no second corpus to aim at", () => {
    // `⇧R` drew a random fossil until the two corpora became one search. It is
    // deliberately unbound rather than reassigned: `r` covers both pools now,
    // and a reader whose fingers remember the old key should get nothing
    // rather than something else.
    expect(matchKey(press("R", { shiftKey: true }))).toBeNull();
  });

  it("gives Tab back to the browser, in both directions and at every scope", () => {
    // The check this file exists for most, and the one whose failure is
    // invisible until somebody with no pointer tries to reach a button.
    //
    // `step` was on bare `Tab` and `step-back` on `⇧Tab`. App's handler
    // prevents the default of everything it matches, so for as long as those
    // rows existed the focus ring did not move in this app at all — the control
    // bar, the canvas-mode panel and the detail card were all unreachable to a
    // keyboard, which `a11y.dom.test.tsx` is the other half of.
    //
    // It is asserted as an absence at *both* scopes rather than fixed with a
    // `Scope`, because unlike Enter no surface here wants Tab: scoping it to a
    // focused canvas would trap a reader inside the canvas, which is a worse
    // bug (WCAG 2.1.2) than the one it fixes. So the row is gone, and the way to
    // bring the bug back is to add one.
    for (const shiftKey of [false, true]) {
      expect(matchKey(press("Tab", { shiftKey }))).toBeNull();
      expect(matchKey(press("Tab", { shiftKey }), "global")).toBeNull();
      expect(matchKey(press("Tab", { shiftKey }), "surface")).toBeNull();
    }
    expect(BINDINGS.some((b) => b.key === "Tab")).toBe(false);
    // And nothing prints it either, which is the same rule from the other end:
    // a badge reading Tab on a control whose key is `N` is the failure the
    // whole table exists to make impossible.
    expect(BINDINGS.some((b) => b.kbd.includes("Tab"))).toBe(false);
  });

  it("steps the selection on `n`, forward and back", () => {
    // The letter Tab's job went to. `n` names *next*, which is what the press
    // gets you, and the shifted half is the same action reversed — the variant
    // rule, unchanged by the move.
    expect(matchKey(press("n"))).toBe("step");
    expect(matchKey(press("N", { shiftKey: true }))).toBe("step-back");
    expect(kbd("step")).toBe("N");
    expect(kbd("step-back")).toBe("⇧N");
    // The word moved with the letter rather than the badge lying about it.
    // "Step" had no free letter left — `s`, `t`, `e` and `p` are all spent —
    // and the census below holds the badge/label exceptions at two.
    expect(binding("step").label).toBe("Next");
    expect(binding("step-back").label).toBe("Previous");
  });

  it("is case-insensitive, so caps lock does not change what a key does", () => {
    expect(matchKey(press("S"))).toBe("sidebar");
    expect(matchKey(press("C"))).toBe("clear");
  });

  it("takes `/` with or without shift", () => {
    // Unshifted on a US layout, shifted on several others, so the row carries
    // no shift constraint and answers both. Nothing else claims `/`, so there
    // is no variant to lose.
    expect(matchKey(press("/"))).toBe("search");
    expect(matchKey(press("/", { shiftKey: true }))).toBe("search");
  });

  it("refuses every modified press", () => {
    // The whole reason this surface exists. ⌘R reloads, ⌘L reaches the URL
    // bar, ⌘F opens find, and none of them may reach us.
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
      for (const key of ["s", "a", "f", "l", "r", "c", "/", "n", "i", "d"]) {
        expect(matchKey(press(key, { [mod]: true }))).toBeNull();
        expect(
          matchKey(press(key, { [mod]: true, shiftKey: true })),
        ).toBeNull();
      }
    }
  });

  it("answers nothing for a key nobody claimed", () => {
    expect(matchKey(press("q"))).toBeNull();
    expect(matchKey(press("p"))).toBeNull();
    expect(matchKey(press("F5"))).toBeNull();
    expect(matchKey(press(" "))).toBeNull();
  });

  it("still handles the two keys that are not letters", () => {
    expect(matchKey(press("Escape"))).toBe("escape");
    expect(matchKey(press("Backspace"))).toBe("remove");
    expect(matchKey(press("Delete"))).toBe("remove");
  });

  it("hides Enter from the global handler and hands it to the surface", () => {
    // The check that matters most in this file, because what it is preventing
    // is invisible until somebody tries to press a button with the keyboard.
    //
    // App's handler preventDefaults everything it matches, and Enter is the
    // browser's own way of activating a focused button — so a globally
    // matched Enter would silently make every button in the app unpressable
    // from the keyboard. The scope makes that impossible rather than
    // remembered: App asks for `global` and is never handed this press.
    expect(matchKey(press("Enter"))).toBeNull();
    expect(matchKey(press("Enter"), "global")).toBeNull();
    expect(matchKey(press("Enter"), "surface")).toBe("open-opening");
  });

  it("hands a surface no key that belongs to the app", () => {
    // The other direction, and it is not symmetric by construction — a
    // surface-scoped listener runs on `window` alongside the app's own, so a
    // letter leaking into it would fire twice.
    for (const key of [
      "s",
      "a",
      "f",
      "r",
      "c",
      "l",
      "b",
      "e",
      "i",
      "d",
      "/",
      "n",
      "Escape",
    ]) {
      expect(matchKey(press(key), "surface")).toBeNull();
    }
  });

  it("gives up a modified Enter, and takes a shifted one", () => {
    // ⌘Enter and ⌃Enter are somebody else's — open in a new tab, send. Shift
    // is not a modifier this table refuses, and the row carries no `shift`
    // constraint on purpose, like `/`: ⇧Enter means nothing anywhere else on
    // this canvas, and silence for a reader who happened to be holding it is
    // a worse answer than the one they were reaching for.
    expect(matchKey(press("Enter", { metaKey: true }), "surface")).toBeNull();
    expect(matchKey(press("Enter", { ctrlKey: true }), "surface")).toBeNull();
    expect(matchKey(press("Enter", { altKey: true }), "surface")).toBeNull();
    expect(matchKey(press("Enter", { shiftKey: true }), "surface")).toBe(
      "open-opening",
    );
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
    expect(kbd("search")).toBe("/");
    expect(kbd("sidebar")).toBe("S");
    expect(kbd("add-taxon")).toBe("A");
    expect(kbd("random-species")).toBe("R");
    expect(kbd("step")).toBe("N");
  });
});
