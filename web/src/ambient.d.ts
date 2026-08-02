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
