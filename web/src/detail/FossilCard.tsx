/**
 * The card for a fossil.
 *
 * The same slot and the same anatomy as {@link Detail}, and deliberately not
 * the same content — because the two are answers to different questions and a
 * card that pretended otherwise would be the borrowed-silhouette mistake in
 * text. A node card leads with an age, a species count and a depth; a fossil
 * has none of those. What it has is a range in the rock, a count of
 * occurrences, and an attachment point whose looseness is the real caveat.
 *
 * Three things it must do that the node card does not:
 *
 *   - **Credit the drawing.** A graft puts a PhyloPic image on the canvas and
 *     CC-BY applies to whatever is on screen. Until this card existed there was
 *     nowhere for that credit to go, which was a licensing gap and not a polish
 *     item.
 *   - **Say it is not a node**, in the reader's language, once and plainly.
 *     Everything else on this canvas has a position in the tree.
 *   - **State the placement and the date as two separate uncertainties.** Where
 *     it hangs and when it lived are independent, and letting one stand in for
 *     the other is what `placementNote` exists to prevent.
 *
 * The classification block inherits that third rule. What a fossil card can
 * show is the classification of the node it hangs *below*, which is a weaker
 * claim than a node card's and is captioned as one.
 */

import { drawnBounds, youngEndIsIndeterminate, type FossilDetail } from "../api";
import { endedSpanLabel, maLabel } from "../canvas/Bracket";
import { Silhouette } from "../canvas/Silhouette";
import { placementNote } from "../canvas/NodeMark";
import type { Graft } from "../tree/graft";
import {
  CardActions,
  ClassificationBlock,
  EncyclopediaBlock,
  TaxonLink,
  WhyBlock,
  type SelectTaxon,
} from "./blocks";
import { rankIsInformative } from "./classification";
import { useEncyclopedia, useLineage } from "./hooks";

