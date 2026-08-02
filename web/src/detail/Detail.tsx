/**
 * The card for a node.
 *
 * ## What changed, and why the old order was wrong
 *
 * This used to be a name, four numbers, and up to six paragraphs of prose about
 * the tree — why no age is shown, what tier the age is, what the picture is
 * actually of, how loosely the witness is placed. Every one of those paragraphs
 * is still here and none of them has been shortened, because each exists to stop
 * a specific wrong reading and deleting one would let that reading back in.
 *
 * What was wrong was the order. A reader clicks a badger to find out what a
 * badger is. The first thing the card said was that the horizontal axis is
 * ordinal in this region. That is true, it matters, and it is the answer to a
 * question nobody has asked yet.
 *
 * So the provenance is now one disclosure below the facts, and above it sits
 * what the reader came for: the common name, a description, and where the thing
 * sits in the classification. The one piece of prose that stayed on the face of
 * the card is a divergence's derived name — for an `mrcaott…` node that
 * sentence is not provenance, it is the only identity the node has.
 */

import {
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
  type NodeDetail,
} from "../api";
import { bracketGeom, bracketTitle, endedSpanLabel, gapLabel } from "../canvas/Bracket";
import { Silhouette } from "../canvas/Silhouette";
import { mayDrawExemplar, witnessOn } from "../canvas/witness";
import { ageLabel, DerivedName, isScientificItalic } from "../canvas/NodeMark";
import { branchProse, UNNAMED, type Divergence } from "../tree/naming";
import {
  CardActions,
  ClassificationBlock,
  EncyclopediaBlock,
  NamesBlock,
  TaxonLink,
  WhyBlock,
  type SelectTaxon,
} from "./blocks";
import { rankIsInformative } from "./classification";
import { useEncyclopedia, useLineage } from "./hooks";
import { fossilTarget } from "./target";

