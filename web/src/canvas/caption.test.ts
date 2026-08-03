/**
 * The caption is what earns the right to draw a borrowed picture.
 *
 * Almost no node has a portrait — 12,863 drawings against 2.7M nodes — so the
 * ordinary case is a drawing of a relative, and `SILHOUETTE_POLICY` draws every
 * one of them. That is only defensible while the picture says what it is of;
 * the moment a borrow renders uncaptioned it becomes the misinformation
 * architecture §7 warns about, and nothing about the screen looks wrong.
 */

import { describe, expect, it } from "vitest";
import {
  TIER_INTERPOLATED,
  TIER_MEASURED,
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
} from "../api";
import {
  ageLabel,
  borrowedTitle,
  isExtant,
  markAge,
  metaLine,
  occurrenceSpan,
} from "./NodeMark";

describe("borrowedTitle", () => {
  it("says nothing extra about a node's own portrait", () => {
    expect(borrowedTitle("Cetacea", null)).toBe("Silhouette of Cetacea");
  });

  it("names the group and its size when the drawing is of a relative", () => {
    // The riffle beetle: 987 tips, where the old rule offered Ecdysozoa's
    // 1,208,417 and called it a silhouette of the beetle.
    expect(
      borrowedTitle("Cleptelmis ornata", { name: "Elminae", tips: 987 }),
    ).toBe(
      "Not Cleptelmis ornata itself — a drawing from within Elminae, " +
        "the smallest group holding both (987 species)",
    );
  });

  it("does not repeat the name when the group is the node itself", () => {
    // Nobody drew Selachii; somebody drew a shark inside it.
    expect(borrowedTitle("Selachii", { name: "Selachii", tips: 723 })).toBe(
      "Not Selachii itself — a drawing of one of its 723 species",
    );
  });

  it("still declares the borrow when the group has no name", () => {
    // Most internal nodes are unnamed `mrcaott…` divergences. There is nothing
    // to name, and that is not a reason to imply a portrait.
    const t = borrowedTitle("Homo / Pan", { name: null, tips: 4210 });
    expect(t).toContain("Not Homo / Pan itself");
    expect(t).not.toContain("null");
  });

  it("never silently claims a portrait when the size is missing", () => {
    const t = borrowedTitle("Elminae", { name: "Elminae", tips: null });
    expect(t).toContain("Not Elminae itself");
    expect(t).not.toContain("null");
  });
});

describe("the occurrence tier never becomes an age", () => {
  const RANGE = { fea: 83.6, fla: 72.2, lea: 72.2, lla: 66 };

  it("shows no age, exactly like structural", () => {
    // Both mean "nobody estimated one". A tier that reports a range must not
    // also acquire a number, or the range reads as an estimate of it.
    expect(ageLabel(66, TIER_OCCURRENCE)).toBeNull();
    expect(ageLabel(null, TIER_OCCURRENCE)).toBeNull();
  });

  it("states a range, and never without the mark that says what it is", () => {
    const a = markAge(null, TIER_OCCURRENCE, RANGE);
    expect(a).toEqual({
      glyph: "fossil",
      text: "84–66 Ma",
      title: expect.stringContaining("84–66 Ma"),
    });
    // The whole point: beside a node drawn at 66 Ma, a bare "84–66 Ma" is
    // indistinguishable from that node's age. The glyph carries the word the
    // label used to spell out, so the range may never arrive without one.
    expect(occurrenceSpan(TIER_OCCURRENCE, RANGE)).toBe("84–66 Ma");
  });

  it("says what the mark means, for anyone who cannot see it", () => {
    // The mark is the only thing distinguishing a range from an age on the
    // canvas, so the distinction cannot be available to sighted readers alone.
    const a = markAge(null, TIER_OCCURRENCE, RANGE);
    expect(a?.title).toMatch(/not an estimate/i);
  });

  it("never emits a single date", () => {
    // A midpoint is a fabricated estimate wearing an observation's clothes.
    for (const occ of [
      RANGE,
      { fea: 5.333, fla: 1.8, lea: 0.129, lla: 0.0117 },
      { fea: 83.6, fla: null, lea: null, lla: 66 },
    ]) {
      expect(occurrenceSpan(TIER_OCCURRENCE, occ)).toMatch(/–/);
    }
  });

  it("says nothing for a node that is not on the tier", () => {
    expect(occurrenceSpan(TIER_STRUCTURAL, RANGE)).toBeNull();
    expect(occurrenceSpan(TIER_MEASURED, RANGE)).toBeNull();
    // And a structural node with a range attached still shows nothing at all,
    // rather than falling through to a glyph with no figure beside it.
    expect(markAge(null, TIER_STRUCTURAL, RANGE)).toBeNull();
  });

  it("says nothing when the tier arrives without a range", () => {
    // Better silent than a label promising a span it cannot state.
    expect(occurrenceSpan(TIER_OCCURRENCE, null)).toBeNull();
    expect(
      occurrenceSpan(TIER_OCCURRENCE, {
        fea: null,
        fla: null,
        lea: null,
        lla: null,
      }),
    ).toBeNull();
    expect(markAge(66, TIER_OCCURRENCE, null)).toBeNull();
  });

  it("never says the taxon is present, because the tier means it ended", () => {
    // Homo erectus has a last appearance of 0.0117 Ma. The lane's own label
    // renders anything under 0.05 as "present", which is right there and a
    // plain falsehood here — the tier is only applied where nothing below the
    // node is alive.
    const a = markAge(null, TIER_OCCURRENCE, {
      fea: 5.333,
      fla: 1.8,
      lea: 0.129,
      lla: 0.0117,
    });
    expect(a?.glyph).toBe("fossil");
    expect(a?.text).toBe("5.3–0.01 Ma");
  });
});

