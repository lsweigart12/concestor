/**
 * The one control on this bar that acts on the *window* rather than on the tree.
 *
 * A phylogeny is wide, and every pixel the browser spends on its own tab strip,
 * URL bar and bookmarks is a pixel the time axis does not get. Fullscreen is the
 * cheapest thing this app can do about that, and it belongs in the `Canvas`
 * group for the reason the group exists: like clear and share, it is about the
 * canvas as a whole rather than about anything selected on it.
 *
 * **Three things here are not the obvious version, and each is answering
 * something real.**
 *
 * **The document is a parameter.** {@link toggleFullscreen} takes a
 * {@link FullscreenDoc} rather than reaching for the global, exactly as
 * `matchKey` takes a `KeyLike` rather than a `KeyboardEvent`: the decision
 * — request, exit, or say why not — is the part worth pinning, and this project
 * has no DOM to render into. The hook below is the only thing that knows the
 * real `document` exists.
 *
 * **The state is read off the event, never remembered.** A reader leaves
 * fullscreen with Escape or F11 as often as with this button, and neither goes
 * anywhere near our handler — the browser takes Escape *before* the page sees
 * it, which is also why `App.tsx`'s `escape` case cannot be relied on to know.
 * A local boolean flipped on each press is therefore wrong within one keystroke:
 * the button says "on" over a window that is not. `fullscreenchange` is the only
 * honest source, and this subscribes to it.
 *
 * **A browser with no fullscreen at all is offered nothing**, rather than a
 * disabled button. That is deliberately the *opposite* of what `Controls.tsx`
 * does with `fit` on an empty canvas, and the split is capability against state:
 * a greyed `fit` says "add a species and this works", which is true and useful,
 * where a greyed fullscreen would say "your browser will never do this" to
 * somebody who can do nothing about it. `canvas/gl/renderer.ts`'s
 * `supported()` already made this call for bioluminescence and the reasoning is
 * the same — asked once, before anything is drawn, and the switch simply is not
 * there. iOS Safari is the case that matters: it has no element fullscreen, so
 * the control is absent on an iPhone, which is a width where the bar is not
 * drawn either.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Just enough of a `Document` to decide, so this stays testable.
 *
 * `fullscreenEnabled` is the browser's own answer to "may this page do it at
 * all", and it is false inside an iframe without `allow="fullscreen"` as well
 * as on a browser that has never implemented it. Only the unprefixed API is
 * read: a browser old enough to need `webkitRequestFullscreen` reports nothing
 * here and is handed no button, which is a better failure than a button that
 * silently does nothing.
 */
export interface FullscreenDoc {
  fullscreenEnabled: boolean;
  fullscreenElement: Element | null;
  documentElement: { requestFullscreen: () => Promise<void> };
  exitFullscreen: () => Promise<void>;
}

/**
 * Whether this browser will do it, asked once before anything is drawn.
 *
 * Module scope for the same reason `BIOLUM_AVAILABLE` is: the answer cannot
 * change while the tab is open, and a control that appears halfway through a
 * session is worse than one that was never there.
 */
export const FULLSCREEN_AVAILABLE: boolean =
  typeof document !== "undefined" && document.fullscreenEnabled === true;

/** What the reader is told when the browser refuses the request outright. */
export const FULLSCREEN_REFUSED = "This browser would not go fullscreen";

/**
 * How long the browser is given to act before silence is read as a refusal, in
 * ms.
 *
 * Long enough that no honest transition is called a refusal — the promise
 * settles before the window has finished animating, not after — and short
 * enough that the sentence still reads as a receipt for the press that caused
 * it rather than as a notice arriving out of nowhere.
 */
export const FULLSCREEN_DEADLINE_MS = 1500;

/**
 * Ask for it, or give it back — whichever the document is not already doing.
 *
 * The promise is the whole reason this is not two lines at the call site, and
 * **the promise is not the honest source.** A `.catch()` on it was the first
 * version of this and it is dead code against the failure that matters:
 * measured in an embedded browser that declines fullscreen, a request made
 * under a real user gesture returns a promise that **never settles** — it does
 * not resolve, it does not reject, the window does not move, and nothing is
 * ever called back. A rejection handler cannot fire on a promise that never
 * ends. So the three shapes a refusal arrives in are all answered here:
 *
 * - a **rejected promise**, which is what the same browser does for a request
 *   made without a user gesture, and what the spec says should happen;
 * - a **synchronous throw**, which costs one `try` to cover and is what a
 *   browser missing the unprefixed method would do;
 * - and **nothing at all**, which is the one that shipped broken.
 *
 * The last is caught by asking the document rather than the promise, on exactly
 * the principle the state below already keeps: `fullscreenElement` is what
 * actually happened, and after the deadline a document that is still windowed
 * was refused however politely.
 *
 * `exitFullscreen` is allowed to fail silently, and the asymmetry is real: the
 * only way it fails is if the document left fullscreen between the check and
 * the call, and telling a reader who is already looking at a windowed canvas
 * that we could not un-fullscreen it is noise about a thing that happened.
 */
export function toggleFullscreen(
  doc: FullscreenDoc,
  onRefuse: (why: string) => void,
): void {
  if (!doc.fullscreenEnabled) return;

  if (doc.fullscreenElement !== null) {
    try {
      void doc.exitFullscreen().catch(() => {});
    } catch {
      // Silent, for the reason above.
    }
    return;
  }

  // Said once however many of the three shapes arrive: a browser that rejects
  // *and* stays windowed must not toast twice for one press.
  let answered = false;
  const refuse = (): void => {
    if (answered) return;
    answered = true;
    onRefuse(FULLSCREEN_REFUSED);
  };

  try {
    void doc.documentElement.requestFullscreen().then(() => {
      answered = true;
    }, refuse);
  } catch {
    refuse();
    return;
  }

  setTimeout(() => {
    if (doc.fullscreenElement === null) refuse();
  }, FULLSCREEN_DEADLINE_MS);
}

/**
 * The live state and the press, for the bar and for the key.
 *
 * `onRefuse` is held in a ref rather than closed over, so `toggle` keeps one
 * identity for the life of the app. That is the same fix `App.tsx`'s key
 * listener needed and for the same reason: `toggle` is a dependency of the
 * control bar's memo and of the key handler, and a callback that changes on
 * every render walks all the way up through both of them.
 */
export function useFullscreen(onRefuse: (why: string) => void): {
  /** True while this document is the fullscreen one. */
  on: boolean;
  toggle: () => void;
} {
  const [on, setOn] = useState(false);

  const refuse = useRef(onRefuse);
  useEffect(() => {
    refuse.current = onRefuse;
  }, [onRefuse]);

  useEffect(() => {
    if (!FULLSCREEN_AVAILABLE) return;
    const sync = () => setOn(document.fullscreenElement !== null);
    // Once on mount as well: a reload inside an already-fullscreen window fires
    // no change event, and the button would open lit-side-down.
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggle = useCallback(() => {
    if (!FULLSCREEN_AVAILABLE) return;
    toggleFullscreen(document, (why) => refuse.current(why));
  }, []);

  // Memoised, so the returned object changes identity only when the state it
  // reports does. It is a dependency of the control bar's memo, and a fresh
  // object each render would rebuild that bar on every frame of a pan.
  return useMemo(() => ({ on, toggle }), [on, toggle]);
}