export function Detail({
  detail,
  hue,
  divergence,
  nested,
  isLeaf,
  onSelect,
  inSelection,
  isDrawn,
  onAdd,
  onRemove,
}: {
  detail: NodeDetail;
  hue: number;
  /** Set only where the taxonomy has no name and one was derived. */
  divergence: Divergence | null;
  /** Chosen species classified inside this one. Almost always empty. */
  nested: string[];
  /** A species the reader chose, rather than a divergence they arrived at. */
  isLeaf: boolean;
  /** Opens another taxon's card. Every name on this card that names one uses it. */
  onSelect: SelectTaxon;
  /** In `view.keys` — a lineage the reader chose, not merely one that is drawn. */
  inSelection: boolean;
  /** Rendered on the canvas, whether chosen or induced. Changes the verb only. */
  isDrawn: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const age = ageLabel(detail.age_ma, detail.tier);
  // Geometry is not wanted here — the card states the span in words — but
  // `bracketGeom` is what decides `absent` from `range`, and having one place
  // make that call keeps the card and the drill-down lane from disagreeing
  // about what a partial row means.
  const occurrence =
    detail.tier === TIER_OCCURRENCE && detail.occurrence
      ? bracketGeom(detail.occurrence, () => 0)
      : null;
  // The card must show what the canvas shows, and by the same rule, or the two
  // disagree about what a node looks like. A divergence draws its witness or
  // nothing; only a clade the reader chose draws its group's exemplar. The
  // ordinary silhouette is therefore not shown *or credited* on a fork, since
  // it is not on screen and crediting an image nobody can see is noise.
  const place = { node: detail, isLeaf };
  const witness = witnessOn(place);
  const witnessCredit = witness ? (detail.divergence_silhouette ?? null) : null;
  const sil = mayDrawExemplar(place) ? detail.silhouette : null;
  // A picture that is not of this node is a picture of something inside the
  // clade, and the card is where that gets said in full rather than in a
  // tooltip. `clade_name` is null for the unnamed `mrcaott…` nodes, and there
  // is nothing useful to name in that case.
  const borrowed = sil && sil.source_idx !== detail.idx ? sil : null;
  // What the watermark says. Normally the clade, because how far the
  // resemblance is being claimed to reach is the thing a reader needs. But an
  // unillustrated group's clade is itself — nobody drew Elminae, somebody drew
  // a riffle beetle inside it — and stamping ELMINAE across the picture on the
  // Elminae card repeats the heading instead of adding to it. There the
  // drawing's own subject is the new fact, and the credit line below carries
  // the group in full either way.
  const watermark = borrowed
    ? borrowed.clade_name && borrowed.clade_name !== detail.name
      ? borrowed.clade_name
      : borrowed.source_name
    : null;
  // The node that watermark names, so the stamp opens it. Chosen by the same
  // branch that chose the string rather than inferred from it — a name and an
  // index that disagree would be a link to a taxon the card never mentioned,
  // which is the quietest possible way to be wrong.
  const watermarkIdx = borrowed
    ? borrowed.clade_name && borrowed.clade_name !== detail.name
      ? (borrowed.clade_idx ?? null)
      : borrowed.source_idx
    : null;

  const lineage = useLineage(detail.key);
  // The identifier first, always. A name is what puts a Greek war god on a
  // fossil card; the QID is what the build already checked against the item's
  // own `wdt:P225`. The name is passed alongside so a node the crawl never
  // reached still gets a checked answer rather than none.
  const entry = useEncyclopedia({ qid: detail.wikidata_qid ?? null, name: detail.name });
  // The word a reader actually knows. Preferred-first, so this is the headline
  // name rather than whichever alias sorted first, and it sits *under* the
  // scientific name rather than replacing it: the canvas label and the palette
  // row both say "Felidae", and a card that answered to "cat" instead would
  // make the reader check they had clicked the right thing.
  const common = divergence ? null : (detail.vernaculars[0] ?? null);

  return (
    <aside className="detail" style={{ color: `hsl(${hue} 60% 62%)` }}>
      {witness && (
        <div className="detail-image">
          <Silhouette phylopicId={witness.phylopicId} size={110} />
          {witness.name && (
            // The witness's own name, for the same reason the borrowed case
            // stamps its clade: the fact the picture adds is what it is *of*.
            // It links to the **fossil**, which is what it is — see `Witness`.
            <span className="detail-watermark">
              <TaxonLink
                target={
                  witness.pbdbTaxonNo !== null ? fossilTarget(witness.pbdbTaxonNo) : null
                }
                onSelect={onSelect}
                title={`What this drawing is of. Not ${detail.name ?? "this node"} itself — a fossil taxon from somewhere below it, dated to about this split.`}
              >
                {witness.name}
              </TaxonLink>
            </span>
          )}
        </div>
      )}
      {sil && (
        <div className="detail-image">
          <Silhouette phylopicId={sil.phylopic_id} size={110} />
          {watermark && (
            // Watermarked onto the image rather than captioned beside it: the
            // claim is about *this picture*, and on the canvas the same fact
            // was wide enough to run across a neighbouring lineage.
            <span className="detail-watermark">
              <TaxonLink
                target={watermarkIdx}
                onSelect={onSelect}
                title={`What this drawing is of. Not ${detail.name ?? "this node"} itself.`}
              >
                {watermark}
              </TaxonLink>
            </span>
          )}
        </div>
      )}
      <h2
        className={
          !divergence && isScientificItalic(detail.rank) ? "sci-italic" : undefined
        }
        style={{ color: "var(--ink)" }}
      >
        {divergence ? (
          <DerivedName divergence={divergence} />
        ) : (
          (detail.name ?? UNNAMED)
        )}
      </h2>
      {common && <div className="common-name">{common}</div>}
      {divergence ? (
        <div className="rank">divergence</div>
      ) : (
        // "NO RANK" is what the Open Tree taxonomy files an unranked clade
        // under, and printed here it reads as a statement about the clade —
        // *Boreoeutheria*, *Primates*, *Bilateria* all wore it. An unranked
        // clade is a clade; the classification block below says which one.
        rankIsInformative(detail.rank) && <div className="rank">{detail.rank}</div>
      )}

      {/*
        Three states, not two, because "on the canvas" and "chosen" are
        different things and only one of them is what the button changes.

        A drawn divergence is on the canvas *because of* the selections that
        induced it — Boreoeutheria is there only as long as a human and a cat
        both are. Labelling that "Add to the canvas" promises a change the
        reader can see, and the press then appears to do nothing. "Pin" is what
        actually happens: it becomes a lineage of its own and survives the
        removal of everything beneath it.
      */}
      <CardActions
        present={inSelection}
        onAdd={onAdd}
        onRemove={onRemove}
        addLabel={isDrawn ? "Pin to the canvas" : "Add to the canvas"}
        removeLabel="Remove from the canvas"
        {...(isDrawn
          ? { hint: "It is drawn now only because of what sits below it. Pinning keeps it." }
          : {})}
      />

      {divergence && (
        // Stays on the face of the card. For a node the taxonomy never named,
        // this sentence is the name.
        <p className="note">
          The Open Tree taxonomy has no name for this node, so it is described
          by what it separates: it is the last common ancestor of{" "}
          {branchProse(divergence.branches)}. That is a statement about the
          tree, not a name anyone has given it.
        </p>
      )}
      {nested.length > 0 && (
        // Also primary: it is about the reader's own selection, and answers
        // "why is the species I picked drawn as a fork".
        <p className="note">
          {branchProse(nested)}{" "}
          {nested.length === 1 ? "is classified" : "are classified"} inside this
          taxon rather than beside it, so the branch to{" "}
          {nested.length === 1 ? "it" : "them"} leaves from here. This node is
          {/* "a species you chose" until a card could add a clade to the
              canvas, at which point the sentence started appearing over
              *Carnivora*, an order. Adding an ancestor of something already
              drawn is an ordinary move now rather than a rarity. */}
          both a taxon you chose and the divergence you are looking for.
        </p>
      )}

      {/* Keyed on the node, so the "read the rest" toggle does not survive
          into the next card — the reader expanded *this* description, and a
          card that arrives already open has quietly made that choice for them. */}
      <EncyclopediaBlock key={detail.key} entry={entry} subject={detail.name} />
      <ClassificationBlock lineage={lineage} onSelect={onSelect} />

      <dl className="facts">
        <dt>age</dt>
        <dd className="num">{age ?? "not estimated"}</dd>
        {occurrence && (
          // Its own row, below the age and never in place of it. The two are
          // different kinds of claim — one is when lineages parted, the other
          // is what is in the rock — and putting a range in the `age` slot
          // would say they are the same kind, which is what this tier exists
          // not to say.
          <>
            <dt>fossils</dt>
            <dd className="num" title={bracketTitle(detail.name ?? "This taxon", occurrence)}>
              {occurrence.kind === "range"
                ? endedSpanLabel(occurrence.oldest, occurrence.youngest)
                : "no range recorded"}
            </dd>
          </>
        )}
        {witness && witness.oldest !== null && witness.youngest !== null && (
          // Its own row, and never in the `age` slot. The witness's range is a
          // fact about a *different taxon* from the one this card is about —
          // putting it where this node's age goes would read as this node's
          // age, which is two wrong claims at once.
          <>
            <dt>witness</dt>
            <dd className="num">
              {endedSpanLabel(witness.oldest, witness.youngest)}
            </dd>
          </>
        )}
        <dt>species below</dt>
        <dd className="num">{detail.tip_count.toLocaleString()}</dd>
        {detail.child_count > 0 && (
          <>
            <dt>branches here</dt>
            <dd className="num">{detail.child_count.toLocaleString()}</dd>
          </>
        )}
        <dt>depth</dt>
        <dd className="num">{detail.depth}</dd>
        {detail.ott_id !== null && (
          <>
            <dt>OTT</dt>
            <dd className="num">{detail.ott_id}</dd>
          </>
        )}
      </dl>

      <NamesBlock vernaculars={detail.vernaculars} synonyms={detail.synonyms} />

      <WhyBlock summary="Why it is drawn this way">
        {detail.tier === TIER_STRUCTURAL && (
          <p className="note">
            No age is shown because none has been estimated for this node. Its
            position on the axis is ordinal — it sits between its nearest dated
            ancestor and descendant, and in this region the horizontal axis means
            nesting depth rather than time.
          </p>
        )}
        {detail.tier === TIER_OCCURRENCE && (
          <p className="note">
            No age is shown because none has been estimated for this node: every
            age here comes from a tree of <em>living</em> species, and this taxon
            has no counterpart in one. What is known instead is where it turns up
            in the rock, which is an observation rather than an estimate — a
            range, and deliberately never a single date.
          </p>
        )}
        {detail.tier === 1 && age && (
          <p className="note">
            This clade is a subset of the one the chronogram dates, so{" "}
            <span className="num">{age}</span> is an upper bound on its true age,
            not an estimate of it.
          </p>
        )}
        {witness && (
          <p className="note">
            The picture is{" "}
            <TaxonLink
              target={
                witness.pbdbTaxonNo !== null ? fossilTarget(witness.pbdbTaxonNo) : null
              }
              onSelect={onSelect}
              rank={witness.rank}
            >
              {witness.name ?? "a taxon from below this fork"}
            </TaxonLink>
            , not this whole group — a fossil taxon from somewhere below this
            fork, and the nearest in time that anyone has drawn. The most
            familiar thing below a split is nearly always a living group that did
            not exist when the split happened, so this shows something that did
            instead. Its dates are observations of where it turns up in the rock,
            never an estimate of when these lineages parted.
            {witness.attachWalk !== null && witness.attachWalk > 0 && (
              // Where the fossil hangs is a separate uncertainty from when it
              // lived, and the card is where both get stated rather than one
              // standing in for the other. It is not in the tree at all — it was
              // placed by walking its own classification upward until something
              // was — so "below this fork" is the strongest true statement.
              <>
                {" "}
                It is not itself in the tree:{" "}
                {witness.attachWalk <= 2
                  ? "it is known to sit just below "
                  : "all that is known is that it belongs somewhere below "}
                <TaxonLink target={witness.attachIdx} onSelect={onSelect}>
                  this point
                </TaxonLink>
                , not where on the branch.
              </>
            )}
            {age === null ? (
              <>
                {" "}
                This fork has no estimated age, so the match was made against
                where it is <em>drawn</em> on the axis rather than against a date.
                Read the pairing loosely: the picture is the closest available,
                not a claim that the two coincide.
              </>
            ) : witness.spans ? (
              <> Its range does contain this split.</>
            ) : (
              // The gap is spelled out rather than left for the reader to
              // subtract, because at these scales rounding hides it: the
              // horse–rhino fork is dated 56.26 Ma and Eohippus tops out at 56.0,
              // so both figures above read "56" and the sentence looks like a
              // contradiction. Saying "by 0.3 Ma" is the only thing that resolves
              // it, and it is worth saying at every size.
              <>
                {" "}
                Its range does not reach this split
                {witness.gapMa !== null && witness.gapMa > 0 ? (
                  <>
                    {" "}
                    — it stops <span className="num">
                      {gapLabel(witness.gapMa)}
                    </span>{" "}
                    short
                  </>
                ) : null}
                . Read the picture as the nearest available, not a contemporary.
              </>
            )}
          </p>
        )}
        {borrowed && (
          <p className="note">
            The silhouette is a drawing of{" "}
            <TaxonLink target={borrowed.source_idx} onSelect={onSelect} rank="species">
              {borrowed.source_name ?? "a relative"}
            </TaxonLink>
            , not of this taxon — nobody has drawn this one, so the closest
            relative anyone has drawn stands in for it
            {borrowed.clade_name ? (
              <>
                . Both are inside{" "}
                <TaxonLink target={borrowed.clade_idx ?? null} onSelect={onSelect}>
                  {borrowed.clade_name}
                </TaxonLink>
                {borrowed.clade_tip_count
                  ? `, ${borrowed.clade_tip_count.toLocaleString()} species`
                  : ""}
                , and that group is the whole of what the picture claims
              </>
            ) : null}
            .
          </p>
        )}
      </WhyBlock>

      {witnessCredit && (
        // Credited on its own terms: a different drawing by a different artist
        // from the one `sil` would have carried, and it is the one on screen.
        <div className="credit">
          Silhouette of <em>{witnessCredit.source_name ?? "a taxon from below this fork"}</em>
          {" — "}
          {witnessCredit.attribution
            ? `by ${witnessCredit.attribution}`
            : "creator not recorded"}
          {witnessCredit.contributor &&
          witnessCredit.contributor !== witnessCredit.attribution
            ? `, uploaded by ${witnessCredit.contributor}`
            : ""}
          .
        </div>
      )}
      {sil && (
        <div className="credit">
          Silhouette{" "}
          {borrowed ? (
            <>
              of <em>{borrowed.source_name ?? "a relative"}</em>
              {" — "}
            </>
          ) : null}
          {sil.attribution ? `by ${sil.attribution}` : "creator not recorded"}
          {sil.contributor && sil.contributor !== sil.attribution
            ? `, uploaded by ${sil.contributor}`
            : ""}
          .{" "}
          <a href={sil.license_url} target="_blank" rel="noreferrer noopener">
            licence
          </a>
        </div>
      )}
    </aside>
  );
}
