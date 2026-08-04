/**
 * The empty canvas, as one question at a time.
 *
 * Every opening stacked as a list was a question and an answer each, on screen at
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
 * 4. **It is never the only route.** The arrows and the dots reach every one
 *    directly, and the about panel — reachable at any time — carries the same
 *    carousel with rotation off. Nothing here is reachable only by waiting.
 *    The palette does *not* duplicate them: this surface and the panel are the
 *    two places an opening is offered.
 *
 * The interval is deliberately long. The reveal runs to two lines and a reader
 * who has just arrived is also looking at the silhouettes and the axis, so this
 * is paced for someone who has not started reading yet rather than for someone
 * halfway down.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Silhouette } from "../canvas/Silhouette";
import { OPENINGS, type Opening } from "../openings";
import { kbd, matchKey } from "./bindings";

/** Long enough to read two lines without racing, per the note above. */
const DWELL_MS = 7600;

/**
 * Everything the browser already activates with Enter.
 *
 * The card, the arrows and the dots are all in here, which is the point: a
 * reader who has tabbed to the card and presses Enter gets a click on it, and
 * a window listener firing alongside that click would draw the opening twice.
 * So the key is ours only when it is nobody else's.
 */
const OWNS_ENTER =
  "button, a[href], input, select, textarea, summary, [role='button'], [contenteditable]";

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
  /**
   * Whether Enter draws the question on show — see the `open-opening` row in
   * `bindings.ts`.
   *
   * Its own prop rather than a second reading of `autoRotate`, because it is
   * not a fact about this component at all: it is a fact about what is *on top
   * of* it.
   *
   * The case that named it is gone — the about panel used to leave this
   * carousel mounted behind it, so the canvas turned the key off while it was
   * up. About is a page now and `main.tsx` unmounts this whole tree to show it,
   * so the canvas passes `true` unconditionally and there is exactly one
   * caller. The prop stays, defaulting to **off**, because the principle
   * outlived its example: a surface that does not answer Enter must not print
   * the badge, and the next thing to render a carousel should have to say that
   * it does.
   *
   * The badge on the card rides on this too, on the rule the rest of the app
   * follows: **a key is printed only where the press would do it.**
   */
  keyToOpen = false,
}: {
  onOpen: (o: Opening) => void;
  autoRotate?: boolean;
  keyToOpen?: boolean;
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

  /**
   * Enter draws whatever is on show.
   *
   * The card has always been pressable and nothing on it said so — a question
   * and an answer, centred, in an app whose empty state is otherwise prose. A
   * reader who took it for a caption was reading it correctly. The badge below
   * is half the fix and this is the other half: a key printed on a surface
   * that does not answer it is worse than no badge at all.
   *
   * Deliberately *not* wired into `App`'s handler with the rest of the table.
   * That one matches a key and then `preventDefault`s everything it matched,
   * which is right for a letter the canvas owns outright and catastrophic for
   * Enter — it would take keyboard activation off every button in the app. The
   * `surface` scope is what keeps the two apart, and it does it structurally:
   * `App` calls `matchKey` with the default scope and so is never handed this
   * press at all, rather than being trusted to give it back.
   */
  useEffect(() => {
    if (!keyToOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (matchKey(e, "surface") !== "open-opening") return;
      if (e.target instanceof Element && e.target.closest(OWNS_ENTER)) return;
      const shown = OPENINGS[at];
      if (!shown) return;
      e.preventDefault();
      onOpen(shown);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyToOpen, at, onOpen]);

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
            <Silhouette key={t.key} phylopicId={t.art} size={30} tip={t.label} />
          ))}
        </span>
        <span className="carousel-q">{o.question}</span>
        <span className="carousel-a">{o.reveal}</span>
        {/*
          What the press does, said inside the thing that does it.

          A `span`, and styled with no box of its own, because **there is one
          target here and it is the card**. The first attempt drew this as a
          filled pill, which put a button inside a button: two shapes, the
          inner one smaller and so read as the real one, on a surface where
          pressing anywhere does the same thing. `styles.css` carries the rest
          — the card is the object, this is its caption, and one hover lights
          them together.

          The badge rides on `keyToOpen` for the same reason the detail card's
          remove badge rides on its remove state: **a key is printed only
          where the press would do it.** In the about panel the card is still
          one press away from a tree, so the words stay; Enter there belongs
          to the modal's focus ring, so the badge goes.

          No arrow beside the words, which is the one piece of the obvious
          shape this refuses. A `→` on a carousel, six pixels from the `‹` and
          `›` that step through it, reads as "next question" — the card would
          gain an affordance and lose the two it had.
        */}
        <span className="carousel-go">
          Explore this question
          {keyToOpen && <span className="kbd">{kbd("open-opening")}</span>}
          {/*
            Decoration to a screen reader, which already has "Explore this
            question" and the key: an arrow read aloud is a character name, not
            a direction.
          */}
          <span className="carousel-go-arrow" aria-hidden="true">
            →
          </span>
        </span>
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
