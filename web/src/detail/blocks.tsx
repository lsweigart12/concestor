/**
 * The blocks both cards share.
 *
 * A node card and a fossil card answer different questions and deliberately do
 * not have the same anatomy — but "what is this thing" and "what is it inside
 * of" are asked of both, and the answers must look identical when they are the
 * same kind of answer. These live here so they cannot drift.
 */

import { useState } from "react";
import { isScientificItalic } from "../canvas/NodeMark";
import { rankIsInformative, rankProse, type Lineage } from "./classification";
import type { Pending } from "./hooks";
import type { LinkTarget } from "./target";
import type { Encyclopedia } from "./wiki";

/** Opens the card for another taxon. Cards are given one; blocks pass it down. */
export type SelectTaxon = (target: LinkTarget) => void;

/**
 * A name on a card that opens that thing's own card.
 *
 * **Degrades to plain text when there is nothing to point at**, and that is the
 * whole reason this is a component rather than an inline `<button>`. Half the
 * link targets on a card are optional fields — a silhouette's clade is null for
 * the unnamed `mrcaott…` nodes, a witness on an older build carries no PBDB
 * number — and a control that looks clickable and is not is worse than a word.
 *
 * A `<button>` rather than an `<a href>` because there is no document to fetch:
 * this is a selection change, the same one a click on the canvas makes, and it
 * belongs in the same history entry mechanism. The two real anchors on this
 * card (Wikipedia, the licence) leave the app, and looking different from these
 * is correct.
 */
export function TaxonLink({
  target,
  onSelect,
  rank,
  title,
  children,
}: {
  /** Null or undefined renders the children unchanged. */
  target: LinkTarget | null | undefined;
  onSelect?: SelectTaxon | undefined;
  /** Italicises a genus or species, by the same rule the rest of the app uses. */
  rank?: string | null | undefined;
  title?: string | undefined;
  children: React.ReactNode;
}) {
  const italic = isScientificItalic(rank ?? null) ? " sci-italic" : "";
  if (!onSelect || target === null || target === undefined) {
    return italic ? <em className="sci-italic">{children}</em> : <>{children}</>;
  }
  return (
    <button
      type="button"
      className={`taxon-link${italic}`}
      onClick={() => onSelect(target)}
      {...(title ? { title } : {})}
    >
      {children}
    </button>
  );
}

/**
 * The card's own controls: put this on the canvas, or take it off.
 *
 * Directly under the name, above everything a reader might scroll past. The
 * card is reachable from a link now, so it is frequently open on something that
 * is **not drawn** — the whole point of a lineage you can click through is
 * arriving somewhere you have not been — and "add it" is then the only thing
 * the reader wants and the one thing the canvas cannot offer, because there is
 * no mark on it to click.
 *
 * One button, not two. Add and remove are the same question asked of a
 * different state, and a pair with one greyed out spends twice the width to say
 * half as much.
 */
export function CardActions({
  present,
  onAdd,
  onRemove,
  addLabel,
  removeLabel,
  /** Shown under the button. Set where the press changes less than it sounds. */
  hint,
  /** Why adding would do nothing visible. Renders instead of the button. */
  refusal,
}: {
  present: boolean;
  onAdd: () => void;
  onRemove: () => void;
  addLabel: string;
  removeLabel: string;
  hint?: string | undefined;
  refusal?: string | undefined;
}) {
  if (!present && refusal) {
    return <p className="card-actions-refusal">{refusal}</p>;
  }
  return (
    <div className="card-actions">
      <button
        type="button"
        className={present ? "card-action remove" : "card-action add"}
        onClick={present ? onRemove : onAdd}
      >
        <span className="card-action-sign">{present ? "−" : "+"}</span>
        {present ? removeLabel : addLabel}
      </button>
      {!present && hint && <p className="card-action-hint">{hint}</p>}
    </div>
  );
}

