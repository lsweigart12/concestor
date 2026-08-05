/**
 * The axis, rendered, against the one input it cannot draw: a projection that
 * is not a number.
 *
 * `TimeAxis.test.ts` has the arithmetic and is where the tick rules live. This
 * is the other question, and it needs a DOM to ask: *what reaches the page*.
 * Every position on this strip — the geologic bands, the ticks, the knee, the
 * two named edges — is `toScreenX` of something, and `toScreenX` projects
 * through the live viewport transform. When that transform is NaN, as it was
 * on load for the whole of issue #100, each of those is NaN too, and an SVG
 * length attribute set to `"NaN"` is rejected by the DOM per attribute and
 * quietly replaced with a default. Nothing throws. The axis simply draws in
 * the wrong place — "present" hard against the left edge of a canvas whose
 * present is on the right — and the only trace is a run of console errors.
 *
 * So the assertion is deliberately blunt and made over the *whole* subtree
 * rather than over the elements this issue happened to reach: no attribute
 * anywhere may be NaN. Each guard is somewhere different — the bands are
 * dropped by a width test, the knee and the edges by range tests that NaN
 * already fails, the ticks by `buildTicks` refusing to place what it cannot
 * measure — and a rule spread over four places is one that gets half-changed.
 * This is the single test that notices when it does.
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimeAxis } from "./TimeAxis";
import { ageFrac, type AxisMode } from "../tree/layout";
import type { TimescaleInterval } from "../api";

const ICS: TimescaleInterval[] = [
  ["Phanerozoic", null, 538.8, 0, "Eon"],
  ["Mesozoic", "Phanerozoic", 251.9, 66, "Era"],
  ["Cenozoic", "Phanerozoic", 66, 0, "Era"],
  ["Cretaceous", "Mesozoic", 145, 66, "Period"],
  ["Paleogene", "Cenozoic", 66, 23.03, "Period"],
];

function mount(
  toScreenX: (age: number) => number,
  toAge: (x: number) => number,
  mode: AxisMode = "log",
) {
  return render(
    <TimeAxis
      maxAge={1315}
      width={1000}
      toScreenX={toScreenX}
      toAge={toAge}
      intervals={ICS}
      axisMode={mode}
      onAxisMode={vi.fn()}
      legend={null}
    />,
  );
}

/** Every attribute of every element drawn, as `tag@name=value`. */
function attrs(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll("*")) {
    for (const a of el.attributes) out.push(`${el.tagName}@${a.name}=${a.value}`);
  }
  return out;
}

describe("TimeAxis", () => {
  it("draws nothing at NaN when the viewport transform is not a number", () => {
    // Exactly the boot state issue #100 reported: React Flow reports a size for
    // a container the browser has not laid out, the fit computed against it is
    // interpolated by d3-zoom against the real zero-width extent, and the store
    // transform becomes NaN. Both directions go with it — the axis asks what
    // age sits under a screen x as well as where an age lands.
    const { container } = mount(
      () => NaN,
      () => NaN,
    );
    expect(attrs(container).filter((a) => a.includes("NaN"))).toEqual([]);
    // And it is drawn rather than crashed: the strip is still there, waiting
    // for a transform it can project through.
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("still draws the axis when the transform is real", () => {
    // The guard above must not be doing its job by drawing nothing ever.
    const toX = (age: number) => 1000 - 1000 * ageFrac(age, 1315, "log");
    const { container } = mount(toX, (x) => 1315 * (1 - x / 1000));
    expect(attrs(container).filter((a) => a.includes("NaN"))).toEqual([]);
    expect(container.querySelectorAll("g.axis-tick").length).toBeGreaterThan(3);
    expect(container.textContent).toContain("present");
  });

  it("keeps the ticks it can place when only one age is unprojectable", () => {
    const toX = (age: number) => 1000 - 1000 * ageFrac(age, 1315, "log");
    const holed = (age: number) => (age === 0 ? NaN : toX(age));
    const { container } = mount(holed, (x) => 1315 * (1 - x / 1000));
    expect(attrs(container).filter((a) => a.includes("NaN"))).toEqual([]);
    expect(container.querySelectorAll("g.axis-tick").length).toBeGreaterThan(3);
    // The present is the one it cannot place, so it is the one that goes.
    expect(container.textContent).not.toContain("present");
  });
});
