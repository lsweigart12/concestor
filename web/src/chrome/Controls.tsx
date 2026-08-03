/**
 * The control bar, on the top edge.
 *
 * It replaces a hint bar that advertised four chords and could not be clicked.
 * Keyboard operation is still first class — design-reference.md's "every action
 * has a command, the mouse is a convenience path" is unchanged — but *first
 * class* and *exclusive* are different claims, and the app was making the
 * second one. A reader who has not yet learned the keys had nothing to press.
 *
 * The key stays the loudest thing on each button, which is the point of the
 * arrangement rather than a stylistic choice: the button is how you do it
 * today and the key is how you will do it in a minute, so the badge leads and
 * the word explains it. Clicking a button and pressing its key run the same
 * callback, and both come from the same row of {@link BINDINGS}.
 *
 * Unavailable actions are **disabled rather than hidden**. A bar that
 * reshuffles as the selection changes forces a reader to re-find the button
 * they were reaching for, and a greyed button with a reason in its tooltip
 * says more than an absent one.
 */

import { binding, type ActionId } from "./bindings";
import { PendingLine } from "./Pending";

export interface ControlAction {
  id: ActionId;
  run: () => void;
  /** Set when the action cannot do anything right now, and why. */
  disabledBecause?: string;
  /** Overrides the binding's own label — the axis toggle names its state. */
  label?: string;
  /** True while the action's effect is the current state. */
  active?: boolean;
}

export function Controls({
  actions,
  idle,
  busy,
}: {
  actions: ControlAction[];
  /** Chrome auto-hides; the canvas is the page. */
  idle: boolean;
  /**
   * Something is in flight and has been long enough to be worth saying.
   *
   * The caller decides what counts and applies the delay — see
   * `chrome/Pending.tsx`. This bar is the last resort for a wait with nowhere
   * better to show itself, never a second copy of one that has a home.
   */
  busy: boolean;
}) {
  return (
    <div className={`controls${idle ? " idle" : ""}`}>
      {actions.map((a) => {
        const b = binding(a.id);
        const off = a.disabledBecause !== undefined;
        return (
          <button
            key={a.id}
            type="button"
            className={`control${b.chrome === "secondary" ? " secondary" : ""}${a.active ? " on" : ""}`}
            disabled={off}
            title={off ? a.disabledBecause : b.hint}
            onClick={a.run}
          >
            <span className="kbd">{b.kbd}</span>
            <span className="control-label">{a.label ?? b.label}</span>
          </button>
        );
      })}
      {busy && (
        <PendingLine className="controls-busy mono">resolving…</PendingLine>
      )}
    </div>
  );
}
