/**
 * Every key this app claims, in one table. The sidebar draws a control for each
 * row, printing `kbd` on it, so a key and its button cannot drift.
 *
 * Bindings hold no modifier: the canvas has no text entry, so bare letters are
 * ours and the browser keeps its chords. {@link matchKey} refuses any press
 * with ctrl, meta or alt held. Shift is a variant of the same action at a
 * different scope (`f`/`⇧F`, `n`/`⇧N`), never a separate binding.
 *
 * `Tab` deliberately has no row: a global binding that `preventDefault`s it
 * would break focus navigation, and scoping it to the canvas would be a
 * keyboard trap. Enter is `surface`-scoped for the same reason — see
 * {@link Scope}.
 */

export type ActionId =
  | "open-opening"
  | "sidebar"
  | "search"
  | "add-taxon"
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
 * Who answers a press. `global` is the app's own handler. `surface` is for a
 * key the browser already spends (today only Enter): it is invisible to
 * {@link matchKey}'s default, so a handler must ask for it by name, and the
 * global handler never `preventDefault`s it.
 */
export type Scope = "global" | "surface";

export interface Binding {
  id: ActionId;
  /** `KeyboardEvent.key`, lower-cased when it is a single character. */
  key: string;
  /** Whether shift must be held. Undefined means "either" — see `/`. */
  shift?: boolean;
  /** Who answers it. Undefined is `global`, which is nearly everything. */
  scope?: Scope;
  /** How the key prints on a button or a palette row. */
  kbd: string;
  /** The word beside it. */
  label: string;
}

/**
 * Order is load-bearing where two rows share a key: the shifted variant is
 * listed first, so `⇧F` cannot be answered by the unshifted `f` row.
 */
export const BINDINGS: readonly Binding[] = [
  {
    // Scoped to `surface` (not global): OpeningCarousel claims Enter only when
    // it would otherwise do nothing, so the opening is not drawn twice.
    id: "open-opening",
    key: "Enter",
    scope: "surface",
    kbd: "Enter",
    label: "Explore this question",
  },
  {
    id: "sidebar",
    key: "s",
    shift: false,
    kbd: "S",
    label: "Sidebar",
  },
  {
    id: "search",
    key: "/",
    kbd: "/",
    label: "Search",
  },
  {
    // The Taxa list's add row: the species search with commands filtered out.
    id: "add-taxon",
    key: "a",
    shift: false,
    kbd: "A",
    label: "Add",
  },
  {
    // One key draws from both corpora — see `RANDOM_FOSSIL_CHANCE`.
    id: "random-species",
    key: "r",
    shift: false,
    kbd: "R",
    label: "Random",
  },
  {
    id: "fit-selection",
    key: "f",
    shift: true,
    kbd: "⇧F",
    label: "Fit here",
  },
  {
    id: "fit",
    key: "f",
    shift: false,
    kbd: "F",
    label: "Fit",
  },
  {
    id: "isolate",
    key: "i",
    shift: false,
    kbd: "I",
    label: "Isolate",
  },
  {
    id: "step-back",
    key: "n",
    shift: true,
    kbd: "⇧N",
    label: "Previous",
  },
  {
    id: "step",
    key: "n",
    shift: false,
    kbd: "N",
    label: "Next",
  },
  {
    id: "biolum",
    key: "b",
    shift: false,
    kbd: "B",
    label: "Bioluminescence",
  },
  {
    id: "axis",
    key: "t",
    shift: false,
    kbd: "T",
    label: "Time scale",
  },
  {
    // Cycles rather than flips: off → scientific → common → off.
    id: "labels",
    key: "l",
    shift: false,
    kbd: "L",
    label: "Labels",
  },
  {
    // Labelled "Dates" but the id, store, URL and gates still say `ages`.
    id: "ages",
    key: "d",
    shift: false,
    kbd: "D",
    label: "Dates",
  },
  {
    // `E`, not `F`: `f` is fit. The label is "Fullscreen" though the key is E.
    id: "fullscreen",
    key: "e",
    shift: false,
    kbd: "E",
    label: "Fullscreen",
  },
  {
    // The one action that asks for confirmation before it runs.
    id: "clear",
    key: "c",
    shift: false,
    kbd: "C",
    label: "Clear",
  },
  {
    id: "remove",
    key: "Backspace",
    kbd: "⌫",
    label: "Remove",
  },
  { id: "remove", key: "Delete", kbd: "⌫", label: "Remove" },
  {
    id: "escape",
    key: "Escape",
    kbd: "esc",
    label: "Back",
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
 * What a press means to `scope`, or null if it means nothing there. A press
 * holding ctrl, meta or alt always means nothing, so browser chords survive.
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
