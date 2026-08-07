/**
 * The census that keeps hover copy out of this app.
 *
 * `title` is an attribute every element accepts, no linter objects to, and no
 * test notices — which is how this app came to explain its bioluminescence
 * switch in 101 characters of documentation prose, drawn by the OS over the
 * timeline, and its label modes in 372. Nothing failed. Nothing could fail: a
 * `title` renders, it just renders as somebody else's widget, wherever the
 * pointer happens to be, a second late, and never at all on a touch screen.
 *
 * The app's own tooltip fixed every one of those faults and was removed anyway,
 * which is the rule this file now guards rather than the attribute alone. A
 * drawn tooltip is still a paragraph over the graph every time the pointer
 * crosses a silhouette, and the surface built to hold prose — the node card —
 * is one press away. See `docs/design-reference.md` § *Nothing explains itself
 * on hover*.
 *
 * So the guard is a census in the style of `styles.test.ts`: a lint over the
 * `.tsx` corpus, counting what it read before trusting a search for an absence.
 * That is source text and it stays source text on purpose — the question is
 * whether an attribute is *written anywhere*, which no rendered tree can
 * answer, and it matches a token rather than a shape, so nothing about it
 * depends on where an author broke a line.
 */
import { describe, expect, it } from "vitest";

/** Every `.tsx` and `.ts` that renders or wires something, as source text. */
const SOURCES: [string, string][] = Object.entries(
  import.meta.glob<string>("../**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).filter(([f]) => !f.includes(".test."));

/**
 * The JSX half of it. The two attribute checks below read tags, and a `.ts`
 * module has none — what it has is generics, and `Record<string, X>` followed
 * by a `title` key parses as `<string title=…>` to a scanner this simple.
 */
const JSX: [string, string][] = SOURCES.filter(([f]) => f.endsWith(".tsx"));

/** Comments stripped, so this file's own prose cannot trip its own check. */
function bare(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The tag an attribute belongs to.
 *
 * Attributes live between `<Tag` and the `>` that closes it, so the nearest
 * `<` behind one is its own tag's — which is all this needs to tell
 * `<Confirm title=…>`, a component prop and perfectly fine, from
 * `<span title=…>`, which is the browser's tooltip and is not.
 */
function tagBefore(src: string, at: number): string | null {
  const open = src.lastIndexOf("<", at);
  if (open < 0) return null;
  return /^<\s*([A-Za-z][\w.]*)/.exec(src.slice(open, at))?.[1] ?? null;
}

const intrinsic = (tag: string) => /^[a-z]/.test(tag);

describe("nothing in this app explains itself on hover", () => {
  /**
   * Every check below is a search for an absence and passes for free against an
   * empty corpus — a moved file or a changed Vite option would leave them green
   * and measuring nothing, which is the failure `docs/ci.md` §2 is about.
   */
  it("is reading the modules at all", () => {
    expect(SOURCES.length).toBeGreaterThan(30);
    expect(JSX.length).toBeGreaterThan(20);
    expect(SOURCES.every(([, s]) => s.length > 0)).toBe(true);
    // And reading files that would carry a tip if one came back: these are the
    // surfaces that had the most of them.
    const named = SOURCES.map(([f]) => f);
    for (const f of ["Silhouette.tsx", "CanvasChrome.tsx", "Palette.tsx"]) {
      expect(named.some((n) => n.endsWith(f))).toBe(true);
    }
  });

  /**
   * A `title` on a component is a prop and its business — `Confirm` takes one
   * for its heading — so only the lowercase tags, which are the ones the
   * browser will act on.
   */
  it("sets no title attribute on a DOM element", () => {
    const found: string[] = [];
    for (const [file, src] of JSX) {
      const text = bare(src);
      for (const m of text.matchAll(/\stitle\s*=/g)) {
        const tag = tagBefore(text, m.index);
        if (tag && intrinsic(tag)) {
          found.push(`${file}: <${tag} title=…>`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  /**
   * The SVG half of the same thing, which is the one that hides. A `<title>`
   * child is the platform tooltip by another route, it is what `Bracket` and
   * `SilhouetteSvg` used, and grepping for `title=` would never have found
   * either of them.
   */
  it("renders no SVG title element", () => {
    const found: string[] = [];
    for (const [file, src] of JSX) {
      if (/<title[\s>]/.test(bare(src))) found.push(file);
    }
    expect(found).toEqual([]);
  });

  /**
   * And the app's own, which is the version that would come back. It was a hook
   * spread onto a trigger and a single layer at the root, so either name
   * reappearing is the whole of it returning.
   */
  it("has no tooltip of its own either", () => {
    const found: string[] = [];
    for (const [file, src] of SOURCES) {
      const text = bare(src);
      if (/\buseTip\b|\bTooltipLayer\b|role="tooltip"/.test(text)) {
        found.push(file);
      }
    }
    expect(found).toEqual([]);
  });
});
