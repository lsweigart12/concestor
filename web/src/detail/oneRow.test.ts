import { describe, expect, it } from "vitest";

import { fitOneRow, type Box } from "./oneRow";

/** Items laid out left to right on one row until `rowWidth` is exceeded. */
function layout(widths: readonly number[], rowWidth: number, gap = 6): Box[] {
  const out: Box[] = [];
  let left = 0;
  let top = 0;
  for (const width of widths) {
    if (left > 0 && left + width > rowWidth) {
      left = 0;
      top += 21;
    }
    out.push({ left, width, top });
    left += width + gap;
  }
  return out;
}

describe("fitOneRow", () => {
  it("returns every item when the list already fits", () => {
    const items = layout([60, 70, 80], 360);
    // The signal for "no control needed" is the count equalling the length —
    // the caller has nothing else to go on.
    expect(fitOneRow(items, 60, 360)).toBe(items.length);
  });

  it("does not spend the last name on a control that would count nothing", () => {
    // Exactly filling the row is the case where an over-eager reserve would
    // drop an item to make room for "+0 more".
    const items = layout([100, 100, 100], 320);
    expect(items.every((b) => b.top === 0)).toBe(true);
    expect(fitOneRow(items, 80, 320)).toBe(3);
  });

  it("leaves room for the control when the list overflows", () => {
    const items = layout([100, 100, 100, 100], 310);
    // Four items wrap, so a control is needed; with 80px reserved only the
    // first two clear 310 − 80.
    expect(fitOneRow(items, 80, 310)).toBe(2);
  });

  it("counts only the first row, never a later one that happens to be short", () => {
    const items = layout([200, 200, 20], 360);
    // The 20px item is on row two. It must not be counted just because it
    // would fit inside the remaining width of row one.
    expect(items[2]!.top).toBeGreaterThan(0);
    expect(fitOneRow(items, 40, 360)).toBe(1);
  });

  it("keeps one name even when nothing fits beside the control", () => {
    const items = layout([350, 100], 360);
    // Answering "0 names, +2 more" would hide the name the ranking says
    // matters most in order to advertise that it exists.
    expect(fitOneRow(items, 300, 360)).toBe(1);
  });

  it("is empty for an empty list", () => {
    expect(fitOneRow([], 60, 360)).toBe(0);
  });

  it("treats sub-pixel tops as the same row", () => {
    const items: Box[] = [
      { left: 0, width: 100, top: 0 },
      { left: 106, width: 100, top: 0.5 },
      { left: 0, width: 100, top: 21 },
    ];
    expect(fitOneRow(items, 40, 360)).toBe(2);
  });
});
