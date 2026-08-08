/**
 * One column, holding everything that is not the tree.
 *
 * ## What it replaced, and why the pieces were fine and the sum was not
 *
 * The chrome used to sit on four edges at once — a captioned button bar along
 * the top, a stack of mode switches bottom left, the scale switch on the axis
 * footer, a detail card in the top-right corner, a round palette button bottom
 * right on a phone. Every placement had an argument and several were good ones:
 * *a control belongs on the thing it changes* is why the scale switch was under
 * the ruler it redraws. But the sum is a canvas with a hole in each corner, and
 * a reader whose eye has to go somewhere different for each kind of thing they
 * want to do. The tree is the product; it was the thing with least of the
 * screen to itself.
 *
 * So: one docked column on the left, and the canvas gets everything else. What
 * stays outside is the canvas, the timeline flush along the bottom, and two
 * small clusters in the canvas's own corners — the panel's toggle at the top
 * left, and the three viewport actions at the top right that are about
 * *looking* rather than about the tree.
 *
 * ## The order down the column is the order of a session
 *
 * Wordmark, then the way in, then what you have put on the canvas, then how it
 * is drawn, then the things you do once you have stopped building. That is not
 * a taxonomy of the controls, it is the sequence a reader moves through, and it
 * is why the settings are below the taxa rather than above them: nobody changes
 * how a canvas is drawn before there is anything on it — which is the same
 * observation the old mode panel made when it drew one chip on an empty canvas
 * instead of three.
 *
 * ## Three things this shell owns and nothing else does
 *
 * **The landmark.** An `<aside>`, which is `complementary` — supporting content
 * that can stand alone beside the main region. Not `<nav>`: nothing in here
 * navigates anywhere, and half of it acts on the canvas, one destructively.
 * That is the same call `Controls` made when it refused `nav` and took `banner`,
 * and it survives the move.
 *
 * **Being unreachable when it is shut.** A panel hidden by `transform` alone is
 * still in the tab order, which is an off-screen focus trap and the single most
 * common bug in this whole pattern. `inert` is what makes the hidden panel
 * genuinely absent — the attribute exists for this and is the only thing that
 * takes both focus and the accessibility tree with it.
 *
 * **Not owning the search.** `SearchEntry` is rendered by `App` in a fixed
 * layer, deliberately outside this element, because it has to survive the panel
 * closing — see its own header. A child of the panel goes where the panel goes.
 */

import type { LabelMode } from "../tree/naming";
import { BIOLUM_AVAILABLE } from "../canvas/capability";
import { BiolumToggle } from "../chrome/BiolumToggle";
import { AgesToggle, LabelsToggle } from "../chrome/LabelModes";
import { SourceLinks } from "../chrome/SourceLinks";
import { PendingLine } from "../chrome/Pending";
import { PanelToggle } from "../chrome/CanvasChrome";
import { SearchEntry } from "./SearchEntry";
import { TaxaList, type TaxaListProps } from "./TaxaList";
import { SIDEBAR_ID } from "./useSidebar";
import { BrandMark } from "../chrome/BrandMark";

export interface SidebarProps {
  open: boolean;
  docked: boolean;
  onToggle: () => void;
  /** Open the palette. The field in the column is one of its two doors. */
  onSearch: () => void;
  /** The invitation's words, when an opening has just answered its question. */
  tip?: string;
  taxa: TaxaListProps;
  /** The canvas modes, all four of them, in one place for the first time. */
  labels: LabelMode;
  onLabels: (m: LabelMode) => void;
  ages: boolean;
  onAges: (v: boolean) => void;
  biolum: boolean;
  onBiolum: (v: boolean) => void;
  /** The one-way action that is about the whole tree. `clear` is the list's. */
  onShare: () => void;
  onAbout: () => void;
  /**
   * Something is in flight and has been long enough to be worth saying.
   *
   * The caller decides what counts and applies the delay — see
   * `chrome/Pending.tsx`. This is the last resort for a wait with nowhere
   * better to show itself, never a second copy of one that has a home, which
   * is why the two card fetches are deliberately not in it.
   */
  busy: boolean;
}

