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
  /**
   * Part of the group being pointed at: the reader has just been shown a tree
   * they did not build, and these are the ways to make it theirs.
   *
   * A **run** rather than a set — the marked actions are drawn inside one
   * outline with one line of copy under it, so they have to be adjacent in this
   * list, and {@link Controls} groups whatever contiguous run it finds. That is
   * the shape the invitation actually has: it is one offer with three doors,
   * not three offers, and three separately decorated buttons said the second.
   *
   * Nothing has happened here, so it is not a badge and carries no count. It
   * goes out the moment any of the doors is used, and the caller owns that —
   * see `settle` in `App.tsx`.
   */
  tip?: boolean;
}

export function Controls({
  actions,
  idle,
  busy,
  tip,
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
  /**
   * The line that slides out under the marked group, when there is one.
   *
   * Passed in rather than written here, because the copy belongs to the moment
   * that produced it — an opening has just answered a question — and this bar
   * knows nothing about openings. It draws the tray; `App.tsx` decides there is
   * something to say.
   */
  tip?: React.ReactNode;
}) {
  const draw = (a: ControlAction) => {
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
  };

  // Contiguous runs, so the marked ones can be drawn inside one outline. A
  // disabled control is never in one: the invitation says "you can do this
  // now", and a box around something that cannot be pressed says the opposite.
  const runs: { marked: boolean; items: ControlAction[] }[] = [];
  for (const a of actions) {
    const marked = a.tip === true && a.disabledBecause === undefined;
    const last = runs[runs.length - 1];
    if (last && last.marked === marked) last.items.push(a);
    else runs.push({ marked, items: [a] });
  }

  return (
    <div className={`controls${idle ? " idle" : ""}`}>
      {runs.map((run, i) =>
        run.marked ? (
          <span className="control-tip" key={`tip-${i}`}>
            {run.items.map(draw)}
            {/*
              The tray. Absolutely positioned and so outside the bar's flow —
              a line that pushed the row it hangs from would move the three
              buttons it is pointing at, on the frame it arrived, which is the
              one frame they must not move.
            */}
            {tip !== undefined && <span className="control-tip-tray">{tip}</span>}
          </span>
        ) : (
          run.items.map(draw)
        ),
      )}
      {busy && (
        <PendingLine className="controls-busy mono">resolving…</PendingLine>
      )}
    </div>
  );
}
