import { describe, expect, it } from "vitest";
import { bracketGeom, bracketKey, spanLabel, MIN_MARK_PX, type Appearance } from "./Bracket";

/**
 * A linear stand-in for the symlog axis: present at x=1000, one Ma per px
 * running left. Only the direction matters to the geometry — older is smaller
 * x — and a linear map makes the expected numbers readable.
 */
const toX = (ma: number) => 1000 - ma;

const none: Appearance = { fea: null, fla: null, lea: null, lla: null };

describe("bracketGeom", () => {
  /**
   * Case 1: `fla > lea`, so there is an extent the record forces. Only 39.6%
   * of PBDB rows with four bounds reach this case at all.
   * *Allosaurus*, 147 occurrences, from the real segment 654137 → 654219.
   */
  it("draws both marks when the certain extent has duration", () => {
    const g = bracketGeom(
      { fea: 161.5, fla: 152.21, lea: 143.1, lla: 137.05 },
      toX,
    );
    if (g.kind !== "range") throw new Error("expected a range");
    expect(g.certainty).toBe("extent");
    // Envelope is fea → lla, the maximal possible extent.
    expect(g.envelope.x).toBeCloseTo(toX(161.5));
    expect(g.envelope.w).toBeCloseTo(161.5 - 137.05);
    // Core is fla → lea, the minimal certain one, and strictly inside it.
    expect(g.certain).not.toBeNull();
    expect(g.certain!.x).toBeCloseTo(toX(152.21));
    expect(g.certain!.w).toBeCloseTo(152.21 - 143.1);
    expect(g.certain!.x).toBeGreaterThan(g.envelope.x);
    expect(g.certain!.x + g.certain!.w).toBeLessThan(g.envelope.x + g.envelope.w);
    expect(g.oldest).toBe(161.5);
    expect(g.youngest).toBe(137.05);
  });

  /**
   * Case 2: `fla < lea`. The first- and last-appearance brackets overlap, so
   * no moment is certainly occupied and nothing solid may be drawn — not
   * zero-width, not inverted. This is the majority case, 60.4% of four-bound
   * rows and 99.9% of single-occurrence taxa.
   * *Tyrannosaurus mcraeensis*, 1 occurrence, from segment 654140 → 654142.
   */
  it("draws no certain bar where the brackets overlap", () => {
    const g = bracketGeom({ fea: 83.6, fla: 66, lea: 83.6, lla: 66 }, toX);
    if (g.kind !== "range") throw new Error("expected a range");
    expect(g.certainty).toBe("overlapping");
    expect(g.certain).toBeNull();
    expect(g.envelope.w).toBeCloseTo(83.6 - 66);
  });

  /**
   * `fla === lea`: the brackets meet at one date. A zero-duration extent drawn
   * as a hairline reads as precision, so it draws no bar either — but it stays
   * a case of its own, because it is not the same claim as an overlap.
   * *Tyrannosaurus rex*, 70 occurrences.
   */
  it("draws no bar for an extent of zero duration", () => {
    const g = bracketGeom({ fea: 83.6, fla: 72.2, lea: 72.2, lla: 66 }, toX);
    if (g.kind !== "range") throw new Error("expected a range");
    expect(g.certainty).toBe("instant");
    expect(g.certain).toBeNull();
  });

  /** Case 3: no interval at all — 21.4% of the corpus. */
  it("reports an absent bracket rather than an empty one", () => {
    expect(bracketGeom(none, toX)).toEqual({ kind: "absent" });
    // Not a range of zero width, which would put a mark on the axis at a
    // position nothing in the record supports.
    expect(bracketGeom(none, toX).kind).not.toBe("range");
  });

  it("never summarises a bracket as a single point", () => {
    const rows: Appearance[] = [
      { fea: 161.5, fla: 152.21, lea: 143.1, lla: 137.05 },
      { fea: 83.6, fla: 66, lea: 83.6, lla: 66 },
      { fea: 83.6, fla: 72.2, lea: 72.2, lla: 66 },
    ];
    for (const r of rows) {
      const g = bracketGeom(r, toX);
      if (g.kind !== "range") throw new Error("expected a range");
      // The only mark every row gets is the envelope, and it spans the whole
      // record. A midpoint would be somewhere strictly inside it.
      expect(g.envelope.x).toBeCloseTo(toX(g.oldest));
      expect(g.envelope.x + g.envelope.w).toBeCloseTo(toX(g.youngest));
    }
  });

  it("keeps a sub-pixel envelope visible", () => {
    const g = bracketGeom({ fea: 66.1, fla: 66.05, lea: 66.02, lla: 66 }, toX);
    if (g.kind !== "range") throw new Error("expected a range");
    expect(g.envelope.w).toBe(MIN_MARK_PX);
    // Centred on the true extent rather than grown off one end.
    expect(g.envelope.x + g.envelope.w / 2).toBeCloseTo((toX(66.1) + toX(66)) / 2);
  });

  /**
   * A partial row: PBDB recorded a first appearance and no last one. 424 rows
   * of 523,112 are partial, and this is the commonest shape. The young end is
   * where the record stops, not where the taxon does, so it is flagged for the
   * fade rather than capped.
   */
  it("flags a record with no last-appearance bracket as open", () => {
    const g = bracketGeom({ fea: 190, fla: 182, lea: null, lla: null }, toX);
    if (g.kind !== "range") throw new Error("expected a range");
    expect(g.openYoung).toBe(true);
    expect(g.certainty).toBe("unrecorded");
    expect(g.certain).toBeNull();
    expect(g.envelope.w).toBeCloseTo(8);
  });
});

describe("spanLabel", () => {
  it("keeps the unit on a figure", () => {
    expect(spanLabel(161.5, 137.05)).toBe("162–137 Ma");
    // A living clade's last appearance is zero, and "239–present Ma" reads as
    // a quantity of Ma named "present".
    expect(spanLabel(239.48, 0)).toBe("239 Ma – present");
  });
});

describe("bracketKey", () => {
  it("names only the marks that are drawn", () => {
    const extent = bracketGeom({ fea: 161.5, fla: 152.21, lea: 143.1, lla: 137.05 }, toX);
    const overlap = bracketGeom({ fea: 83.6, fla: 66, lea: 83.6, lla: 66 }, toX);
    const absent = bracketGeom(none, toX);

    expect(bracketKey([overlap]).map((r) => r.id)).toEqual(["envelope"]);
    expect(bracketKey([extent, overlap]).map((r) => r.id)).toEqual([
      "certain",
      "envelope",
    ]);
    expect(bracketKey([overlap, absent]).map((r) => r.id)).toEqual([
      "envelope",
      "absent",
    ]);
    expect(bracketKey([])).toEqual([]);
  });
});
