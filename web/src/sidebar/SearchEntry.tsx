/**
 * The way in, as a field in the column.
 *
 * ## It was a pill that bulged out over the canvas, and that is gone
 *
 * It used to span the panel and keep going past its right edge, ending in a
 * round cap that was all that remained when the panel shut — one element in two
 * states, with the collapsed diameter falling out of
 * `--search-out − --rail-pad = --search-h`. The arithmetic worked and the
 * transition was the width animating. It read as a bulge: a lozenge poking out
 * of a straight edge is the one shape on this layout that nothing else
 * explains, and it drew the eye to the panel's border rather than to the field.
 *
 * So the field is native to the column now — a normal control at the normal
 * inset, spaced by the same `--side-gap` as everything else — and the collapsed
 * state is a *button in a cluster* rather than the same object narrowed. Two
 * controls where there was one, which is the trade: what makes it honest is
 * that the collapsed pair is drawn by the same component as the three viewport
 * actions in the opposite corner, with the same anatomy and the same badges, so
 * the two clusters read as one family instead of as one clever object and three
 * ordinary ones. `chrome/CanvasChrome.tsx` draws it.
 *
 * ## A button, not an input
 *
 * The obvious mistake is to make this a real `<input>` and route what is typed
 * into the palette. Then there are two search fields on screen the moment it is
 * used, the first keystroke has to be replayed into the second, and the reader
 * watches their word appear somewhere else. Every application that puts a
 * search field in a sidebar over a command palette draws a button that *looks*
 * like a field and opens the real one; the palette already owns focus, the
 * debounce, the abort and the arrow keys, so this is the door and nothing else.
 *
 * The rule the choice actually rests on is the accessibility one: a focusable
 * `<input>` that discards keystrokes and opens a dialog is a lie to anybody
 * using a keyboard or a screen reader. A `<button>` announces itself as a
 * button, and what it opens is a real field.
 *
 * The badge says `/` because that is what `/` does everywhere else on the web —
 * see `bindings.ts`, where it is the one row that needed no argument.
 *
 * ## There is no rotating hint in it, and that is a decision rather than a gap
 *
 * A placeholder that cycles through example queries — *dog… blue whale… T.
 * rex…* — is a tempting answer to the real problem this product has, which is
 * that a curious reader facing a corpus of that size has no species in mind. It
 * was designed, and then refused on three grounds that all point the same way.
 *
 * Placeholder text is already the weakest place to put an instruction: it is
 * transient, so it breaks recognition-over-recall the moment somebody types,
 * and it is routinely read as pre-filled content by readers with cognitive
 * disabilities (NN/g, *Form Design: Placeholders*; Deque, *The Problem With
 * Placeholders*). Rotating it adds auto-playing motion — motion nobody
 * triggered — inside the one control the reader is about to use. And the text
 * sits in the control's accessible description, so it changes while a screen
 * reader is reading it.
 *
 * The decisive argument is that this app already ships the honest version of
 * the same idea. The palette opens on **Recent** over **Start here** — ten
 * curated taxa as ordinary rows, each one press from the canvas, each
 * arrow-key reachable, each gated in Go against the real database by
 * `hits_test.go`. Those are examples a reader can *press*. Putting the same
 * words back into a placeholder would replace a list you can act on with a word
 * that vanishes when you touch the keyboard.
 */

import { kbd } from "../chrome/bindings";
import { SearchGlyph } from "../chrome/CanvasChrome";

export function SearchEntry({
  onOpen,
  tip,
}: {
  onOpen: () => void;
  /**
   * The invitation's words, after an opening has answered its question — and
   * the words rather than a flag.
   *
   * The round palette button two layouts ago made that the rule and it has
   * survived both: a ring pulsing round a control with nothing beside it is a
   * light the reader cannot read. One string means the pulse cannot happen
   * without them.
   */
  tip?: string;
}) {
  return (
    <div className={`side-search${tip === undefined ? "" : " is-tip"}`}>
      <button
        type="button"
        className="side-search-btn"
        onClick={onOpen}
        aria-label="Search species, fossils and commands"
      >
        <SearchGlyph />
        <span className="side-search-words" aria-hidden="true">
          Search
        </span>
        <span className="kbd side-search-kbd" aria-hidden="true">
          {kbd("search")}
        </span>
      </button>
      {/*
        The invitation's words, under the field they point at. A caption and
        never a target — see the rule's `pointer-events`. It is *after* the
        button here, unlike the fixed layer it replaced: in the column the
        reading order and the visual order are the same, so nothing has to be
        reordered for a screen reader.
      */}
      {tip !== undefined && <p className="side-search-tip">{tip}</p>}
    </div>
  );
}
