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
  removeKeys?: string | undefined;
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
        {present && removeKeys && <span className="kbd">{removeKeys}</span>}
      </button>
      {!present && hint && <p className="card-action-hint">{hint}</p>}
    </div>
  );
}

/**
 * The card, before the card.
 *
 * The alternative it replaces was not a blank panel — it was the *previous*
 * taxon's card, left standing because the fetch that would replace it had not
 * come back yet. A link on a card mostly points at something the app has never
 * asked about (a classification rung three levels above anything drawn, the
 * fossil behind a witness), so this is the ordinary path rather than an edge
 * case, and the failure it produced was the quiet kind: a complete, plausible,
 * confidently-numbered card about the wrong animal.
 *
 * Empty except for the line, and deliberately. A skeleton of grey bars would
 * predict a shape this cannot know — the card has an image or it has not, a
 * description or none, five ranks or twenty — and every one of those guesses
 * would be wrong often enough to read as the layout settling.
 */
export function CardPending({ children }: { children: React.ReactNode }) {
  return (
    <aside className="detail detail-pending">
      <PendingLine>{children}</PendingLine>
    </aside>
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
  /**
   * Three states, not two, for the same reason the encyclopaedia block has
   * three: `undefined` is *still coming* and `null` is *there is no answer*,
   * and collapsing them makes the heading appear a beat after the card does,
   * pushing everything below it down under the reader's eye. A broken taxon has
   * no single path — that is what broken means — and it must not spend the
   * session claiming one is on the way.
   */
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
 * The other names this thing goes by, on the face of the card.
 *
 * **This is a ranked list and it is presented as one.** It used to be an 11.5px
 * comma-run in a `.note`, filed at the bottom beside the scientific synonyms —
 * which was the right place while the order was arbitrary and the content was
 * therefore trivia. It is not arbitrary now: `usage_rank` orders these by how
 * the name is actually used, measured against English Wikipedia's title and
 * redirect graph, so *"what else do people call this"* is an answer rather than
 * a bag of strings. Answers go above the fold.
 *
 * It sits **above the description** for the same reason the description sits
 * above the provenance: a reader who clicked a badger wants to know what a
 * badger is called before they read four sentences about badgers, and this is
 * the one block on the card that is short enough to be read at a glance.
 *
 * Names are separated by a dot rather than a comma because several of them
 * contain commas of their own, and rendered as discrete items so the list reads
 * as *names* rather than as prose. No brightness ramp down the list, tempting
 * as it is with a ranking in hand: the design language reserves luminance for
 * selection, and order already carries the ranking.
 *
 * **One row, then "+N more".** Carnivora carries eight of these and *Cavia
 * porcellus* five, so left to wrap freely the block costs three lines above the
 * description — which is the space the promotion was supposed to buy for the
 * description in the first place. One row is the compromise the ranking earns:
 * the names that fit are the ones the evidence put first, and the rest are one
 * press away.
 *
 * How many fit is **measured, not guessed**. The card is 360px on desktop and
 * full-width on narrow, and these strings run from `cat` to
 * `Artiodactylamorpha`, so any fixed count is wrong on one of them.
 * `fitOneRow` does the arithmetic and is tested; this component only feeds it
 * boxes.
 */
export function AlsoCalledBlock({
  vernaculars,
}: {
  /**
   * **Most used first**, and the order is the pipeline's — `usage_rank`,
   * measured against English Wikipedia's title and redirect graph. Read
   * positionally and never re-sorted: `[0]` is already the card's subtitle, so
   * it is dropped here, and what follows is a ranking rather than a bag.
   *
   * That is why `man` and `men` come last on *Homo sapiens* rather than second
   * and third. Both are names for humans and neither is removed, but the
   * article `Man` is not the article this taxon sits at, so both are demoted.
   */
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
    // Differenced against the first item rather than read raw: `offsetLeft`
    // and `offsetTop` are relative to the offset parent, which is the
    // positioned card, so absolute values would carry the card's own padding
    // and position into the arithmetic.
    const originLeft = nodes[0]!.offsetLeft;
    const originTop = nodes[0]!.offsetTop;
    const boxes = nodes.map((n) => ({
      left: n.offsetLeft - originLeft,
      top: n.offsetTop - originTop,
      width: n.offsetWidth,
    }));
    // The gap is folded into the reserve because `fitOneRow` deliberately
    // knows nothing about the layout's spacing. The measured control carries
    // the **widest** label it could ever end up with, so the reserve can only
    // be generous and the row can never overflow.
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
 * The scientific names this thing is *filed* under, which is a different
 * question and stays where it was.
 *
 * A synonym block is not decoration on a taxonomy browser: the Open Tree files
 * *Homo floresiensis* as a synonym of *Homo sapiens*, and a reader who searched
 * for one and is looking at the other deserves to see the string that connected
 * them rather than to conclude the search misheard. But it answers *why did I
 * land here*, not *what is this* — so it belongs down with the provenance,
 * unlike the common names it used to share a block with.
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
