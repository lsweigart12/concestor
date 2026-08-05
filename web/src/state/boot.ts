/**
 * What the app asks for before a reader has asked for anything.
 *
 * Three requests, one of which decides whether there is an app at all and two
 * of which decide how good the first screen is. They are made together rather
 * than in sequence, and the ordering below is the only thing about this that is
 * load-bearing: `/v1/about` goes first because it is both the probe *and* the
 * warm-up, and starting it a round trip earlier is a round trip off the wait
 * for a container that was asleep.
 *
 * Split out of `App.tsx` unchanged. What it is worth having on its own is the
 * account below of what the probe is for, which was previously forty lines of
 * comment sitting between two pieces of unrelated state.
 */

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  api,
  type About,
  type SearchHit,
  type TimescaleInterval,
} from "../api";
import { STARTERS } from "../palette/starters";

interface Boot {
  about: About | null;
  /**
   * Exposed because a random pick may have to re-read it past the memo.
   *
   * `build_id` is read once here and remembered, and a deploy landing
   * mid-session takes the pool for that build out of service — so the 404 path
   * in `App.tsx`'s `randomPick` asks again with `api.about(true)` and writes
   * the answer back here. That is the one write from outside, and it is a
   * correction rather than a second source: it replaces a value this hook
   * fetched with a fresher answer to the same question.
   */
  setAbout: Dispatch<SetStateAction<About | null>>;
  /** Null until the probe answers. False is the boot-error screen. */
  reachable: boolean | null;
  timescale: TimescaleInterval[] | null;
  /** The curated species the empty palette offers, dressed by `/v1/hits`. */
  starters: SearchHit[];
}

export function useBoot(): Boot {
  const [about, setAbout] = useState<About | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [timescale, setTimescale] = useState<TimescaleInterval[] | null>(null);
  /**
   * Fetched once on boot and held here rather than in the palette, because the
   * palette is unmounted between openings and would re-ask every time — the
   * memo in `api.ts` would answer instantly, but the state would still start
   * empty and the list would flash in on every open.
   */
  const [starters, setStarters] = useState<SearchHit[]>([]);

  // Boot. The API is a hard dependency for search; say so plainly rather than
  // rendering an empty canvas that looks like it worked.
  //
  // **`/v1/about` is the probe, and there is no separate one.** A `/healthz`
  // fetch stood here and could not fail: that path exists on the Go mux only,
  // and neither surface the app is served from routes it there — production
  // answers it with `index.html` and so does vite. `api.ts` has the full
  // account. The consequence worth stating here is that the boot-error screen
  // was unreachable in production for as long as this was two requests.
  //
  // It is also the warm-up, and that is not a side effect to be tidied away
  // later. `/v1/about` is `max-age=60, must-revalidate` rather than immutable
  // precisely so that it reaches the container on every boot — so this is what
  // wakes a sleeping one, before anybody has typed anything.
  useEffect(() => {
    api.about().then(
      (a) => {
        setAbout(a);
        setReachable(true);
      },
      () => setReachable(false),
    );
    // Alongside the probe rather than behind it. The geologic band is a
    // reference scale and not the subject: its absence costs legibility, not
    // correctness, so it neither gates the boot nor waits on it.
    api
      .timescale()
      .then((t) => setTimescale(t.intervals))
      .catch(() => {});
    // The species palette's empty state, fetched now so it is already there
    // when `S` is first pressed — waiting until the palette opens would put a
    // round trip in front of the one screen a reader judges the app on.
    //
    // Alongside for the same reason as the timescale, and it is the cheaper of
    // the two: one fixed URL, a pure function of the build, so the edge answers
    // it and the container sees roughly one per Worker version. It must not
    // gate `reachable` — `/v1/about` is the probe, and a second endpoint
    // reporting on reachability is a second answer that can disagree with it.
    api
      .hits([...STARTERS])
      .then((r) => setStarters(r.results))
      .catch(() => {
        // The palette falls back to its prompt line, which is what it said
        // before this existed. A suggestion list is an invitation, and an
        // invitation that failed to load is not an error worth reporting.
      });
  }, []);

  return { about, setAbout, reachable, timescale, starters };
}
