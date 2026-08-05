/**
 * The whole router, and it has one route in it.
 *
 * `state/store.ts` says the URL *is* the store's serialisation, and that stayed
 * true for as long as everything this app showed was a view of the tree. An
 * about page is not: it is a second document that happens to live at the same
 * origin, and `encode` has nothing to say about it.
 *
 * **The two must not share a history effect.** The store writes `encode(view)`
 * whenever the view changes and compares it against `search || pathname`; on
 * `/about` the search is empty and the pathname is not `/`, so the very first
 * pass would `replaceState` the reader onto `/` and the page would vanish under
 * a canvas. That is why the split is at the *root*: `main.tsx` mounts `App` or
 * `AboutPage`, never both, so on `/about` the store is not mounted and has no
 * opinion about the address bar.
 *
 * The cost of that is the honest one and worth stating: leaving the tree
 * unmounts it. Coming back re-reads the URL and rebuilds — which is fast, and
 * only fast because `api.ts`'s cache is a module singleton that outlives the
 * component tree, so every ancestor path is already in memory. A cold `/about`
 * link has nothing to rebuild and is the case this is really for.
 */

import { useEffect, useState } from "react";

type Route = "app" | "about";

/** Where the about page lives. One string, because three files need it. */
export const ABOUT_PATH = "/about";

/**
 * Whether this session got to `/about` from inside the app.
 *
 * `sessionStorage` rather than a module variable, because the question is
 * asked after a navigation that may have been a real page load — and it is
 * asked to decide one thing only: whether "Back to the tree" should be
 * `history.back()`, which returns the reader to the tree they had, or a plain
 * navigation to `/`, which is all that can be offered to somebody who opened a
 * shared `/about` link cold. Calling `back()` on that reader sends them off the
 * site entirely, which is the failure this exists to avoid.
 */
const CAME_FROM_APP = "concestor:about-from-app";

export function routeOf(pathname: string): Route {
  // Trailing slash tolerated because a link somebody types or a server that
  // canonicalises may add one, and `/about/` is not a different page.
  return pathname.replace(/\/+$/, "") === ABOUT_PATH ? "about" : "app";
}

/** The current route, kept in step with back and forward. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    routeOf(window.location.pathname),
  );
  useEffect(() => {
    const onPop = () => setRoute(routeOf(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}

/**
 * Leave the tree for the about page.
 *
 * A push rather than a replace: the tree the reader assembled is a history
 * entry worth keeping, and back is the control every browser already gives
 * them for returning to it.
 */
export function goAbout(): void {
  try {
    window.sessionStorage.setItem(CAME_FROM_APP, "1");
  } catch {
    // Private mode, or storage disabled. The fallback below is a correct
    // answer for everyone, so there is nothing to handle.
  }
  window.history.pushState(null, "", ABOUT_PATH);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Return to the tree.
 *
 * `history.back()` when this session pushed `/about` itself, because that is
 * the entry holding whatever the reader had drawn — including a selection, an
 * axis and a drill lane that `/` cannot reconstruct. A plain navigation
 * otherwise.
 */
export function leaveAbout(): void {
  let pushed = false;
  try {
    pushed = window.sessionStorage.getItem(CAME_FROM_APP) === "1";
    window.sessionStorage.removeItem(CAME_FROM_APP);
  } catch {
    pushed = false;
  }
  if (pushed) {
    window.history.back();
    return;
  }
  window.history.pushState(null, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
}
