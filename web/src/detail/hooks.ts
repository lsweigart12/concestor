/**
 * The two asynchronous things a card wants that a card is not given.
 *
 * Both follow the same rule: the card renders complete without them and grows
 * when they land. Neither is awaited before anything is drawn, because the
 * click that opened the card has already been answered by the data the app
 * holds — a selection resolves in the same frame, and a spinner over facts we
 * already have would be a regression dressed as feedback.
 */

import { useEffect, useState } from "react";
import { api } from "../api";
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
  return state;
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
export function useLineage(key: string | null, subjectIsLast = true): Lineage | null {
  const [state, setState] = useState<Lineage | null>(null);
  useEffect(() => {
    if (!key) {
      setState(null);
      return;
    }
    let cancelled = false;
    setState(null);
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
  return state;
}