export function FossilCard({
  fossil,
  hue,
  graft,
  onSelect,
  drawn,
  onDraw,
  onRemove,
}: {
  fossil: FossilDetail;
  hue: number;
  /** Present when it is actually drawn; absent when the card is open cold. */
  graft: Graft | null;
  onSelect: SelectTaxon;
  /** In `view.fossils`. Drawn *and* in the view are different questions — see below. */
  drawn: boolean;
  onDraw: () => void;
  onRemove: () => void;
}) {
  // The range as it may be *drawn*, so the figure on the card and the glyph on
  // the canvas are the same statement. PBDB's own is printed beside it in the
  // disclosure wherever the two differ — it is not hidden, it is just not the
  // headline, because the headline was asserting a date the catalogue does not
  // support for the named animal.
  const shown = drawnBounds(fossil);
  const bounds = [shown.fea, shown.fla, shown.lea, shown.lla].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  const span = bounds.length
    ? endedSpanLabel(Math.max(...bounds), Math.min(...bounds))
    : null;
  // PBDB's young end against the youngest one an *identified* member reaches.
  // Where they differ the later date rests on material catalogued no finer
  // than the taxon itself, and the reader is owed that in words: the range on
  // the card is PBDB's and stays PBDB's, so without a sentence the number and
  // the glyph's position would simply disagree.
  const indeterminate = youngEndIsIndeterminate(fossil);
  const movedTo =
    indeterminate &&
    typeof fossil.lla_drawn === "number" &&
    fossil.lla_drawn !== fossil.lla
      ? fossil.lla_drawn
      : null;
  const sil = fossil.silhouette ?? null;
  const host = fossil.attach ?? null;
  const walk = fossil.attach_walk ?? null;
  // The two refusals `makeGraft` makes that no selection can fix. Stated in the
  // reader's terms rather than hidden behind a button that answers with a
  // notice: 21.4% of PBDB taxa carry no bracket, and there is nowhere in time
  // to put one of them.
  const refusal = !span
    ? "It cannot be drawn on the tree: PBDB records no appearance interval for it, so there is nowhere in time to put it."
    : fossil.pbdb_taxon_no === undefined
      ? "It cannot be drawn on the tree: this build's fossil table carries no identifier for it."
      : undefined;

  // No QID: a PBDB taxon is not a Wikidata item and nothing in the build has
  // ever tied one to the other. So this goes down the checked path — the item
  // behind an article of this name has to name this taxon in its own `P225`
  // before a word of it reaches the card. *Ares*, *Iris* and *Nike* are all
  // PBDB genera, and all three have articles about something else entirely.
  const entry = useEncyclopedia({ name: fossil.name });
  /**
   * Zero `parent_no` hops: PBDB's own taxon is in the synthesis tree, so the
   * attachment point is not a node the fossil sits *below* — it is this taxon,
   * under the same name.
   *
   * It changes what the classification block is allowed to say. At any other
   * walk the block is about a host and has to be captioned as one; here it is
   * the fossil's own classification, and captioning it as a host's would have
   * *Tyrannosaurus rex* described as the node *Tyrannosaurus rex* sits beneath,
   * with itself as the last rung of its own lineage.
   */
  const exact = walk === 0 && host !== null;
  // The attachment point's ancestry, *including* the attachment point — except
  // where that point is the taxon itself, which is the subject and not part of
  // its own classification.
  const lineage = useLineage(host?.key ?? null, exact);

  return (
    <aside className="detail" style={{ color: `hsl(${hue} 60% 62%)` }}>
      {sil && (
        <div className="detail-image">
          <Silhouette phylopicId={sil.phylopic_id} size={110} />
          {/* No watermark. On a node card it says whose portrait this really
              is, because the drawing is nearly always of a relative. Here it
              is of this taxon — `fossil_image` matches PBDB and PhyloPic on the
              same name and never inherits — so a watermark would repeat the
              heading. */}
        </div>
      )}
      <h2
        className={
          fossil.rank === "species" || fossil.rank === "genus"
            ? "sci-italic"
            : undefined
        }
        style={{ color: "var(--ink)" }}
      >
        {fossil.name}
      </h2>
      <div className="rank">
        {rankIsInformative(fossil.rank) ? `fossil · ${fossil.rank}` : "fossil"}
      </div>

      {/*
        `drawn` is membership of the view, not visibility. A fossil in the view
        whose host branch is off the canvas is refused by `makeGraft` and drawn
        nowhere — and the button still has to say "remove", because that is what
        the reader would be undoing. `drawFossil` is what closes the gap: it
        adds the host when the graft would otherwise be refused, so pressing
        add here produces a picture rather than a notice.

        A taxon with no range and one with no identifier are refused outright
        and cannot be drawn at any selection, so those say so instead of
        offering a button that would do nothing.
      */}
      <CardActions
        present={drawn}
        onAdd={onDraw}
        onRemove={onRemove}
        addLabel="Draw on the tree"
        removeLabel="Remove from the tree"
        {...(refusal ? { refusal } : {})}
      />

      {/* Keyed on the taxon — see the node card. */}
      <EncyclopediaBlock
        key={fossil.pbdb_taxon_no ?? fossil.name}
        entry={entry}
        subject={fossil.name}
      />
      {exact ? (
        <ClassificationBlock lineage={lineage} onSelect={onSelect} />
      ) : (
        <ClassificationBlock
          lineage={lineage}
          onSelect={onSelect}
          heading="Classified below"
          caveat={
            <>
              A fossil taxon has no place of its own in the tree, so this is the
              classification of{" "}
              <TaxonLink target={host?.key} onSelect={onSelect} rank={host?.rank}>
                <strong>{host?.name ?? "the node it hangs below"}</strong>
              </TaxonLink>{" "}
              — the deepest node this fossil is known to sit beneath, not a
              lineage it is known to sit on.
            </>
          }
        />
      )}

      <dl className="facts">
        {/* No `age` row, and its absence is the point rather than an omission.
            Every age in this app comes from a chronogram of living species and
            an extinct taxon has no counterpart in one. */}
        <dt>fossils</dt>
        <dd className="num">{span ?? "no range recorded"}</dd>
        {fossil.n_occs > 0 && (
          <>
            <dt>occurrences</dt>
            <dd className="num">{fossil.n_occs.toLocaleString()}</dd>
          </>
        )}
        <dt>below</dt>
        <dd>
          <TaxonLink
            target={host?.key ?? fossil.attach_idx}
            onSelect={onSelect}
            rank={host?.rank}
          >
            {host?.name ?? `node ${fossil.attach_idx}`}
          </TaxonLink>
        </dd>
        <dt>PBDB</dt>
        <dd className="num">{fossil.pbdb_taxon_no}</dd>
      </dl>

      <WhyBlock summary="Sources and caveats">
        <p className="note">
          This is a fossil taxon, not a node in the tree: the Open Tree
          synthesis has no lineage for it, so it has no position of its own and
          no divergence age. Its dates come from the Paleobiology Database —
          where it turns up in the rock, which is an observation rather than an
          estimate.
          {walk !== null && placementNote(walk)}
        </p>
        {indeterminate && (
          <p className="note">
            The later end of that range is not one any identified member of{" "}
            <strong>{fossil.name}</strong> reaches. The youngest that is
            recorded is {maLabel(fossil.lla_identified as number)} Ma; everything
            after it rests on material catalogued no more precisely than the
            group itself — a specimen filed as <em>{fossil.name}</em> sp. or
            indet., which says where something in the group turned up and not
            where this one did.{" "}
            {movedTo !== null ? (
              <>
                So the range above ends at {maLabel(movedTo)} Ma, where its own
                named record ends, and that is where it is drawn.{" "}
                <strong>PBDB's own figure for the taxon is{" "}
                {maLabel(fossil.lla as number)} Ma</strong>, and this is the
                only difference between the two.
              </>
            ) : (
              <>
                Too little is recorded at the earlier date to put it there
                instead, so it stays where PBDB has it and this note is the
                whole of the correction.
              </>
            )}
          </p>
        )}
        {graft && span && (
          <p className="note">
            It is drawn hanging from{" "}
            <TaxonLink target={host?.key} onSelect={onSelect} rank={host?.rank}>
              <strong>{host?.name ?? "the branch above it"}</strong>
            </TaxonLink>
            , at its own date. The line meets the branch{" "}
            {graft.joinAt === "first-appearance" ? (
              <>
                at its first appearance, which is the latest its lineage can have
                parted from the rest.
              </>
            ) : graft.joinAt === "anchor" ? (
              <>
                at that point because it first appears later — its lineage parted
                somewhere below there, off the branches drawn here.
              </>
            ) : (
              <>
                as far back as the branch is drawn, because it is older than all
                of it.
              </>
            )}
          </p>
        )}
      </WhyBlock>

      {sil && (
        <p className="credit">
          Silhouette{sil.attribution ? ` by ${sil.attribution}` : ""}
          {sil.contributor && sil.contributor !== sil.attribution
            ? `, uploaded by ${sil.contributor}`
            : ""}{" "}
          ·{" "}
          <a href={sil.license_url} target="_blank" rel="noreferrer noopener">
            licence
          </a>{" "}
          · PhyloPic
        </p>
      )}
    </aside>
  );
}
