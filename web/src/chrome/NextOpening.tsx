/**
 * The next question, offered once one has been answered.
 *
 * An opening ends with a tree the reader did not build and a sentence telling
 * them what it shows. Until now that was the whole of it: the animation
 * stopped, the toast expired, and the one surface that offered another way in —
 * the carousel — is on the empty canvas, which is the one place they can no
 * longer be. So the conversion moment was spent on nothing.
 *
 * This is the *second* of the two things offered there, and the two are
 * deliberately different requests. The pulsing controls ask them to put
 * something of their own beside it, which is the thing this app is for. This
 * asks for one more press of ours, which is the cheaper answer and so is
 * offered second, smaller, and in the corner rather than under their eyes.
 *
 * **It carries the silhouettes and the question, and not the reveal.** Same
 * reasoning as the carousel it is a small echo of: the pictures say what is
 * about to be drawn without a word, and the answer is the thing the reader is
 * pressing to find out. A card down here holding two lines of prose would be a
 * banner.
 *
 * It appears only once the pinned answer has been dismissed, so the reader is
 * never asked what to do next while still reading what just happened.
 */

import { Silhouette } from "../canvas/Silhouette";
import type { Opening } from "../openings";
import { kbd } from "./bindings";

export function NextOpening({
  opening,
  onOpen,
  onClose,
}: {
  opening: Opening;
  onOpen: (o: Opening) => void;
  onClose: () => void;
}) {
  return (
    <aside className="next-up" aria-label="Another question">
      <button
        type="button"
        className="next-up-card"
        onClick={() => onOpen(opening)}
      >
        <span className="next-up-eyebrow">Next</span>
        <span className="next-up-art" aria-hidden="true">
          {opening.taxa.map((t) => (
            <Silhouette key={t.key} phylopicId={t.art} size={22} title={t.label} />
          ))}
        </span>
        <span className="next-up-q">{opening.question}</span>
      </button>
      {/*
        Its own control rather than a corner of the card, because the card is one
        big target that draws a tree and a dismiss hidden inside it would be a
        press that does the opposite of what the thing it sits on promises. The
        badge is the same key the pinned answer above it took, so one letter
        closes both in the order they arrived.
      */}
      <button
        type="button"
        className="next-up-close"
        onClick={onClose}
        aria-label="Dismiss"
        title="Dismiss"
      >
        <span className="kbd">{kbd("escape")}</span>
      </button>
    </aside>
  );
}
