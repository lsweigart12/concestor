/**
 * One tooltip, for the whole app. `tip.ts` carries the placement arithmetic;
 * this is the store, the hook and the single layer that draws it.
 *
 * It is a hook (`useTip`) rather than a wrapper component so the trigger's DOM
 * is unchanged — a wrapping element would break `.mode-chip`'s grid and the
 * drill lane's SVG. One layer subscribes to a module store, so only the trigger
 * opening and the one closing re-render on a hover.
 *
 * WCAG 1.4.13: the tip is dismissible (Escape), hoverable (pointer can reach
 * the words, hence the close timer) and persistent (no timeout). Mouse only —
 * a touch tap would raise a tip nothing could dismiss.
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
interface TipProps {
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
    // The anchor is measured once at open time, so anything that relays out the
    // page invalidates it. Listen on the window (not the trigger) to catch a
    // press on another element or a keystroke while the pointer sits still, and
    // dismiss rather than re-place.
    const go = () => dismiss();
    window.addEventListener("resize", go);
    window.addEventListener("scroll", go, true);
    window.addEventListener("pointerdown", go, true);
    // Escape is swallowed only when a tip is open, so the tip is the innermost
    // link in the escape chain. Every other key just closes it and travels on.
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
