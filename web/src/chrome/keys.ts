/**
 * How the app hears a key at all.
 *
 * `bindings.ts` is the table — which letter means which action, and what
 * `matchKey` refuses. This is the other half: one window listener, for the life
 * of the app, calling through to whatever the current handler is.
 *
 * **The subscription and the behaviour are deliberately separated**, and that
 * is the fix for a real bug rather than tidiness. This used to be one effect in
 * `App.tsx` whose dependency list ended in `tree`, and `useTree()` builds a
 * fresh object on every render — so the window listener was torn off and put
 * back on every render, which on this canvas is continuous. A binding that is
 * being unsubscribed and resubscribed dozens of times a second is one the
 * reader sometimes presses into a gap: the press does nothing, the chrome wakes
 * on its own listener, and the second press — landing on a subscription that
 * has settled — works. That is exactly the "it only fires the second time"
 * symptom, and it was worst after the chrome faded, because a reader who has
 * been still for four seconds is a reader whose next input is a keypress rather
 * than a click.
 *
 * So the handler may be rebuilt as often as its dependencies like. The browser
 * is told once.
 */

import { useEffect, useRef } from "react";

/**
 * Listen for `keydown` on the window, without resubscribing.
 *
 * `onKey` may be a fresh function on every render; only the ref is rewritten,
 * and the registration below runs exactly once. Nothing about the behaviour of
 * a press changes — the handler still closes over current state, because it is
 * the current handler that is called.
 *
 * The ref is written **in an effect rather than during render**, which is the
 * one subtlety worth keeping: a render React discards must not be the one the
 * next press is answered from.
 */
export function useWindowKeys(onKey: (e: KeyboardEvent) => void): void {
  const onKeyRef = useRef(onKey);
  useEffect(() => {
    onKeyRef.current = onKey;
  }, [onKey]);

  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
