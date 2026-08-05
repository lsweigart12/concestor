/**
 * One tooltip, for the whole app. `tip.ts` carries the reasoning and the
 * arithmetic; this is the store, the hook and the layer that draws it.
 *
 * **A hook rather than a wrapper**, and that is a decision about this codebase
 * rather than a taste. `<Tip><button/></Tip>` is the friendlier API and it puts
 * an element into the tree — which here means into `.mode-chip`'s grid, into
 * `.canvas-modes`'s subgrid, into a `<g>` inside the drill lane's single SVG.
 * `styles.test.ts` exists because a stray element in one of those fails
 * silently, in text, at a window size nobody is looking at. `useTip` returns
 * event handlers and nothing else: the DOM after this change is the DOM before
 * it, attribute for attribute, minus every `title`.
 *
 * **One tip, one layer, one element.** The alternative is a portal per trigger,
 * which is a few hundred idle React subtrees on a canvas of marks. Here the
 * layer is mounted once beside the app and every trigger talks to a module
 * store. Only two components re-render on a hover — the one opening and the one
 * closing — because `useSyncExternalStore` is given a snapshot that is a
 * boolean about *this* trigger, so the other forty-eight subscribers see no
 * change and React does nothing with them.
 *
 * **What it owes a reader, from WCAG 1.4.13**, all three of which the native
 * `title` this replaces failed:
 *
 * - *Dismissible.* Escape closes it without moving the pointer. The listener is
 *   in the capture phase and swallows the press only when a tip is actually
 *   open, which is what makes the tooltip the innermost thing in the app's
 *   escape chain rather than a fourth thing competing with the palette, the
 *   card and the dialog.
 * - *Hoverable.* The pointer can move onto the words. That is why the tip takes
 *   pointer events and why leaving is on a timer rather than immediate — a
 *   reader at 400% zoom is reading a tip that may be most of their screen.
 * - *Persistent.* Nothing times out. It goes when the pointer leaves, when
 *   focus leaves, on Escape, or on the press it was explaining.
 *
 * **The focus half of that was near-dead for this component's whole life, and
 * is live now.** `App.tsx` calls `preventDefault` on every key it matches, and
 * `bindings.ts` used to claim bare `Tab` for stepping the selection — so the
 * focus ring did not move in this app at all, and a tip that opens on focus was
 * waiting for something that could not happen outside the palette and the
 * dialog. The handlers were kept anyway, on the ground that they were correct
 * the moment that changed and cost one comparison until then, and that is what
 * they turned out to be: `step` moved to `n`, `Tab` went back to the browser,
 * and every tip on the bar and the mode panel now opens under the focus ring
 * without a line changing here. Which is the argument for writing the correct
 * handler while the thing it depends on is still broken.
 *
 * **Mouse only, deliberately.** `pointerenter` fires for touch, so a tapped
 * control on a phone would raise a tip that nothing can dismiss — the finger is
 * already gone. Touch readers lose nothing here that they had: a `title`
 * attribute never showed on a touch screen either, which is half of why the
 * copy that accumulated in them was never reviewed.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CLOSE_MS, openDelay, place, type Placement, type Rect } from "./tip";

/** The tip's element id, which is what `aria-describedby` points at. */
const TIP_ID = "app-tip";

interface Active {
  /** The `useId` of the trigger that owns it. */
  id: string;
  text: string;
  anchor: Rect;
}

let active: Active | null = null;
/** When the last tip closed, for `openDelay`. */
let lastClosed: number | null = null;
let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

const subs = new Set<() => void>();

function emit(): void {
  for (const f of subs) f();
}

function subscribe(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

function clearTimers(): void {
  if (openTimer !== null) clearTimeout(openTimer);
  if (closeTimer !== null) clearTimeout(closeTimer);
  openTimer = closeTimer = null;
}

function setActive(next: Active | null): void {
  if (active === next) return;
  if (active && !next) lastClosed = Date.now();
  active = next;
  emit();
}

/** Ask for a tip after the hover delay. A second ask replaces the first. */
function request(id: string, text: string, anchor: Rect): void {
  clearTimers();
  const delay = openDelay(Date.now(), lastClosed);
  if (delay === 0) {
    setActive({ id, text, anchor });
    return;
  }
  openTimer = setTimeout(() => {
    openTimer = null;
    setActive({ id, text, anchor });
  }, delay);
}

/** Show now, with no delay — what focus does, because focus is deliberate. */
function show(id: string, text: string, anchor: Rect): void {
  clearTimers();
  setActive({ id, text, anchor });
}

/** Let it go after the grace period, so the pointer can cross `GAP`. */
function release(id: string): void {
  if (openTimer !== null) {
    clearTimeout(openTimer);
    openTimer = null;
  }
  if (active?.id !== id) return;
  if (closeTimer !== null) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = null;
    setActive(null);
  }, CLOSE_MS);
}

