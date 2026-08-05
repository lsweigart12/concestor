/**
 * The carousel's clock, checked against the copy it is pacing.
 *
 * Two things are being pinned, and they are the two halves of the bug. The
 * dwell has to be longer than the words on the card actually take to read, or
 * the app's primary call to action moves while the reader is deciding — which
 * it did, at a flat 7600 ms against openings running to 32 words. And the
 * rotation has to *end*, because hover-to-pause is not a rule that exists on a
 * phone.
 *
 * The dwell half is a test rather than a comment because the constant and the
 * prose it is pacing live in different files and nothing else joins them: an
 * opening that grows a clause is a change to `openings.ts` that silently makes
 * `rotation.ts` wrong, and this is the only thing that would say so.
 */

import { describe, expect, it } from "vitest";
import { OPENINGS } from "../openings";
import { AUTO_ADVANCES, READ_MS_PER_WORD, REACH_MS, dwellFor, wordsIn } from "./rotation";

/** What the constant this replaced was, so the comparison below is a fact. */
const OLD_FLAT_DWELL_MS = 7600;

const CAROUSEL = import.meta.glob<string>("./OpeningCarousel.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
})["./OpeningCarousel.tsx"]!;

describe("wordsIn", () => {
  it("counts the question and the reveal together, which is what is on screen", () => {
    expect(
      wordsIn({ id: "x", question: "Is a koala a bear?", reveal: "No.", taxa: [] }),
    ).toBe(6);
  });

  it("is not fooled by the newlines a wrapped string literal leaves behind", () => {
    // `openings.ts` writes its reveals as concatenated lines, and prettier is
    // free to re-wrap them. A split on " " rather than on whitespace would
    // count "the\nshark" as one word and quietly shorten that opening's dwell.
    expect(
      wordsIn({ id: "x", question: " Are\nyou  a fish? ", reveal: "You\tand the salmon", taxa: [] }),
    ).toBe(8);
  });
});

describe("dwellFor", () => {
  it("gives every real opening the time its own words take, plus the reach", () => {
    for (const o of OPENINGS) {
      expect(dwellFor(o), o.id).toBe(REACH_MS + wordsIn(o) * READ_MS_PER_WORD);
      expect(dwellFor(o), o.id).toBeGreaterThan(wordsIn(o) * READ_MS_PER_WORD);
    }
  });

  it("is longer than the flat constant it replaced, for every one of them", () => {
    // The point of the change, stated as an assertion: the shortest opening in
    // the corpus now rests longer than the *longest* one used to. If a future
    // retune ever fails this, the moving target is back.
    for (const o of OPENINGS) {
      expect(dwellFor(o), o.id).toBeGreaterThan(OLD_FLAT_DWELL_MS);
    }
  });

  it("separates the long openings from the short ones", () => {
    // A constant cannot; that is the whole argument for a function. Measured
    // 2026-08-04, the corpus runs 22 to 32 words, so the spread is real and
    // this is not a test that passes vacuously on a corpus of one length.
    const spread = OPENINGS.map(wordsIn);
    expect(Math.max(...spread)).toBeGreaterThan(Math.min(...spread));

    const longest = OPENINGS.reduce((a, b) => (wordsIn(a) >= wordsIn(b) ? a : b));
    const shortest = OPENINGS.reduce((a, b) => (wordsIn(a) <= wordsIn(b) ? a : b));
    expect(dwellFor(longest)).toBeGreaterThan(dwellFor(shortest));
  });

  it("reads at 200 wpm or slower, because the reader is also looking at pictures", () => {
    // 300 ms/word is 200 wpm. Anything faster is a claim that somebody who has
    // just arrived reads this card the way they read a page they chose.
    expect(READ_MS_PER_WORD).toBeGreaterThanOrEqual(300);
  });
});

describe("the bound on auto-rotation", () => {
  it("stops while there are still questions the reader has not been shown", () => {
    // The bound is a claim about attention, not about the corpus. A full pass
    // was refused precisely because it scales with `OPENINGS.length`: sixteen
    // openings is over three minutes of movement, which is the same moving
    // target with an end nobody waits for. The arrows and the dots are what
    // reach the rest — carousel rule 5.
    expect(AUTO_ADVANCES).toBeGreaterThan(0);
    expect(AUTO_ADVANCES).toBeLessThan(OPENINGS.length);
  });

  it("keeps the whole moving stretch under a minute at its worst", () => {
    // Worst case: the longest openings land in the first slots. A reader who
    // arrives and does nothing at all watches this much motion and then the
    // surface is still for good.
    const longest = Math.max(...OPENINGS.map(dwellFor));
    expect(longest * AUTO_ADVANCES).toBeLessThan(60_000);
  });
});

describe("the component's end of it", () => {
  it("is reading the file at all", () => {
    // Every check below is a substring search, and all of them pass on an
    // empty string. A renamed file would leave this describe measuring nothing.
    expect(CAROUSEL).toContain("export function OpeningCarousel");
  });

  it("takes its interval from the opening on show rather than a constant", () => {
    expect(CAROUSEL).toContain("dwellFor(shown)");
    expect(CAROUSEL).not.toContain("DWELL_MS");
  });

  it("spends the budget, so the surface can go still without a gesture", () => {
    expect(CAROUSEL).toContain("advances >= AUTO_ADVANCES");
  });

  it("stops on a touch, which is the only stop a phone has", () => {
    // `mouseenter` never fires for a finger, so `onMouseEnter` alone is not a
    // weaker pause on touch — it is an absent one. And it must be the press
    // rather than the click: the card is keyed on the opening, so an advance
    // between the two replaces the button being pressed.
    expect(CAROUSEL).toContain("onPointerDown");
    expect(CAROUSEL).toContain("onPointerDown={() => setTaken(true)}");
  });
});
