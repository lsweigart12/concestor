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
    expect(
      highlight("Homo sapiens", m.ranges)
        .map((p) => p.text)
        .join(""),
    ).toBe("Homo sapiens");
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
    // The run covers the plural, not just the letters typed: the reader typed
    // a word, and "sharks" is that word. See the plural block below.
    expect(litRanges("shark", "Bamboo sharks")).toEqual([[7, 13]]);
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

describe("a regular plural is the word the reader typed", () => {
  it("lights the plural of a typed singular", () => {
    // Papilionidae is headlined "swallowtail butterflies". Without this it was
    // the one row on the page for "butterfly" with nothing lit — directly
    // above three that had, which reads as "this one does not match".
    expect(litRanges("butterfly", "swallowtail butterflies")).toEqual([
      [12, 23],
    ]);
    expect(litRanges("shark", "mackerel sharks")).toEqual([[9, 15]]);
    expect(litRanges("finch", "Darwin's finches")).toEqual([[9, 16]]);
  });

  it("still lights nothing when the word is genuinely absent", () => {
    expect(litRanges("butterfly", "Papilionidae")).toEqual([]);
    expect(litRanges("oak", "Sphagnum")).toEqual([]);
  });

  it("will not pluralise anything short enough to be an accident", () => {
    // "go" must not claim "goes"; the substring hit at 0 is all it earns.
    expect(litRanges("go", "goes nowhere")).toEqual([[0, 2]]);
  });
});