/** Go now: a press, Escape, a scroll, a resize, an unmounted trigger. */
function dismiss(id?: string): void {
  if (id !== undefined && active?.id !== id) {
    // Not ours, but a pending open might be — a pointer that left before the
    // delay elapsed must not open a tip afterwards.
    if (openTimer !== null) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    return;
  }
  clearTimers();
  setActive(null);
}

/** The tip is being read. Whatever was about to close it, stop. */
function hold(): void {
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/**
 * The props that give an element a tooltip.
 *
 * Spread onto the trigger and nothing else changes about it. Passing no text —
 * which several callers do conditionally — returns an empty object, so a
 * caption that exists only sometimes needs no branch at the call site.
 */
export interface TipProps {
  onPointerEnter?: (e: React.PointerEvent) => void;
  onPointerLeave?: (e: React.PointerEvent) => void;
  onFocus?: (e: React.FocusEvent) => void;
  onBlur?: (e: React.FocusEvent) => void;
  "aria-describedby"?: string;
}

export function useTip(text: string | undefined | null): TipProps {
  const id = useId();

  // A boolean about this trigger, so a hover anywhere else is a snapshot that
  // did not change and a render React never schedules.
  const mine = useSyncExternalStore(
    subscribe,
    () => active?.id === id,
    () => false,
  );

  // A trigger can leave while its tip is up — a mark the reader has just taken
  // off the canvas, a palette row filtered away by the next keystroke — and
  // there is then nothing left to fire `pointerleave`.
  useEffect(() => () => dismiss(id), [id]);

  const onPointerEnter = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== "mouse" || !text) return;
      request(id, text, rectOf(e.currentTarget));
    },
    [id, text],
  );

  const onPointerLeave = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      release(id);
    },
    [id],
  );

  const onFocus = useCallback(
    (e: React.FocusEvent) => {
      // Only a keyboard's focus. A click focuses too, and a tip that springs
      // up on every press is the flicker this delay exists to prevent.
      if (!text || !e.currentTarget.matches(":focus-visible")) return;
      show(id, text, rectOf(e.currentTarget));
    },
    [id, text],
  );

  const onBlur = useCallback(() => dismiss(id), [id]);

  if (!text) return {};
  return {
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onBlur,
    ...(mine ? { "aria-describedby": TIP_ID } : {}),
  };
}

/**
 * The layer, mounted once at the root beside whichever document is showing.
 *
 * It draws in two passes and has to: `place` needs the tip's height, the height
 * depends on where the words wrap, and the wrap depends on the copy. So the
 * first pass renders it unplaced and invisible, a layout effect measures it,
 * and the second pass puts it where it goes — before paint, so nothing is ever
 * drawn in the corner on the way.
 */
export function TooltipLayer() {
  const state = useSyncExternalStore(
    subscribe,
    () => active,
    () => null,
  );
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    if (!state) {
      setPlacement(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPlacement(
      place(
        state.anchor,
        { w: r.width, h: r.height },
        { w: window.innerWidth, h: window.innerHeight },
      ),
    );
  }, [state]);

  useEffect(() => {
    if (!state) return;
    /*
      The anchor is a rectangle measured once, at open time, so **anything that
      relays out the page invalidates it** — and the failure is not a tip in
      slightly the wrong place, it is a sentence about one control left hanging
      over another. This app re-lays out the whole canvas constantly: opening
      the detail card narrows the plot and re-fits the tree, `L` and `A` change
      what every label prints, `F` reframes.

      All of it is caught here rather than at the trigger, and that is the
      correction worth recording. `pointerdown` and `keydown` were originally
      handlers on the trigger itself, which cannot see the two cases that
      matter: a press on some *other* element, and a keystroke while the
      pointer sits still on a mark. Both leave the old tip up, pointing at
      something that has moved out from under it.

      Re-placing instead of dismissing was the other option and is wrong: the
      reader asked about a control, and the honest answer to "that control is
      no longer where you asked about it" is to stop answering.
    */
    const go = () => dismiss();
    window.addEventListener("resize", go);
    window.addEventListener("scroll", go, true);
    window.addEventListener("pointerdown", go, true);
    // Escape is swallowed, and only when there is a tip to dismiss — which is
    // what makes the tooltip the innermost thing in the app's escape chain
    // rather than a fourth thing competing with the palette, the card and the
    // dialog. Every other key just closes it and travels on.
    const onKey = (e: KeyboardEvent) => {
      if (!active) return;
      dismiss();
      if (e.key === "Escape") e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("resize", go);
      window.removeEventListener("scroll", go, true);
      window.removeEventListener("pointerdown", go, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [state]);

  if (!state) return null;

  return (
    <div
      ref={ref}
      id={TIP_ID}
      role="tooltip"
      className={placement ? `tip tip-${placement.side}` : "tip"}
      style={
        placement
          ? { left: placement.x, top: placement.y }
          : // The measuring pass. `visibility` rather than `display`, because a
            // box that is not laid out has no height to read.
            { left: 0, top: 0, visibility: "hidden" }
      }
      onPointerEnter={hold}
      onPointerLeave={() => dismiss()}
    >
      {state.text}
    </div>
  );
}
