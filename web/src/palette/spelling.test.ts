/**
 * The two spelling surfaces, and the one way they go wrong silently.
 *
 * `corrected` and `suggested` are alternatives — the server substitutes only
 * where the typed string had no rows to lose — and each is a property of *one*
 * answer. Left standing across a keystroke, either would caption this search's
 * rows with the last search's spelling, and nothing about that looks broken on
 * screen: the note is plausible, the rows are real, and they are about different
 * strings. `corrected` was written with that hazard in mind and its own comment
 * says so; `suggested` arrived later and had to be added to all three of the
 * same branches.
 *
 * A census rather than a render test, because `vitest.config.ts` runs in `node`
 * and this repository has no component harness. What it can prove is the thing
 * that actually broke: that the two are cleared in lockstep.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./Palette.tsx", import.meta.url), "utf8");

describe("the spelling note and the spelling offer", () => {
  it("clears the offer everywhere it clears the correction", () => {
    const corrected = SRC.match(/setCorrected\(null\)/g) ?? [];
    const suggested = SRC.match(/setSuggested\(null\)/g) ?? [];
    expect(corrected.length).toBeGreaterThan(0);
    expect(suggested.length).toBe(corrected.length);
  });

  it("reads both fields off the same response", () => {
    expect(SRC).toContain("setCorrected(r.corrected ?? null)");
    expect(SRC).toContain("setSuggested(r.suggested ?? null)");
  });

  /**
   * The offer is pressable and the note is not, and that is the whole
   * difference between them. A note captions rows the reader did not ask for; an
   * offer sits above rows they did, and the only thing it can do for them is put
   * the better spelling in the field.
   */
  it("makes the offer a button and leaves the note inert", () => {
    const offer = SRC.slice(SRC.indexOf("function SpellingOffer"));
    expect(offer).toMatch(/<button[\s\S]*?type="button"/);
    expect(offer).toContain("palette-note is-lead is-offer");

    const note = SRC.slice(
      SRC.indexOf("function SpellingNote"),
      SRC.indexOf("function SpellingOffer"),
    );
    expect(note).not.toContain("<button");
    expect(note).not.toContain("onClick");
  });

  /**
   * The note says "nothing matched", and it may only ever say that where nothing
   * did. The offer stands over the reader's own rows, so the same sentence there
   * would be a plain untruth about what is on screen underneath it.
   */
  it("does not tell the reader nothing matched when something did", () => {
    const offer = SRC.slice(SRC.indexOf("function SpellingOffer"));
    expect(offer).not.toContain("Nothing matched");
  });
});
