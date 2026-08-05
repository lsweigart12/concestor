/**
 * The icons, against the two things they are copies of.
 *
 * `public/favicon.svg` is a standalone document. It cannot read a custom
 * property, so the palette is literal hex inside it; and it cannot be
 * rasterised at build time without a dependency this project does not carry,
 * so `scripts/make-icons.py` holds the same geometry a second time and emits
 * the `.ico` and the touch icon. Two copies, in two languages, neither of
 * which the type checker or the bundler can see — the icon is the one asset
 * here that can drift silently in both directions at once.
 *
 * So this file asks the two questions that catch it, and deliberately not a
 * third. It does *not* re-render the PNG and diff pixels: `make-icons.py
 * --check` already does exactly that, from the source of truth, in the
 * language that wrote the file. Restating it here in TypeScript would be a
 * second renderer to keep correct.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const CSS = read("./styles.css");
const SVG = read("../public/favicon.svg");
const PY = read("../../scripts/make-icons.py");
const HTML = read("../index.html");

/** The SVG with its comment removed — everything below reads drawn attributes. */
const DRAWN = SVG.replace(/<!--[\s\S]*?-->/g, "");

// ------------------------------------------------------------- the palette --

/** `--name: value;` from `:root`, value verbatim. */
function customProp(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(CSS);
  if (!m) throw new Error(`styles.css has no --${name}`);
  return m[1]!.trim();
}

/** CSS `hsl(h s% l%)` to `#rrggbb`, rounding each channel as a browser does. */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = (
    [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ] as const
  )[Math.floor(h / 60) % 6]!;
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.round((v + m) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

/** `#rrggbb` back to HSL, for asking what a literal *is* rather than what it says. */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  ) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (!d) return { h: 0, s: 0, l };
  const h =
    max === r
      ? 60 * (((g - b) / d + 6) % 6)
      : max === g
        ? 60 * ((b - r) / d + 2)
        : 60 * ((r - g) / d + 4);
  return { h, s: d / (1 - Math.abs(2 * l - 1)), l };
}

const ACCENT_H = Number(customProp("accent-h"));

describe("the icon is painted in the app's own palette", () => {
  /**
   * Both directions below search for a *mismatch*, so both pass for free if a
   * read silently returned nothing — a moved file, a renamed property. Count
   * first, the way `styles.test.ts` does.
   */
  it("is reading the stylesheet, the icon and the generator at all", () => {
    expect(CSS.length).toBeGreaterThan(1000);
    expect(DRAWN).toContain("<circle");
    expect(PY).toContain("def render(");
    expect(ACCENT_H).toBe(186);
  });

  /**
   * The one way this file can be broken by writing *prose*.
   *
   * XML forbids `--` anywhere inside a comment, and this icon's comment wants
   * to name custom properties, which all begin with one. A browser does not
   * degrade over it — it refuses the whole document, so `<img>` fires
   * `onerror`, the tab silently falls back to the `.ico`, and every check
   * above still passes because they all read attributes the parser never got
   * to. It cost one round of exactly that to find, hence a check for the
   * literal rule rather than for a parse: this repository has no XML parser
   * and does not need one to enforce a two-character prohibition.
   */
  it("writes a comment that XML will actually parse", () => {
    for (const [c] of SVG.matchAll(/<!--([\s\S]*?)-->/g)) {
      expect(c.slice(4, -3), "`--` inside an SVG comment").not.toContain("--");
    }
    // And the shapes are outside every comment, or the check above is vacuous.
    expect(DRAWN).toContain("<rect");
    expect([...SVG.matchAll(/<!--/g)]).toHaveLength(1);
  });

  it("plates the icon in --void and strokes the ring in --accent", () => {
    // hsl(var(--accent-h) 72% 62%) — the h is a reference, the rest literal.
    const m = /hsl\(var\(--accent-h\)\s+([\d.]+)%\s+([\d.]+)%\)/.exec(
      customProp("accent"),
    );
    expect(
      m,
      "--accent is no longer an hsl() this test can resolve",
    ).toBeTruthy();
    const accent = hslToHex(ACCENT_H, Number(m![1]) / 100, Number(m![2]) / 100);

    expect(DRAWN).toContain(`fill="${customProp("void")}"`);
    expect(DRAWN).toContain(`stroke="${accent}"`);
  });

  /**
   * The core is *not* pinned to a literal, and that is the point.
   *
   * On the canvas it is `hsl(hue 70% 74%)` — NodeMark.tsx's figures for an
   * MRCA — but those live inside a ternary in a `.tsx`, and a regex reaching
   * into one is the kind of check that gets deleted the first time somebody
   * reformats the file. What actually has to stay true is weaker and is the
   * whole claim the icon makes: the core is the ring's hue, brighter. A change
   * to `--accent-h` that forgets the icon fails this; a nudge to the MRCA's
   * lightness does not, and should not.
   */
  it("fills the core with a brighter tone of the same hue", () => {
    const m = /<circle[^>]*fill="(#[0-9a-f]{6})"/.exec(DRAWN);
    expect(m, "the icon draws no filled circle").toBeTruthy();
    const core = hexToHsl(m![1]!);
    // ±1°, which is the width of one 8-bit step at this saturation.
    expect(Math.abs(core.h - ACCENT_H)).toBeLessThanOrEqual(1);
    expect(core.l).toBeGreaterThan(hexToHsl("#58d6e4").l);
  });
});

// ------------------------------------------------------------ the geometry --

