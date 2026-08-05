/**
 * The stylesheet, parsed once, for the tests that pin a constant to it.
 *
 * Six test files used to read `styles.css` and each brought its own regex to
 * find a rule in it. That is one idea implemented six times, and every copy was
 * wrong in a slightly different way: one stripped comments and another did not,
 * one matched a rule body as `\{([^{}]*)\}` and so could not survive a nested
 * rule, two captured an `@media` block with a `\n\}` terminator and so depended
 * on the closing brace being at column zero, and one found its rule with
 * `indexOf("\n" + selector + " {")` — which is a claim about the *one space*
 * between the selector and the brace.
 *
 * None of that was ever the point. **Pinning `CARD_W` to the rule that draws the
 * card is a genuinely good test**: the two disagreeing is silent, the tree just
 * starts sliding back under the panel, and nothing in either file would notice.
 * What made those tests fragile was reading CSS with a regular expression, and
 * the fix is to read it with a CSS parser — `postcss`, which the build already
 * depends on through Vite and which is declared here so nothing rests on
 * hoisting.
 *
 * So a reformat of the stylesheet — #84's, or anyone's — moves no test in this
 * repo, and a selector list written across three lines is the same selector
 * list as one written across one.
 *
 * Everything here is *reading*. Nothing in this module asserts, so a test that
 * asks for a rule that is not there gets a thrown error naming the selector
 * rather than a `null` dereference twenty lines later.
 */

import { readFileSync } from "node:fs";
import postcss, { type AtRule, type Container } from "postcss";

/** The stylesheet as text, for the few checks that are genuinely textual. */
export const CSS_TEXT: string = readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8",
);

const ROOT = postcss.parse(CSS_TEXT, { from: "styles.css" });

/**
 * A selector with its whitespace made irrelevant.
 *
 * `.num,\n.mono` and `.num, .mono` are the same selector list and a test
 * naming one of them must not care which the author wrote. Newlines inside a
 * list are the ordinary way this stylesheet writes a long one.
 */
export function normSel(sel: string): string {
  return sel
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

/**
 * The same treatment for a declared value, and for the same reason: a font
 * stack is a comma-separated list that gets wrapped when it is long.
 */
export const normValue = normSel;

/** One rule, flattened: the selector it matches on and what it declares. */
export interface StyleRule {
  /** The whole selector list, normalised. */
  selector: string;
  /** The list split on commas, each part normalised. */
  selectors: string[];
  /** Property to value, later declarations winning, `!important` kept. */
  decls: Map<string, string>;
  /** The preludes of the at-rules this rule sits inside, outermost first. */
  at: string[];
  /**
   * Where it starts, 1-based.
   *
   * Order in the file is load-bearing in exactly one place — the narrow-window
   * block at the foot hides elements declared two thousand lines above it, and
   * at equal specificity the later rule wins — so it is worth being able to
   * assert. Nothing else should read it.
   */
  line: number;
}

function declsOf(node: Container): Map<string, string> {
  const out = new Map<string, string>();
  node.each((child) => {
    if (child.type === "decl") {
      out.set(
        child.prop,
        normValue(child.value) + (child.important ? " !important" : ""),
      );
    }
  });
  return out;
}

function atChain(node: Container): string[] {
  const out: string[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "atrule") {
      const a = p as AtRule;
      out.unshift(normSel(`@${a.name} ${a.params}`));
    }
  }
  return out;
}

/**
 * Every rule in the sheet, or in one container of it.
 *
 * Rules inside `@media` are included — they are rules, and a test asking what
 * the stylesheet declares for `.detail` at a narrow width is asking about one
 * of them. Keyframe steps are not: `from`, `to` and `47%` are not selectors and
 * every consumer of this list filtered them out by hand.
 */
