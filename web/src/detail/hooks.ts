/**
 * The two asynchronous things a card wants that a card is not given.
 *
 * Both follow the same rule: the card renders complete without them and grows
 * when they land. Neither is awaited before anything is drawn, because the
 * click that opened the card has already been answered by the data the app
 * holds — a selection resolves in the same frame, and a spinner over facts we
 * already have would be a regression dressed as feedback.
 *
 * That last sentence is now enforced rather than merely asserted. Both hooks
 * report `undefined` only once the request has outlived `PENDING_DELAY_MS`;
 * before that they report `null`, which every block renders as nothing at all.
 * `/v1/path` in particular is *already in the cache* by the time the card
 * mounts — the selection that opened it fetched the same URL — so without the
 * gate the classification block would announce a lookup it had already done,
 * for one frame, on every card.
 */

import { useEffect, useState } from "react";
import { api } from "../api";
import { usePending } from "../chrome/Pending";
import { lineageOf, type Lineage } from "./classification";
import { lookup, type Encyclopedia, type WikiQuery } from "./wiki";

/**
 * `undefined` while the request is out, `null` once there is no answer.
 *
 * Three states rather than two because the block has three appearances and one
 * of them is a lie if collapsed into another: pending must not render "no
 * description", and "no description" must not render as pending forever.
 */
export type Pending<T> = T | null | undefined;

/**
 * Pending, but only once the waiting is worth saying out loud.
 *
 * A request that has not yet earned an indicator is reported as *absent*
 * rather than as *coming*, because absent is the state that renders nothing —
 * and nothing is the correct picture of a wait the reader is not having. The
 * ordering never runs backwards: a block goes silent → pending → answered, and
 * for a cached answer it skips the middle rung entirely.
 */
function whileSlow<T>(state: Pending<T>, slow: boolean): Pending<T> {
  return state === undefined && !slow ? null : state;
}

export function useEncyclopedia(q: WikiQuery): Pending<Encyclopedia> {
  const qid = q.qid ?? null;
  const name = q.name ?? null;
  const [state, setState] = useState<Pending<Encyclopedia>>(undefined);
  useEffect(() => {
    if (!qid && !name) {
      setState(null);
      return;
    }
    let cancelled = false;
    setState(undefined);
    lookup({ qid, name })
      .then((e) => !cancelled && setState(e))
      .catch(() => !cancelled && setState(null));
    return () => {
      cancelled = true;
    };
  }, [qid, name]);
  return whileSlow(state, usePending(state === undefined));
}

/**
 * A node's ancestry, for the classification block.
 *
 * `/v1/path` rather than anything the store already holds, and the round trip
 * is free: the selection that opened this card fetched the same URL, and
 * `api.get` memoises on it for the session. Reading the store's node map
 * instead would work for a node the reader put on the canvas and quietly fail
 * for one they arrived at — a divergence's ancestors are on the path of its
 * descendants, but a *graft*'s attachment point may sit above everything drawn.
 */
export function useLineage(
  key: string | null,
  subjectIsLast = true,
): Pending<Lineage> {
  const [state, setState] = useState<Pending<Lineage>>(null);
  useEffect(() => {
    if (!key) {
      setState(null);
      return;
    }
    let cancelled = false;
    // `undefined` rather than `null` on the way out, so a card opened on a
    // second taxon does not hold the first one's ancestry while the new one is
    // fetched. The classification is the one block on the card whose stale
    // version is *plausible* — six ranks that belong to something else — so it
    // is the one that must not survive its subject.
    setState(undefined);
    api
      .path(key)
      .then((r) => {
        // A broken taxon has no single path — that is what broken means — and
        // the card that shows one already explains it in its own words.
        if (!cancelled) setState(r.path ? lineageOf(r.path, { subjectIsLast }) : null);
      })
      .catch(() => !cancelled && setState(null));
    return () => {
      cancelled = true;
    };
  }, [key, subjectIsLast]);
  return whileSlow(state, usePending(state === undefined));
}
