/**
 * The stylesheet against the components that wear it.
 *
 * Three rules in one branch turned out to draw nothing, in two directions: a
 * declaration that could never win, a class applied with no rule to answer it,
 * and a declaration nothing rendered in that still leaked through inheritance.
 * `docs/handoff.md` §5 has the evaluation and the numbers; what survived it is
 * here, and the criterion it had to meet was **precision, not reach**. Every
 * check in this file was run against the commit before those three were fixed
 * and against the commit after, and flags exactly the real ones. A check that
 * fires on a dynamic class name gets switched off within a week and then the
 * real one goes with it.
 *
 * Two whole families were measured and rejected rather than tuned, and the
 * numbers are in the doc so nobody re-derives them: cross-referencing every
 * class in both directions caught **none** of the three against 17 false
 * positives, and flagging inline styles that collide with the stylesheet caught
 * one against 13. Both of those are recorded as *rejected*, not as todo.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/** Every `.tsx` that renders something, as source text. */
const SOURCES: [string, string][] = Object.entries(
  import.meta.glob("./**/*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).filter(([f]) => !f.includes(".test."));

// ------------------------------------------------------------- the selectors --

interface Rule {
  sel: string;
  body: string;
}

/**
 * Flat rules, comments stripped.
 *
 * Nested at-rules (`@media`) are not unwrapped — the inner rules match this
 * shape on their own and the prelude carries no class we care about.
 */
const RULES: Rule[] = [...CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(
  /(^|[};])\s*([^{}@;]+?)\s*\{([^{}]*)\}/gm,
)]
  .map((m) => ({ sel: m[2]!.trim(), body: m[3]! }))
  .filter((r) => r.sel && !/^(from|to|\d+(\.\d+)?%)$/.test(r.sel));

const classesIn = (s: string) =>
  [...s.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!);

/**
 * Every *compound* the stylesheet styles: the classes that must appear on one
 * element together for some rule to match it.
 *
 * `.a.b .c` yields `{a,b}` and `{c}` — the descendant combinator separates two
 * elements, so the two sets are claims about different elements and must not be
 * merged.
 */
const COMPOUNDS: Set<string>[] = [];
for (const { sel } of RULES) {
  for (const one of sel.split(",")) {
    for (const part of one.trim().split(/[\s>+~]+/)) {
      const cs = classesIn(part);
      if (cs.length) COMPOUNDS.push(new Set(cs));
    }
  }
}

// ------------------------------------------------------- the applied classes --

/** The text of every `className=` attribute value. */
function classNameExprs(src: string): string[] {
  const out: string[] = [];
  const re = /className\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    if (src[i] === '"') {
      const end = src.indexOf('"', i + 1);
      if (end > 0) out.push(src.slice(i, end + 1));
    } else if (src[i] === "{") {
      let depth = 0;
      const start = i;
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) break;
      }
      out.push(src.slice(start, i + 1));
    }
  }
  return out;
}

/**
 * The class names an expression *literally* contains.
 *
 * Quoted strings, and the static chunks of a template between its `${}` holes.
 * Never a bare identifier: `` `tier-${TIER_CLASS[d.tier]}` `` names no class
 * this file can know, and reading `TIER_CLASS` or `d` as one is how a check
 * like this ends up with 31 findings and no users. A composed name is simply
 * invisible here, which makes every check below *incomplete* and never wrong —
 * the only trade that survives contact with a real codebase.
 */
