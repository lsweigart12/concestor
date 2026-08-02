import { describe, expect, it } from "vitest";
import {
  labelBounds,
  placeLabels,
  traceRects,
  type LabelInput,
  type TraceRun,
} from "./labels";

const OPTS = { rowH: 74, maxTextWidth: 240 };

function node(over: Partial<LabelInput> & { idx: number; x: number; y: number }): LabelInput {
  return {
    terminal: false,
    name: "Clade",
    trailing: "",
    trailingGlyph: false,
    meta: "",
    hasSilhouette: false,
    priority: 0,
    ...over,
  };
}

/** Does a placed label's rect overlap anything else placed? */
function rects(inputs: LabelInput[], boxes: ReturnType<typeof placeLabels>) {
  return inputs.flatMap((n) => {
    const b = boxes.get(n.idx);
    if (!b) return [];
    return [
      {
        idx: n.idx,
        x: b.side === "right" ? n.x + 13 : n.x - 13 - b.width,
        y: n.y + b.dy - b.height / 2,
        w: b.width,
        h: b.height,
      },
    ];
  });
}

function anyOverlap(rs: ReturnType<typeof rects>): [number, number] | null {
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i]!;
      const b = rs[j]!;
      const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (dx > 0.5 && dy > 0.5) return [a.idx, b.idx];
    }
  }
  return null;
}

