/**
 * The legend explains what is on the canvas, and nothing else.
 *
 * Both halves of that matter. A row for a pattern that is not drawn sends the
 * reader hunting for a line that is not there; a missing row leaves the dash
 * channel undecodable, which is the failure the legend exists to fix.
 */

import { describe, expect, it } from "vitest";
import { TIER_INTERPOLATED, TIER_MEASURED, TIER_STRUCTURAL } from "../api";
import { legendRows, type TracePattern } from "./Legend";

const measured: TracePattern = { tier: TIER_MEASURED, unbounded: false };
const interpolated: TracePattern = {
  tier: TIER_INTERPOLATED,
  unbounded: false,
};
const structural: TracePattern = { tier: TIER_STRUCTURAL, unbounded: false };
const unbounded: TracePattern = { tier: TIER_STRUCTURAL, unbounded: true };

const ids = (edges: TracePattern[]) => legendRows(edges).map((r) => r.id);

describe("legendRows", () => {
  it("says nothing when every trace is solid", () => {
    // No dashes to decode, so the legend is a caption on the absence of a
    // problem. An empty canvas gets the same treatment.
    expect(legendRows([measured, measured])).toEqual([]);
    expect(legendRows([])).toEqual([]);
  });

  it("explains solid only alongside something that is not", () => {
    expect(ids([measured, structural])).toEqual(["measured", "structural"]);
  });

  it("omits tiers that are not drawn", () => {
    expect(ids([interpolated])).toEqual(["interpolated"]);
    expect(ids([measured, interpolated])).toEqual(["measured", "interpolated"]);
  });

  it("separates an unbounded lineage from a merely undated one", () => {
    // Both are structural and they carry different dash patterns, so a canvas
    // showing one must not be captioned with the other's meaning.
    expect(ids([structural])).toEqual(["structural"]);
    expect(ids([unbounded])).toEqual(["unbounded"]);
    expect(ids([structural, unbounded])).toEqual(["structural", "unbounded"]);
  });

  it("orders rows from most certain to least, whatever order the edges come in", () => {
    expect(ids([unbounded, measured, structural, interpolated])).toEqual([
      "measured",
      "interpolated",
      "structural",
      "unbounded",
    ]);
  });

  it("never shows a row twice", () => {
    const rows = ids([structural, structural, measured, measured]);
    expect(rows).toEqual([...new Set(rows)]);
  });
});
