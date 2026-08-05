import { describe, expect, it } from "vitest";
import { bandTiling, buildTicks, fmtAge, tickLabel } from "./TimeAxis";
import { ageFrac, type AxisMode } from "../tree/layout";
import type { TimescaleInterval } from "../api";

/**
 * A screen mapping for a given axis, so the tests read positions the way the
 * canvas does: present on the right, deep time to the left.
 */
function screen(maxAge: number, mode: AxisMode, px = 1000, zoom = 1) {
  return (age: number) => (px - px * ageFrac(age, maxAge, mode)) * zoom;
}

describe("axis ticks", () => {
  it("labels the last 10 Ma, which a fixed tick set could not", () => {
    // The whole human-and-chimp tree lives inside 7 Ma. The axis used to draw
    // one number on it — `0` — because its tick set jumped from 1 to 10.
    const toX = screen(6.7, "log");
    const ticks = buildTicks(0, 6.7, "log", toX, 1000);
    expect(ticks.length).toBeGreaterThan(3);
    expect(ticks.filter((t) => t > 1 && t < 10).length).toBeGreaterThan(1);
  });

  it("follows the view in rather than emptying out", () => {
    // Zoomed into the Pliocene, every member of the old fixed set was
    // off-screen and the axis rendered nothing at all.
    const toX = screen(1315, "log", 1000, 8);
    const ticks = buildTicks(2, 6, "log", toX, 1000);
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(2);
      expect(t).toBeLessThanOrEqual(6);
    }
  });

  it("keeps the boundaries a reader recognises over the round numbers", () => {
    // 66 Ma is the K–Pg and 50 Ma is nothing in particular. On a log axis they
    // land close enough to collide, and priority is what decides it.
    const toX = screen(1315, "log");
    const ticks = buildTicks(0, 1315, "log", toX, 1000);
    expect(ticks).toContain(66);
    expect(ticks).toContain(252);
  });

  it("never offers a tick outside the axis", () => {
    const toX = screen(455, "log");
    for (const t of buildTicks(0, 455, "log", toX, 1000)) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(455);
    }
  });

  it("steps evenly on the linear scale", () => {
    const toX = screen(1315, "linear");
    const ticks = buildTicks(0, 1315, "linear", toX, 1000);
    expect(ticks.length).toBeGreaterThan(4);
    const gaps = ticks.slice(1).map((t, i) => t - ticks[i]!);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0]!, 6);
  });

  it("resolves below 1 Ma when that is all the view holds", () => {
    const toX = screen(6.7, "linear");
    const ticks = buildTicks(0, 0.8, "linear", toX, 1000);
    expect(ticks.some((t) => t > 0 && t < 1)).toBe(true);
    // A step of 0.1 must print as "0.3", not as 0.30000000000000004.
    for (const t of ticks) expect(fmtAge(t)).not.toMatch(/000000|999999/);
  });

  it("keeps the labels apart, not just their positions", () => {
    // "present" is seven characters where every other tick is one to four, so
    // a flat centre-to-centre gap lets the neighbour print through it.
    const toX = screen(1315, "log");
    const ticks = buildTicks(0, 1315, "log", toX, 1000);
    const boxes = ticks
      .map((t) => {
        const half = (tickLabel(t).length * 6.3) / 2;
        return { lo: toX(t) - half, hi: toX(t) + half };
      })
      .sort((a, b) => a.lo - b.lo);
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.lo).toBeGreaterThan(boxes[i - 1]!.hi);
    }
  });

  it("names the present rather than numbering it", () => {
    expect(tickLabel(0)).toBe("present");
    expect(tickLabel(66)).toBe("66");
  });

  /**
   * A projection that cannot place anything must yield nothing to place.
   *
   * React Flow substitutes 500 for a container dimension that measures zero,
   * so a canvas the browser has not laid out yet reports a size and gets a
   * fit — which d3-zoom then interpolates against the real, zero-width extent
   * and resolves to a NaN transform. Every `toScreenX` downstream of that is
   * NaN, and this is where it used to become visible: the placement loop
   * measures collisions with `>=`, NaN fails every comparison, so the first
   * candidate was kept, every later one was judged to collide with it, and the
   * survivor was drawn at `x="NaN"` — which the DOM rejects per attribute and
   * silently replaces with zero, printing "present" against the left edge of a
   * canvas whose present is on the right. Nothing errored and nothing looked
   * broken enough to report.
   */
  it("offers no ticks at all through a projection that is not a number", () => {
    const nan = () => NaN;
    expect(buildTicks(0, 1315, "log", nan, 1000)).toEqual([]);
    expect(buildTicks(0, 1315, "linear", nan, 1000)).toEqual([]);
    // The failure it replaces: exactly one survivor, at NaN.
    expect(buildTicks(0, 96, "linear", nan, 1000)).not.toContain(0);
  });

  it("drops only the ticks it cannot place, never the ones it can", () => {
    // A projection finite everywhere but at the present — the guard must be a
    // property of each tick rather than of the axis, or one bad age silences
    // the whole rule.
    const toX = screen(1315, "log");
    const holed = (age: number) => (age === 0 ? NaN : toX(age));
    const ticks = buildTicks(0, 1315, "log", holed, 1000);
    expect(ticks).not.toContain(0);
    expect(ticks).toContain(66);
    expect(ticks.length).toBeGreaterThan(3);
    for (const t of ticks) expect(Number.isFinite(holed(t))).toBe(true);
  });
});

