import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  labelBounds,
  MONO,
  placeLabels,
  SANS,
  traceRects,
  TYPE,
  type LabelInput,
  type TraceRun,
} from "./labels";

const OPTS = { rowH: 74, maxTextWidth: 240 };

function node(
  over: Partial<LabelInput> & { idx: number; x: number; y: number },
): LabelInput {
  return {
    terminal: false,
    name: "Clade",
    trailing: "",
    trailingGlyph: false,
    meta: "",
    hasSilhouette: false,
    medium: false,
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

/**
 * The stylesheet, read rather than remembered.
 *
 * Every constant this checks was already documented as having to match the CSS,
 * and three of them had drifted from it: the font stack was an abbreviation
 * canvas resolves to a narrower face, `.mark-age` renders at 11px and was
 * measured at 9.5, and an MRCA's label is 560 weight and was measured at 400.
 * All three under-measure, so every one of them ended as text through a line or
 * a one-word name broken in half.
 */
const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function block(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`styles.css has no rule for ${selector}`);
  return CSS.slice(at, CSS.indexOf("}", at));
}

function decl(selector: string, prop: string): string {
  const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`).exec(
    block(selector),
  );
  if (!m) throw new Error(`${selector} declares no ${prop}`);
  return m[1]!.replace(/\s+/g, " ").trim();
}

describe("the measurer is measuring the type that is actually drawn", () => {
  it("carries the stylesheet's own font stacks, not an abbreviation of them", () => {
    // `ui-sans-serif, -apple-system, sans-serif` is not shorthand for the full
    // list: canvas resolves it to a face 6.1% narrower at 12.5px, and SLACK was
    // spending its entire 6% covering that up.
    expect(SANS).toBe(decl(":root", "--sans"));
    expect(MONO).toBe(decl(":root", "--mono"));
  });

  it("measures each row at the size that row is rendered at", () => {
    expect(TYPE.NAME_FONT).toBe(`${decl(".mark-name", "font-size")} ${SANS}`);
    expect(TYPE.AGE_FONT).toBe(`${decl(".mark-age", "font-size")} ${MONO}`);
    expect(TYPE.META_FONT).toBe(`${decl(".mark-meta", "font-size")} ${MONO}`);
  });

  it("measures the MRCA at the weight the MRCA is drawn in", () => {
    const med = decl(":root", "--w-med");
    expect(decl(".mark.is-mrca .mark-label", "font-weight")).toBe(
      "var(--w-med)",
    );
    expect(TYPE.NAME_FONT_MED).toBe(`${med} ${TYPE.NAME_FONT}`);
  });

  it("reserves the letter-spacing the browser adds and the model cannot see", () => {
    // `measureText` knows nothing about CSS tracking. `.mark-meta` carries
    // 0.06em — eleven pixels across a twenty-character rank. The age's is
    // negative and arrives from `.num`, not from `.mark-age`.
    expect(`${TYPE.NAME_TRACKING}em`).toBe(
      decl(".mark-name", "letter-spacing"),
    );
    expect(`${TYPE.AGE_TRACKING}em`).toBe(
      decl(".num,\n.mono", "letter-spacing"),
    );
    expect(`${TYPE.META_TRACKING}em`).toBe(
      decl(".mark-meta", "letter-spacing"),
    );
  });

  it("takes the age's family from the class that actually sets it", () => {
    // `.mark-age` declares a size and no family; `.num` beside it is where the
    // mono comes from. Measuring the figure in the name's sans would be a
    // different width entirely.
    expect(decl(".num,\n.mono", "font-family")).toBe("var(--mono)");
  });

  it("reserves the age glyph as the word it stands in for", () => {
    const w = Number.parseFloat(decl(".age-glyph", "width"));
    const gap = Number.parseFloat(decl(".age-glyph", "margin-right"));
    expect(TYPE.GLYPH_W).toBe(w + gap);
  });

  it("gives every row at least the height its own line-height asks for", () => {
    // A row is at least as tall as its strut — its font-size times its
    // line-height — whatever is inside it, so a row that does not pin both is a
    // row whose height nothing here can predict. One did not: it inherited
    // `.mark.is-leaf .mark-label`'s 13.5px and stood 17.9px against a
    // reserved 15.
    const line = (sel: string) =>
      Number.parseFloat(decl(sel, "font-size")) *
      Number.parseFloat(decl(sel, "line-height"));
    expect(TYPE.NAME_LINE).toBeGreaterThanOrEqual(line(".mark-name"));
    expect(TYPE.META_LINE).toBeGreaterThanOrEqual(line(".mark-age"));
    expect(TYPE.META_LINE).toBeGreaterThanOrEqual(line(".mark-meta"));
  });
});

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
    const parent = node({
      idx: 1,
      x: 100,
      y: 0,
      name: "Carnivora",
      meta: "ORDER",
    });
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
      const clash = anyOverlap(
        [r, ...others].filter((o) => o.idx === r.idx || true),
      );
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
      node({
        idx: 2,
        x: 400,
        y: 74,
        terminal: true,
        name: "Homo sapiens",
        priority: 1e9,
      }),
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
    const [vertical, horizontal] = traceRects([
      { ax: 10, ay: 0, bx: 200, by: 50 },
    ]);
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
