/**
 * The queue behind everything this app says in words.
 *
 * Added, removed, drew, link copied, this fossil is not drawn and why — every
 * sentence the app volunteers goes through here, and the column that draws them
 * is `App.tsx`'s one live region. A toast is a **receipt**: it reports something
 * the reader has just done, it can be missed without cost, and it goes on its
 * own. The two things in this app that are *not* receipts are deliberately not
 * toasts — the pinned answer to an opening, which is a reply and has no timer,
 * and the clear dialog, which asks a question.
 *
 * The store is here and the column is not. Splitting them that way is what lets
 * the queue be read as a queue: the render is nine lines of JSX inside a live
 * region whose `aria-live` and `aria-atomic` are arguments about announcement
 * order, and none of that is about how a body gets into the list or when it
 * leaves.
 */

import { useCallback, useRef, useState, type ReactNode } from "react";

export interface Toast {
  id: number;
  body: ReactNode;
  warn?: boolean;
}

/**
 * How long a toast stays up, in ms.
 *
 * Long enough to read two clauses without hurrying, and short enough that a
 * reader adding species in a run is never looking at a stack of four. Nothing
 * is lost by missing one: the canvas is the record, and the toast is the
 * receipt for a change the canvas already shows.
 */
const TOAST_MS = 5200;

/** Say something. `warn` is for a thing the reader asked for and did not get. */
export type Say = (body: ReactNode, warn?: boolean) => void;

export interface Toasts {
  toasts: Toast[];
  toast: Say;
}

/**
 * The queue, and the one function that adds to it.
 *
 * `toast` is stable for the life of the app — it closes over nothing but its
 * own ref and its own setter — and that matters far more here than it looks
 * like it should. It is a dependency of a dozen callbacks in `App.tsx`, several
 * of which are themselves dependencies of the control bar and the palette's
 * command list, so a `toast` that changed identity every render would rebuild
 * both on every frame the canvas moves.
 */
export function useToasts(): Toasts {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = useCallback<Say>((body, warn = false) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, body, warn }]);
    window.setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      TOAST_MS,
    );
  }, []);

  return { toasts, toast };
}
