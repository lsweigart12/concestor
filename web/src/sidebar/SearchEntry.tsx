/**
 * The way in, and the one object in this layout that is in two places at once.
 *
 * ## It is a pill that hangs out over the canvas
 *
 * The field spans the panel and then keeps going, past the panel's right edge,
 * ending in a round cap whose centre sits exactly under the sidebar toggle. The
 * overhang is not decoration: it is what makes the control survive the panel
 * closing. `--sidebar-w` goes to `0px` when the sidebar shuts, the pill's width
 * is computed from it, and what is left standing on the canvas is a 40px circle
 * carrying the same glyph in the same place it already was. One element, two
 * states, and the transition between them is the width animating.
 *
 * That is the whole reason this is drawn in a fixed layer of its own rather
 * than inside the panel's scroll region. A child of the panel goes where the
 * panel goes, and the panel goes away.
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
import { useTip } from "../chrome/Tooltip";

export function SearchEntry({
  onOpen,
  /** The panel is shut, so this is a lone circle on the canvas. */
  collapsed,
  tip,
}: {
  onOpen: () => void;
  collapsed: boolean;
  /**
   * The invitation's words, after an opening has answered its question — and
   * the words rather than a flag.
   *
   * The round palette button this replaced made that the rule and it survives
   * the button: a ring pulsing round a control with nothing beside it is a
   * light the reader cannot read. One string means the pulse cannot happen
   * without them.
   */
  tip?: string;
}) {
  // The hover explanation, which is a different sentence from `tip` above —
  // that one is the invitation and pulses; this one only ever answers "what is
  // this". It is offered only when the panel is shut, because open the pill
  // says "Search" in words and a tooltip repeating it is noise.
  const hover = useTip(
    collapsed
      ? "Search species, fossils and commands — the panel stays shut"
      : undefined,
  );

  return (
    <>
      {/*
        Before the button in the DOM so a screen reader meets the invitation and
        then the door it is about, which is the order the eye takes them in. It
        is a caption and never a target — see the rule's `pointer-events`.
      */}
      {tip !== undefined && <p className="side-search-tip">{tip}</p>}
      <div
        className={`side-search${collapsed ? " is-collapsed" : ""}${
          tip !== undefined ? " is-tip" : ""
        }`}
      >
        <button
          type="button"
          className="side-search-btn"
          onClick={onOpen}
          aria-label="Search species, fossils and commands"
          {...hover}
        >
          <SearchGlyph />
          <span className="side-search-words" aria-hidden="true">
            Search
          </span>
          <span className="kbd side-search-kbd" aria-hidden="true">
            {kbd("search")}
          </span>
        </button>
      </div>
    </>
  );
}

/**
 * The glyph, drawn rather than typed.
 *
 * `⌕` is the honest character and renders at three different weights and two
 * different baselines across the fonts in `--sans`, which on a 40px circle is
 * the difference between a control and a smudge. Twelve lines of SVG is the
 * cheaper answer, and it takes `currentColor` like every other mark here.
 */
function SearchGlyph() {
  return (
    <svg
      className="side-search-glyph"
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <circle cx="7" cy="7" r="4.4" />
        <path d="M10.3 10.3 L14 14" />
      </g>
    </svg>
  );
}
