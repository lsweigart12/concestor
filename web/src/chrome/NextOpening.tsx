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
import { useTip } from "./Tooltip";
import type { Opening } from "../openings";

export function NextOpening({
  opening,
  onOpen,
  onClose,
}: {
  opening: Opening;
  onOpen: (o: Opening) => void;
  onClose: () => void;
}) {
  const dismiss = useTip("Dismiss (esc)");
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
            <Silhouette
              key={t.key}
              phylopicId={t.art}
              size={22}
              tip={t.label}
            />
          ))}
        </span>
        <span className="next-up-q">{opening.question}</span>
        {/*
          The same mark the carousel's card ends on, at the same corner and
          lit by the same rule — the whole card's hover, never its own. This
          is a small echo of that surface and the thing they most need to have
          in common is what the press looks like before you make it.
        */}
        <span className="next-up-arrow" aria-hidden="true">
          →
        </span>
      </button>
      {/*
        Its own control rather than a corner of the card, because the card is one
        big target that draws a tree and a dismiss hidden inside it would be a
        press that does the opposite of what the thing it sits on promises.

        It used to print `esc`. The key still closes this — nothing about the
        binding changed — but a keycap is a *teaching* mark and this corner is
        not where that lesson belongs: it sat at the top of the reading order
        of a card whose whole job is to offer a question, and the first thing
        the reader met was how to refuse. An `×` is the same control read at a
        glance and costs the offer nothing. The key survives in the tooltip,
        for anyone who goes looking.
      */}
      <button
        type="button"
        className="next-up-close"
        onClick={onClose}
        aria-label="Dismiss"
        {...dismiss}
      >
        ×
      </button>
    </aside>
  );
}
