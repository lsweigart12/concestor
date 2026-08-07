/**
 * A verb in a section's caption row.
 *
 * A ghost button in the caption's own face: the word, and its key when it has
 * one, inside one hairline. It replaced a pair of filled bordered buttons that
 * were the loudest object in a panel whose whole register is quiet, and then a
 * bare word whose key badge sat *beside* it as a second boxed object — two
 * things where the reader was being offered one. Now the badge rides inside
 * the button, past a thin rule, so the whole of what a pointer can press is
 * the one outline the hairline draws.
 *
 * **`clear` sits in the `Taxa` caption**, which is the placement rather than a
 * habit: clearing empties the list the caption is over, so it belongs on that
 * list's own header — and at its far right, which is exactly where each row in
 * the list puts its own remove control. The list-level action lines up with
 * the row-level ones.
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
  keys,
  hint,
  onClick,
  danger,
  disabledBecause,
}: {
  label: string;
  /** The bound key, printed inside the button. Omit for an unbound verb. */
  keys?: string;
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
      {keys !== undefined && (
        <span className="side-act-key" aria-hidden="true">
          {keys}
        </span>
      )}
    </button>
  );
}
