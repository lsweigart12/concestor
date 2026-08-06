/**
 * The only two things drawn on the canvas that are not the tree.
 *
 * ## Top left: the panel's own switch
 *
 * It rides the *canvas* rather than the panel, at `--sidebar-w` plus a margin,
 * which is the structural point rather than a placement detail: a toggle inside
 * the thing it hides has to be duplicated or animated out, and every shipped
 * sidebar that gets this right — tldraw's, Linear's — puts it on the layout.
 * Here it slides sideways as the panel is dragged and stays exactly where the
 * hand left it when the panel goes.
 *
 * It is the ARIA **disclosure** pattern and nothing more elaborate: a button
 * with `aria-expanded` and `aria-controls`. Focus deliberately does **not**
 * move into the panel when it opens — the pattern does not ask for it, and for
 * a panel that stays open across a whole session a second press has to be able
 * to close what the first press opened without hunting for the button again.
 *
 * ## Top right: the three that are about looking
 *
 * Fit, isolate and fullscreen. What they have in common is the argument for the
 * cluster existing at all: none of them changes the tree, they change *your
 * view of it*, and a control that acts on the viewport belongs on the viewport
 * rather than in a list of the tree's contents. Everything else that used to be
 * on the control bar is in the panel, where it is about a thing rather than
 * about a look.
 *
 * `step` is the one that did not come. It walked the selection because the
 * marks are small targets on a crowded canvas — and the panel now draws every
 * one of them as a row you cannot miss, which is a strictly better version of
 * the same idea. It keeps its key and its palette row; what it loses is a
 * button that was a worse way to do what the list does.
 *
 * **Each button prints its key.** That is the rule the whole surface follows —
 * a badge teaches the key, and a key that appears nowhere is a key nobody
 * learns. The glyph carries the meaning and the tooltip carries the sentence;
 * without the badge these would be the only three controls in the app that a
 * reader could use for a year without discovering they had letters.
 *
 * **Absent, not disabled, where the browser has no fullscreen.** The opposite
 * of the rule beside it: a greyed `fit` says "add a species and this works",
 * and a greyed fullscreen would say "your browser will never do this".
 * `FULLSCREEN_AVAILABLE` is asked once at module scope and gates this button
 * and the palette row from the same expression, because gating them separately
 * is how an iPhone ends up with a command for a thing that cannot happen.
 */

import type { ReactNode } from "react";
import { binding, kbd, type ActionId } from "./bindings";
import { FULLSCREEN_AVAILABLE } from "./fullscreen";
import { useTip } from "./Tooltip";
import { SIDEBAR_ID } from "../sidebar/useSidebar";

export interface ViewportAction {
  id: ActionId;
  /**
   * The mark on the button.
   *
   * A node rather than a string, because two of these are drawn SVGs — the
   * panel and the magnifier — and the three on the right are characters. What
   * they have in common is that they take `currentColor` and sit in the same
   * 13px box, which is what makes the two clusters read as one family.
   */
  glyph: ReactNode;
  run: () => void;
  /** True while the action's effect is the current state. */
  active?: boolean;
  /** Set when the action cannot do anything right now, and why. */
  disabledBecause?: string;
  /** The disclosure contract, for the one of these that is a disclosure. */
  expanded?: boolean;
  controls?: string;
}

/**
 * The pair top left, drawn only while the panel is shut.
 *
 * **It is the same component as the cluster on the right**, with the same
 * anatomy, the same badges and the same corner offset — which is the whole
 * point. The panel's switch and the way into the search are two ordinary
 * controls, and drawing them as ordinary controls is what the layout owed them:
 * the toggle was a bordered, backdrop-blurred tile of its own and the search
 * was a pill that bulged out over the canvas, and between them they were the
 * loudest thing on a screen whose subject is the tree.
 *
 * Open, neither is here. The toggle moves into the panel's own header beside
 * the wordmark — `sidebar/Sidebar.tsx` — and the search is a field in the
 * column, where a search field belongs.
 */
