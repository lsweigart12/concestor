/**
 * Every key this app claims, in one table.
 *
 * Three rules, and the first is the reason the table exists at all.
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
 * **Shift is the variant, never a second binding.** `r` adds a species and `⇧R`
 * draws a fossil; `f` frames everything and `⇧F` frames the selection; `Tab`
 * steps forward and `⇧Tab` back. A reader who learns one half has guessed the
 * other, and nothing has to be memorised twice.
 *
 * **A binding is a thing you can also click.** Keyboard operation is first
 * class and no longer exclusive: `chrome` marks the ones the control bar draws
 * as buttons, with the key printed on the button rather than described in a
 * hint. The two cannot drift, because the button and the handler read the same
 * row.
 */

export type ActionId =
  | "palette"
  | "species"
  | "fit"
  | "fit-selection"
  | "isolate"
  | "step"
  | "step-back"
  | "axis"
  | "random-species"
  | "random-fossil"
  | "clear"
  | "remove"
  | "escape";

export interface Binding {
  id: ActionId;
  /**
   * `KeyboardEvent.key`, lower-cased when it is a single character.
   *
   * Lower-casing is what makes `⇧R` reachable: the browser reports `"R"` for a
   * shifted letter, so a table keyed on the printed character would need both
   * cases of every letter and would still miss a reader with caps lock on.
   */
  key: string;
  /** Whether shift must be held. Undefined means "either" — see `/`. */
  shift?: boolean;
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
 * listed first, so `⇧R` cannot be answered by the unshifted `r` row.
 */
export const BINDINGS: readonly Binding[] = [
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
    hint: "Search 2.4 million species. Also reachable from the palette by typing s then space",
    chrome: "primary",
  },
  {
    id: "random-fossil",
    key: "r",
    shift: true,
    kbd: "⇧R",
    label: "Fossil",
    hint: "Draw a random illustrated fossil at its own date",
    chrome: "secondary",
  },
  {
    id: "random-species",
    key: "r",
    shift: false,
    kbd: "R",
    label: "Random",
    hint: "Add a random illustrated species — the way in that needs no name in mind",
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
    id: "axis",
    key: "l",
    shift: false,
    kbd: "L",
    label: "Time scale",
    hint: "Switch between a logarithmic and a linear time axis",
  },
  {
    // Primary, and the reason is the narrow layout rather than the wide one:
    // `secondary` means "drop me below 620px", and the reader on a phone is the
    // one who cannot fall back to a key. Stepping is meaningless without a
    // keyboard and a random fossil is a flourish; starting over is neither.
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
 * What a press means, or null if it means nothing here.
 *
 * A modified press always means nothing here. That refusal is the whole point
 * of the surface — ⌘R must reload, ⌘L must reach the URL bar, ⌘F must open
 * find — and it has to live in the matcher rather than in the caller, because
 * a caller that forgets is a caller that silently steals a browser command.
 */
export function matchKey(e: KeyLike): ActionId | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (const b of BINDINGS) {
    if (b.key !== k) continue;
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