export function Sidebar(p: SidebarProps) {
  return (
    <aside
      id={SIDEBAR_ID}
      className={`sidebar${p.open ? " is-open" : ""}${p.docked ? "" : " is-floating"}`}
      // Named because a page with more than one landmark owes each of them a
      // name, and *not* named "Sidebar": a `complementary` called that
      // announces as "complementary sidebar", which says the same word twice
      // and neither time says what is in it.
      aria-label="Taxa and controls"
      // The attribute rather than a class, because taking an element out of the
      // tab order is not something CSS can do. React 19 takes `inert` as a
      // boolean; `undefined` is what leaves it off entirely.
      {...(p.open ? {} : { inert: true })}
    >
      <div className="side-inner">
        {/*
          The wordmark, and the panel's own switch beside it.

          The switch was a bordered tile floating on the canvas at the panel's
          edge, which is where every shipped sidebar puts it — and it was the
          loudest object on the screen while the panel was open, a control with
          a backdrop blur announcing a thing the reader is already looking at.
          Open, it belongs in the header of the thing it closes, beside the name
          of the app: one row, one rule, nothing floating.

          Shut, it is back on the canvas — in a cluster with the search, drawn by
          the same component as the three viewport actions in the opposite
          corner. `chrome/CanvasChrome.tsx` is that pair.
        */}
        <div className="side-head">
          <Brand onAbout={p.onAbout} />
          <PanelToggle onToggle={p.onToggle} />
          {p.busy && (
            <PendingLine className="side-busy mono">resolving…</PendingLine>
          )}
        </div>

        {/*
          Native to the column, at the normal inset, spaced by the same gap as
          everything else. It used to be a pill in a fixed layer that bulged out
          past the panel's edge; `sidebar/SearchEntry.tsx` records why that went.
        */}
        <SearchEntry
          onOpen={p.onSearch}
          {...(p.tip === undefined ? {} : { tip: p.tip })}
        />

        {/*
          The taxa list is the only thing that scrolls, and everything below it
          is pinned.

          It was one scroll region holding both sections, which is the obvious
          arrangement and the wrong one: the list is the part that grows without
          bound, and the four canvas modes are a fixed set that a reader wants
          in the same place every time. Under one scroller, adding a tenth
          species pushed `LABELS` off the bottom of the panel — a control moving
          because of something that has nothing to do with it.

          So `.side-taxa` takes the free height and its rows scroll inside it,
          while `Canvas` and the footer strip sit under it at their natural
          height. The list grows into the space and stops; nothing else moves.
        */}
        <TaxaList {...p.taxa} />

        <section className="side-section side-canvas" aria-label="Canvas">
          <h2 className="side-h">
            <span>Canvas</span>
          </h2>
          {/*
              One set: the controls that change how the canvas is drawn rather
              than what is on it. They are only legible as a set when they sit
              beside each other, which is why a mode never goes off on its own
              next to the thing it changes — the time scale did that on the axis
              footer, wearing this panel's anatomy at the far end of the window,
              and it is gone now along with the second scale it switched.
            */}
          <div className="side-modes">
            <LabelsToggle mode={p.labels} onChange={p.onLabels} />
            <AgesToggle on={p.ages} onChange={p.onAges} />
            {/*
                No WebGL2, no switch. The mode is one instanced draw call and
                six passes on the GPU; there is no software path and there is
                not going to be one, and a switch that is offered and then turns
                the canvas black is worse than one that is not offered.
              */}
            {BIOLUM_AVAILABLE && (
              <BiolumToggle on={p.biolum} onChange={p.onBiolum} />
            )}
          </div>
        </section>

        {/*
          One strip at the foot of the panel: where this came from, and how to
          send it on.

          Both were somewhere else and both were louder there. `SourceLinks` was
          the right end of the axis footer, which is where it was read least — a
          reader looking for what this is does not look at the bottom of a
          ruler. `share` was a bordered button under a `This tree` caption, and
          that whole section is gone with it: one caption over one button, for
          the action a reader reaches for last, in a panel whose register is
          quiet.

          They are two groups rather than three links, and the space between
          them is what says so: the left pair answers *where did this come
          from*, and the right one sends it on. Out of the scroll region because
          both have to be reachable from wherever the reader has got to, and
          because the licence in the first is a condition rather than a
          footnote.

          **There was an `About Concestor →` row above this once and it is
          gone.** `SourceLinks`'s first link *is* the about page — same
          `goAbout`, same destination — so the two were one control drawn twice,
          stacked, in a corner where a reader is deciding whether either is
          worth a press. The wordmark at the top of this panel is the door now,
          which is what a wordmark is everywhere else on the web, and the empty
          canvas ends with *Learn more about Concestor* — which is where a
          first-time reader actually is.
        */}
        <div className="side-bottom">
          <SourceLinks />
          <ShareLink onShare={p.onShare} />
        </div>

        {/*
          **The detail card is not in here, and that is a decision.**

          It was, for one iteration: an overlay sheet on this panel's scroll
          region, on the argument that one column should hold everything that is
          not the tree. What that costs is the thing the card is *for*. A card
          is about one taxon on the canvas, and reading it beside the tree means
          looking left, then right, then left again — while the panel it covered
          was the list you were choosing from.

          So it flies out from the right, over the canvas, opposite the panel.
          `canvas/viewport.ts` is what makes that safe: the fit is computed
          against the canvas minus the card, so the tree reframes into the strip
          between the two rather than sliding under either. The panel keeps the
          list; the card keeps the answer; the tree stays between them.
        */}
      </div>
    </aside>
  );
}
/**
 * The wordmark, with the app's own glyph standing in for both `O`s — and it is
 * the door to the about page.
 *
 * **A wordmark that goes somewhere is the one convention this layout can take
 * for free.** It costs no pixels, it needs no caption, and it is what a reader
 * reaches for when they want to know what a thing is. It replaced a row in the
 * footer reading `About Concestor →`, which sat directly above `SourceLinks`'s
 * own `about` link and went to the same place — one control drawn twice.
 *
 * **The tagline is inside the target, not beside it.** *Everything alive is
 * related* is the claim, and the about page is where that claim is made good —
 * so a reader who wants to press on it should be pressing on it, rather than on
 * the eight characters above it. It also makes the target a block rather than a
 * word, which is the difference between a link somebody finds and one they hit.
 *
 * The button goes **inside** the `<h1>` rather than round it, because a
 * button's content model is phrasing content and a heading is not. Two `<span>`s
 * are, so both lines sit in the button and the heading keeps its outline.
 *
 * **There is no `aria-label` on it, and that is deliberate.** The visible text
 * is now two lines and a label naming only the first would fail WCAG 2.5.3 —
 * a control's accessible name has to contain what it visibly says. So the name
 * comes from the contents: the glyphs are `aria-hidden` and a visually hidden
 * span supplies the word they stand in for, leaving *Concestor. Everything
 * alive is related.* What pressing it gets you is the about page, which is one
 * press away and says all of it.
 *
 * The mark is the MRCA — a bright core inside a ring standing off it — which is
 * the one drawing this product could have as a logo, and `CONCESTOR` happens to
 * have two `O`s at either end of it. Setting the glyph in both is the cheapest
 * possible statement of what the app is about: two lineages, the same shape,
 * with the name of the thing they share between them.
 *
 * The letters are the *only* place in this app where type is tracked out this
 * far. That is what makes it read as a mark rather than as a heading — the
 * glyph has to sit in the run at the size of a capital, and at normal tracking
 * a circle between two letters reads as a mistake.
 *
 * `aria-label` carries the plain word, because the accessible name of the
 * product must not be `C·NCEST·R`.
 */
