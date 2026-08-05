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
 * **The buttons are grouped now, and each group wears a `ModeChip`'s anatomy:**
 * a small-caps mono caption over a recessed track holding the pressable things.
 * That is the same argument the canvas-mode panel made when three free-floating
 * chips became one panel — a reader has to be able to see where the pressable
 * thing starts *without reading any of the words in it*, and eight bare buttons
 * on a row of scrim gave them nothing to see. It also lets a word be spent
 * once: `S` and `R` used to print "Species" and "Random", which named the
 * corpus twice and the verb never; under a `SPECIES` caption they are **add**
 * and **random**, which is what they do.
 *
 * Three slots, and the split is by what the group is *for*. `lead` builds the
 * tree and holds the row's weight at the top left; `trail` acts on the canvas
 * as a whole — the two that are one-way, clear and share — and sits opposite
 * it; `rest` is how you look at what you have built and takes the second row,
 * because framing and stepping are what you reach for *after* there is
 * something to frame.
 *
 * Unavailable actions are **disabled rather than hidden**. A bar that
 * reshuffles as the selection changes forces a reader to re-find the button
 * they were reaching for, and a greyed button with a reason in its tooltip
 * says more than an absent one.
 *
 * **None of this exists below 620px.** The bar and the canvas-mode panel are
 * both gone there and one round button replaces them — see {@link PaletteFab},
 * which is where that trade is argued out.
 */

import { binding, type ActionId } from "./bindings";
import { BrandMark } from "./BrandMark";
import { PendingLine } from "./Pending";
import { useTip } from "./Tooltip";

/**
 * What a control can be pointed at, which is a key's action or `share`.
 *
 * Share is the one button on this bar with no row in `bindings.ts`, and it has
 * to stay that way: that table is *every key this app claims*, share has no key
 * on purpose — `s` and `l` are the two most-used letters here — and a keyless
 * row in a key table is a lie about what the table is. So it carries its own
 * words instead, and the union below is what makes carrying them mandatory
 * rather than remembered.
 */
export type ControlId = ActionId | "share";

interface Common {
  run: () => void;
  /** Set when the action cannot do anything right now, and why. */
  disabledBecause?: string;
  /** True while the action's effect is the current state. */
  active?: boolean;
  /**
   * Part of the group being pointed at: the reader has just been shown a tree
   * they did not build, and these are the ways to make it theirs.
   *
   * Marked per *action*, read per **group** — {@link Controls} outlines a
   * contiguous run of groups whose every action carries it, so the mark has to
   * cover a whole group to draw anything. That is the shape the invitation
   * actually has: it is one offer with three doors, not three offers, and three
   * separately decorated buttons said the second.
   *
   * Nothing has happened here, so it is not a badge and carries no count. It
   * goes out the moment any of the doors is used, and the caller owns that —
   * see `settle` in `App.tsx`.
   */
  tip?: boolean;
}

export type ControlAction = Common &
  (
    | {
        id: ActionId;
        /** Overrides the binding's own label — under a caption, a verb. */
        label?: string;
        /** Overrides the binding's own tooltip. */
        hint?: string;
      }
    | { id: "share"; label: string; hint: string }
  );

/** Where a group sits. See the note at the head of this file. */
export type ControlSlot = "lead" | "trail" | "rest";

export interface ControlGroup {
  /**
   * The caption over the track, in the vocabulary this app already uses for a
   * field label: small-caps mono, the way `.mark-meta` prints a rank.
   */
  name: string;
  slot: ControlSlot;
  /**
   * Draws the app's mark before the caption. The lead group only — it is the
   * wordmark, not a decoration, and a second one would make it neither.
   */
  brand?: boolean;
  actions: ControlAction[];
}

