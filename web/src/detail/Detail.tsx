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
 *
 * That exemption covers the sentence and not the paragraph around it. The
 * clauses that used to trail it and the nested-selection note explained what
 * those notes were doing rather than saying anything about the taxon, and the
 * add button's hint explained why a press keeps a fork the reader had not yet
 * wondered about — all of it read before the name, all of it gone. The
 * provenance paragraphs in the disclosure are the ones that may not be cut:
 * each stops a specific wrong reading, and none of these did.
 */

import { gapLabel } from "../ages";
import {
  TIER_CURATED,
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
  type NodeDetail,
} from "../api";
import { bracketGeom, endedSpanLabel } from "../canvas/Bracket";
import { Silhouette } from "../canvas/Silhouette";
import { kbd } from "../chrome/bindings";
import { mayDrawExemplar, witnessOn } from "../canvas/witness";
import { ageLabel, DerivedName, isScientificItalic } from "../canvas/NodeMark";
import { branchProse, UNNAMED, type Divergence } from "../tree/naming";
import {
  CardActions,
  ClassificationBlock,
  EncyclopediaBlock,
  AlsoCalledBlock,
  FoldedBlock,
  NamesBlock,
  TaxonLink,
  WhyBlock,
  type SelectTaxon,
} from "./blocks";
import { rankIsInformative } from "./classification";
import { useEncyclopedia, useLineage } from "./hooks";
import { fossilTarget } from "./target";
import { spreadProse, type SpreadEnd, type SpreadProse } from "./spread";

/**
 * The bound, named and linked, or the unnamed-divergence phrase in its place.
 *
 * An `mrcaott…` bound has no name — 24.4% of them — and dropping it would leave
 * the sentence with one end. It is still a node the reader can open, so it is
 * still a link; only the words change.
 *
 * The article is outside the link and only on the unnamed form, because "spread
 * between unnamed divergence and Brunellia" is not a sentence, while "between
 * *an* unnamed divergence and *Brunellia*" is — a proper name takes no article
 * and a description does.
 */
function Bound({ end, onSelect }: { end: SpreadEnd; onSelect: SelectTaxon }) {
  const link = (
    <TaxonLink target={end.key} onSelect={onSelect} rank={end.rank}>
      {end.name ?? UNNAMED}
    </TaxonLink>
  );
  return end.name ? link : <>an {link}</>;
}

/**
 * Where this node was drawn, in the terms the build can actually support.
 *
 * The four cases are `spread.ts`'s, and the reason there are four rather than
 * one sentence is there too: the phrase this replaced was true of 2.8% of the
 * nodes it appeared on. Nothing here is hedged — each form states a fact the
 * reader can check against the axis in front of them.
 */
function SpreadSentence({
  spread,
  onSelect,
}: {
  spread: SpreadProse;
  onSelect: SelectTaxon;
}) {
  if (!spread) {
    // No bound to name. The surrounding paragraph still says what is missing
    // and why, which is the part that matters; this clause simply does not run.
    return null;
  }
  if (spread.kind === "between") {
    return (
      <>
        It is spread between <Bound end={spread.above} onSelect={onSelect} /> (
        {spread.above.age}) above it and{" "}
        <Bound end={spread.below} onSelect={onSelect} /> ({spread.below.age})
        below, by how many undated steps lie on either side.
      </>
    );
  }
  if (spread.kind === "toPresent") {
    return (
      <>
        It is spread between <Bound end={spread.above} onSelect={onSelect} /> (
        {spread.above.age}) above it and the present below: every age here comes
        from a chronogram of <em>living</em> species, so nothing beneath this
        node carries a date to anchor the older end.
      </>
    );
  }
  return (
    <>
      Its nearest dated relative,{" "}
      <Bound end={spread.above} onSelect={onSelect} />, is itself at the
      present, so there is no span to spread into and the two are drawn at the
      same point.
    </>
  );
}

/**
 * True where the node sits inside a run the axis cannot read as time.
 *
 * The `collapsed` case is the exception and it has to be: the node was placed
 * *on* its dated relative because there was no gap between them, so there is no
 * stretch for a reader to be warned about. Printing "through this stretch the
 * axis reads as nesting order" over a node with no stretch describes a region
 * that is not on screen.
 */
