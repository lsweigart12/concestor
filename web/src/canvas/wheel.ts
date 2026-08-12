/**
 * What a plain scroll should do to the canvas, and how to guess the device.
 *
 * ## Two conventions, one canvas
 *
 * A trackpad wants scroll-to-pan: two fingers are a hand on the map, pinch is
 * the zoom, and every design tool (Figma, tldraw, Excalidraw) ships exactly
 * that. A mouse wants scroll-to-zoom: the wheel is the only analogue axis on
 * the device, dragging already pans, and scroll-to-pan spends the wheel on a
 * vertical-only copy of what the drag does better — which is why every map
 * since Google Maps zooms on the wheel. Concestor is a map of deep time, so the
 * mouse gets the maps convention and the trackpad keeps the design-tool one.
 *
 * ## Why this is a guess
 *
 * The browser does not say which device sent a wheel event, so every canvas app
 * either asks (Miro's mouse/trackpad choice), buries a checkbox (Figma's
 * "scroll wheel zooms"), or guesses. We guess, and keep the chip in the sidebar
 * for the reader the guess gets wrong — a press there pins the mode and the
 * classifier is not consulted again ({@link loadWheelChoice} in the store).
 *
 * ## The signals, strongest first
 *
 * - `ctrlKey` says nothing about the device. Browsers deliver a trackpad pinch
 *   as a ctrl+wheel, and a mouse under a held Ctrl looks identical.
 * - `deltaMode` of lines or pages is a wheel. Only Firefox with a real mouse
 *   emits non-pixel deltas; no touch surface does.
 * - A horizontal component is a touch surface. A wheel has one axis, so any
 *   `deltaX` means two fingers moving freely.
 * - A fractional `deltaY` is a touch surface. Detents arrive whole; deltas that
 *   went through gesture scaling arrive with remainders.
 * - A large, whole `deltaY` after a quiet gap is a detent. Chrome and Edge send
 *   ≥100 per click of a wheel, and a hand resting on a wheel is quiet between
 *   clicks — where a trackpad flick reaches the same magnitude only mid-stream,
 *   with events a frame apart. The gap is what tells those two apart, and it is
 *   why the classifier holds state rather than judging events alone.
 *
 * Anything else — a small, whole, vertical, isolated delta, which is both a
 * slow mac mouse and a careful trackpad — returns null: no opinion, keep doing
 * whatever the canvas is doing. The known failure modes (a free-spinning wheel
 * unlatched, a violently vertical trackpad flick) are exactly what the sidebar
 * chip is for.
 */

export type WheelMode = "pan" | "zoom";

/** Every value the mode may take, so the store's loader can validate one. */
export const WHEEL_MODES = ["pan", "zoom"] as const;

/** What a detent is at minimum: one Chrome/Edge wheel click is 100. */
const DETENT_MIN = 90;

/**
 * How quiet the wheel must have been for a big delta to count as a detent.
 * Trackpad streams run at frame rate, so anything past a few frames is a hand
 * that was resting.
 */
const QUIET_MS = 80;

interface WheelSample {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages — `WheelEvent.deltaMode`. */
  deltaMode: number;
  ctrlKey: boolean;
}

/**
 * A classifier over one stream of wheel events. Holds the previous event's
 * timestamp (the quiet-gap rule above), so make one per canvas and feed it
 * every event in order.
 */
export function makeWheelClassifier(): (
  e: WheelSample,
  /** The event's own `timeStamp`, so tests can write the clock. */
  now: number,
) => WheelMode | null {
  let last = -Infinity;
  return (e, now) => {
    const quiet = now - last >= QUIET_MS;
    last = now;
    if (e.ctrlKey) return null;
    if (e.deltaMode !== 0) return "zoom";
    if (e.deltaX !== 0) return "pan";
    if (!Number.isInteger(e.deltaY)) return "pan";
    if (Math.abs(e.deltaY) >= DETENT_MIN && quiet) return "zoom";
    return null;
  };
}
