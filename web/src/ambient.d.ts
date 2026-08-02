/**
 * A stylesheet is a module, and from TypeScript 7 it has to say so.
 *
 * `main.tsx` imports styles.css and `Graph.tsx` imports xyflow's, both for
 * effect and neither for a value. TS 7 checks side-effect imports it
 * previously waved through and raises TS2882 on both; the bundler has always
 * resolved them, so this declares what Vite already does rather than changing
 * anything that runs.
 *
 * `vite/client` rather than a hand-written `declare module "*.css"`, which is
 * the pattern the file below otherwise follows, because the reason that
 * pattern exists here is to keep `@types/node`'s globals out of a browser
 * bundle. These globals are the browser bundle's — `import.meta.env` and the
 * asset-import shapes are Vite's half of the contract this app is already
 * built against, and writing our own wildcard would be a second, worse copy
 * of it.
 */
/// <reference types="vite/client" />

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