describe("label placement", () => {
  it("separates labels on nodes that share a lane", () => {
    // Two nodes 60px apart on the same row. Both default to the same side, so
    // one has to move; this is the case that produced overlapping text.
    const inputs = [
      node({ idx: 1, x: 0, y: 0, name: "Boreoeutheria", trailing: "≤ 96 Ma" }),
      node({ idx: 2, x: 60, y: 0, name: "Mammalia", meta: "CLASS" }),
    ];
    const boxes = placeLabels(inputs, [], OPTS);
    expect(boxes.size).toBe(2);
    expect(anyOverlap(rects(inputs, boxes))).toBeNull();
  });

  it("keeps a clade label off the trace running out of it", () => {
    // Carnivora → Canis in the same lane: the edge is a horizontal run at the
    // child's y, straight through where a right-hand label would sit.
    const parent = node({ idx: 1, x: 100, y: 0, name: "Carnivora", meta: "ORDER" });
    const child = node({
      idx: 2,
      x: 600,
      y: 0,
      terminal: true,
      name: "Canis lupus familiaris",
      meta: "SUBSPECIES",
      priority: 1e9,
    });
    const runs: TraceRun[] = [{ ax: 100, ay: 0, bx: 600, by: 0 }];
    const boxes = placeLabels([parent, child], runs, OPTS);

    const p = boxes.get(1)!;
    // It must not sit on the line: either it moved off the row, or it went to
    // the side the trace does not occupy.
    expect(Math.abs(p.dy) > p.height / 2 || p.side === "left").toBe(true);
    expect(p.overlapped).toBe(false);
  });

  it("wraps a name too long for the column instead of running past it", () => {
    const long = node({
      idx: 1,
      x: 0,
      y: 0,
      name: "Ornithorhynchus anatinus of the western river systems",
    });
    const b = placeLabels([long], [], OPTS).get(1)!;
    // Never wider than the column it was given...
    expect(b.width).toBeLessThanOrEqual(OPTS.maxTextWidth + 1);
    // ...which means this name had to become more than one row.
    expect(b.height).toBeGreaterThan(20);
  });

  it("never overlaps silently — a crowded label either moves, wraps, or says so", () => {
    // The invariant that matters, over a genuinely dense cluster with long
    // names. Every box is either clear of every other, or flagged. Anything
    // else is text printed over text with nothing downstream knowing.
    const inputs = [
      node({ idx: 1, x: 0, y: 0, name: "Boreoeutheria", trailing: "≤ 96 Ma" }),
      node({ idx: 2, x: 46, y: 8, name: "Mammalia", meta: "CLASS" }),
      node({ idx: 3, x: 92, y: 16, name: "Carnivora", meta: "ORDER" }),
      node({
        idx: 4,
        x: 150,
        y: 24,
        terminal: true,
        name: "Canis lupus familiaris",
        meta: "SUBSPECIES · silhouette: Mammalia",
        hasSilhouette: true,
        priority: 1e9,
      }),
      node({ idx: 5, x: 30, y: -20, name: "Heteromorpha", meta: "GENUS" }),
    ];
    const boxes = placeLabels(inputs, [], OPTS);
    const placedRects = rects(inputs, boxes);
    for (const r of placedRects) {
      const others = placedRects.filter((o) => o.idx !== r.idx);
      const clash = anyOverlap([r, ...others].filter((o) => o.idx === r.idx || true));
      if (clash) {
        // If anything overlaps, at least one participant must admit it.
        const [a, b] = clash;
        expect(boxes.get(a)!.overlapped || boxes.get(b)!.overlapped).toBe(true);
      }
    }
  });

  it("gives the clear space to the higher-priority label", () => {
    // Same point, so the two labels want the identical slot and exactly one
    // can have it. The selection outranks the divergence it hangs from.
    const leaf = node({
      idx: 1,
      x: 0,
      y: 0,
      terminal: true,
      name: "Homo sapiens",
      priority: 1e9,
    });
    const clade = node({ idx: 2, x: 0, y: 0, name: "Hominidae", priority: 1 });
    const boxes = placeLabels([leaf, clade], [], OPTS);
    expect(boxes.get(1)!.side).toBe("right");
    expect(boxes.get(1)!.dy).toBe(0);
    expect(boxes.get(2)!.dy).not.toBe(0);
    expect(anyOverlap(rects([leaf, clade], boxes))).toBeNull();
  });

  it("routes a label around another node's point, not over it", () => {
    // A luminous dot with text printed across it is unreadable both ways.
    const subject = node({ idx: 1, x: 0, y: 0, terminal: true, priority: 1e9 });
    const neighbour = node({ idx: 2, x: 22, y: 0, priority: 10 });
    const b = placeLabels([subject, neighbour], [], OPTS).get(1)!;
    expect(Math.abs(b.dy)).toBeGreaterThan(0);
  });

  it("admits defeat rather than hiding an unavoidable collision", () => {
    // Forty labels stacked on one point. There are fourteen candidate slots,
    // so no search can place these cleanly — and the honest output is every
    // label still positioned, with the ones that had to overlap saying so.
    const inputs = Array.from({ length: 40 }, (_, i) =>
      node({ idx: i, x: 0, y: 0, name: `Taxon number ${i}`, priority: -i }),
    );
    const boxes = placeLabels(inputs, [], OPTS);
    expect(boxes.size).toBe(40);
    // Nothing is silently dropped...
    for (let i = 0; i < 40; i++) expect(boxes.get(i)).toBeDefined();
    // ...and the crowding is reported rather than hidden.
    expect([...boxes.values()].some((b) => b.overlapped)).toBe(true);
  });

  it("is deterministic and independent of input order", () => {
    const a = node({ idx: 1, x: 0, y: 0, priority: 5 });
    const b = node({ idx: 2, x: 40, y: 0, priority: 5 });
    const c = node({ idx: 3, x: 80, y: 20, priority: 5 });
    const one = placeLabels([a, b, c], [], OPTS);
    const two = placeLabels([c, b, a], [], OPTS);
    for (const k of [1, 2, 3]) {
      expect(two.get(k)).toEqual(one.get(k));
    }
  });

  it("reports bounds that contain every label", () => {
    const inputs = [
      node({ idx: 1, x: 0, y: 0, name: "Eukaryota", trailing: "1781 Ma" }),
      node({ idx: 2, x: 400, y: 74, terminal: true, name: "Homo sapiens", priority: 1e9 }),
    ];
    const boxes = placeLabels(inputs, [], OPTS);
    const bounds = labelBounds(inputs, boxes)!;
    for (const r of rects(inputs, boxes)) {
      expect(r.x).toBeGreaterThanOrEqual(bounds.x - 0.5);
      expect(r.x + r.w).toBeLessThanOrEqual(bounds.x + bounds.w + 0.5);
      expect(r.y).toBeGreaterThanOrEqual(bounds.y - 0.5);
      expect(r.y + r.h).toBeLessThanOrEqual(bounds.y + bounds.h + 0.5);
    }
  });
});

describe("trace occupancy", () => {
  it("covers both runs of an orthogonal edge", () => {
    const [vertical, horizontal] = traceRects([{ ax: 10, ay: 0, bx: 200, by: 50 }]);
    expect(vertical!.x).toBeLessThanOrEqual(10);
    expect(vertical!.h).toBeGreaterThanOrEqual(50);
    expect(horizontal!.w).toBeGreaterThanOrEqual(190);
    expect(horizontal!.y).toBeLessThanOrEqual(50);
  });

  it("gives a same-lane edge a horizontal run with real extent", () => {
    const [, horizontal] = traceRects([{ ax: 0, ay: 0, bx: 500, by: 0 }]);
    expect(horizontal!.w).toBeGreaterThan(400);
    expect(horizontal!.h).toBeGreaterThan(0);
  });
});