/**
 * A slice of the real ICS tree, enough to exercise the two shapes that broke
 * the old single-rank rule: an Era whose siblings differ in width by 6×, and a
 * Period whose two children are a whole Epoch and 11,700 years.
 */
const ICS: TimescaleInterval[] = [
  ["Precambrian", null, 4567, 538.8, "Super-Eon"],
  ["Hadean", "Precambrian", 4567, 4031, "Eon"],
  ["Archean", "Precambrian", 4031, 2500, "Eon"],
  ["Proterozoic", "Precambrian", 2500, 538.8, "Eon"],
  ["Phanerozoic", null, 538.8, 0, "Eon"],
  ["Paleozoic", "Phanerozoic", 538.8, 251.9, "Era"],
  ["Mesozoic", "Phanerozoic", 251.9, 66, "Era"],
  ["Cenozoic", "Phanerozoic", 66, 0, "Era"],
  ["Triassic", "Mesozoic", 251.9, 201.4, "Period"],
  ["Jurassic", "Mesozoic", 201.4, 145, "Period"],
  ["Cretaceous", "Mesozoic", 145, 66, "Period"],
  ["Paleogene", "Cenozoic", 66, 23.03, "Period"],
  ["Neogene", "Cenozoic", 23.03, 2.58, "Period"],
  ["Quaternary", "Cenozoic", 2.58, 0, "Period"],
  ["Pleistocene", "Quaternary", 2.58, 0.0117, "Epoch"],
  ["Holocene", "Quaternary", 0.0117, 0, "Epoch"],
].map(([id, parent, begin_ma, end_ma, rank]) => ({
  id: id as string,
  name: id as string,
  rank: rank as string,
  parent: parent as string | null,
  begin_ma: begin_ma as number,
  end_ma: end_ma as number,
  color: "#333",
}));

const named = (rows: TimescaleInterval[]) => rows.map((r) => r.name);

describe("geologic band tiling", () => {
  const maxAge = 538.8;
  const toX = screen(maxAge, "log");
  const widthOf = (i: TimescaleInterval) =>
    Math.abs(toX(i.begin_ma) - toX(i.end_ma));

  it("tiles the axis without gaps or overlaps", () => {
    const out = bandTiling(ICS, widthOf).sort(
      (a, b) => b.begin_ma - a.begin_ma,
    );
    expect(out[0]!.begin_ma).toBe(4567);
    expect(out[out.length - 1]!.end_ma).toBe(0);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.begin_ma).toBeCloseTo(out[i - 1]!.end_ma, 6);
    }
  });

  it("does not hold the whole axis at one rank for one narrow sibling", () => {
    // The Paleozoic is a sliver on a log axis next to the Cenozoic. Under the
    // old single-rank rule that one interval put "Phanerozoic" across the whole
    // strip; under an all-children-fit rule it does the same.
    const out = named(bandTiling(ICS, widthOf));
    expect(out).not.toContain("Phanerozoic");
    expect(out).toContain("Paleozoic");
  });

  it("gives the recent end more detail than the deep end", () => {
    const out = bandTiling(ICS, widthOf);
    const rankOf = (name: string) => out.find((i) => i.name === name)?.rank;
    expect(rankOf("Paleozoic")).toBe("Era");
    expect(rankOf("Neogene")).toBe("Period");
  });

  it("splits a band whose one legible child covers it", () => {
    // The Quaternary's children are a screen-wide Pleistocene and an
    // 11,700-year Holocene. One of two is not a majority by count, and that
    // left a 470-pixel Pleistocene unnamed.
    const out = named(bandTiling(ICS, widthOf));
    expect(out).toContain("Pleistocene");
    expect(out).not.toContain("Quaternary");
  });

  it("keeps a band whose children could not carry their own names", () => {
    // Splitting the Mesozoic here buys three Periods too narrow to label, so
    // the reader gets three anonymous slivers instead of one named Era.
    const out = named(bandTiling(ICS, widthOf));
    expect(out).toContain("Mesozoic");
    expect(out).not.toContain("Jurassic");
  });

  it("refines as the view zooms in", () => {
    const deep = screen(maxAge, "log", 1000, 12);
    const out = named(
      bandTiling(ICS, (i) => Math.abs(deep(i.begin_ma) - deep(i.end_ma))),
    );
    expect(out).toContain("Jurassic");
    expect(out).toContain("Cretaceous");
  });

  it("reaches the formation of the Earth whatever the selection holds", () => {
    // The band used to be cut off at the deepest node in the current
    // selection, so it began abruptly and unlabelled wherever that root
    // happened to fall — and moved every time a species was added.
    const shallow = screen(6.7, "log");
    const out = bandTiling(ICS, (i) =>
      Math.abs(shallow(i.begin_ma) - shallow(i.end_ma)),
    ).sort((a, b) => b.begin_ma - a.begin_ma);
    expect(out[0]!.begin_ma).toBe(4567);
  });
});

describe("age formatting", () => {
  it("prints what a reader would write", () => {
    expect(fmtAge(0)).toBe("0");
    expect(fmtAge(1)).toBe("1");
    expect(fmtAge(66)).toBe("66");
    expect(fmtAge(0.5)).toBe("0.5");
    expect(fmtAge(2500)).toBe("2500");
  });

  it("strips the float noise a step calculation leaves behind", () => {
    expect(fmtAge(0.1 + 0.2)).toBe("0.3");
    expect(fmtAge(3 * 0.1)).toBe("0.3");
  });
});