export function rules(within: Container = ROOT): StyleRule[] {
  const out: StyleRule[] = [];
  within.walkRules((r) => {
    // `endsWith` rather than `/keyframes$/`, so the vendor-prefixed forms
    // (`-webkit-keyframes`) are caught by the same test and nothing has to
    // read a regex to see that.
    if (
      r.parent?.type === "atrule" &&
      (r.parent as AtRule).name.endsWith("keyframes")
    ) {
      return;
    }
    const selector = normSel(r.selector);
    out.push({
      selector,
      selectors: selector.split(", "),
      decls: declsOf(r),
      at: atChain(r),
      line: r.source?.start?.line ?? 0,
    });
  });
  return out;
}

/**
 * The first rule that styles `sel`, throwing if there is none.
 *
 * A request naming one selector matches any rule whose list contains it, so
 * `.mark-name` finds `.mark-name, .mark-age` too — which is what a caller
 * asking "what font-size does this element get" means. A request that itself
 * carries a comma has to match the whole list, because then the caller is
 * naming the rule rather than the element.
 */
export function ruleFor(sel: string, within: Container = ROOT): StyleRule {
  const want = normSel(sel);
  const hit = rules(within).find((r) =>
    want.includes(",") ? r.selector === want : r.selectors.includes(want),
  );
  if (!hit) throw new Error(`styles.css has no rule for ${want}`);
  return hit;
}

/** Every rule that styles `sel`, in source order. */
export function rulesFor(sel: string, within: Container = ROOT): StyleRule[] {
  const want = normSel(sel);
  return rules(within).filter((r) =>
    want.includes(",") ? r.selector === want : r.selectors.includes(want),
  );
}

/** One declared value, throwing if the rule does not declare it. */
export function decl(
  sel: string,
  prop: string,
  within: Container = ROOT,
): string {
  const v = ruleFor(sel, within).decls.get(prop);
  if (v === undefined) throw new Error(`${normSel(sel)} declares no ${prop}`);
  return v;
}

/** A custom property off `:root`, e.g. `cssVar("--s4")` → `"8px"`. */
export function cssVar(name: string): string {
  return decl(":root", name);
}

/**
 * The `@media` blocks whose prelude is exactly `params`.
 *
 * By prelude rather than by width alone, so a caller asking for
 * `(max-width: 620px)` is not handed a `(prefers-reduced-motion: reduce)` block
 * that happens to sit at the same width. Returns them all; which one is wanted
 * is the caller's question, and answering it by counting the blocks in the
 * whole sheet — as one of these tests did — fails an unrelated assertion the
 * day somebody adds a second breakpoint.
 */
export function media(params: string): AtRule[] {
  const want = normSel(params);
  const out: AtRule[] = [];
  ROOT.walkAtRules("media", (a) => {
    if (normSel(a.params) === want) out.push(a);
  });
  return out;
}

/** Where an at-rule starts, 1-based — see {@link StyleRule.line}. */
export function lineOf(at: AtRule): number {
  return at.source?.start?.line ?? 0;
}

/** Every animation the sheet declares, by name. */
export function keyframes(): string[] {
  const out: string[] = [];
  ROOT.walkAtRules(/keyframes$/, (a) => {
    out.push(a.params.trim());
  });
  return out;
}

/** The `@media (max-width: Npx)` blocks, which is the only kind this app has. */
export function narrower(px: number): AtRule[] {
  return media(`(max-width: ${px}px)`);
}

/**
 * The one `@media (max-width: Npx)` block that styles `sel`, throwing unless
 * there is exactly one.
 *
 * The stylesheet has several blocks at the same width — the swap alone touches
 * four families — so "the narrow block" is only ever meaningful with respect to
 * something in it.
 */
export function narrowerFor(px: number, sel: string): AtRule {
  const hits = narrower(px).filter((b) => rulesFor(sel, b).length > 0);
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one @media (max-width: ${px}px) block styling ${sel}, found ${hits.length}`,
    );
  }
  return hits[0]!;
}
