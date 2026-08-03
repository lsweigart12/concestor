/**
 * The one Node API this project uses, declared rather than depended on.
 *
 * `labels.test.ts` reads styles.css so the type metrics it measures against can
 * be pinned to the CSS that actually renders them — the drift between those two
 * is a real bug this repo has already shipped once. Two other routes were tried
 * and rejected: `?raw` returns an empty string, because Vite's CSS plugin
 * handles the file before the raw loader sees it; and `@types/node` would put
 * `process`, `Buffer` and the rest of the Node globals into the type space of a
 * browser bundle, where the whole point is that they are not available.
 *
 * `readFileSync(path, "utf8")` has been this shape since Node 0.x.
 */
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}

/**
 * `import.meta.glob`, on the same terms.
 *
 * `styles.test.ts` reads every component's source to ask which classes they
 * actually apply, and `?raw` *does* work for `.tsx` — the note above is about
 * CSS, which Vite's own plugin claims before the raw loader sees it. So the
 * source files need no `readdirSync`, no directory walk and no `@types/node`
 * beyond what is already declared.
 *
 * `vite/client` would type this and much else besides: it declares every asset
 * module, `ImportMetaEnv`, and the hot-reload API, into a type space this
 * project keeps deliberately small. One signature is cheaper, and it is the
 * only form called — eager, raw, default import, so the result is a plain
 * `Record<string, string>` rather than a map of loader thunks.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}
