/**
 * One row of the canvas-mode panel: a key, a caption, and a switch.
 *
 * There are three of them — labels, ages, bioluminescence — and they are one
 * set rather than three controls that happen to look alike: *things that change
 * how the canvas is drawn rather than what is on it*. That set lives on the
 * bottom edge with the axis, and the actions that change the selection live on
 * the control bar at the top. The split was first written down in
 * `.axis-mode`'s note and the bioluminescence switch is what made it a rule.
 *
 * **They are drawn as one panel, and it took two passes to get there.** Three
 * free-floating chips said the opposite of what the set means: each drew its own
 * border, each was a different width, and the columns inside them began at three
 * different x positions, so the group read as clutter that happened to be
 * stacked. The panel owns the border now and the rows share a grid.
 *
 * The caption then sat in a column of its own, which was the second mistake:
 * that column is as wide as the longest word in the *set*, so `BIOLUMINESCENCE`
 * decided the indent of a row reading `AGES` and two thirds of the panel was
 * dead space. It stacks **above** its own switch instead — a line rather than a
 * column — which leaves two columns to align, key and switch, and makes the
 * panel as wide as its widest switch. `.canvas-modes` in styles.css is the grid;
 * this component supplies the three cells, always in the same order and never
 * conditionally, because a missing cell is what pulls a row out of line.
 *
 * Two things it inherits from the switch it was extracted from, both of which
 * are the reason it is a component and not a `<button>`:
 *
 * **Segments, never a single reversing button.** A one-sided toggle never says
 * whether the word on it is the state or the destination, and a reader who
 * wants the plain instrument back should be able to press *off* rather than
 * work out that the button reverses. It also means the control states where you
 * are and what else there is at the same time, which is what lets it be read
 * without being clicked.
 *
 * **A switch states its position and stops.** The chosen option is raised out
 * of its well and that is the whole of what these say about themselves; nothing
 * here marks a choice as a *departure* from a default. It used to, in the app's
 * accent, and three lit controls at once is what made the panel shout.
 */

import { useTip } from "./Tooltip";

export interface ModeSegment<T> {
  value: T;
  /** What the segment prints. Also what the key badge would have to match. */
  label: string;
  /**
   * The hover explanation. Every segment gets one; none of them is obvious.
   *
   * **A sentence, and the length is the rule rather than a preference.** These
   * were `title` attributes, which cost nothing to fill and so filled with the
   * reasoning that belongs in the header comments above — one of them reached
   * 372 characters, three sentences of naming policy, delivered by an OS
   * tooltip that a reader could not select, scroll or dismiss. The rewrite kept
   * what a reader standing at the switch needs and moved the rest nowhere,
   * because it was already written down here and in `docs/name-ranking.md`.
   *
   * What survives is the answer to one question — *what will pressing this
   * do* — plus, where there is one, the caveat that would otherwise cost
   * somebody their trust in the canvas. "Nothing about the data changes" is the
   * whole of why the bioluminescence copy is two sentences and not one.
   */
  tip: string;
}

export function ModeChip<T extends string | boolean>({
  className,
  name,
  ariaLabel,
  kbd,
  value,
  segments,
  onChange,
}: {
  /**
   * The variant's class, and any state class the variant wants with it.
   *
   * There is no `modified` prop, and there was: every chip took the app's
   * accent when it sat away from its default. Three controls doing that turned
   * the corner of the canvas into the loudest thing on screen, announcing a
   * *setting* on an instrument whose whole design is that the graph is the only
   * light source. Exactly one of the three earns a lit state — see
   * `BiolumToggle` — and it composes its own class here rather than every chip
   * carrying a flag two of them do nothing with.
   */
  className: string;
  /** The word outside the segments, saying what is being switched. */
  name: string;
  ariaLabel: string;
  /** The key badge. Always from `bindings.ts` via `kbd()`, never a literal. */
  kbd?: string;
  value: T;
  segments: readonly ModeSegment<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      className={`mode-chip ${className}`}
      role="group"
      aria-label={ariaLabel}
    >
      {/*
        The word sits outside the switch because the segments' own words rarely
        name anything on their own: "off" and "on" do not, and neither does
        "common". The axis switch is the exception — "linear" and "log" name
        themselves — and it is the one chip that needs no such word.

        Which created the problem this markup fixes. Set like its neighbours,
        "labels" reads as a *fourth option* — `labels · off · scientific ·
        common` is four words in a row and only three of them are pressable, so
        the control appears to be sitting on a setting nobody can name. Two
        things separate them now and both are needed: the caption is small-caps
        mono, the vocabulary this app already uses for a field label (`.mark-meta`
        prints a rank that way), and the options live inside a recessed track
        that draws a real boundary around what can be pressed.
      */}
      <span className="mode-name">{name}</span>
      {/*
        The badge, printed only where the press would do it — the same rule the
        card's remove button follows, and the reason `share` shows none. All
        three of these chips have a key and none invents one: `bindings.ts` is
        the only table that hands letters out and the caller reads its row
        through `kbd()`, so the badge and the handler cannot print different
        things. The span is rendered even when empty, because the panel places
        these on a shared grid and a collapsed cell would slide that row's switch
        out of line with the others.

        It comes *after* the caption in source order, and has to: the caption
        spans both columns, so a badge placed first takes the first cell of the
        first row and pushes the caption down onto a row of its own.
      */}
      <span className="mode-key">{kbd}</span>
      <span className="mode-track">
        {segments.map((s) => (
          <Seg
            key={String(s.value)}
            seg={s}
            on={value === s.value}
            onChange={onChange}
          />
        ))}
      </span>
    </div>
  );
}

/**
 * One segment, extracted for one reason: `useTip` is a hook and the segments
 * are a `map`. The button it renders is the button that was written inline
 * here, attribute for attribute — `useTip` returns handlers and an
 * `aria-describedby`, so nothing about the track's layout can have moved.
 */
function Seg<T extends string | boolean>({
  seg,
  on,
  onChange,
}: {
  seg: ModeSegment<T>;
  on: boolean;
  onChange: (v: T) => void;
}) {
  const tip = useTip(seg.tip);
  return (
    <button
      type="button"
      className={`mode-seg${on ? " is-on" : ""}`}
      aria-pressed={on}
      onClick={() => onChange(seg.value)}
      {...tip}
    >
      {seg.label}
    </button>
  );
}