function Brand({ onAbout }: { onAbout: () => void }) {
  return (
    <div className="side-brand">
      <h1 className="side-wordmark">
        <button type="button" className="side-wordmark-btn" onClick={onAbout}>
          <span className="side-mark" aria-hidden="true">
            C<BrandMark size={15} />
            NCEST
            <BrandMark size={15} />R
          </span>
          {/*
            The word the glyphs stand in for. Hidden from the eye and not from
            the accessibility tree, because the mark reads `C·NCEST·R` with the
            two rings taken out of it and the product's own name may not be
            that.
          */}
          <span className="visually-hidden">Concestor</span>
          {/*
            One line, and it is the claim rather than a description of the
            mechanism. `openings.ts` threw out "see where their lineages meet,
            in deep time" for exactly that: nobody wants a minimal subtree, they
            want to find out they are a fish. It is inside the button because
            the about page is where the claim is made good.
          */}
          <span className="side-tagline">Everything alive is related</span>
        </button>
      </h1>
    </div>
  );
}

/**
 * Copy a link to this tree, at the right end of the footer strip.
 *
 * It was a bordered button under a `This tree` caption, and that section held
 * one control for the action a reader reaches for last — a caption, a box and a
 * glyph, in a panel whose whole register is quiet. It reads better as what it
 * actually is: a small link at the bottom of the page, opposite the two that
 * say where the page came from.
 *
 * **The chain glyph is doing real work here and the word alone would not.**
 * "Share" is the most overloaded verb in software — it means *post this*, *send
 * this to a person*, *open a sheet of destinations* — and none of those is what
 * this does. What it does is put a URL on the clipboard, and a link glyph says
 * that before the word is read. The half that surprises people — the labels,
 * the dates and the light do **not** travel, because a setting that is a claim
 * about the *reader* may not ride in a link — is on the palette row's subtitle,
 * where there is room to say it and a reader looking for it.
 *
 * `.side-links` round it rather than joining `SourceLinks`'s own group: the two
 * are different questions — *where did this come from* against *send this on* —
 * and the space between them at opposite ends of the strip is what says so.
 * What they share is the anatomy, which is the point.
 */
function ShareLink({ onShare }: { onShare: () => void }) {
  return (
    <div className="side-links">
      <button type="button" className="side-link" onClick={onShare}>
        <LinkGlyph />
        <span className="side-link-word">share</span>
      </button>
    </div>
  );
}

/**
 * Two halves of a chain, which is the one drawing everybody reads as *a link*.
 *
 * Drawn rather than typed for `SearchGlyph`'s reason: the nearest characters
 * (`🔗`, `⛓`) are emoji on most platforms and arrive in somebody else's colour
 * at somebody else's weight. This takes `currentColor` and the 1.9 stroke at
 * 13px matches the weight of the GitHub mark it sits opposite.
 */
function LinkGlyph() {
  return (
    <svg
      className="src-mark"
      viewBox="0 0 24 24"
      width="13"
      height="13"
      aria-hidden="true"
      focusable="false"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </g>
    </svg>
  );
}
