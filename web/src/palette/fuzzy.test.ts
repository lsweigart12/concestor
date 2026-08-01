import { describe, expect, it } from "vitest";
import { fuzzy, highlight, litRanges } from "./fuzzy";

describe("fuzzy matching", () => {
  it("prefers a prefix over a match buried in the middle", () => {
    const pre = fuzzy("can", "Canidae")!;
    const mid = fuzzy("can", "Toucan")!;
    expect(pre.score).toBeGreaterThan(mid.score);
  });

  it("returns null when the needle is not a subsequence", () => {
    expect(fuzzy("zzz", "Homo sapiens")).toBeNull();
  });

  it("matches across a word boundary", () => {
    const m = fuzzy("hs", "Homo sapiens");
    expect(m).not.toBeNull();
    expect(m!.ranges.length).toBe(2);
  });

  it("reports ranges that reconstruct the original string", () => {
    const m = fuzzy("sap", "Homo sapiens")!;
    expect(highlight("Homo sapiens", m.ranges).map((p) => p.text).join("")).toBe(
      "Homo sapiens",
    );
    expect(highlight("Homo sapiens", m.ranges).some((p) => p.hit)).toBe(true);
  });

  it("treats an empty needle as a match with no highlight", () => {
    expect(fuzzy("", "anything")).toEqual({ score: 0, ranges: [] });
  });

  it("is case-insensitive", () => {
    expect(fuzzy("HOMO", "Homo sapiens")).not.toBeNull();
  });
});

describe("highlight ranges are an explanation, not a match report", () => {
  it("lights nothing when the query is only a scattered subsequence", () => {
    // fuzzy() accepts this and should — it is what makes typeahead forgiving.
    // Highlighting it would claim the row is here because of those letters.
    expect(fuzzy("abc", "a-b-c")).not.toBeNull();
    expect(litRanges("abc", "a-b-c")).toEqual([]);
  });

  it("lights nothing on a name the query does not appear in at all", () => {
    // The real case that motivated this: searching "shark" surfaces
    // Chiloscyllium because its *vernacular* is "Bamboo sharks". Ranges
    // computed against one string were being painted onto another.
    expect(litRanges("shark", "Chiloscyllium")).toEqual([]);
    expect(litRanges("shark", "Bamboo sharks")).not.toEqual([]);
  });

  it("lights the contiguous run when there is one", () => {
    expect(litRanges("shark", "Bamboo sharks")).toEqual([[7, 12]]);
  });

  it("is case-insensitive and merges abutting occurrences into one run", () => {
    // "an" occurs at 1 and 3 in "Banana"; two adjacent highlights would render
    // as one anyway, so they are merged rather than emitted separately.
    expect(litRanges("an", "Banana")).toEqual([[1, 5]]);
  });

  it("lights each word of a multi-word query where it appears", () => {
    expect(litRanges("homo sapiens", "Homo sapiens")).toEqual([
      [0, 4],
      [5, 12],
    ]);
  });

  it("returns nothing for an empty or whitespace query", () => {
    expect(litRanges("", "anything")).toEqual([]);
    expect(litRanges("   ", "anything")).toEqual([]);
  });
});
