/**
 * Every key this app claims, in one table.
 *
 * Four rules, and the first is the reason the table exists at all.
 *
 * **Nothing here holds a modifier.** The old surface was built on ⌘/Ctrl and
 * every binding on it was a negotiation with something that got there first:
 * ⌘L is the URL bar and cannot be prevented, so the axis toggle had to become
 * ⌘⇧L; ⌘F is find and ⌘R is reload, so the two random picks became ⌘⇧S and
 * ⌘⇧F; ⌘⇧R was refused outright because taking hard-reload from a reader is
 * not a trade this app gets to make. Bare letters end that argument — the
 * canvas has no text entry, so the letter keys are ours, and the browser keeps
 * every chord it started with. {@link matchKey} therefore refuses outright
 * when ctrl, meta or alt is down: a modified press is somebody else's.
 *
 * **Shift is the variant, never a second binding.** `f` frames everything and
 * `⇧F` frames the selection; `n` walks the selection forward and `⇧N` back. A
 * reader who learns one half has guessed the other, and nothing has to be
 * memorised twice.
 *
 * A variant is only earned where the two halves are the same action pointed at
 * different scopes. `⇧R` was here once, drawing a random *fossil* against `r`'s
 * random species, and it was a variant of nothing: the two picks differ in
 * which catalogue the taxon came out of, which is not a thing the reader knows
 * or should have to decide before pressing a key.
 *
 * **A binding is a thing you can also click.** Keyboard operation is first
 * class and no longer exclusive: the control bar draws buttons, with the key
 * printed on the button rather than described in a hint. The two cannot drift,
 * because the button and the handler read the same row.
 *
 * **And a thing you can click is a thing you can search for**, which is the
 * half of that rule the sub-620px layout stands on: down there the bar is not
 * drawn at all and a circular button opens the palette instead, so a control
 * with no command is a control a reader on a phone cannot reach — no key to
 * press, no button on screen, nothing to type. `step` was exactly that for as
 * long as it existed, on `Tab` and then on `N`. `App.test.tsx` walks this table
 * against the rendered palette now, with an exemption list that names each row
 * allowed to be missing and why; the assertion runs one way only, because
 * `share` is the exception in the other direction and has a command with no key.
 *
 * There was a `chrome` field here saying which rows the bar drew and at what
 * prominence, and it is gone rather than updated. It could never be the whole
 * answer — `App.tsx` composes the bar and always did, the bar now holds a
 * control with no row here at all (share, which has no key on purpose), and a
 * flat flag cannot say which of four captioned groups a button belongs in. A
 * field that describes the layout from a distance and is not read by it is a
 * second source of truth with no way to be wrong out loud.
 *
 * **A key the browser already spends is either scoped to the one surface that
 * wants it, or it is not here at all.** Enter is the scoped case: it is in the
 * table for the two things this table is for — the badge on the carousel's card
 * reads from it, and the modifier refusal above applies to it — while
 * {@link Scope} keeps it out of the app's global handler, which would
 * `preventDefault` it and so take keyboard activation off every button in the
 * app.
 *
 * **`Tab` is the other case, and it is why `step` is on `n`.** This table held
 * `Tab`/`⇧Tab` for stepping the selection, globally, and the global handler
 * prevents the default of everything it matches — so the focus ring did not
 * move in this app at all. Every button the bar draws, every segment of the
 * canvas-mode panel and every link on the detail card was unreachable to a
 * reader with a keyboard and no pointer: the app was operable by keyboard only
 * in the sense that its *commands* were, which is not the same claim and was
 * being made in the same breath. It is exactly the Enter failure one level up —
 * Enter would have cost keyboard *activation*, `Tab` cost keyboard
 * *navigation* — and the argument that settled Enter settles this.
 *
 * The fix is absence rather than a scope, because unlike Enter there is no
 * surface in this app that wants `Tab`: scoping it to a focused canvas would
 * mean a reader who tabs *into* the canvas can never tab out, which is a
 * keyboard trap (WCAG 2.1.2) and a worse bug than the one being fixed. A
 * composite widget that legitimately claims `Tab` inward — a grid, a listbox —
 * spends arrows on its contents and leaves `Tab` alone for exactly this reason,
 * so even that route moves stepping off `Tab`. So `Tab` has no row, which makes
 * it structurally invisible to {@link matchKey} and structurally impossible for
 * the global handler to prevent: a row that is not here cannot be matched by a
 * caller that forgets, which is the same guarantee {@link Scope} gives Enter.
 *
 * `n` for next is what a bare-letter surface has instead, and the label follows
 * the letter rather than the other way round — see the `step` row.
 */