/**
 * The description, and the way out to the article.
 *
 * Three states, drawn three ways. Pending is a dim line rather than nothing,
 * because the alternative is a card that silently grows a paragraph a second
 * after the reader started reading it. Absent is nothing at all: "no
 * description available" is a row that says only that a row could have been
 * here.
 *
 * The text is Wikipedia's and is credited as Wikipedia's. That is a licence
 * condition — the extract is CC BY-SA — and it is also the honest framing:
 * everything else on this card is a claim the build makes and this is a claim
 * somebody else makes.
 */
export function EncyclopediaBlock({
  entry,
  /** What the card is about, for the note when the entry is about something broader. */
  subject,
}: {
  entry: Pending<Encyclopedia>;
  subject: string | null;
}) {
  /**
   * Clamped to seven lines until asked otherwise.
   *
   * Not a length preference. Wikipedia's lead on a well-worked article runs to
   * a thousand characters — the one on *Homo sapiens* is six sentences — and at
   * full height it pushed the classification, the ages and the species count
   * off the bottom of the card. The description is why the card was rebuilt and
   * it still may not evict everything the card already answered.
   */
  const [expanded, setExpanded] = useState(false);
  if (entry === undefined) {
    return <p className="wiki-pending">Looking for an encyclopaedia entry…</p>;
  }
  if (entry === null) return null;
  const body = entry.extract ?? entry.gloss;
  // Decided on the string rather than on the rendered height, so the clamp and
  // the button can never disagree — a "Read the rest" under a paragraph that is
  // already whole is the failure mode of measuring one and not the other.
  // 380 characters is about seven lines at this measure; a Wikidata gloss is
  // rarely over 60 and never reaches it.
  const clamped = !expanded && !!body && body.length > 380;
  return (
    <div className="wiki">
      {entry.broaderThanAsked && (
        // Printed above the paragraph, not below it, because it changes what
        // the paragraph is about and a reader who has finished reading has
        // already formed the wrong impression.
        <p className="wiki-scope">
          Wikipedia has no separate entry for{" "}
          <em className="sci-italic">{subject ?? "this taxon"}</em>. This is
          about the genus{" "}
          <em className="sci-italic">{entry.broaderThanAsked}</em>, which it
          belongs to.
        </p>
      )}
      {body && <p className={clamped ? "wiki-extract clamped" : "wiki-extract"}>{body}</p>}
      {clamped && (
        <button type="button" className="wiki-more" onClick={() => setExpanded(true)}>
          Read the rest
        </button>
      )}
      <p className="wiki-links">
        {entry.articleUrl && (
          <a href={entry.articleUrl} target="_blank" rel="noreferrer noopener">
            Wikipedia
          </a>
        )}
        {entry.articleUrl && " · "}
        <a href={entry.wikidataUrl} target="_blank" rel="noreferrer noopener">
          Wikidata
        </a>
        {body && (
          <span className="wiki-licence">
            {" "}
            · text from Wikipedia, CC BY-SA
          </span>
        )}
      </p>
    </div>
  );
}

/**
 * Where this sits in the classification.
 *
 * The ladder is the answer to the question people actually ask, and the full
 * lineage is folded away beneath it — the reverse of what is interesting, and
 * the right way round for what is *looked up*. A reader who wants to know the
 * family wants six rows; a reader who wants to know that they are an
 * opisthokont will open a disclosure to find out.
 *
 * **Every rung is a link**, and the objection that used to stand against that
 * has been answered rather than waived. Most of these ancestors are suppressed
 * from the drawn subtree, so selecting one opens a card for something with no
 * mark on the canvas to highlight — which was a dead end while the card was
 * only a description, and is now the ordinary way to get somewhere: the card
 * carries its own "add to canvas", so a lineage you can click through is a
 * lineage you can walk up and pull from. Selection no longer requires the thing
 * to be drawn.
 */
