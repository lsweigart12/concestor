/**
 * The census that keeps an unlabelled graphic out, and the regions named.
 *
 * A companion to `chrome/tip.test.ts`, written the same way and for the same
 * reason: an inline `<svg>` with no `aria-hidden` and no name renders perfectly,
 * no linter objects, and nothing fails — it simply arrives in the accessibility
 * tree as an anonymous graphic, or does not arrive at all. Several of this
 * app's inline SVGs were in that state, and the only reason the number was ever
 * knowable is that somebody counted by hand against a running browser.
 *
 * So it is text against text, this project having no DOM to render into, and it
 * counts what it read before trusting a search for an absence.
 *
 * What it does **not** try to check is which element is `main` and which is the
 * banner. That is one expression in `App.tsx` with two mutually exclusive
 * branches in it, and a source census able to tell them apart would be
 * asserting the source rather than the page. It belongs with the DOM harness.
 */
import { describe, expect, it } from "vitest";

/** Every `.tsx` that renders something, as source text. */
const SOURCES: [string, string][] = Object.entries(
  import.meta.glob<string>("./**/*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).filter(([f]) => !f.includes(".test."));

/** Comments stripped, so this file's own prose cannot trip its own check. */
function bare(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The attribute run of the JSX tag opening at `at`, or null if what is there is
 * not one.
 *
 * The closing `>` cannot simply be searched for: `width={a > 1 ? 2 : 3}` and a
 * path `d` both carry one. And `Silhouette.tsx` holds the string `"<svg"` and
 * the template `` `<svg width=…` `` in ordinary code, which is why a quote or a
 * backtick immediately behind the tag disqualifies it outright. What is left is
 * walked with a brace depth and a quote state, which is the whole of what JSX
 * needs here.
 */
function openingTag(src: string, at: number, name: string): string | null {
  const before = src[at - 1];
  if (before === '"' || before === "'" || before === "`") return null;
  const start = at + name.length + 1;
  let depth = 0;
  let quote = "";
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i);
  }
  return null;
}

/** Every `<name …>` this app writes, as `[file, attributes]`. */
function census(name: string): [string, string][] {
  const pattern = new RegExp(`<${name}[\\s/>]`, "g");
  return SOURCES.flatMap(([file, src]) => {
    const text = bare(src);
    const out: [string, string][] = [];
    for (const m of text.matchAll(pattern)) {
      const attrs = openingTag(text, m.index, name);
      if (attrs !== null) out.push([file, attrs]);
    }
    return out;
  });
}

const INLINE_SVG = census("svg");

describe("every inline graphic says whether it is content", () => {
  /**
   * The check below is a search for an absence and passes for free against an
   * empty corpus — a moved file or a changed Vite option would leave it green
   * and measuring nothing, which is the failure `docs/ci.md` §2 is about.
   */
  it("is reading the components at all", () => {
    expect(SOURCES.length).toBeGreaterThan(10);
    expect(INLINE_SVG.length).toBeGreaterThan(4);
    // Both answers are in the corpus, so neither branch of the rule below is
    // passing because nobody takes it.
    expect(
      INLINE_SVG.filter(([, a]) => a.includes("aria-hidden")),
    ).not.toHaveLength(0);
    expect(
      INLINE_SVG.filter(([, a]) => a.includes("aria-label")),
    ).not.toHaveLength(0);
  });

  /**
   * Hidden, or named. There is no third state that is not a bug: a graphic with
   * neither is announced as an unlabelled image by some readers and skipped by
   * others, and which one a given reader gets is not a decision this app made.
   *
   * A name without a role is not enough either. `aria-label` on a bare `<svg>`
   * is only honoured where the element has a role to hang it on, and the
   * default for `<svg>` is not one every engine agrees about.
   */
  it("gives every inline svg aria-hidden, or a role and a name", () => {
    const found = INLINE_SVG.filter(
      ([, a]) =>
        !a.includes("aria-hidden") &&
        !(/\brole=/.test(a) && a.includes("aria-label")),
    ).map(([f]) => f);
    expect(found).toEqual([]);
  });
});

describe("the drawings decide once", () => {
  const SILHOUETTE = SOURCES.find(([f]) =>
    f.endsWith("canvas/Silhouette.tsx"),
  )?.[1];

  /**
   * Both wrappers go through `describe`, and neither hardcodes the answer.
   *
   * The HTML span and the SVG `<g>` are the same decision drawn twice, and the
   * failure this pins is the quiet one: an `aria-hidden` put back on either of
   * them takes the witness caption — *the closest fossil PhyloPic has drawn to
   * when these lineages parted* — off half the canvas, and the other half goes
   * on reading correctly.
   */
  it("attaches the name in one place", () => {
    expect(SILHOUETTE).toBeDefined();
    const text = bare(SILHOUETTE ?? "");
    expect([...text.matchAll(/\{\.\.\.describe\(tip\)\}/g)]).toHaveLength(2);
    expect(text).not.toMatch(/aria-hidden="true"/);
  });
});

describe("every region a reader can land in is named", () => {
  /**
   * `aside` is a landmark everywhere this app uses it — always a direct child
   * of the root — and an unnamed landmark is a destination nobody can choose.
   *
   * `main` and `header` are exempt and stay so: there is one of each on screen
   * and the role is already the name. Naming them would put "main main" in the
   * landmark list.
   */
  it("names every aside", () => {
    const found = census("aside")
      .filter(([, a]) => !a.includes("aria-label"))
      .map(([f]) => f);
    expect(found).toEqual([]);
  });
});
