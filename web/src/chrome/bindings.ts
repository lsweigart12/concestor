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
 * `⇧F` frames the selection; `Tab` steps forward and `⇧Tab` back. A reader who
 * learns one half has guessed the other, and nothing has to be memorised twice.
 *
 * A variant is only earned where the two halves are the same action pointed at
 * different scopes. `⇧R` was here once, drawing a random *fossil* against `r`'s
 * random species, and it was a variant of nothing: the two picks differ in
 * which catalogue the taxon came out of, which is not a thing the reader knows
 * or should have to decide before pressing a key.
 *
 * **A binding is a thing you can also click.** Keyboard operation is first
 * class and no longer exclusive: `chrome` marks the ones the control bar draws
 * as buttons, with the key printed on the button rather than described in a
 * hint. The two cannot drift, because the button and the handler read the same
 * row.
 *
 * **A key the browser already spends is scoped to the one surface that wants
 * it.** Enter is the only such row so far, and it is here for the two things
 * this table is for — the badge on the carousel's card reads from it, and the
 * modifier refusal above applies to it — while {@link Scope} keeps it out of
 * the app's global handler, which would `preventDefault` it and so take
 * keyboard activation off every button in the app.
 */

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
  /** Drawn in the control bar, and at what prominence. */
  chrome?: "primary" | "secondary";
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
    chrome: "primary",
  },
  {
    id: "species",
    key: "s",
    shift: false,
    kbd: "S",
    label: "Species",
    hint:
      "Search 2.7 million species, in the tree and in the fossil record. " +
      "Also reachable from the palette by typing s then space",
    chrome: "primary",
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
    chrome: "primary",
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
    chrome: "primary",
  },
  {
    // Unshifted on a US layout and shifted on several others, so this one row
    // answers both. Nothing else claims `/`, so there is no variant to lose.
    id: "isolate",
    key: "/",
    kbd: "/",
    label: "Isolate",
    hint: "Dim every lineage except the path to the selected node",
    chrome: "primary",
  },
  {
    id: "step-back",
    key: "Tab",
    shift: true,
    kbd: "⇧Tab",
    label: "Step back",
    hint: "Move the selection to the previous species",
  },
  {
    id: "step",
    key: "Tab",
    shift: false,
    kbd: "Tab",
    label: "Step",
    hint: "Move the selection to the next species",
    chrome: "secondary",
  },
  {
    // No `chrome` entry, and that is placement rather than demotion. This is
    // one of four rows whose control lives on the *bottom* edge — the axis
    // scale, the labels, the ages and the light — because all four answer
    // questions about the **canvas** rather than about the selection, and the
    // control bar at the top is the things you do to a tree. So their job in
    // this table is to own the letter and to print it on the chip: a key that
    // appears nowhere is a key nobody learns, which is the whole argument for
    // the badge.
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
    // Primary, and the reason is the narrow layout rather than the wide one:
    // `secondary` means "drop me below 620px", and the reader on a phone is the
    // one who cannot fall back to a key. Stepping is meaningless without a
    // keyboard and framing is recoverable; starting over is neither.
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