export function ClassificationBlock({
  lineage,
  onSelect,
  heading = "Classification",
  /**
   * Printed under the heading, before the rows. The fossil card sets it,
   * because what it can classify is not the fossil — see `subjectIsLast`.
   */
  caveat,
}: {
  lineage: Lineage | null;
  onSelect?: SelectTaxon | undefined;
  heading?: string;
  caveat?: React.ReactNode;
}) {
  if (!lineage || lineage.full.length === 0) return null;
  const { ladder, full, missing } = lineage;
  return (
    <section className="classification">
      <h3>{heading}</h3>
      {caveat && <p className="note">{caveat}</p>}
      {ladder.length > 0 ? (
        <dl>
          {ladder.map((n) => (
            <div key={n.idx} className="cl-row">
              <dt>{n.rank}</dt>
              <dd>
                <TaxonLink
                  target={n.key}
                  onSelect={onSelect}
                  rank={n.rank}
                  title={`Open ${n.name}`}
                >
                  {n.name}
                </TaxonLink>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="note">
          Nothing on this lineage carries a Linnaean rank. The named clades above
          it are in the full lineage below.
        </p>
      )}
      {missing.length > 0 && (
        // The human case, and it is not a display bug: the synthesis tree has
        // no ranked order on this path and no Hominidae node at all. Filling
        // the gap from a second taxonomy would put a claim on the card that the
        // tree behind it does not make.
        <p className="note">
          The Open Tree synthesis has no ranked {rankProse(missing)} on this
          lineage — the clades that would sit there are unranked, and are in the
          full lineage.
        </p>
      )}
      <details className="lineage">
        <summary>Full lineage · {full.length}</summary>
        <p className="lineage-chain">
          {full.map((n, i) => (
            <span key={n.idx}>
              {i > 0 && <span className="lineage-sep"> › </span>}
              <TaxonLink
                target={n.key}
                onSelect={onSelect}
                rank={n.rank}
                title={rankIsInformative(n.rank) ? `${n.name} · ${n.rank}` : `Open ${n.name}`}
              >
                {n.name}
              </TaxonLink>
            </span>
          ))}
        </p>
      </details>
    </section>
  );
}

/**
 * The other names this thing goes by.
 *
 * A synonym block is not decoration on a taxonomy browser: the Open Tree files
 * *Homo floresiensis* as a synonym of *Homo sapiens*, and a reader who searched
 * for one and is looking at the other deserves to see the string that connected
 * them rather than to conclude the search misheard.
 */
export function NamesBlock({
  vernaculars,
  synonyms,
}: {
  /** Preferred first. The first is already the card's subtitle, so it is dropped. */
  vernaculars: readonly string[];
  synonyms: readonly string[];
}) {
  const others = vernaculars.slice(1, 9);
  if (others.length === 0 && synonyms.length === 0) return null;
  return (
    <section className="names">
      {others.length > 0 && (
        <p className="note">
          <span className="names-label">Also called</span> {others.join(", ")}.
        </p>
      )}
      {synonyms.length > 0 && (
        <p className="note">
          <span className="names-label">Filed also as</span>{" "}
          <em className="sci-italic">{synonyms.slice(0, 8).join(", ")}</em>.
        </p>
      )}
    </section>
  );
}

/**
 * The provenance notes, folded away.
 *
 * Everything in here was on the face of the card and is now one disclosure
 * below the facts. It is not less true and it has not been shortened — a tier
 * that shows no number still has to say why, and a picture of a different taxon
 * still has to say so. What changed is the order: a reader who clicked a badger
 * wants to know what a badger is first, and *how confident the axis is about
 * when badgers began* second.
 *
 * The one thing that stays outside is a divergence's derived name, because for
 * an unnamed node that sentence is not provenance — it is the only identity the
 * node has.
 */
export function WhyBlock({
  children,
  summary,
}: {
  children: React.ReactNode;
  summary: string;
}) {
  // `children` is a fragment of conditionals and is frequently entirely false,
  // which renders as an empty disclosure that opens onto nothing.
  const any = Array.isArray(children)
    ? children.some((c) => c !== false && c !== null && c !== undefined)
    : Boolean(children);
  if (!any) return null;
  return (
    <details className="why">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
