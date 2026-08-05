/**
 * Which card is open, and what is on it.
 *
 * Two fetches and two placeholders for two cards that are never both up, and
 * the reason they are two rather than one parameterised by kind is that they
 * show different things: a node card has an age, a tip count and an ancestry,
 * and a fossil card has none of the three and carries a drawing's credit
 * instead. `Detail.tsx` and `FossilCard.tsx` are separate components for the
 * same reason.
 *
 * What this owes its caller beyond the payloads is `open` — see below. The
 * canvas reframes around a card, so *is there a panel over the top right* has
 * to be answered from the same expression that draws it or the two drift.
 *
 * Distinct from `hooks.ts` next door, which is the pair of hooks a card calls
 * for itself once it is already on screen. This decides whether there is a card.
 */

import { useEffect, useState } from "react";
import { api, type FossilDetail, type NodeDetail } from "../api";
import { usePending } from "../chrome/Pending";
import { toApiKey } from "../state/store";

export interface Cards {
  detail: NodeDetail | null;
  fossilDetail: FossilDetail | null;
  cardPending: boolean;
  fossilCardPending: boolean;
  /**
   * Is a card on screen, over the top-right of the canvas?
   *
   * Computed once and used both by the chrome and by the canvas, which reframes
   * around it — see `canvas/viewport.ts`. Derived from the render conditions
   * rather than from the selection, because a selection does not always produce
   * a card: a broken taxon answers `/v1/node` with a payload the card refuses,
   * and a canvas that had reserved a corner for it would leave a hole with
   * nothing in it. Every one of the four states it covers wears `.detail` and so
   * occupies the same rectangle.
   */
  cardOpen: boolean;
}

/**
 * @param nodeKey  the key the node card is about, or null. Not an index: a card
 *   reached by a link is very often a taxon that is nowhere on the canvas, so
 *   this asks the API directly rather than resolving through what is drawn.
 * @param taxonNo  the focused fossil's PBDB number, or null. Non-null is what
 *   makes this a fossil card rather than a node one, and the two are mutually
 *   exclusive by construction — `App.tsx` derives `nodeKey` as null whenever
 *   this is set.
 */
export function useCards(
  nodeKey: string | null,
  taxonNo: number | null,
): Cards {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  /**
   * The key whose card is being fetched, or null.
   *
   * Separate from `detail` because the two are about different taxa during the
   * fetch, and that gap is the whole reason this exists. A card reached by a
   * link — a classification rung, a witness, a watermark — is very often one
   * the app has never asked about, so the request is a real round trip, and
   * until it lands the *previous* taxon's card is still on screen answering as
   * if it were the one just clicked. Every figure on it is wrong and none of it
   * looks wrong.
   */
  const [fetchingKey, setFetchingKey] = useState<string | null>(null);

  useEffect(() => {
    if (!nodeKey) {
      setDetail(null);
      setFetchingKey(null);
      return;
    }
    let cancelled = false;
    setFetchingKey(nodeKey);
    const done = () => !cancelled && setFetchingKey(null);
    api
      .node(toApiKey(nodeKey))
      .then((d) => {
        // `/v1/node` explains a broken taxon rather than 404ing, and that
        // payload has no `idx` — rendering it as a card would print `undefined`
        // against every figure. The canvas already announces broken taxa in the
        // reader's language; here the card simply does not open.
        if (!cancelled) setDetail(typeof d.idx === "number" ? d : null);
        done();
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
        done();
      });
    return () => {
      cancelled = true;
    };
  }, [nodeKey]);

  const [fossilDetail, setFossilDetail] = useState<FossilDetail | null>(null);
  const [fetchingFossil, setFetchingFossil] = useState(false);

  // The fossil card's own payload. A separate fetch from the node card's and a
  // separate piece of state, because the two cards show different things: this
  // one carries the drawing's credit and the attachment point's name, and has
  // no age, no tip count and no ancestry to show.
  useEffect(() => {
    if (taxonNo === null) {
      setFossilDetail(null);
      setFetchingFossil(false);
      return;
    }
    let cancelled = false;
    setFetchingFossil(true);
    const done = () => !cancelled && setFetchingFossil(false);
    api
      .fossil(taxonNo)
      .then((d) => {
        if (!cancelled) setFossilDetail(d);
        done();
      })
      .catch(() => {
        if (!cancelled) setFossilDetail(null);
        done();
      });
    return () => {
      cancelled = true;
    };
  }, [taxonNo]);

  /**
   * Whether a card is worth showing a placeholder for, and which one.
   *
   * Gated on {@link usePending} rather than on the request itself: `/v1/node`
   * and `/v1/fossil` are memoised for the session, so a taxon the reader has
   * already looked at answers in the frame they clicked in, and swapping a
   * complete card for a placeholder and back inside one frame is a flicker
   * bought with nothing. What survives the delay is the case this is for — a
   * name on a card that nobody has opened before.
   */
  const cardPending = usePending(fetchingKey !== null);
  const fossilCardPending = usePending(fetchingFossil);

  const nodeCardOpen = taxonNo === null && (cardPending || detail !== null);
  const fossilCardOpen =
    taxonNo !== null && (fossilCardPending || fossilDetail !== null);

  return {
    detail,
    fossilDetail,
    cardPending,
    fossilCardPending,
    cardOpen: nodeCardOpen || fossilCardOpen,
  };
}
