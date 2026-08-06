/**
 * Enough of a browser and enough of an API to render the whole app.
 *
 * `App.test.tsx` and `App.bare.test.tsx` both need this and differ only in what
 * the browser can do, so the arrangement lives here and the capability stubs
 * stay in the test files — those have to run in `vi.hoisted`, because
 * `FULLSCREEN_AVAILABLE` and `BIOLUM_AVAILABLE` are both decided at module
 * scope on first import and a file is the unit vitest evaluates a module graph
 * in.
 *
 * Three jsdom gaps and one wall:
 *
 * - **`ResizeObserver`** is what xyflow measures its container with. Without it
 *   the canvas throws on mount and nothing renders at all. Stubbed rather than
 *   simulated: jsdom lays nothing out, so every rect is zero either way, and the
 *   viewport arithmetic that cares is `viewport.test.ts`'s subject and pure.
 * - **`matchMedia`** answers `prefers-reduced-motion`. It is stubbed to *reduce*
 *   on purpose — `openSequenced` then draws an opening's taxa in one go rather
 *   than stepping them in over several seconds, which is the same tree by the
 *   same path and is the reader this suite can actually wait for.
 * - **`getBoundingClientRect`** is left alone. Nothing here asserts a position.
 * - **the network** is already walled off by `setup-dom.ts`, whose `fetch`
 *   throws. Every `api` method these tests reach is spied, and one that is not
 *   fails loudly rather than hanging.
 */

import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import type { PathNode, PathResponse } from "../api";
import { api, TIER_MEASURED, TIER_STRUCTURAL } from "../api";
import App from "../App";

/** xyflow measures its container; jsdom has nothing to measure with. */
class NoResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * A media query that says yes to reduced motion, yes to a desktop width, and
 * no to everything else.
 *
 * The width half is not a convenience. `sidebar/useSidebar.ts` asks whether the
 * window is wide enough to *dock* the panel, and a stub answering no puts every
 * test in this suite behind a drawer that starts shut — so a file about the
 * chrome would be asserting against an app with none of it drawn. jsdom's
 * window is 1024 wide, which is genuinely over `DOCK_W`, so answering `true`
 * here is reporting the environment rather than pretending about it.
 */
function stubMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      query.includes("prefers-reduced-motion") || query.includes("min-width"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

const node = (over: Partial<PathNode> & { idx: number }): PathNode => ({
  key: `ott${over.idx}`,
  ott_id: over.idx,
  name: `Taxon ${over.idx}`,
  rank: "species",
  age_ma: null,
  age_layout: 0,
  tier: TIER_STRUCTURAL,
  tip_count: 1,
  depth: 1,
  phylopic_id: null,
  silhouette_source_idx: null,
  ...over,
});

/**
 * One ancestor everything shares, so any two taxa induce a subtree.
 *
 * The dates are the only part that has to be plausible: the layout puts a mark
 * at `age_layout` and the axis is drawn from the spread of them.
 */
const ROOT = node({
  idx: 1,
  key: "ott1",
  name: "Root",
  rank: null,
  age_ma: 400,
  age_layout: 400,
  tier: TIER_MEASURED,
  tip_count: 99,
  depth: 0,
});

/**
 * The API, answering about whatever it is asked.
 *
 * Every key gets its own index and its own leaf hanging off the one root, so
 * the canvas draws a real induced subtree without this file having to know
 * which opening a test pressed.
 */
export function stubApi(): void {
  const idxFor = new Map<string, number>();
  let next = 100;
  const resolve = (key: string): PathResponse => {
    if (!idxFor.has(key)) idxFor.set(key, ++next);
    const idx = idxFor.get(key)!;
    return { key, idx, forwarded_from: null, path: [ROOT, node({ idx, key })] };
  };

  vi.spyOn(api, "about").mockResolvedValue({
    build_id: "test-build",
    counts: { nodes: 2 },
  });
  vi.spyOn(api, "path").mockImplementation((key: string) =>
    Promise.resolve(resolve(key)),
  );
  vi.spyOn(api, "paths").mockImplementation((keys: string[]) =>
    Promise.resolve({
      paths: Object.fromEntries(keys.map((k) => [k, resolve(k)])),
    }),
  );
}

/** Let effects, promises and the store's fetches settle. */
export async function settle(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise((r) => {
      setTimeout(r, ms);
    });
  });
}

/**
 * Mount the whole app on an empty canvas, resolved and idle.
 *
 * **The address bar and `sessionStorage` are cleared first**, and that is not
 * housekeeping. `state/store.ts` writes the drawn tree into the URL with
 * `replaceState` and holds the labels, the ages and the light in
 * `sessionStorage` — both of which outlive `cleanup`, because neither is in the
 * document. Without this the second test in a file boots on the first one's
 * tree, finds no carousel to press and no invitation to read, and fails
 * somewhere that has nothing to do with what it is asking.
 */
export async function renderApp(): Promise<void> {
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
  vi.stubGlobal("ResizeObserver", NoResizeObserver);
  stubMatchMedia();
  stubApi();
  render(<App />);
  await settle();
}

/** Press the carousel's front card, and let the tree land. */
export async function drawOpening(): Promise<void> {
  const card = document.querySelector<HTMLElement>(".carousel-card");
  if (!card) throw new Error("the empty canvas is drawing no opening to press");
  await act(async () => {
    card.click();
    await new Promise((r) => {
      setTimeout(r, 60);
    });
  });
}

/**
 * Open the palette from the search pill, and read its rows.
 *
 * Through the control rather than a key, because that is the surface these
 * tests are about — and it is the one control in the app that reaches every
 * other one's row. It is also the one control that is drawn whether the panel
 * is open or shut, which is what makes it the right handle here.
 */
export async function openPalette(): Promise<string[]> {
  const command = document.querySelector<HTMLElement>(".side-search-btn");
  if (!command) throw new Error("nothing is drawing the search");
  await act(async () => {
    command.click();
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  });
  return [...document.querySelectorAll(".palette .row")].map(
    (r) => r.textContent ?? "",
  );
}

/** Dismiss the answer, which is what tells the app the reader is ready. */
export async function dismissAnswer(): Promise<void> {
  const x = document.querySelector<HTMLElement>(".toast-dismiss");
  if (!x) throw new Error("no answer is pinned to dismiss");
  await act(async () => {
    x.click();
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  });
}