import { SPECIES_PHRASE } from "../corpora";

export type ActionId =
  | "open-opening"
  | "palette"
  | "species"
  | "fit"
  | "fit-selection"
  | "isolate"
  | "step"
  | "step-back"
  | "axis"
  | "labels"
  | "ages"
  | "random-species"
  | "biolum"
  | "fullscreen"
  | "clear"
  | "remove"
  | "escape";

/**
 * Who answers a press.
 *
 * `global` is the app's own handler and is what every letter on this canvas
 * wants: the key means one thing wherever the reader is standing.
 *
 * `surface` is for a key the *browser* already spends — today only Enter,
 * which activates whatever the focus ring is on. That key cannot be matched
 * globally, because the global handler `preventDefault`s everything it matches
 * and doing that to Enter takes keyboard activation off every button in the
 * app. The scope is what makes that structural rather than remembered: a
 * surface-scoped row is **invisible** to {@link matchKey}'s default, so a
 * handler has to ask for it by name to get it, and one that forgets simply
 * never sees the press.
 */
export type Scope = "global" | "surface";

export interface Binding {
  id: ActionId;
  /**
   * `KeyboardEvent.key`, lower-cased when it is a single character.
   *
   * Lower-casing is what makes `⇧F` reachable: the browser reports `"F"` for a
   * shifted letter, so a table keyed on the printed character would need both
   * cases of every letter and would still miss a reader with caps lock on.
   */
  key: string;
  /** Whether shift must be held. Undefined means "either" — see `/`. */
  shift?: boolean;
  /** Who answers it. Undefined is `global`, which is nearly everything. */
  scope?: Scope;
  /** How the key prints on a button or a palette row. */
  kbd: string;
  /** The word beside it. */
  label: string;
  /** What it does, for a tooltip. */
  hint: string;
}

/**
 * Order is load-bearing where two rows share a key: the shifted variant is
 * listed first, so `⇧F` cannot be answered by the unshifted `f` row.
 */
