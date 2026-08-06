/**
 * The blocks both cards share.
 *
 * A node card and a fossil card answer different questions and deliberately do
 * not have the same anatomy — but "what is this thing" and "what is it inside
 * of" are asked of both, and the answers must look identical when they are the
 * same kind of answer. These live here so they cannot drift.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { PendingLine } from "../chrome/Pending";
import { useTip } from "../chrome/Tooltip";
import { isScientificItalic } from "../canvas/NodeMark";
import { rankIsInformative, rankProse, type Lineage } from "./classification";
import type { Pending } from "./hooks";
import { fitOneRow } from "./oneRow";
import type { LinkTarget } from "./target";
import type { Encyclopedia } from "./wiki";

/** Opens the card for another taxon. Cards are given one; blocks pass it down. */
export type SelectTaxon = (target: LinkTarget) => void;

/**
 * A name on a card that opens that thing's own card. Degrades to plain text when
 * there is no target (many are optional fields), so a word that cannot be
 * clicked is not drawn as a control. A `<button>`, not an `<a>`: it is a
 * selection change, not a document fetch.
 */
export function TaxonLink({
  target,
  onSelect,
  rank,
  tip,
  children,
}: {
  /** Null or undefined renders the children unchanged. */
  target: LinkTarget | null | undefined;
  onSelect?: SelectTaxon | undefined;
  /** Italicises a genus or species, by the same rule the rest of the app uses. */
  rank?: string | null | undefined;
  /** The hover explanation, where the link's own words are not the whole of it. */
  tip?: string | undefined;
  children: React.ReactNode;
}) {
  const italic = isScientificItalic(rank ?? null) ? " sci-italic" : "";
  const hover = useTip(tip);
  if (!onSelect || target === null || target === undefined) {
    return italic ? (
      <em className="sci-italic">{children}</em>
    ) : (
      <>{children}</>
    );
  }
  return (
    <button
      type="button"
      className={`taxon-link${italic}`}
      onClick={() => onSelect(target)}
      {...hover}
    >
      {children}
    </button>
  );
}

/**
 * The card's own controls: put this on the canvas, or take it off. Under the
 * name, because a card reached from a link is often open on an undrawn taxon
 * whose only useful action is "add". One button, not two — add and remove are
 * one question asked of a different state.
 */
export function CardActions({
  present,
  onAdd,
  onRemove,
  addLabel,
  removeLabel,
  /**
   * How the key that also removes prints, where one exists.
   *
   * Only the remove state can carry it: there is no key that adds, and adding
   * is the state a taxon reached by a link is usually in. Pass it from
   * `bindings.ts` rather than typing the glyph, so this cannot print a key the
   * table has moved — and pass nothing where the press would do nothing, which
   * is a badge that lies about a surface the reader is looking straight at.
   */
  removeKeys,
  /** Why adding would do nothing visible. Renders instead of the button. */
  refusal,
}: {
  present: boolean;
  onAdd: () => void;
  onRemove: () => void;
  addLabel: string;
  removeLabel: string;
  removeKeys?: string | undefined;
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
        {present && removeKeys && <span className="kbd">{removeKeys}</span>}
      </button>
    </div>
  );
}

/**
 * The card, before the card. Shown instead of leaving the previous taxon's card
 * standing while the next resolves — which would be a plausible card about the
 * wrong animal, since a link often points at something never fetched. Empty but
 * for the line: a skeleton would predict a shape this cannot know.
 */
export function CardPending({ children }: { children: React.ReactNode }) {
  return (
    // Named the same in all three states, since the landmark is the slot.
    <aside className="detail detail-pending" aria-label="Selection">
      <PendingLine>{children}</PendingLine>
    </aside>
  );
}

/**
 * The description, and the way out to the article. Three states: pending is a
 * dim line (not a paragraph that appears a second later), absent is nothing. The
 * text is Wikipedia's and is credited as such — a CC BY-SA condition, and the
 * honest framing for the one claim on the card the build does not make.
 */
export function EncyclopediaBlock({
  entry,
  /** What the card is about, for the note when the entry is about something broader. */
  subject,
}: {
  entry: Pending<Encyclopedia>;
  subject: string | null;
}) {
  // Clamped to seven lines until asked otherwise, or a long lead pushes the
  // classification and ages off the bottom of the card.
  const [expanded, setExpanded] = useState(false);
  if (entry === undefined) {
    return (
      <PendingLine className="wiki-pending">
        Looking for an encyclopaedia entry…
      </PendingLine>
    );
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
      {body && (
        <p className={clamped ? "wiki-extract clamped" : "wiki-extract"}>
          {body}
        </p>
      )}
      {clamped && (
        <button
          type="button"
          className="wiki-more"
          onClick={() => setExpanded(true)}
        >
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
          <span className="wiki-licence"> · text from Wikipedia, CC BY-SA</span>
        )}
      </p>
    </div>
  );
}

