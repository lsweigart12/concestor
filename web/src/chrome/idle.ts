/**
 * Chrome auto-hides. The canvas is the page.
 *
 * The control bar is the only always-visible thing this app draws over the
 * tree, and a bar nobody is looking at is a bar in the way. It fades after a
 * few still seconds and comes back on the first sign of a reader.
 *
 * Two events are watched and the pair is deliberate: a pointer moving is how a
 * mouse user arrives, and a key going down is how everybody else does. Neither
 * is enough alone — the keyboard surface is bare letters and a reader who has
 * been reading rather than moving reaches for one of those next, which is
 * exactly the moment the bar had faded.
 *
 * What this does *not* decide is whether the bar is allowed to idle at all.
 * `App.tsx` holds it open through an opening's afterglow, because a reader
 * reading the answer to their question is precisely the reader holding still.
 */

import { useEffect, useState } from "react";

/** How long the reader has to be still before the chrome goes, in ms. */
const IDLE_MS = 4000;

export function useIdle(): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let t = window.setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);
  return idle;
}
