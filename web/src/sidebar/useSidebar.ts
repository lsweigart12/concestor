/**
 * Whether the panel is open, how wide it is, and where the first fact is kept.
 *
 * ## One panel, and what it replaced
 *
 * The chrome used to be scattered over the canvas on four edges at once: a
 * captioned button bar along the top, a stack of mode switches bottom left, a
 * scale switch on the axis footer, a detail card in the top-right corner and a
 * round palette button bottom right on a phone. Every one of those placements
 * was argued for on its own merits and several of the arguments were good ones
 * — a control belongs on the thing it changes — but the sum of them is a canvas
 * with a hole in each corner, and the reader's eye has to go to a different
 * part of the screen for each kind of thing they want to do.
 *
 * The pivot is to one docked column on the left holding all of it, which is
 * what every canvas application the audience has already used does: Figma,
 * Framer, tldraw, Photoshop, Linear. What is left outside it is the canvas, the
 * timeline flush along the bottom, two small clusters in the canvas's own
 * corners — the panel's toggle at the top left, and the three viewport actions
 * at the top right — and the detail card, which flies out from the right.
 *
 * ## It is one width, and it is deliberately not draggable
 *
 * A drag handle was built first, to the full WAI-ARIA window-splitter contract:
 * a focusable separator, arrow keys, `Home`/`End`, double-click to reset, a
 * coarse-pointer target, a snap past the minimum that closed the panel. All of
 * it worked, and it was removed, because there is no width a reader would
 * rather be at.
 *
 * The panel's contents do not reward one. Every row in it is a name, a caption
 * or a switch, and none of them is a document that gets easier to read wider —
 * {@link WIDTH} is set by the widest fixed thing in the column and everything
 * else fits inside it comfortably. Narrower buys canvas that `S` already gives
 * away for free, and gives back a panel whose captions have started to wrap.
 * Wider buys nothing at all and costs the tree.
 *
 * So the two states are **open and shut**, which is a control anybody can find
 * and nobody has to discover. What the drag was really offering was a way to
 * trade panel for canvas, and the toggle already is one — instantly,
 * reversibly, and from the keyboard.
 *
 * ## Open or shut is the reader's, and it is a preference rather than a view
 *
 * `state/store.ts` is emphatic that a setting which is a claim about the
 * *reader* may not ride in a link, and that the canvas modes are therefore
 * `sessionStorage` — a shared tree must not open looking like whatever the
 * recipient last chose. That rule is about how the canvas is **drawn** and does
 * not reach here: whether a panel is open changes no pixel of the tree and
 * cannot leak into a URL, so it is `localStorage` on `palette/recent.ts`'s
 * precedent, which is the same distinction drawn the same way. A workspace that
 * forgets its shape every tab is not a workspace.
 *
 * ## Docked or over the top, decided by the window and nothing else
 *
 * Above {@link DOCK_W} the panel is docked: it takes width out of the canvas,
 * the canvas reflows into what is left, and the timeline starts at the panel's
 * inner edge. Below it the panel is an overlay with a scrim, the canvas keeps
 * the whole window, and opening it is a deliberate act the reader closes again.
 *
 * That threshold is not a guess about devices. It is where a docked panel still
 * leaves the canvas more than `MIN_FREE_W` — the number `canvas/viewport.ts`
 * already measured as the narrowest strip worth reframing a tree into, below
 * which the labels are drawn at a size nobody can read. 264 + 420 is 684; the
 * room to 940 is the margin between *a tree fits* and *a tree fits beside an
 * open card as well*.
 *
 * ## Everything here is two numbers on the document
 *
 * `--sidebar-w` is what the panel takes off the canvas and `--chrome-left` is
 * where its right edge sits on screen; {@link apply} is why those are different
 * questions. The canvas is `left: var(--sidebar-w)`, and because the axis, the
 * drill lane and the marks are all positioned *inside* the canvas, they follow
 * for free — there is no second place that has to be told the panel opened.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/**
 * How wide the panel is. One number, and there is no second one.
 *
 * It is the **narrowest** width the column's contents read at, not a
 * comfortable one. That distinction is the whole of why this number changed:
 * the panel was 336 while the detail card lived inside it, sized so the card's
 * prose kept the measure it was written for — and the card moved out to the
 * right-hand edge, taking the only argument for the extra 72px with it.
 *
 * What sets it now is the widest thing still in the column, which is the
 * `labels` switch: three words in a recessed track under a caption and a key
 * badge, and `scientific` is the longest of them. Everything else — a taxon
 * row, the add row, the two tree actions — fits inside that with room to spare.
 * Every pixel past it is canvas spent on a track stretching to say nothing
 * extra.
 */
export const WIDTH = 264;

/** Above this the panel is docked and takes width off the canvas. */
export const DOCK_W = 940;

/** How much canvas a floating drawer leaves showing beside it. */
export const FLOAT_GAP = 56;

const KEY = "concestor.sidebar";

/**
 * The panel's DOM id, so the toggle can point at it.
 *
 * A disclosure's button carries `aria-controls` naming what it shows, and the
 * two are in different components — the toggle rides the canvas, deliberately,
 * so that it stays put when the thing it controls goes away. A shared constant
 * is what stops the two halves of one relationship from drifting into two ids.
 */
export const SIDEBAR_ID = "concestor-sidebar";

/**
 * What is stored, which is one boolean.
 *
 * The version tag stays at 1 and the shape is a **subset** of what it was: the
 * blob carried a width beside this flag while the panel was draggable, and one
 * written then still parses, because an extra key nobody reads is not a reason
 * to throw a reader's preference away. A blob missing `open` is, and does.
 */
interface Stored {
  v: 1;
  open: boolean;
}

