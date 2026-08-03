/**
 * The one control on a narrow window, bottom right, above the axis.
 *
 * Below 620px the control bar and the canvas-mode panel are both gone and this
 * replaces them. That is a swap rather than a removal, and it only works
 * because of something that was already true: **the palette can do everything
 * they can.** Every button on the bar and every switch on the panel has a
 * command — that is design-reference.md's rule, not a convenience — and the
 * palette's own input searches 2.7 million species as well as the command list,
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
 * **It can carry the invitation.** The pulse after an opening is drawn belongs
 * to the bar's lead group; with the bar gone the moment would simply not
 * happen, and the reader who has just been shown a tree they did not build is
 * exactly the reader who needs telling where their own species go in. Same
 * animation, same rule — it goes out the moment any door is used.
 */

import { binding } from "./bindings";
import { BrandMark } from "./BrandMark";

export function PaletteFab({
  onOpen,
  tip,
}: {
  onOpen: () => void;
  /** The invitation, when the bar that would normally carry it is not drawn. */
  tip?: boolean;
}) {
  const b = binding("palette");
  return (
    <button
      type="button"
      className={`palette-fab${tip === true ? " is-tip" : ""}`}
      onClick={onOpen}
      aria-label={`${b.label} — ${b.hint}`}
      title={b.hint}
    >
      <BrandMark size={24} />
    </button>
  );
}