export function CanvasLeftControls({
  onToggle,
  onSearch,
}: {
  onToggle: () => void;
  onSearch: () => void;
}) {
  return (
    /*
      It owns its own slot, where the trio on the right is placed by `App`.
      That is not an inconsistency to tidy: this pair is drawn only in one
      state and never fades, so there is nothing for a caller to decide, and
      keeping the class here means the modifier is applied to the element the
      stylesheet answers it on — which `styles.test.ts` checks, and caught.
    */
    <div className="viewport-slot is-left">
      <ViewportControls
        actions={[
          {
            id: "sidebar",
            glyph: <PanelGlyph />,
            run: onToggle,
            expanded: false,
            controls: SIDEBAR_ID,
          },
          { id: "search", glyph: <SearchGlyph />, run: onSearch },
        ]}
      />
    </div>
  );
}

/**
 * The panel's switch, in the panel's own header beside the wordmark.
 *
 * Quieter than the cluster version and deliberately so: inside the column it
 * has a heading to sit against and a border round nothing, so what is left is
 * the glyph, the badge, and a track under the pointer.
 *
 * It is a *second instance* of one control rather than a second control, which
 * costs one thing worth paying attention to: pressing it unmounts it. `App.tsx`
 * moves focus to whichever instance survives, or a reader closing the panel
 * from the keyboard is left with the focus ring on nothing.
 */
export function PanelToggle({ onToggle }: { onToggle: () => void }) {
  const b = binding("sidebar");
  const tip = useTip(b.hint);
  return (
    <button
      type="button"
      className="side-toggle"
      onClick={onToggle}
      aria-expanded
      aria-controls={SIDEBAR_ID}
      aria-label={b.label}
      {...tip}
    >
      <PanelGlyph />
      <span className="kbd" aria-hidden="true">
        {b.kbd}
      </span>
    </button>
  );
}

export function ViewportControls({ actions }: { actions: ViewportAction[] }) {
  return (
    /*
      A `group` rather than a `toolbar`, on the reasoning the control bar
      settled: `toolbar` is a keyboard contract — one tab stop for the whole
      cluster, arrows between the buttons — and three buttons do not earn the
      implementation. Promising it and not keeping it is a lie about the
      keyboard, which is the one thing this app's key surface exists to avoid.
    */
    <div className="viewport-controls" role="group" aria-label="View">
      {actions.map((a) => (
        <ViewportButton key={a.id} a={a} />
      ))}
    </div>
  );
}

function ViewportButton({ a }: { a: ViewportAction }) {
  const b = binding(a.id);
  const off = a.disabledBecause !== undefined;
  const tip = useTip(off ? a.disabledBecause : b.hint);
  return (
    <button
      type="button"
      className={`viewport-btn${a.active === true ? " on" : ""}`}
      aria-disabled={off || undefined}
      aria-label={b.label}
      {...(a.expanded === undefined ? {} : { "aria-expanded": a.expanded })}
      {...(a.controls === undefined ? {} : { "aria-controls": a.controls })}
      onClick={off ? undefined : a.run}
      {...tip}
    >
      <span className="viewport-glyph" aria-hidden="true">
        {a.glyph}
      </span>
      <span className="kbd" aria-hidden="true">
        {kbd(a.id)}
      </span>
    </button>
  );
}

/** Whether to offer the fullscreen button at all. Re-exported so `App` asks once. */
export { FULLSCREEN_AVAILABLE };

/**
 * A rectangle with a filled band down its left, which is the one glyph every
 * application uses for this and therefore the one a reader has already learned.
 * Drawn rather than typed for `SearchGlyph`'s reason: the nearest characters
 * (`▤`, `◧`) sit on different baselines in different fonts.
 */
function PanelGlyph() {
  return (
    <svg
      className="side-toggle-glyph"
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="1.6"
        y="2.6"
        width="12.8"
        height="10.8"
        rx="2.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      {/* The filled band is what says which side opens. Its own path rather
          than a second `rect`, because a square fill inside a rounded frame
          spills out of both left corners. */}
      <path
        d="M6.2 2.6 H3.8 A2.2 2.2 0 0 0 1.6 4.8 V11.2 A2.2 2.2 0 0 0 3.8 13.4 H6.2 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The magnifier, drawn rather than typed.
 *
 * `⌕` is the honest character and renders at three different weights and two
 * different baselines across the fonts in `--sans`. Twelve lines of SVG is the
 * cheaper answer, and it takes `currentColor` like every other mark here. It
 * lives beside the panel glyph because the two are drawn to the same box and
 * are used together in the left-hand cluster.
 */
export function SearchGlyph() {
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
