/**
 * What every test in the `dom` project gets before it runs. See the header of
 * `vitest.config.ts` for why there are two projects at all.
 *
 * Deliberately small. A setup file is shared by every component test in the
 * repo, so anything put here is a fact about the app that no individual test
 * can see being arranged — and a harness that quietly makes the app behave
 * unlike itself is worse than no harness. What is here is either bookkeeping
 * (`cleanup`), a jsdom gap that is not the subject of any test (`scrollIntoView`),
 * or a wall between the test runner and the network.
 */

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * Unmount between tests.
 *
 * `@testing-library/react` registers this itself when vitest's `globals` are
 * on. They are off here — the rest of the suite imports `describe`/`it`/`expect`
 * explicitly and there is no reason for these files to differ — so it has to be
 * asked for. Without it, every `render` leaves its tree in the document and
 * `getByRole` starts finding two of everything, several tests after the one
 * that actually caused it.
 */
afterEach(cleanup);

/**
 * jsdom lays nothing out, so it implements no scrolling.
 *
 * The palette calls `scrollIntoView` to keep the active row in view on every
 * arrow press. That is a real behaviour with no observable consequence in a
 * zero-height document, so it is stubbed rather than asserted on — a test that
 * wanted to prove it would need a browser.
 */
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

/**
 * Give back the `localStorage` node took away.
 *
 * jsdom implements it — `globalThis.jsdom.window.localStorage` is a genuine
 * `Storage` — but node 22 and later ship an *own* experimental `localStorage`
 * accessor on the global, and vitest's populate step leaves an existing global
 * alone rather than clobbering a node builtin. So node's accessor wins, it
 * returns `undefined` without `--localstorage-file`, and the runner prints
 * "localStorage is not available because --localstorage-file was not provided".
 * `sessionStorage` is unaffected purely because node has no global of that name,
 * which is what makes this look like a jsdom bug rather than a collision.
 *
 * The real object is put back rather than a `Map` dressed up as one: the point
 * of a DOM harness is that the module under test reaches the same API it reaches
 * in a browser, and `fuzzy.ts`'s whole bug is in what comes back *out* of that
 * API. Guarded on `undefined` so a node without the experimental global, or one
 * run with the flag, keeps whatever it already had.
 */
{
  const g = globalThis as typeof globalThis & {
    jsdom?: { window?: { localStorage?: Storage } };
  };
  const real = g.jsdom?.window?.localStorage;
  if (typeof g.localStorage === "undefined" && real) {
    Reflect.deleteProperty(g, "localStorage");
    Object.defineProperty(g, "localStorage", {
      value: real,
      configurable: true,
      writable: true,
    });
  }
}

/**
 * Analytics must not leave the process.
 *
 * `beacon.ts` prefers `sendBeacon` and falls back to `fetch`, and it is reached
 * from ordinary interactions — typing in the palette records a search. jsdom
 * has no `sendBeacon`, so without this every such test would fall through to
 * the network stub below and rely on `post`'s own try/catch to swallow the
 * result. Returning `true` here is what the browser does, and it means the
 * fallback is never taken.
 */
navigator.sendBeacon = () => true;

/**
 * No test may reach the network, and one that tries should say so.
 *
 * jsdom inherits node's global `fetch`, which resolves against
 * `http://localhost:3000` — so an unstubbed request does not fail, it *hangs*
 * for the length of a connection timeout and then fails somewhere unrelated. A
 * test that needs a response should stub the `api` method it is exercising
 * (`vi.spyOn(api, "search")`), or replace this with `vi.stubGlobal("fetch", …)`
 * and restore it in `afterEach`.
 */
vi.stubGlobal("fetch", () => {
  throw new Error(
    "fetch() in a component test: stub the api method you are exercising, " +
      "or vi.stubGlobal('fetch', …) for the length of this test.",
  );
});