export const BINDINGS: readonly Binding[] = [
  {
    // **The one row here that something else on the page may already own**,
    // and so the one row that is not `global` — see {@link Scope}.
    //
    // `OpeningCarousel` claims it, because the carousel is the only thing that
    // knows *which* question is showing, and it takes the press only when the
    // press would otherwise do nothing: a reader who has tabbed to the card
    // and pressed Enter is already getting a click on it, and a second handler
    // firing alongside would draw the opening twice.
    //
    // It earns a row anyway rather than being a bare `e.key === "Enter"` in
    // the component, for the two reasons the table exists: the badge printed
    // on the card reads from here, so a key cannot print one thing and do
    // another; and the refusal of a modified press stays in the matcher, where
    // ⌘Enter is somebody else's whoever is asking.
    id: "open-opening",
    key: "Enter",
    scope: "surface",
    kbd: "Enter",
    label: "Explore this question",
    hint: "Draw the question the empty canvas is showing",
  },
  {
    id: "palette",
    key: "p",
    shift: false,
    kbd: "P",
    label: "Commands",
    hint: "Everything this app can do, in one searchable list",
  },
  {
    id: "species",
    key: "s",
    shift: false,
    kbd: "S",
    label: "Species",
    hint:
      `Search ${SPECIES_PHRASE}, in the tree and in the fossil record. ` +
      "Also reachable from the palette by typing s then space",
  },
  {
    // No `⇧R` beside it any more, and the missing variant is the point rather
    // than an omission. `⇧R` used to draw a random *fossil*, which stated in
    // the key surface a split the product does not have: a fossil is a species
    // too, and the only difference is whether the tree happens to contain it.
    // One key now draws from both — see `RANDOM_FOSSIL_CHANCE` — so the reader
    // is never asked to choose a corpus before they know what is in either.
    id: "random-species",
    key: "r",
    shift: false,
    kbd: "R",
    label: "Random",
    hint:
      "Add a random illustrated species — the way in that needs no name in mind. " +
      "About one in five comes from the fossil record, pinned to its branch",
  },
  {
    id: "fit-selection",
    key: "f",
    shift: true,
    kbd: "⇧F",
    label: "Fit here",
    hint: "Frame the selected node",
  },
  {
    id: "fit",
    key: "f",
    shift: false,
    kbd: "F",
    label: "Fit",
    hint: "Frame the whole tree",
  },
  {
    // Unshifted on a US layout and shifted on several others, so this one row
    // answers both. Nothing else claims `/`, so there is no variant to lose.
    id: "isolate",
    key: "/",
    kbd: "/",
    label: "Isolate",
    hint: "Dim every lineage except the path to the selected node",
  },
  {
    id: "step-back",
    key: "n",
    shift: true,
    kbd: "⇧N",
    label: "Previous",
    hint: "Move the selection to the previous species",
  },
  {
    // **`N` over the word Next, and both halves of that moved together.** This
    // was `Tab`, which the header explains at length; what it cost here is the
    // word. "Step" named the action exactly and has no free letter left in it —
    // `s` is species, `t` the time scale, `e` fullscreen, `p` the palette — so
    // the choice was a third badge that prints one word and does another, or a
    // word that starts with a free letter.
    //
    // The word moved, and the rule it moved under is the one `fullscreen`
    // states from the other side: a badge teaches the key and a label teaches
    // the action. There the letter could not match the right word and the label
    // won; here a right word *does* start with a free letter, so nothing has to
    // disagree at all. `bindings.test.ts` pins that this row did not become the
    // third exception — two is the whole list and a third should have to be
    // argued for.
    //
    // "Next" is also the better word on its own merits, which is what makes
    // this a repair rather than a concession. "Step" names the gesture; a
    // reader scanning the Navigate group beside `fit` and `isolate` wants to
    // know what they get, and what they get is the next species along.
    id: "step",
    key: "n",
    shift: false,
    kbd: "N",
    label: "Next",
    hint: "Move the selection to the next species",
  },
  {
    // No button on the control bar, and that is placement rather than
    // demotion. This is one of four rows whose control lives on the *bottom*
    // edge — the axis scale, the labels, the ages and the light — because all
    // four answer questions about the **canvas** rather than about the
    // selection, and the control bar at the top is the things you do to a tree.
    // So their job in this table is to own the letter and to print it on the
    // chip: a key that appears nowhere is a key nobody learns, which is the
    // whole argument for the badge.
    id: "biolum",
    key: "b",
    shift: false,
    kbd: "B",
    label: "Bioluminescence",
    hint: "Light the canvas like the deep sea. Nothing about the data changes — the dashes, the tiers and every figure are the same in both states",
  },
  {
    // `t` for time, and it was `l` for log until the labels wanted a letter.
    // Moving it is the better trade in both directions: `l` names the thing it
    // now switches, where it only ever named one of the two scales it used to,
    // and a reader who half-remembers `l` finds a control on the same edge of
    // the canvas rather than nothing at all.
    id: "axis",
    key: "t",
    shift: false,
    kbd: "T",
    label: "Time scale",
    hint: "Switch between a logarithmic and a linear time axis",
  },
  {
    // Three states on one key, so this cycles where every other toggle here
    // flips: off → scientific → common → off. The cycle passes through the
    // default on its way round, so a reader who overshoots is one press from
    // home, and the chip beside the axis shows where they are at every step —
    // which is what makes a three-state key legible at all.
    id: "labels",
    key: "l",
    shift: false,
    kbd: "L",
    label: "Labels",
    hint: "Cycle the words on the canvas: off, scientific names, common names",
  },
  {
    id: "ages",
    key: "a",
    shift: false,
    kbd: "A",
    label: "Ages",
    hint: "Show or hide the age on every mark. The axis still says when",
  },
  {
    // **`E` over the word Fullscreen**, which is the second row here whose
    // label is not the word its letter came from — `P` has printed
    // **Commands** since this bar was built, because `p` names the palette and
    // the word names what opening one is *for*.
    //
    // The letter is forced. `f` is spent on fit, with `⇧F` on fit-selection,
    // and neither may move: the precedent that looks like it licenses a swap
    // is the axis giving `l` up to the labels, and it does not reach here,
    // because that trade went to the word the letter described and `f` names
    // *fit* exactly. Taking it would swap one word starting with the letter
    // for another and cost a reader the most-pressed key on this canvas.
    // Printing `F` here anyway is refused hardest of all — the whole reason the
    // bar reads its badges out of this table is that a key cannot print one
    // thing and do another. So `e` is the nearest free mnemonic: expand,
    // enlarge, enter.
    //
    // The word is not forced, and **Expand** was tried first for the symmetry.
    // It is the wrong word twice over: it names the gesture rather than the
    // result, and this canvas already *has* things you expand — a drill lane
    // opens, isolate narrows — so a reader scanning the bar for more room can
    // fairly read it as being about a clade. A badge teaches the key; a label
    // teaches the action. Where the two cannot be the same word the label
    // wins, because a reader who cannot find the control never gets as far as
    // learning its letter. `bindings.test.ts` pins the pair, and pins that
    // these two rows are the only ones allowed to disagree.
    id: "fullscreen",
    key: "e",
    shift: false,
    kbd: "E",
    label: "Fullscreen",
    hint: "Fill the screen with the canvas — a wide tree gets the browser's chrome back as time axis. Press again to leave, or Escape",
  },
  {
    // On the bar beside share rather than among the rest, because both are
    // one-way: this one can destroy an hour of work and is the only action in
    // the app that asks first. It is also the one binding whose loss on a phone
    // would be felt — the reader there cannot fall back to a key — which is
    // what the palette behind `PaletteFab` is for, and why every button here
    // has a command as well as a letter.
    id: "clear",
    key: "c",
    shift: false,
    kbd: "C",
    label: "Clear",
    hint: "Take everything off the canvas",
  },
  {
    id: "remove",
    key: "Backspace",
    kbd: "⌫",
    label: "Remove",
    hint: "Take the selected species off the canvas",
  },
  { id: "remove", key: "Delete", kbd: "⌫", label: "Remove", hint: "" },
  {
    id: "escape",
    key: "Escape",
    kbd: "esc",
    label: "Back",
    hint: "Close what is open, innermost first",
  },
];