function literalClasses(expr: string): Set<string> {
  const chunks: string[] = [];
  for (const m of expr.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) {
    chunks.push(m[1] ?? m[2]!);
  }
  for (const m of expr.matchAll(/`([^`]*)`/g)) {
    chunks.push(...m[1]!.split(/\$\{[^}]*\}/));
  }
  const out = new Set<string>();
  for (const c of chunks) {
    for (const tok of c.split(/\s+/)) {
      if (/^-?[_a-zA-Z][\w-]*$/.test(tok)) out.add(tok);
    }
  }
  return out;
}

/** One rendered element's literal class set. */
const ELEMENTS: { file: string; classes: Set<string> }[] = [];
for (const [file, src] of SOURCES) {
  for (const expr of classNameExprs(src)) {
    const classes = literalClasses(expr);
    if (classes.size) ELEMENTS.push({ file, classes });
  }
}

describe("a class the components apply is a class the stylesheet answers", () => {
  /**
   * Both checks below are searches for the *absence* of something, so both pass
   * for free if the corpus is empty. A glob that silently resolved to nothing —
   * a moved file, a changed Vite option — would leave two green tests measuring
   * no code at all, which is the failure `docs/ci.md` §2 is about. Count first.
   */
  it("is reading the components and the stylesheet at all", () => {
    expect(SOURCES.length).toBeGreaterThan(10);
    expect(ELEMENTS.length).toBeGreaterThan(100);
    expect(RULES.length).toBeGreaterThan(100);
    expect(SOURCES.every(([, s]) => s.length > 0)).toBe(true);
  });


  /**
   * The one cross-reference worth running, and it is not "is this class used".
   *
   * `.mark-fossil` receives `flaring` in NodeMark.tsx and `.mark-fossil.flaring`
   * did not exist, so grafts never flared. No count of usages sees that: both
   * classes are used, and both have rules. What is wrong is the *combination* —
   * `flaring` is styled on `.mark-dot` and on `.mark-alive`, and the third mark
   * that wears it was missed.
   *
   * So the question this asks is narrow enough to have an answer: where a
   * modifier is styled on some of the bases that receive it and not on others,
   * the odd one out is a mistake. A modifier styled on *none* of them is not
   * flagged — that is a deliberate unstyled hook, like `.card-action.add`,
   * which carries no rule because `.card-action` already styles it and only
   * `.remove` differentiates.
   */
  it("styles a modifier on every mark that wears it, or on none", () => {
    // A modifier is a class the stylesheet only ever styles in combination.
    const modifiers = new Set<string>();
    for (const cs of COMPOUNDS) {
      if (cs.size > 1) for (const c of cs) modifiers.add(c);
    }
    for (const cs of COMPOUNDS) {
      if (cs.size === 1) modifiers.delete([...cs][0]!);
    }

    const covers = (mod: string, on: Set<string>) =>
      COMPOUNDS.some((cs) => cs.has(mod) && [...cs].every((c) => on.has(c)));

    const complaints: string[] = [];
    for (const mod of modifiers) {
      const hosts = ELEMENTS.filter((e) => e.classes.has(mod));
      const styled = hosts.filter((e) => covers(mod, e.classes));
      const bare = hosts.filter((e) => !covers(mod, e.classes));
      if (!styled.length || !bare.length) continue;
      const name = (e: { classes: Set<string> }) =>
        "." + [...e.classes].filter((c) => c !== mod).join(".");
      complaints.push(
        `.${mod} is styled on ${styled.map(name).join(", ")} ` +
          `but not on ${bare.map((e) => `${name(e)} (${e.file})`).join(", ")}`,
      );
    }
    expect(complaints).toEqual([]);
  });
});

describe("the label draws no type the measurer has not been told about", () => {
  /**
   * The sequel to `labels.test.ts`, and the check that would have caught
   * `.mark.is-leaf .mark-label { font-size: 13.5px }`.
   *
   * That rule rendered nothing — no element under a label draws text at the
   * label's own size, because every row pins its own. It was still not free:
   * an inline row is at least as tall as its strut, so the number became the
   * height of any row that forgot to pin one, and the figures row did exactly
   * that and stood 17.9px against a reserved 15.
   *
   * Neither cross-reference above sees it. `.mark` and `.mark-label` are both
   * used and both styled; the rule matches real elements, so even a browser
   * coverage report counts it as live. What is wrong is that the value reaches
   * a row by inheritance and `labels.ts` has no constant for it — which is a
   * question this file *can* answer, by census. Every font-size the label's
   * text column can see must be one the measurer models.
   */
  it("sets no font-size in the label column that labels.ts does not model", () => {
    const COLUMN = ["mark-label", "mark-text", "mark-name", "mark-age", "mark-meta"];
    const found = new Map<string, string>();
    for (const { sel, body } of RULES) {
      if (!classesIn(sel).some((c) => COLUMN.includes(c))) continue;
      const m = /(?:^|[;{\s])font-size:\s*([^;]+)/.exec(body);
      if (m) found.set(sel.replace(/\s+/g, " "), m[1]!.trim());
    }
    // The three rows, and nothing above them. A fourth entry here is either a
    // new row — which owes `labels.ts` a line constant and this list an entry —
    // or a size that reaches a row without drawing anything, which is the bug.
    expect(Object.fromEntries(found)).toEqual({
      ".mark-name": "12.5px",
      ".mark-age": "11px",
      ".mark-meta": "9.5px",
    });
  });
});