export function Controls({
  groups,
  idle,
  busy,
  tip,
}: {
  groups: ControlGroup[];
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
   * The line that slides out under the marked groups, when there is one.
   *
   * Passed in rather than written here, because the copy belongs to the moment
   * that produced it — an opening has just answered a question — and this bar
   * knows nothing about openings. It draws the tray; `App.tsx` decides there is
   * something to say.
   */
  tip?: React.ReactNode;
}) {
  const drawGroup = (g: ControlGroup) => (
    <div className="control-group" key={g.name} role="group" aria-label={g.name}>
      <span className="control-name">
        {g.brand === true && <BrandMark />}
        {g.name}
      </span>
      <span className="control-track">
        {g.actions.map((a) => (
          <Control key={a.id} a={a} />
        ))}
      </span>
    </div>
  );

  const inSlot = (s: ControlSlot) => groups.filter((g) => g.slot === s);

  // Contiguous runs of *groups*, so the marked ones are drawn inside one
  // outline. A group with a disabled action is never in one: the invitation
  // says "you can do this now", and a box around something that cannot be
  // pressed says the opposite.
  const runs: { marked: boolean; groups: ControlGroup[] }[] = [];
  for (const g of inSlot("lead")) {
    const marked =
      g.actions.length > 0 &&
      g.actions.every((a) => a.tip === true && a.disabledBecause === undefined);
    const last = runs[runs.length - 1];
    if (last && last.marked === marked) last.groups.push(g);
    else runs.push({ marked, groups: [g] });
  }

  return (
    /*
      A `header`, which is to say the page's banner, and it is the second of the
      two landmarks this app has.

      Not `nav`: half of what is in here does not navigate — clear, share and
      fullscreen act on the canvas, and one of them is destructive — and a
      landmark that promises links to elsewhere and delivers a destructive
      button is worse than none. Not `toolbar` either, which is a keyboard
      contract — one tab stop for the whole bar, arrows between the buttons —
      that this bar does not keep. It could now: `Tab` used to be spent on
      stepping the selection and reached nothing here at all, and since it moved
      to `n` every button in here is a tab stop of its own. Which is exactly why
      the role stays off. A reader tabs through nine controls across two rows and
      lands on each one, and the role would promise them a shortcut past it that
      is not implemented — a lie about the keyboard is what this landmark was
      chosen to avoid in the first place.

      What it *is* is the strip along the top edge carrying the app's mark and
      every global command, which is what a banner is. The groups inside keep
      their own `role="group"` labels, so the landmark list reads Concestor, Add
      species, Canvas, Navigate — the same four captions a reader can see.
    */
    <header className={`controls${idle ? " idle" : ""}`}>
      <div className="controls-lead">
        {runs.map((run, i) =>
          run.marked ? (
            <span className="control-tip" key={`tip-${i}`}>
              {run.groups.map(drawGroup)}
              {/*
                The tray, which comes out of this outline's right-hand edge.
                Absolutely positioned and so outside the bar's flow — a line
                that pushed the row it hangs from would move the buttons it is
                pointing at, on the frame it arrived, which is the one frame
                they must not move. It is inside the outline because that is
                what it is positioned against; the rule says why sideways is
                what let it come back here.
              */}
              {tip !== undefined && <span className="control-tip-tray">{tip}</span>}
            </span>
          ) : (
            run.groups.map(drawGroup)
          ),
        )}
      </div>
      <div className="controls-trail">{inSlot("trail").map(drawGroup)}</div>
      <div className="controls-rest">
        {inSlot("rest").map(drawGroup)}
        {busy && (
          <PendingLine className="controls-busy mono">resolving…</PendingLine>
        )}
      </div>
    </header>
  );
}

/**
 * One button on the bar.
 *
 * A component rather than the local `draw` it was, because `useTip` is a hook
 * and that was a function called from a `map`. The markup is unchanged bar one
 * attribute, and that one is the interesting part.
 *
 * **`aria-disabled` rather than `disabled`, so the reason survives.** A
 * `disabled` button fires no pointer events in any browser — that is what the
 * attribute means — and it is not focusable either. Under a `title` attribute
 * that did not matter, because the platform draws a native tooltip for a
 * disabled control anyway; under any tooltip the page draws itself, the
 * explanation is unreachable by pointer *and* by keyboard. Which loses exactly
 * the tooltip worth having: `App.tsx` writes five of these, and every one is
 * the sentence saying what would make the button work — "Select a node first",
 * "Add a species and this steps through the selection".
 *
 * So the control stays a real, focusable button that announces itself as
 * disabled and does nothing when pressed. That is the WAI-ARIA pattern for a
 * control whose unavailability needs explaining, and here it is the whole
 * reason the state exists. The stylesheet follows: `.control:disabled` is now
 * `.control[aria-disabled="true"]`, in all four places.
 */
function Control({ a }: { a: ControlAction }) {
  // The one control with no row in the key table carries its own words. The
  // type above is what guarantees it has them, so there is nothing to throw.
  const b = a.id === "share" ? null : binding(a.id);
  const off = a.disabledBecause !== undefined;
  const kbd = b?.kbd;
  const tip = useTip(off ? a.disabledBecause : (a.hint ?? b?.hint));
  return (
    <button
      type="button"
      // The keyless button carries no marker class any more. It existed for
      // one rule — the 720px block that hid every label and then had to put
      // share's back — and that rule is gone, so the class was a fact about
      // a button nothing reads. What guarantees share has words is the type,
      // which is where it always belonged. `Controls.test.ts` asserts both
      // halves of that, because a stylesheet is where this comes back.
      // `is-command` on the palette button alone, and unlike the keyless
      // marker above it this one has readers: `styles.css` glows its border,
      // and `canvas/bootLight.ts` measures it as a light source in
      // bioluminescent mode. `.controls-lead .control` cannot stand in for
      // it — the lead slot is three buttons, `P`, `S` and `R`.
      className={`control${a.active ? " on" : ""}${a.id === "palette" ? " is-command" : ""}`}
      aria-disabled={off || undefined}
      onClick={off ? undefined : a.run}
      {...tip}
    >
      {/* Printed only where the press would do it, which is the rule the
          whole key surface follows — share shows none because it has none,
          and inventing one here would be the table disagreeing with itself
          in the one place a reader can see both. */}
      {kbd !== undefined && <span className="kbd">{kbd}</span>}
      <span className="control-label">{a.label ?? b?.label}</span>
    </button>
  );
}