/** Just enough of a `KeyboardEvent` to decide, so this stays testable. */
export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * What a press means to `scope`, or null if it means nothing there.
 *
 * A modified press always means nothing here. That refusal is the whole point
 * of the surface — ⌘R must reload, ⌘L must reach the URL bar, ⌘F must open
 * find — and it has to live in the matcher rather than in the caller, because
 * a caller that forgets is a caller that silently steals a browser command.
 *
 * The scope defaults to `global` so the app's own handler cannot pick up a key
 * a surface claimed just by not knowing about it. Read {@link Scope} before
 * adding the second `surface` row.
 */
export function matchKey(e: KeyLike, scope: Scope = "global"): ActionId | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (const b of BINDINGS) {
    if (b.key !== k) continue;
    if ((b.scope ?? "global") !== scope) continue;
    if (b.shift !== undefined && b.shift !== e.shiftKey) continue;
    return b.id;
  }
  return null;
}

/** The row for an action, for printing its key somewhere. */
export function binding(id: ActionId): Binding {
  const b = BINDINGS.find((x) => x.id === id);
  // Every id in the union has a row; the cast-free lookup is worth the throw.
  if (!b) throw new Error(`no binding for ${id}`);
  return b;
}

/** How an action's key prints. */
export function kbd(id: ActionId): string {
  return binding(id).kbd;
}
