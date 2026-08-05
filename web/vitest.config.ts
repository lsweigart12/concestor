import { configDefaults, defineConfig } from "vitest/config";

/**
 * Two suites, because there are two kinds of test here and only one of them
 * needs a browser.
 *
 * Most of `src/` is pure: `tree/induced.ts` pinned to a Python reference,
 * `canvas/gl/tuning.ts` proving a float invariant, `chrome/tip.ts` doing the
 * tooltip's arithmetic against three rectangles — that last one says in its own
 * header that it lives apart from the component "so it can be tested, this
 * project having no DOM to render into." None of it touches a document, all of
 * it runs in node in a few hundred milliseconds, and that speed is worth
 * keeping: it is what makes the suite something you run on every save. So the
 * environment is not switched globally. `node` keeps exactly the tests it had,
 * in exactly the environment it had them in.
 *
 * `dom` is the other half. It boots jsdom, which costs about a second, and it
 * exists so a React component can actually be rendered. Roughly 8,000 lines of
 * `.tsx` had no behavioural coverage at all — not because nobody wrote a
 * component test, but because `include` would never have collected one.
 *
 * **Which project a file lands in is decided by its name**, and there are two
 * ways in on purpose:
 *
 * - `*.test.tsx` — a component test. This is the usual one. Render it with
 *   `@testing-library/react` and drive it through the DOM.
 * - `*.dom.test.ts` — a *module* test that needs a document anyway. There are a
 *   few of those waiting: anything reading `localStorage`, `sessionStorage`,
 *   `matchMedia` or `window`. Calling such a file `.tsx` when it renders
 *   nothing would be a lie about what it is, so it gets its own suffix instead.
 *
 * Everything else stays `*.test.ts` and stays in node. A node test that starts
 * complaining a global is unavailable is a test to rename, not a reason to
 * widen this file.
 *
 * Run one half alone with `npm test -- --project=dom`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          // Spreading the defaults back in is the point: naming `exclude`
          // replaces it, and dropping `**/node_modules/**` from a project whose
          // include is anchored at `src/` is a trap that only springs later.
          exclude: [...configDefaults.exclude, "src/**/*.dom.test.ts"],
        },
      },
      {
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx", "src/**/*.dom.test.ts"],
          setupFiles: ["./src/test/setup-dom.ts"],
        },
      },
    ],
  },
});