describe("the generator draws the same glyph as the SVG", () => {
  /**
   * `make-icons.py` cannot parse the SVG — it is the standard library and
   * nothing else, on purpose — so it restates the geometry as constants. This
   * is the check that the restatement is true, and it is the only thing
   * standing between a redesigned favicon and a `.ico` still showing the old
   * one.
   */
  const pyConst = (name: string): number[] => {
    const m = new RegExp(`^${name}\\s*=\\s*([^#\\n]+)`, "m").exec(PY);
    if (!m) throw new Error(`make-icons.py has no ${name}`);
    return m[1]!.split(",").map((v) => Number(v.trim()));
  };

  /** The attributes of the SVG's shapes, in document order. */
  const circles = [...DRAWN.matchAll(/<circle\b[^>]*>/g)].map((c) => c[0]);
  const attr = (tag: string, name: string) => {
    const m = new RegExp(`${name}="([^"]+)"`).exec(tag);
    return m ? Number(m[1]) : undefined;
  };

  it("found the three circles and the plate", () => {
    expect(circles).toHaveLength(3);
    expect(attr(/<rect\b[^>]*>/.exec(DRAWN)![0], "rx")).toBe(
      pyConst("CORNER_R")[0],
    );
    expect(attr(/<rect\b[^>]*>/.exec(DRAWN)![0], "width")).toBe(
      pyConst("BOX")[0],
    );
  });

  it("agrees on the bloom, the ring and the core", () => {
    const [bloom, ring, core] = circles as [string, string, string];

    expect([attr(bloom, "r"), attr(bloom, "stroke-width")]).toEqual(
      pyConst("BLOOM_R, BLOOM_W"),
    );
    expect(attr(bloom, "opacity")).toBe(pyConst("BLOOM_A")[0]);

    expect([attr(ring, "r"), attr(ring, "stroke-width")]).toEqual(
      pyConst("RING_R, RING_W"),
    );

    expect(attr(core, "r")).toBe(pyConst("CORE_R")[0]);

    // Everything is concentric on the box's centre. Said once, here, because
    // an off-centre shape would pass every radius check above.
    for (const c of circles) {
      expect([attr(c, "cx"), attr(c, "cy")]).toEqual([
        pyConst("CENTRE")[0],
        pyConst("CENTRE")[0],
      ]);
    }
  });
});

// ------------------------------------------------------------ the third copy --

/**
 * `chrome/BrandMark.tsx` draws the same glyph a third time, in JSX.
 *
 * The head of this file says the icon is the one asset that can drift silently
 * in two directions at once; the mark in the control bar and on the palette
 * button makes it three, and it is the copy a reader sees *beside* the tab it
 * has to match. It cannot import the SVG — that file bakes in a black plate and
 * literal hex, neither of which belongs on a strip of scrim — so it restates
 * the geometry, and this is the check that the restatement is true.
 *
 * Only the circles are compared. The plate and the colours are deliberately
 * different and are the subject of the two decisions in that file's header.
 */
describe("the inline mark is the icon's glyph", () => {
  const TSX = read("./chrome/BrandMark.tsx");

  it("is reading a component that draws circles at all", () => {
    expect(TSX).toContain('viewBox="0 0 32 32"');
    expect([...TSX.matchAll(/<circle\b[^/>]*\/>/g)]).toHaveLength(3);
  });

  it("draws the icon's three circles, at the icon's radii", () => {
    // Attribute by attribute rather than by string equality, because JSX spells
    // `stroke-width` as `strokeWidth` and would fail a diff for a reason that
    // is not drift.
    const svg = [...DRAWN.matchAll(/<circle\b[^>]*>/g)].map((m) => m[0]);
    const tsx = [...TSX.matchAll(/<circle\b[^>]*>/g)].map((m) => m[0]);
    const num = (tag: string, name: string) =>
      Number(new RegExp(`${name}="([^"]+)"`).exec(tag)?.[1]);

    expect(tsx).toHaveLength(svg.length);
    for (const [i, tag] of tsx.entries()) {
      const ref = svg[i]!;
      for (const [a, b] of [
        ["cx", "cx"],
        ["cy", "cy"],
        ["r", "r"],
        ["strokeWidth", "stroke-width"],
        ["opacity", "opacity"],
      ] as const) {
        expect([i, a, num(tag, a)]).toEqual([i, a, num(ref, b)]);
      }
    }
  });

  /**
   * The one thing it must *not* copy. A standalone icon cannot read a custom
   * property so the SVG carries literal hex; this one can, and a hex value
   * pasted in here is how the chrome ends up off the app's accent the next time
   * `--accent-h` moves.
   */
  it("takes its colour from the caller and not from a literal", () => {
    expect(TSX).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(TSX).toContain("currentColor");
  });
});

// ----------------------------------------------------------------- the html --

describe("the document links what public/ actually holds", () => {
  it("links all three icons, and the .ico before the .svg", () => {
    const hrefs = [
      ...HTML.matchAll(/<link\b[^>]*rel="(?:apple-touch-)?icon"[^>]*>/g),
    ].map((m) => /href="([^"]+)"/.exec(m[0])![1]!);
    expect(hrefs).toEqual([
      "/favicon.ico",
      "/favicon.svg",
      "/apple-touch-icon.png",
    ]);
  });

  /**
   * A link is only ever wrong in one direction here — Vite copies public/
   * wholesale, so nothing in it can fail to ship, but a renamed file leaves
   * the `<link>` pointing at a path the SPA fallback answers with index.html.
   *
   * The two rasters are read as text, which mangles them and does not matter:
   * this asks whether the file is there, and what is *in* it is
   * `make-icons.py --check`'s question, asked in the language that wrote it.
   */
  it("ships every file it links", () => {
    for (const f of ["favicon.ico", "favicon.svg", "apple-touch-icon.png"]) {
      expect(read(`../public/${f}`).length, `public/${f}`).toBeGreaterThan(0);
    }
  });
});
