/**
 * What is on the canvas, as a list you can point at.
 *
 * ## It is the layers panel, and that is the right borrowed idea
 *
 * Every canvas application the audience has already used puts a list of the
 * things on the canvas down the left: Figma's layers, Photoshop's, tldraw's,
 * Framer's. It earns its place for a reason that is sharper here than in any of
 * them — the marks on this canvas are *small*, they move whenever a species is
 * added, and past about a dozen taxa the labels start colliding. A row is a
 * target that never moves, is never too small, and always says the whole name.
 *
 * Clicking one selects it, which lights its mark, dims the lineages off its
 * path if isolate is on, and opens its card — the same thing clicking the mark
 * does, because it is the same call.
 *
 * ## The section is **Taxa**, not **Species**
 *
 * The list holds species and it also holds *Cetacea*, which is not one, and
 * *Tyrannosaurus*, which is a genus. "Species" was accurate about the search
 * and never about the result: a reader is free to put a whole clade on the
 * canvas and routinely does, because that is what the openings do. `Taxa` is
 * the word that covers everything a row can be, and the search underneath is
 * still allowed to say "species" because that is genuinely what it looks
 * through.
 *
 * ## Two kinds of row, and the badge is the only difference
 *
 * A node is a lineage in the tree. A **fossil** is a species the tree has no
 * lineage for — `docs/fossil-grafts.md` §9 has the sentence and the reason the
 * badge reads *on a branch* rather than *extinct*, which would be wrong about
 * *T. rex*. Anything else about the two is identical here: same anatomy, same
 * hit target, same remove control, one list. Filing them apart would restate a
 * split the product spent a whole change removing.
 *
 * ## The add row is at the top and it is a row
 *
 * `+` at the top of a layers panel is where every one of those applications
 * puts it, and making it a row rather than a button in the section header means
 * it is in the same tab order and the same vertical rhythm as everything under
 * it. Two ways to fill the list, side by side: name one, or be given one. They
 * are the two doors the old control bar's `Add species` group held, and they
 * have not changed — only the letter has, since `s` went to the sidebar.
 */

import type { FossilTaxon, PathNode } from "../api";
import { drawnBounds, silhouetteIsInformative } from "../api";
import { kbd } from "../chrome/bindings";
import { HeaderAction } from "./HeaderAction";
import { useTip } from "../chrome/Tooltip";
import { Silhouette } from "../canvas/Silhouette";
import { isScientificItalic } from "../canvas/NodeMark";
import { markName, type LabelMode } from "../tree/naming";
import { maFigure } from "../ages";

export interface TaxaListProps {
  /** The chosen lineages, in the order the canvas draws them. */
  nodes: readonly PathNode[];
  /** The fossils pinned to branches, in the order they were added. */
  fossils: readonly FossilTaxon[];
  /** The canvas index the card is open on, or null. */
  selectedIdx: number | null;
  /** The PBDB taxon number the card is open on, or null. */
  selectedTaxonNo: number | null;
  labels: LabelMode;
  onSelectNode: (n: PathNode) => void;
  onRemoveNode: (n: PathNode) => void;
  onSelectFossil: (f: FossilTaxon) => void;
  onRemoveFossil: (f: FossilTaxon) => void;
  onAdd: () => void;
  onRandom: () => void;
  /**
   * Take everything off the canvas.
   *
   * It lives on this section's caption rather than under `This tree`, where it
   * used to sit beside share, because what it empties is *this list* — so it
   * belongs beside this list's own count, at the far right of the header, which
   * is exactly where every row below puts its own remove control. The
   * list-level action lines up with the row-level ones.
   */
  onClear: () => void;
  /** A random pick is in flight, so the die is spinning. */
  picking: boolean;
}

