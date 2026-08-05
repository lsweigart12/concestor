// The formatter for `web/`, and the counterpart to `gofmt` in `server/` and
// `ruff format` in `pipeline/`.
//
// **Every value here is Prettier's own default, and that is the finding rather
// than a shrug.** The house style was measured against 34,484 non-blank lines
// of TypeScript before this file was written: double quotes, semicolons,
// trailing commas, two-space indent, `always` arrow parens — all of it already
// what Prettier does unasked. The only real disagreement was line width, and
// there the code answers for itself. The 90th percentile line is 79 characters
// and the 95th is 80; the prose comments are hand-wrapped at 72–78. Prettier's
// default of 80 is the width this project already writes to.
//
// The alternative was measured too, and refused. At `printWidth: 100` the
// first run touches 92 files and *collapses* 1,518 lines the author had
// deliberately broken, against 75 files and no collapsing at 80. A formatter
// whose first act is to undo a thousand line breaks somebody chose is the kind
// of tooling this repository reverts. 80 only ever splits what overflows.
//
// A `.js` config rather than `.prettierrc.json` so this comment can exist.
// It is ESM because `web/package.json` says `"type": "module"`.

/** @type {import("prettier").Config} */
export default {
  // Stated rather than inherited, because a default that moves under you is
  // a repository-wide reformat arriving in a dependency bump.
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "lf",
};
