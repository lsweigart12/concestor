/**
 * A verb in a section's caption row.
 *
 * A word in the caption's own face and nothing else — no box, no glyph, no
 * badge. The two of these replaced a pair of bordered buttons that were the
 * loudest object in a panel whose whole register is quiet, spent on the two
 * actions a reader reaches for least. `SourceLinks` at the foot of the panel
 * has read this way from the beginning and has never needed more.
 *
 * **`clear` sits in the `Taxa` caption and `share` in `This tree`**, which is
 * the placement rather than a symmetry: clearing empties the list the caption
 * is over, so it belongs beside that list's own count — and at the far right of
 * the header, which is exactly where each row in the list puts its own remove
 * control. The list-level action lines up with the row-level ones.
 *
 * **No key badge, and the key did not go with it.** `C` is still bound, still
 * printed on the palette's own row, and named in the tooltip here. That is the
 * right place for it: clear is the one action in this app that asks before it
 * acts, so it is nobody's mid-flow keystroke, and a small box beside a word
 * that is deliberately not a box would be the only thing in the row breaking
 * its own register.
 *
 * `aria-disabled` rather than `disabled`, which is the rule the whole app keeps:
 * a `disabled` button fires no pointer events, so the tooltip explaining *why*
 * it is off is unreachable by pointer and by keyboard both — and the only
 * tooltip worth having on a disabled control is the sentence saying what would
 * make it work.
 *
 * Focus is an **underline** and not a colour, because the resting and hovered
 * states are already the only two colours this row has and a third would have
 * to be told apart from them at 9.5px.
 */

import { useTip } from "../chrome/Tooltip";

export function HeaderAction({
  label,
  hint,
  onClick,
  danger,
  disabledBecause,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  danger?: boolean;
  disabledBecause?: string;
}) {
  const off = disabledBecause !== undefined;
  const tip = useTip(off ? disabledBecause : hint);
  return (
    <button
      type="button"
      className={`side-act${danger === true ? " is-danger" : ""}`}
      aria-disabled={off || undefined}
      onClick={off ? undefined : onClick}
      {...tip}
    >
      {label}
    </button>
  );
}
