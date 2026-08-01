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
  TIER_MEASURED,
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
} from "../api";
import { ageLabel, borrowedTitle, occurrenceLabel } from "./NodeMark";

describe("borrowedTitle", () => {
  it("says nothing extra about a node's own portrait", () => {
    expect(borrowedTitle("Cetacea", null)).toBe("Silhouette of Cetacea");
  });

  it("names the group and its size when the drawing is of a relative", () => {
    // The riffle beetle: 987 tips, where the old rule offered Ecdysozoa's
    // 1,208,417 and called it a silhouette of the beetle.
    expect(borrowedTitle("Cleptelmis ornata", { name: "Elminae", tips: 987 })).toBe(
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

  it("states a range and prefixes it so it cannot read as an age", () => {
    const l = occurrenceLabel(TIER_OCCURRENCE, RANGE);
    expect(l).toBe("fossils 84–66 Ma");
    // The whole point: beside a node drawn at 66 Ma, a bare "84–66 Ma" is
    // indistinguishable from that node's age.
    expect(l).toMatch(/^fossils /);
  });

  it("never emits a single date", () => {
    // A midpoint is a fabricated estimate wearing an observation's clothes.
    for (const occ of [
      RANGE,
      { fea: 5.333, fla: 1.8, lea: 0.129, lla: 0.0117 },
      { fea: 83.6, fla: null, lea: null, lla: 66 },
    ]) {
      expect(occurrenceLabel(TIER_OCCURRENCE, occ)).toMatch(/–/);
    }
  });

  it("says nothing for a node that is not on the tier", () => {
    expect(occurrenceLabel(TIER_STRUCTURAL, RANGE)).toBeNull();
    expect(occurrenceLabel(TIER_MEASURED, RANGE)).toBeNull();
  });

  it("says nothing when the tier arrives without a range", () => {
    // Better silent than a label promising a span it cannot state.
    expect(occurrenceLabel(TIER_OCCURRENCE, null)).toBeNull();
    expect(
      occurrenceLabel(TIER_OCCURRENCE, { fea: null, fla: null, lea: null, lla: null }),
    ).toBeNull();
  });

  it("reaches to the present rather than inventing a young bound", () => {
    // Mammalia's fossils run to now. "94 Ma – 0 Ma" reads as an extinction.
    expect(occurrenceLabel(TIER_OCCURRENCE, { fea: 94, fla: 66, lea: 2, lla: 0 })).toBe(
      "fossils 94 Ma – present",
    );
  });
});
