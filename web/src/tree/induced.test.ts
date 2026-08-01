/**
 * The client-side induced subtree must agree exactly with the Python
 * reference in `pipeline/src/concestor_build/render.py`.
 *
 * The fixture is generated from the real baked topology arrays, so this is not
 * a mock: it is the same eleven species the walking-skeleton renderer draws,
 * with their real 41-deep ancestor paths. If the port ever drifts — a
 * suppression rule off by one, an MRCA found at the wrong depth — the tree the
 * user sees stops being the tree the pipeline validated against the live Open
 * Tree API, and nothing else in the system would notice.
 */

import { describe, expect, it } from "vitest";
import { addDelta, induced } from "./induced";
import fixture from "./__fixtures__/induced.json";

const paths = new Map<number, number[]>(
  Object.entries(fixture.paths).map(([k, v]) => [Number(k), v as number[]]),
);
const pathOf = (i: number) => paths.get(i);

describe("induced subtree", () => {
  const ind = induced(fixture.selection, pathOf);

  it("finds the same MRCA as the reference", () => {
    expect(ind.mrca).toBe(fixture.expected.mrca);
  });

  it("renders exactly the reference node set", () => {
    expect(ind.rendered).toEqual(fixture.expected.rendered);
  });

  it("hits the 2|L| - 1 bound exactly", () => {
    // Architecture §7: |L| selections produce at most 2|L|-1 nodes after
    // suppression. Eleven species is twenty-one nodes, and it is exact here
    // because no two selections share a rendered parent.
    expect(ind.rendered.length).toBe(fixture.expected.bound);
  });

  it("reproduces every segment, including the suppressed runs", () => {
    for (const [key, want] of Object.entries(fixture.expected.segments)) {
      const got = ind.segments.get(Number(key));
      expect(got, `segment ${key}`).toBeDefined();
      expect(got!.anc, `anc of ${key}`).toBe(want.anc);
      expect(got!.suppressed, `suppressed of ${key}`).toEqual(want.suppressed);
    }
    expect(ind.segments.size).toBe(
      Object.keys(fixture.expected.segments).length,
    );
  });

  it("suppresses real intermediates — drill-down has content", () => {
    const total = [...ind.segments.values()].reduce(
      (n, s) => n + s.suppressed.length,
      0,
    );
    expect(total).toBeGreaterThan(50);
  });
});

describe("degenerate selections", () => {
  it("one species induces itself, with no MRCA above it", () => {
    const one = fixture.selection[0]!;
    const ind = induced([one], pathOf);
    expect(ind.mrca).toBe(one);
    expect(ind.rendered).toEqual([one]);
    expect(ind.segments.get(one)!.anc).toBeNull();
  });

  it("two species give three nodes: both leaves and their MRCA", () => {
    const [a, b] = [fixture.selection[0]!, fixture.selection[1]!];
    const ind = induced([a, b], pathOf);
    expect(ind.rendered).toHaveLength(3);
    expect(ind.rendered).toContain(a);
    expect(ind.rendered).toContain(b);
    // The MRCA is the last common element of the two paths — no separate
    // query, no separate code path.
    const pa = paths.get(a)!;
    const pb = paths.get(b)!;
    let last = -1;
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      if (pa[i] === pb[i]) last = pa[i]!;
      else break;
    }
    expect(ind.mrca).toBe(last);
  });

  it("is order-independent and duplicate-safe", () => {
    const shuffled = [...fixture.selection].reverse();
    const dup = [...shuffled, shuffled[0]!];
    expect(induced(dup, pathOf).rendered).toEqual(
      induced(fixture.selection, pathOf).rendered,
    );
  });

  it("survives an empty selection", () => {
    expect(induced([], pathOf).rendered).toEqual([]);
  });
});

describe("the add delta — the signature interaction's input", () => {
  it("flares at the join point, not at the root", () => {
    const first = fixture.selection.slice(0, 3);
    const before = induced(first, pathOf);
    const added = fixture.selection[3]!;
    const after = induced([...first, added], pathOf);
    const d = addDelta(before, after, added);

    // The subject of the animation is where the new species joins, so the
    // flare must land on a node that was already on screen.
    expect(before.rendered).toContain(d.flare);
    // ...and the drawn chain must terminate at the new leaf.
    expect(d.drawOrder[d.drawOrder.length - 1]).toBe(added);
    // Root-ward first: staggering in this order reads as travel.
    expect(d.drawOrder.length).toBeGreaterThan(0);
    for (const v of d.drawOrder) expect(before.rendered).not.toContain(v);
  });

  it("treats the very first selection as its own subject", () => {
    const one = fixture.selection[0]!;
    const after = induced([one], pathOf);
    expect(addDelta(null, after, one).flare).toBe(after.mrca);
  });

  it("reports the nodes that merely move", () => {
    const first = fixture.selection.slice(0, 4);
    const before = induced(first, pathOf);
    const after = induced([...first, fixture.selection[4]!], pathOf);
    const d = addDelta(before, after, fixture.selection[4]!);
    for (const v of d.reflowing) expect(before.rendered).toContain(v);
  });
});
