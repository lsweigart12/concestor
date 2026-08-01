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
    expect(d.drawOrder[d.drawOrder.length - 1]).toContain(added);
    // Root-ward first: staggering in this order reads as travel.
    expect(d.drawOrder.length).toBeGreaterThan(0);
    for (const v of d.drawOrder.flat()) expect(before.rendered).not.toContain(v);
  });

  it("treats the very first selection as its own subject", () => {
    const one = fixture.selection[0]!;
    const after = induced([one], pathOf);
    expect(addDelta(null, after, one).flare).toBe(after.mrca);
  });

  it("draws every new segment, not one route to the newest leaf", () => {
    // The page-load case: nothing was on screen, so the whole subtree is new
    // and every branch of it has to be drawn. Tracing the added leaf's own
    // ancestry left the rest of the tree to appear without an animation.
    const after = induced(fixture.selection, pathOf);
    const d = addDelta(null, after, fixture.selection[0]!);
    // Every rendered node but the root, which is the point the first wave
    // leaves from and has no segment above it to draw.
    expect([...d.drawOrder.flat()].sort((a, b) => a - b)).toEqual(
      after.rendered.filter((v) => v !== after.mrca),
    );
    expect(d.drawOrder.flat()).not.toContain(after.mrca);
    expect(d.reflowing).toEqual([]);
  });

  it("puts siblings in the same wave and children in the next one", () => {
    const after = induced(fixture.selection, pathOf);
    const d = addDelta(null, after, fixture.selection[0]!);

    // The first wave is everything hanging directly off the MRCA: the
    // animation starts at one point and opens outward from it.
    for (const v of d.drawOrder[0]!) {
      expect(after.segments.get(v)?.anc).toBe(after.mrca);
    }
    // And each later wave holds exactly the nodes whose nearest rendered
    // ancestor was in the wave before it, which is what makes sibling branches
    // leave their shared ancestor together.
    for (let w = 1; w < d.drawOrder.length; w++) {
      for (const v of d.drawOrder[w]!) {
        expect(d.drawOrder[w - 1]).toContain(after.segments.get(v)?.anc);
      }
    }
    // A tree several nodes deep must take several waves, or the stagger has
    // collapsed back into a single frame.
    expect(d.drawOrder.length).toBeGreaterThan(1);
  });

  it("starts an incremental add on the very first beat", () => {
    // Wave 0 is the stagger's first beat. A node joining an on-screen ancestor
    // belongs there — if it slipped to wave 1 the whole sequence would sit
    // idle through a beat before anything moved.
    const first = fixture.selection.slice(0, 3);
    const before = induced(first, pathOf);
    const added = fixture.selection[3]!;
    const after = induced([...first, added], pathOf);
    const d = addDelta(before, after, added);
    expect(d.drawOrder[0]!.length).toBeGreaterThan(0);
  });

  it("reports the nodes that merely move", () => {
    const first = fixture.selection.slice(0, 4);
    const before = induced(first, pathOf);
    const after = induced([...first, fixture.selection[4]!], pathOf);
    const d = addDelta(before, after, fixture.selection[4]!);
    for (const v of d.reflowing) expect(before.rendered).toContain(v);
  });
});
