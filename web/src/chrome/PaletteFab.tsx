/**
 * The one control on a narrow window, bottom right, above the axis.
 *
 * Below 620px the control bar and the canvas-mode panel are both gone and this
 * replaces them. That is a swap rather than a removal, and it only works
 * because of something that was already true: **the palette can do everything
 * they can.** Every button on the bar and every switch on the panel has a
 * command — that is design-reference.md's rule, not a convenience — and the
 * palette's own input searches 2.4 million species as well as the command list,
 * so one press reaches the search, the random pick, clear, share, the axis, the
 * labels, the ages and the light. Nothing on a phone is behind two taps that
 * was behind one on a desktop.
 *
 * What the swap actually buys is the canvas. Nine controls and three switches
 * at 375px are two wrapped rows of chrome at the top and a stack in the corner,
 * over a tree that has about 500px of height to draw itself in — and every one
 * of them is a target sized for a mouse being hit by a thumb. The reader on a
 * phone is also the one reader who cannot fall back to a key, which is the
 * argument for the button existing at all rather than for hiding the bar and
 * stopping there.
 *
 * **One thing is genuinely lost and it is the right one.** `step` has no
 * command, because stepping the selection with no keyboard to step it from is
 * meaningless — `bindings.ts` says so where the key is claimed.
 *
 * Three decisions worth keeping:
 *
 * **Bottom right, on the same shelf as the mode panel.** It rides
 * `--axis-h + --lane-h`, exactly like `.canvas-modes` on the opposite side, so
 * an open drill lane pushes it up rather than swallowing it — which is why this
 * is rendered inside the canvas rather than beside the bar it replaces, because
 * that is where the number lives. Above the timeline and under the thumb.
 *
 * **It wears the app's own mark and nothing else.** The glyph that captions the
 * commands on a wide window *is* the commands here, which is the through-line
 * that makes the two layouts one design. A word inside a 54px circle would be
 * three characters of type nobody needs: the button is the only chrome on
 * screen, so there is nothing it could be confused with.
 *
 * **It carries the invitation, and it carries the words with it.** The pulse
 * after an opening is drawn belongs to the bar's lead group; with the bar gone
 * the moment would simply not happen, and the reader who has just been shown a
 * tree they did not build is exactly the reader who needs telling where their
 * own species go in. Same animation, same rule — it goes out the moment any
 * door is used.
 *
 * The words are the half that was missing. On the bar the outline is drawn
 * around three buttons that already say `S`, `R` and `P`, and the tray under
 * them only has to supply the sentence; here the outline is a ring on an
 * unlabelled circle, which is a light with nothing saying what it is for. So
 * the line comes out the **left** of the button, which is the one side not
 * already spoken for — the tree is drawn above it, the timeline is under it,
 * and the right-hand margin is the edge of the window.
 *
 * **The words being the prop is the point.** `tip` was a boolean and the
 * sentence lived only in the bar's props, so the two surfaces could not
 * disagree about *whether* the invitation was made and could not agree about
 * what it said. One string means the pulse cannot happen without them.
 */

import { binding } from "./bindings";
import { BrandMark } from "./BrandMark";

export function PaletteFab({
  onOpen,
  tip,
}: {
  onOpen: () => void;
  /**
   * The invitation's words, when the bar that would normally carry them is not
   * drawn. Absent is the resting state; present is both the pulse and the line.
   */
  tip?: string;
}) {
  const b = binding("palette");
  return (
    <>
      {/*
        Before the button in the DOM so a screen reader meets the invitation
        and then the door it is about, which is the order the eye takes them
        in. It is a caption and never a target — see the rule's `pointer-events`
        and `.control-tip-tray`, which refuses a press for the same reason.
      */}
      {tip !== undefined && <p className="palette-fab-tip">{tip}</p>}
      <button
        type="button"
        className={`palette-fab${tip !== undefined ? " is-tip" : ""}`}
        onClick={onOpen}
        aria-label={`${b.label} — ${b.hint}`}
        title={b.hint}
      >
        <BrandMark size={24} />
      </button>
    </>
  );
}