describe("the age slot's marks", () => {
  it("says nothing at all where the answer is not a quantity", () => {
    // "present" is a position, not a quantity — the rule this file has always
    // stated — and every neighbour in this slot is a figure. So the slot no
    // longer answers it: the clock that used to stand here took the width of a
    // figure to say something that was never one. Whether the taxon is alive is
    // a fact about the taxon, and it marks the taxon now. See `isExtant`.
    expect(markAge(0.01, TIER_MEASURED, null)).toBeNull();
  });

  it("reads extinction off the tier, which is the only place it is recorded", () => {
    // `occurrence` is applied only where nothing below the node is alive — that
    // is what makes it a range in the rock rather than a divergence age.
    expect(isExtant(TIER_OCCURRENCE)).toBe(false);
    expect(isExtant(TIER_MEASURED)).toBe(true);
  });

  it("does not confuse being alive with being drawn at the present", () => {
    // The first attempt asked whether `age_ma` was ~0, and *Cetacea* and *Homo*
    // are as alive as *Homo sapiens* is. A clade sits at its crown age — when it
    // began — so a rule keyed on position marks only the tips, and marking "this
    // is at x ≈ 0" says what the axis already says.
    expect(isExtant(TIER_STRUCTURAL)).toBe(true);
    expect(isExtant(TIER_INTERPOLATED)).toBe(true);
  });

  it("leaves an ordinary age unmarked", () => {
    // Every other value in the slot is a figure that reads on its own. A glyph
    // on all of them would be decoration, and decoration here costs label width.
    expect(markAge(96, TIER_MEASURED, null)).toEqual({
      glyph: null,
      text: "96 Ma",
      title: "",
    });
  });

  it("shows nothing where no age may be shown", () => {
    expect(markAge(96, TIER_STRUCTURAL, null)).toBeNull();
  });
});

describe("metaLine", () => {
  it("prints a rank the reader can use", () => {
    expect(metaLine("species", true)).toBe("SPECIES");
    expect(metaLine("species", false)).toBe("");
  });

  it("refuses every string the taxonomy uses to mean 'unranked'", () => {
    // The canvas knew about `no rank` and not about `no rank - terminal`, which
    // 78,696 nodes carry — so the row meant to say what kind of thing this is
    // could say NO RANK - TERMINAL above the name. One predicate now, shared
    // with the card, which had the full set from the day it was written.
    for (const r of ["no rank", "no rank - terminal", "unranked", "", null]) {
      expect(metaLine(r, true)).toBe("");
    }
  });
});