export function TaxaList(p: TaxaListProps) {
  const count = p.nodes.length + p.fossils.length;
  return (
    <section className="side-section side-taxa" aria-label="Taxa">
      {/*
        Three cells, and the middle one is on the row's own midline.

        The count and CLEAR used to sit together at the right end, and read as
        one object — a number that looked like part of the button beside it. A
        grid of `1fr auto 1fr` puts the count on the midline whatever the two
        words either side of it are doing, which is the same trick the axis
        footer uses to centre its key: the outer columns are equal whether or
        not either has anything in it.

        It also gives CLEAR the whole right-hand end, which is what lets it
        carry its key badge. That badge came off when this row held *two* verbs
        and a small box beside two words that were deliberately not boxes was
        the only thing breaking the row's register. Alone at the end of the row,
        with the count no longer crowding it, it is the thing that gives the one
        destructive control in the panel an identity — and `C` is a key nobody
        learns from a tooltip.

        **Both are absent at zero, and for one reason.** "0" beside a heading
        over an empty list says what the empty list says, louder — and a greyed
        CLEAR over the same empty list says it a third time. That is the one
        place this app's standing rule gives way: *disabled rather than hidden*
        exists so a control does not move out from under a hand reaching for it,
        and the tooltip on a greyed one says what would make it work. Neither
        applies here. Nothing reaches for clear on an empty canvas, and the
        sentence a tooltip would carry — "the canvas is already empty" — is the
        list itself. The palette drops `fit-all` and `step` on the same canvas
        for the same reason.
      */}
      <h2 className="side-h is-taxa">
        <span>Taxa</span>
        <span className="side-count mono">{count > 0 ? count : ""}</span>
        <span className="side-h-acts">
          {count > 0 && (
            <>
              <HeaderAction
                label="Clear"
                danger
                hint="Take everything off the canvas"
                onClick={p.onClear}
              />
              <span className="kbd side-act-kbd" aria-hidden="true">
                {kbd("clear")}
              </span>
            </>
          )}
        </span>
      </h2>

      {/*
        The two doors, pinned above the list rather than scrolling with it —
        and drawn at one of two sizes.

        `SPACIOUS_UPTO` is the whole of the rule and it is about *vertical
        space* rather than about expertise. A short list leaves most of this
        column empty, and an empty column below two small buttons is the
        product failing to say what it is for at the one moment a reader has
        not yet decided. So under that count the doors are tiles: square, big
        enough to hit without aiming, each carrying a line saying what is behind
        it. Past it the list is what the column is for, the tiles would be
        pushing rows off the bottom to fill space that is no longer empty, and
        they collapse to the row.

        The two states are the same two controls with the same two keys, which
        is what makes the change a *size* rather than a reshuffle: nothing
        appears, nothing goes, and the badges do not move relative to what they
        label.
      */}
      <AddDoors
        onAdd={p.onAdd}
        onRandom={p.onRandom}
        picking={p.picking}
        spacious={count <= SPACIOUS_UPTO}
      />

      <div className="side-rows">
        {p.nodes.map((n) => (
          <NodeRow
            key={n.idx}
            node={n}
            labels={p.labels}
            on={p.selectedIdx === n.idx}
            onSelect={() => p.onSelectNode(n)}
            onRemove={() => p.onRemoveNode(n)}
          />
        ))}
        {p.fossils.map((f) => (
          <FossilRow
            key={f.pbdb_taxon_no ?? f.name}
            fossil={f}
            on={p.selectedTaxonNo === f.pbdb_taxon_no}
            onSelect={() => p.onSelectFossil(f)}
            onRemove={() => p.onRemoveFossil(f)}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * How short a list has to be for the doors to be drawn large.
 *
 * Two, which is one short of the smallest tree this product will draw an
 * argument from: `openings.ts` refuses to ship a two-taxon opening because *a
 * pair draws one number, and three or more draw an argument*. So the tiles are
 * up for exactly as long as the canvas cannot yet make the case for itself, and
 * they collapse on the add that finally does.
 */
const SPACIOUS_UPTO = 2;

/**
 * Name one, or be given one — at one of two sizes.
 *
 * **Spacious**: two squares side by side, each with a glyph, a title, a line
 * saying what is behind it, and its key. They exist because a short list leaves
 * this column mostly empty, and an empty column under two small buttons is the
 * product failing to say what it is for at the one moment a reader has not
 * decided yet. A tile is also a target you hit without aiming, which is the
 * half that matters on a first visit.
 *
 * **Compact**: the row they collapse to once the list is long enough to want
 * the height. Same two controls, same two keys, same order.
 *
 * The descriptions are the point of the large state and are the thing the row
 * cannot carry. "Add a taxon" says what the button does; *any species, living
 * or fossil* says what is behind it — which is the fact this app is least able
 * to assume a reader knows, since one catalogue holding both is the whole of
 * what `docs/fossil-grafts.md` §9 argued for.
 */
function AddDoors({
  onAdd,
  onRandom,
  picking,
  spacious,
}: {
  onAdd: () => void;
  onRandom: () => void;
  picking: boolean;
  spacious: boolean;
}) {
  const addTip = useTip(
    "Search by name — everyday or scientific, living or fossil",
  );
  const randTip = useTip(
    "Add something illustrated, picked for you. About one in five is a fossil",
  );

  if (spacious) {
    return (
      <div className="side-doors">
        <button type="button" className="side-door" onClick={onAdd} {...addTip}>
          <span className="kbd side-door-kbd" aria-hidden="true">
            {kbd("add-taxon")}
          </span>
          <span className="side-door-glyph" aria-hidden="true">
            +
          </span>
          <span className="side-door-title">Add a taxon</span>
          <span className="side-door-sub">Any species, living or fossil</span>
        </button>
        <button
          type="button"
          className={`side-door${picking ? " is-busy" : ""}`}
          onClick={onRandom}
          {...randTip}
        >
          <span className="kbd side-door-kbd" aria-hidden="true">
            {kbd("random-species")}
          </span>
          <span className="side-door-glyph side-door-die" aria-hidden="true">
            ✦
          </span>
          <span className="side-door-title">Surprise me</span>
          <span className="side-door-sub">
            Something illustrated, at random
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="side-add">
      <button
        type="button"
        className="side-add-main"
        onClick={onAdd}
        {...addTip}
      >
        <span className="side-add-plus" aria-hidden="true">
          +
        </span>
        <span className="side-add-word">Add a taxon</span>
        <span className="kbd" aria-hidden="true">
          {kbd("add-taxon")}
        </span>
      </button>
      <button
        type="button"
        className={`side-add-die${picking ? " is-busy" : ""}`}
        onClick={onRandom}
        aria-label="Add a random species"
        {...randTip}
      >
        <span className="side-add-die-glyph" aria-hidden="true">
          ✦
        </span>
        <span className="kbd" aria-hidden="true">
          {kbd("random-species")}
        </span>
      </button>
    </div>
  );
}

/**
 * One lineage.
 *
 * **The row is a button and the remove control is a second button beside it,
 * never nested.** A button inside a button is invalid markup that browsers
 * resolve differently, and the failure mode is the worst one available here:
 * pressing *remove* also selects, so the card opens on the taxon that has just
 * been taken off the canvas.
 */
function NodeRow({
  node,
  labels,
  on,
  onSelect,
  onRemove,
}: {
  node: PathNode;
  labels: LabelMode;
  on: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  /*
    The list follows the canvas's own labels setting, except that `off` falls
    back to the scientific name rather than to nothing. That is not an
    inconsistency to tidy away: `off` is a statement about the *canvas*, where
    the shape of the tree is the subject and the names are in the way. A list of
    blank rows is not the quieter version of this list, it is a broken one.
  */
  const nm = markName(node, labels === "off" ? "scientific" : labels);
  // The same judgement the canvas and the palette make, from the same
  // function — a borrowed picture always renders *something*, so a row that
  // drew one the canvas refuses would look fine and be a beetle wearing a mole.
  const sil = silhouetteIsInformative(node, node.silhouette_clade_tips)
    ? node.phylopic_id
    : null;
  return (
    <div className={`side-row${on ? " is-on" : ""}`}>
      <button type="button" className="side-row-main" onClick={onSelect}>
        <span className="side-row-art">
          {sil ? (
            <Silhouette phylopicId={sil} size={20} fallback="◦" />
          ) : (
            <span className="side-row-dot" aria-hidden="true">
              ◦
            </span>
          )}
        </span>
        <span className="side-row-body">
          <span
            className={`side-row-name${
              nm && isScientificItalic(nm.rank) ? " sci-italic" : ""
            }`}
          >
            {nm?.text ?? node.key}
          </span>
          <span className="side-row-meta mono">{nodeMeta(node)}</span>
        </span>
      </button>
      <RemoveButton onRemove={onRemove} what={nm?.text ?? node.key} />
    </div>
  );
}

/**
 * The second line: the rank, and how much of the tree this row stands for.
 *
 * A tip count is the honest size of a selection and it is the number the reader
 * cannot get any other way — a mark on the canvas is the same dot whether it
 * holds one species or ninety thousand. `1 species` is dropped rather than
 * printed, because for a species row the rank already said it.
 */
function nodeMeta(n: PathNode): string {
  const rank = n.rank ?? "clade";
  if (n.tip_count > 1) {
    return `${rank} · ${n.tip_count.toLocaleString()} species`;
  }
  return rank;
}

/** One fossil, pinned to a branch. */
function FossilRow({
  fossil,
  on,
  onSelect,
  onRemove,
}: {
  fossil: FossilTaxon;
  on: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div className={`side-row is-fossil${on ? " is-on" : ""}`}>
      <button type="button" className="side-row-main" onClick={onSelect}>
        <span className="side-row-art">
          {fossil.phylopic_id ? (
            <Silhouette
              phylopicId={fossil.phylopic_id}
              size={20}
              fallback="◦"
            />
          ) : (
            <span className="side-row-dot" aria-hidden="true">
              ◦
            </span>
          )}
        </span>
        <span className="side-row-body">
          <span className="side-row-name sci-italic">{fossil.name}</span>
          <span className="side-row-meta mono">
            {/*
              The badge the corpus merge earned. Not "extinct" — that is wrong
              about *T. rex*, which is in the tree — but *a species the tree has
              no lineage for*, shortened to where it hangs instead.
            */}
            <span className="side-row-badge">on a branch</span>
            {fossilSpan(fossil)}
          </span>
        </span>
      </button>
      <RemoveButton onRemove={onRemove} what={fossil.name} />
    </div>
  );
}

/**
 * The fossil's drawn range, or nothing.
 *
 * Through `drawnBounds`, which is the only thing allowed to decide this:
 * `lla_drawn` and never `lla` is the rule, because PBDB's young end can be a
 * fact about the catalogue rather than the animal — *Stegosaurus* stops at 93.9
 * Ma on one `Stegosaurus sp.` and would be drawn 50 Myr after it lived. Every
 * surface that prints the pair has to read the corrected one, and getting that
 * wrong once already put `162–94 Ma` on a node above a graft reading `162–143`.
 * Where either end is missing there is no range and the row simply says less.
 */
function fossilSpan(f: FossilTaxon): string {
  const b = drawnBounds(f);
  if (b.fea === null || b.lla === null) return "";
  // `maFigure` and not a local ladder. `ages.ts` is the one place a figure is
  // rounded in this app and `ages.test.ts` sweeps the corpus for a second copy
  // — which it found here on the first run, correctly.
  return ` · ${maFigure(b.fea)}–${maFigure(b.lla)} Ma`;
}

/**
 * Take it off the canvas.
 *
 * Visible on hover and on focus, and **never on touch-only**: `@media (hover:
 * none)` shows it always, because a control that reveals itself under a pointer
 * is a control that does not exist for a thumb. That is the same reason the
 * carousel's rotation stops on a phone rather than waiting for a `mouseenter`
 * that never comes.
 */
function RemoveButton({
  onRemove,
  what,
}: {
  onRemove: () => void;
  what: string;
}) {
  const tip = useTip(`Take ${what} off the canvas`);
  return (
    <button
      type="button"
      className="side-row-remove"
      onClick={onRemove}
      aria-label={`Remove ${what}`}
      {...tip}
    >
      <span aria-hidden="true">−</span>
    </button>
  );
}