/**
 * Where this sits in the classification: the ladder up front, the full lineage
 * folded away beneath. Every rung is a link — most ancestors are undrawn, but
 * the card carries its own "add to canvas", so selection no longer requires a
 * mark to highlight.
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
  /** `undefined` is still coming, `null` is no answer (a broken taxon). */
  lineage: Pending<Lineage>;
  onSelect?: SelectTaxon | undefined;
  heading?: string;
  caveat?: React.ReactNode;
}) {
  if (lineage === undefined) {
    return (
      <section className="classification">
        <h3>{heading}</h3>
        <PendingLine className="cl-pending">
          Looking up where this sits in the classification…
        </PendingLine>
      </section>
    );
  }
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
                  tip={`Open ${n.name}`}
                >
                  {n.name}
                </TaxonLink>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="note">
          Nothing on this lineage carries a Linnaean rank. The named clades
          above it are in the full lineage below.
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
                tip={
                  rankIsInformative(n.rank)
                    ? `${n.name} · ${n.rank}`
                    : `Open ${n.name}`
                }
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
 * The other names this thing goes by, a ranked list on the face of the card
 * (`usage_rank` order, so it is an answer rather than a bag). Above the
 * description, since it reads at a glance. Names dot-separated (several contain
 * commas), no brightness ramp (luminance is reserved for selection). One row
 * then "+N more"; how many fit is measured by `fitOneRow`, not guessed.
 */
export function AlsoCalledBlock({
  vernaculars,
}: {
  /** Most used first (`usage_rank`), read positionally; `[0]` is the subtitle. */
  vernaculars: readonly string[];
}) {
  const others = vernaculars.slice(1, 9);
  const measureRef = useRef<HTMLParagraphElement | null>(null);
  /** How many fit on row one. `null` until the hidden row has been measured. */
  const [fit, setFit] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  // A new card is a new list. Keyed on the content rather than on a node id,
  // because this component is not told which node it is for and a stale fit
  // from the previous taxon would clip the new one at the wrong name.
  const listKey = others.join(" ");

  const measure = useCallback(() => {
    const el = measureRef.current;
    if (!el) return;
    const nodes = [...el.querySelectorAll<HTMLElement>(".also-called-item")];
    const more = el.querySelector<HTMLElement>(".also-called-more");
    if (nodes.length === 0) return;
    // Differenced against the first item: offsets are relative to the positioned
    // card, so raw values would carry its padding into the arithmetic.
    const originLeft = nodes[0]!.offsetLeft;
    const originTop = nodes[0]!.offsetTop;
    const boxes = nodes.map((n) => ({
      left: n.offsetLeft - originLeft,
      top: n.offsetTop - originTop,
      width: n.offsetWidth,
    }));
    // The gap is folded into the reserve; `fitOneRow` knows nothing of spacing.
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    const reserve = (more?.offsetWidth ?? 0) + gap;
    setFit(fitOneRow(boxes, reserve, el.clientWidth));
  }, []);

  useLayoutEffect(() => {
    setExpanded(false);
    measure();
  }, [listKey, measure]);

  // The card is 360px on desktop and spans the viewport on narrow, so a
  // rotation or a window drag changes the answer. The observed element is the
  // hidden twin, whose content never changes, so this fires on a real resize
  // and not on our own collapsing.
  useEffect(() => {
    const el = measureRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  if (others.length === 0) return null;

  const shown = expanded || fit === null ? others : others.slice(0, fit);
  const hidden = others.length - shown.length;

  /*
    The separator trails its name rather than leading the next one: leading it
    means a wrapped line *starts* with a dot, and Carnivora's second line read
    "· Digitigrada".

    Binding the two with `white-space: nowrap` is then not enough on its own —
    it puts every space inside a nowrap span, leaving the line no break
    opportunity at all, and the list stops wrapping and overflows the card. The
    parent is a wrapping flex row so the gap is layout rather than whitespace,
    and the break points no longer depend on where the spaces happen to be.
  */
  const items = (list: readonly string[]) =>
    list.map((n, i) => (
      <span key={n} className="also-called-item">
        {n}
        {i < list.length - 1 && <span className="also-called-sep"> ·</span>}
      </span>
    ));

  return (
    <section className="also-called">
      <div className="names-label">Also called</div>
      {/*
        A hidden twin holding the *whole* list, and the only thing measured.

        Measuring the visible row instead is the obvious design and it does not
        converge: collapsing the row changes what is laid out, so the next
        measurement sees a different list, re-expands, and measures again. The
        first attempt did exactly that and settled on never collapsing — every
        name across two rows with no control, looking for all the world like
        the measurement had decided it all fitted.

        This twin never changes. Its width tracks the card and its content is
        fixed, so the observer fires only when the card is genuinely resized.
      */}
      <p
        className="also-called-list also-called-measure"
        ref={measureRef}
        aria-hidden
      >
        {items(others)}
        <span className="also-called-more">+{others.length} more</span>
      </p>
      <p className="also-called-list">
        {items(shown)}
        {hidden > 0 && (
          <button
            type="button"
            className="also-called-more"
            // One-way, like the description's "Read the rest" a few lines
            // below it. Two controls that look alike and behave differently
            // cost more than the re-collapse nobody asked for.
            onClick={() => setExpanded(true)}
          >
            +{hidden} more
          </button>
        )}
      </p>
    </section>
  );
}

/**
 * The scientific names this thing is filed under. Answers "why did I land here"
 * (OTT files *Homo floresiensis* as a synonym of *Homo sapiens*), so it sits
 * down with the provenance rather than with the common names.
 */
export function NamesBlock({ synonyms }: { synonyms: readonly string[] }) {
  if (synonyms.length === 0) return null;
  return (
    <section className="names">
      <p className="note">
        <span className="names-label">Filed also as</span>{" "}
        <em className="sci-italic">{synonyms.slice(0, 8).join(", ")}</em>.
      </p>
    </section>
  );
}

/**
 * The provenance notes, folded away below the facts — the caveats about tier and
 * placement, moved but not shortened. A divergence's derived name stays outside,
 * being the node's only identity rather than provenance.
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