function hasOrdinalStretch(spread: SpreadProse): boolean {
  return spread === null || spread.kind !== "collapsed";
}

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
  onBrowse,
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
  /**
   * Opens the palette fenced to this taxon — the card's door into the
   * drill-down. Null where there is nothing to browse (a single species) or
   * nothing to put on the chip (an unnamed divergence).
   */
  onBrowse: (() => void) | null;
}) {
  const age = ageLabel(detail.age_ma, detail.tier);
  // Which dated taxa the position came from. Null on every dated node and on a
  // build predating the field, and the paragraph reads correctly without it.
  const spread = spreadProse(detail.layout_spread);
  // Geometry is not wanted here — the card states the span in words — but
  // `bracketGeom` is what decides `absent` from `range`, and having one place
  // make that call keeps the card and the drill-down lane from disagreeing
  // about what a partial row means.
  const occurrence =
    detail.tier === TIER_OCCURRENCE && detail.occurrence
      ? bracketGeom(detail.occurrence, () => 0)
      : null;
  // The card shows what the canvas shows: a divergence draws its witness or
  // nothing, only a chosen clade draws its group's exemplar.
  const place = { node: detail, isLeaf };
  const witness = witnessOn(place);
  const witnessCredit = witness ? (detail.divergence_silhouette ?? null) : null;
  const sil = mayDrawExemplar(place) ? detail.silhouette : null;
  // A picture whose source_idx is not this node depicts something inside the
  // clade. `clade_name` is null for unnamed `mrcaott…` nodes.
  const borrowed = sil && sil.source_idx !== detail.idx ? sil : null;
  // The watermark names the clade the resemblance is claimed across, except
  // where that clade is the node itself (an unillustrated group), when the
  // drawing's own subject is named instead.
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
  const entry = useEncyclopedia({
    qid: detail.wikidata_qid ?? null,
    name: detail.name,
  });
  // The word a reader actually knows. Preferred-first, so this is the headline
  // name rather than whichever alias sorted first, and it sits *under* the
  // scientific name rather than replacing it: the canvas label and the palette
  // row both say "Felidae", and a card that answered to "cat" instead would
  // make the reader check they had clicked the right thing.
  const common = divergence ? null : (detail.vernaculars[0] ?? null);

  return (
    // One name for the slot rather than the subject's own — see
    // `detail/blocks.tsx`. The subject is the `h2` immediately inside it.
    <aside
      className="detail"
      aria-label="Selection"
      style={{ color: `hsl(${hue} 60% 62%)` }}
    >
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
                  witness.pbdbTaxonNo !== null
                    ? fossilTarget(witness.pbdbTaxonNo)
                    : null
                }
                onSelect={onSelect}
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
              <TaxonLink target={watermarkIdx} onSelect={onSelect}>
                {watermark}
              </TaxonLink>
            </span>
          )}
        </div>
      )}
      <h2
        className={
          !divergence && isScientificItalic(detail.rank)
            ? "sci-italic"
            : undefined
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
        rankIsInformative(detail.rank) && (
          <div className="rank">{detail.rank}</div>
        )
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

        The key rides on the remove state only, and it is honest there for the
        same reason the control bar's is: `remove` fires on `induced.leaves`,
        which is the selection, which is the state `inSelection` puts this
        button in. The fossil card passes none — a graft's index is negative,
        so the handler resolves no node and the press does nothing.
      */}
      <CardActions
        present={inSelection}
        onAdd={onAdd}
        onRemove={onRemove}
        addLabel={isDrawn ? "Pin to the canvas" : "Add to the canvas"}
        removeLabel="Remove from the canvas"
        removeKeys={kbd("remove")}
      />

      {divergence && (
        // Stays on the face of the card. For a node the taxonomy never named,
        // this sentence is the name.
        <p className="note">
          The Open Tree taxonomy has no name for this node, so it is described
          by what it separates: it is the last common ancestor of{" "}
          {branchProse(divergence.branches)}.
        </p>
      )}
      {nested.length > 0 && (
        // Also primary: it is about the reader's own selection, and answers
        // "why is the species I picked drawn as a fork".
        <p className="note">
          {branchProse(nested)}{" "}
          {nested.length === 1 ? "is classified" : "are classified"} inside this
          taxon rather than beside it, so the branch to{" "}
          {nested.length === 1 ? "it" : "them"} leaves from here.
        </p>
      )}

      {/* Above the description, and that is the point of ranking them.
          `usage_rank` makes this a ranked answer to "what else is this
          called" rather than an arbitrary list, and an answer that short
          should not be below four sentences of encyclopaedia. The scientific
          synonyms stay at the bottom: they answer "why did I land here",
          which is provenance. */}
      <AlsoCalledBlock vernaculars={detail.vernaculars} />

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
            <dd className="num">
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
        <dd className="num">
          {detail.tip_count.toLocaleString()}
          {onBrowse && (
            // The number, made walkable: the same drill-down Tab reaches in
            // the palette, entered from the card about the group. A button
            // beside the figure rather than on it, so the fact stays a fact.
            <button type="button" className="fact-browse" onClick={onBrowse}>
              browse
            </button>
          )}
        </dd>
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

      <FoldedBlock folded={detail.folded_infraspecific ?? []} />
      <NamesBlock synonyms={detail.synonyms} />

      <WhyBlock summary="Sources and caveats">
        {detail.tier === TIER_STRUCTURAL && (
          <p className="note">
            No age: the Duke et al. chronogram carries no date for this node.
            Its branching is the Open Tree synthesis's and is unaffected — what
            it changes is only where the mark sits along the axis.{" "}
            <SpreadSentence spread={spread} onSelect={onSelect} />
            {hasOrdinalStretch(spread) && (
              <>
                {" "}
                Through this stretch the axis reads as nesting order rather than
                time.
              </>
            )}
          </p>
        )}
        {detail.tier === TIER_OCCURRENCE && (
          <p className="note">
            No age: the Duke et al. chronogram dates <em>living</em> species,
            and this taxon has no counterpart among them. Its date comes from
            the Paleobiology Database instead — where it is found in the rock,
            which is an observation rather than an estimate of when lineages
            parted. Shown as a range, and deliberately never a single date.
          </p>
        )}
        {detail.tier === 1 && age && (
          <p className="note">
            This clade is a subset of the one the chronogram dates, so{" "}
            <span className="num">{age}</span> is an upper bound on its true
            age, not an estimate of it.
          </p>
        )}
        {detail.tier === TIER_CURATED && age && (
          <p className="note">
            This split is curated rather than computed: the chronogram cannot
            see it because its taxonomy files these lineages inside one species.{" "}
            <span className="num">{age}</span> is the genomic estimate of Prüfer
            et&nbsp;al. (2017), carried by the build with the branching it
            dates.
          </p>
        )}
        {witness && (
          <p className="note">
            The picture is{" "}
            <TaxonLink
              target={
                witness.pbdbTaxonNo !== null
                  ? fossilTarget(witness.pbdbTaxonNo)
                  : null
              }
              onSelect={onSelect}
              rank={witness.rank}
            >
              {witness.name ?? "a taxon from below this fork"}
            </TaxonLink>
            , not this whole group — a fossil taxon from somewhere below this
            fork, and the nearest in time that PhyloPic has drawn. The most
            familiar thing below a split is nearly always a living group that
            did not exist when the split happened, so this shows something that
            did instead. Its dates are observations of where it turns up in the
            rock, never an estimate of when these lineages parted.
            {witness.attachWalk !== null && witness.attachWalk > 0 && (
              // Where the fossil hangs is a separate uncertainty from when it
              // lived, and the card is where both get stated rather than one
              // standing in for the other. It is not in the tree at all — it was
              // placed by walking its own classification upward until something
              // was — so "below this fork" is the strongest true statement.
              <>
                {" "}
                It is not itself in the tree. PBDB's classification was walked
                upward until it reached one, which puts it{" "}
                {witness.attachWalk <= 2 ? "just below " : "somewhere below "}
                <TaxonLink target={witness.attachIdx} onSelect={onSelect}>
                  this point
                </TaxonLink>
                , not at a spot on the branch.
              </>
            )}
            {age === null ? (
              <>
                {" "}
                The chronogram carries no date for this fork, so the match was
                made against where it is <em>drawn</em> on the axis rather than
                against a date. Read the pairing loosely: the picture is the
                closest available, not a claim that the two coincide.
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
                    — it stops{" "}
                    <span className="num">{gapLabel(witness.gapMa)}</span> short
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
            <TaxonLink
              target={borrowed.source_idx}
              onSelect={onSelect}
              rank="species"
            >
              {borrowed.source_name ?? "a relative"}
            </TaxonLink>
            , not of this taxon — PhyloPic has no drawing of this one, so the
            closest relative it does have stands in for it
            {borrowed.clade_name ? (
              <>
                . Both are inside{" "}
                <TaxonLink
                  target={borrowed.clade_idx ?? null}
                  onSelect={onSelect}
                >
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
          Silhouette of{" "}
          <em>{witnessCredit.source_name ?? "a taxon from below this fork"}</em>
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
