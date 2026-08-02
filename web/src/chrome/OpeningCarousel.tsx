/**
 * The empty canvas, as one question at a time.
 *
 * Six openings stacked as a list was six questions and six answers on screen at
 * once — a wall of prose on a surface whose whole argument is that the graph is
 * the only thing worth looking at. One at a time reads as an invitation instead
 * of a menu, and the silhouettes do the work the extra text was doing: they say
 * what you are about to see without a word.
 *
 * **Auto-rotation is the part that has to be done carefully**, because rotating
 * banners are usually a mistake — they move text out from under the reader and
 * they are a classic accessibility failure. Four rules keep this one honest,
 * and none of them is optional:
 *
 * 1. **Hover or focus anywhere in the card stops it.** A reader who is reading
 *    is a reader who must not have the sentence taken away.
 * 2. **Any manual press stops it for good.** Once somebody has taken the wheel,
 *    an auto-advance is fighting them. It does not resume on a timer.
 * 3. **`prefers-reduced-motion` disables it entirely**, along with the fade.
 * 4. **It is never the only route.** The arrows and the dots reach all six
 *    directly, and while the canvas is empty — which is the only time this
 *    shows on it — every opening is also a palette command under `Start here`.
 *    Nothing here is reachable only by waiting.
 *
 * The interval is deliberately long. The reveal runs to two lines and a reader
 * who has just arrived is also looking at the silhouettes and the axis, so this
 * is paced for someone who has not started reading yet rather than for someone
 * halfway down.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Silhouette } from "../canvas/Silhouette";
import { OPENINGS, type Opening } from "../openings";

/** Long enough to read two lines without racing, per the note above. */
const DWELL_MS = 7600;

export function OpeningCarousel({
  onOpen,
  /**
   * Off inside the about panel, on for the empty canvas.
   *
   * The canvas is an attract surface with nothing else on it, so advancing is
   * the whole point. The panel is something a reader opened deliberately and is
   * *reading* — it carries provenance prose below this — and text sliding
   * around above what you are reading is the exact behaviour that gives
   * carousels their reputation. Rule 1 does not save it there either: hover
   * only pauses while the pointer is over the carousel, and a reader three
   * paragraphs down has moved on.
   */
  autoRotate = true,
}: {
  onOpen: (o: Opening) => void;
  autoRotate?: boolean;
}) {
  const [at, setAt] = useState(0);
  /** Set once the reader presses anything. Never cleared — see rule 2. */
  const [taken, setTaken] = useState(false);
  const [held, setHeld] = useState(false);
  const reduced = useRef(false);

  if (typeof window !== "undefined" && window.matchMedia) {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  const go = useCallback((d: number) => {
    setTaken(true);
    setAt((i) => (i + d + OPENINGS.length) % OPENINGS.length);
  }, []);

  useEffect(() => {
    if (!autoRotate || taken || held || reduced.current) return;
    const t = window.setTimeout(
      () => setAt((i) => (i + 1) % OPENINGS.length),
      DWELL_MS,
    );
    return () => window.clearTimeout(t);
  }, [at, taken, held, autoRotate]);

  const o = OPENINGS[at];
  if (!o) return null;

  return (
    <div
      className="carousel"
      role="group"
      aria-roledescription="carousel"
      aria-label="Ways in"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={() => setHeld(false)}
    >
      <button
        type="button"
        className="carousel-arrow"
        aria-label="Previous question"
        onClick={() => go(-1)}
      >
        ‹
      </button>

      {/*
        Keyed on the opening, so React swaps the subtree instead of mutating it
        and the fade restarts. Without the key the silhouettes of the outgoing
        set linger under the incoming text for a frame, which reads as a glitch
        rather than a transition.
      */}
      <button
        key={o.id}
        type="button"
        className="carousel-card"
        onClick={() => onOpen(o)}
      >
        <span className="carousel-art" aria-hidden="true">
          {o.taxa.map((t) => (
            <Silhouette key={t.key} phylopicId={t.art} size={30} title={t.label} />
          ))}
        </span>
        <span className="carousel-q">{o.question}</span>
        <span className="carousel-a">{o.reveal}</span>
      </button>

      <button
        type="button"
        className="carousel-arrow"
        aria-label="Next question"
        onClick={() => go(1)}
      >
        ›
      </button>

      {/*
        Position, and direct access. Labelled by the question rather than by an
        index, because "go to slide 4" tells a screen-reader user nothing about
        whether they want slide 4.
      */}
      <span className="carousel-dots">
        {OPENINGS.map((x, i) => (
          <button
            key={x.id}
            type="button"
            className={`carousel-dot${i === at ? " is-on" : ""}`}
            aria-label={x.question}
            aria-current={i === at}
            onClick={() => {
              setTaken(true);
              setAt(i);
            }}
          />
        ))}
      </span>
    </div>
  );
}