export interface SidebarState {
  open: boolean;
  /** False below {@link DOCK_W}, where the panel floats over the canvas. */
  docked: boolean;
  toggle: () => void;
  setOpen: (v: boolean) => void;
}

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const p: unknown = JSON.parse(raw);
    if (typeof p !== "object" || p === null) return null;
    const o = p as Partial<Stored>;
    if (o.v !== 1 || typeof o.open !== "boolean") return null;
    return { v: 1, open: o.open };
  } catch {
    // Blocked storage, a truncated write, a blob this app did not author. All
    // of them mean the same thing here and none of them is worth a message: the
    // panel opens, which is where a first-time reader starts anyway.
    return null;
  }
}

function write(open: boolean): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, open } satisfies Stored));
  } catch {
    // Private browsing, a full quota. The panel still works; it just forgets.
  }
}

/**
 * Write the stored state to the document before React mounts.
 *
 * Called from `main.tsx`, which is the only place early enough to matter: the
 * variables default to `0px` in the stylesheet, so without this the first
 * painted frame is always a full-width canvas — and on a reader who left the
 * panel open, that frame is the one React Flow measures. The result is not a
 * flicker, it is a tree fitted to a viewport it is not in.
 *
 * Idempotent and silent. It reads the same storage the hook reads and applies
 * the same rule, and if anything at all goes wrong the variables keep the
 * stylesheet's `0px`, which is the state the app had before this existed.
 */
export function primeSidebarWidth(): void {
  // Undocked the panel starts shut whatever the flag says — see `overlayOpen`
  // in the hook — so there is nothing to prime there.
  if (!window.matchMedia(`(min-width: ${DOCK_W}px)`).matches) return;
  apply(true, read()?.open ?? true);
}

/**
 * Write the two numbers the layout reads.
 *
 * **They are two because the panel is two different things.** `--sidebar-w` is
 * what the panel takes *out of the canvas*, so it is zero whenever the panel is
 * floating over the canvas rather than beside it — an overlay that also took
 * width would leave a strip of void down the side of the tree it is covering.
 * `--chrome-left` is where the panel's right edge *is on screen*, which is a
 * different question with a different answer in exactly that case, and it is
 * what the toggle and the search pill ride.
 *
 * Collapsing them into one was the first version and it put the toggle and the
 * pill on top of the drawer's own wordmark at every width below `DOCK_W`.
 */
function apply(docked: boolean, open: boolean): void {
  const root = document.documentElement.style;
  root.setProperty("--sidebar-w", docked && open ? `${WIDTH}px` : "0px");
  // The clamp is `.sidebar.is-floating`'s own `max-width`, restated because a
  // custom property cannot read the width an element resolved to. A drawer may
  // not be wider than the window, and it leaves a strip of canvas showing so a
  // reader can see what they are standing in front of.
  root.setProperty(
    "--chrome-left",
    open ? `min(${WIDTH}px, calc(100vw - ${FLOAT_GAP}px))` : "0px",
  );
}

/**
 * Whether the window is wide enough to dock, tracked live.
 *
 * A rotation, a split-screen drag and the browser's own zoom all cross this
 * threshold without a reload, and a panel that is docked according to a number
 * read once at boot is a panel that covers the canvas on the small half of a
 * screen somebody just split.
 */
function useDocked(): boolean {
  const [docked, setDocked] = useState(
    () =>
      typeof window === "undefined" ||
      window.matchMedia(`(min-width: ${DOCK_W}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${DOCK_W}px)`);
    const on = () => setDocked(mq.matches);
    mq.addEventListener("change", on);
    on();
    return () => mq.removeEventListener("change", on);
  }, []);
  return docked;
}

export function useSidebar(): SidebarState {
  const docked = useDocked();
  const [dockedOpen, setDockedOpen] = useState(() => read()?.open ?? true);

  /**
   * Undocked, the panel starts shut whatever the stored value says.
   *
   * The stored flag is about the docked column — a reader who left it open on a
   * desktop wants it open there next time. On a narrow window the same panel is
   * an overlay across most of the screen, and opening on top of the canvas
   * before the reader has asked for anything hides the one thing they came for.
   * So the flag is *read* in one mode and ignored in the other, rather than two
   * flags that could disagree about one panel.
   */
  const [overlayOpen, setOverlayOpen] = useState(false);
  const open = docked ? dockedOpen : overlayOpen;

  const setOpen = useCallback(
    (v: boolean) => {
      if (!docked) {
        setOverlayOpen(v);
        return;
      }
      setDockedOpen((was) => {
        // Written from inside the updater so the value stored is the value the
        // state actually took, and guarded so a redundant `setOpen(true)` — the
        // card's own, on every selection — is not a write per click.
        if (was !== v) write(v);
        return v;
      });
    },
    [docked],
  );

  const toggle = useCallback(() => {
    if (!docked) {
      setOverlayOpen((v) => !v);
      return;
    }
    setDockedOpen((was) => {
      write(!was);
      return !was;
    });
  }, [docked]);

  /**
   * **`useLayoutEffect`, and that is a bug fix rather than a preference.** The
   * canvas is `left: var(--sidebar-w)` and React Flow measures the canvas with
   * a `ResizeObserver`; under a passive effect the first painted frame is a
   * full-width canvas, React Flow measures *that*, and the fit that follows
   * frames the tree against a viewport a panel's width wider than the one it ends
   * up in —
   * so a shared link opens with its right-hand lineages hanging off the edge.
   * {@link primeSidebarWidth} covers the same ground one step earlier, before
   * React has run at all; this is what keeps it true afterwards.
   */
  useLayoutEffect(() => {
    apply(docked, open);
  }, [docked, open]);

  return { open, docked, toggle, setOpen };
}
