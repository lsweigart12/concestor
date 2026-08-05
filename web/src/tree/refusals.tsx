/**
 * Say when a fossil in the view is not being drawn, and why.
 *
 * A graft that silently fails to appear is indistinguishable from a broken
 * canvas — the same reasoning the broken-taxon and unresolved-key notices in
 * `App.tsx` are built on. `off-tree` is the one that happens in ordinary use,
 * and it is recoverable rather than fatal: removing the species a fossil hung
 * from takes its branch off the canvas, and putting one back brings the fossil
 * with it. So the fossil stays in the URL and the notice says what to do,
 * instead of the view quietly dropping it.
 *
 * `graft.ts` decides *whether* a fossil can be drawn and refuses on three
 * grounds; this is the only place any of those three is ever said out loud.
 */

import { useCallback, useEffect, useRef } from "react";
import type { FossilTaxon } from "../api";
import type { Say } from "../chrome/toasts";
import type { GraftRefusal, GraftSet } from "./graft";

/**
 * How long a graft refusal must persist before it is worth saying, in ms.
 *
 * Long enough to outlast a path fetch on a local API and short enough that a
 * real refusal still feels like a response to the click that caused it.
 */
const REFUSAL_SETTLE_MS = 700;
const REFUSAL_REASONS: GraftRefusal[] = ["off-tree", "no-range", "no-identity"];

/**
 * @param set    the graft build, refusals and all.
 * @param loading whether the store still has lineages in flight.
 * @param renderedCount how many nodes the induced subtree is drawing.
 * @param say    the toast queue.
 *
 * `loading` and `renderedCount` are two parameters rather than one "is the
 * canvas settled" boolean on purpose: the effect below re-runs on either, and
 * collapsing them would drop a run where one changes and the combination does
 * not. The clearing loop at the top runs *before* the early return, so a
 * skipped run is not a no-op.
 */
export function useGraftRefusals(
  set: GraftSet,
  loading: boolean,
  renderedCount: number,
  say: Say,
): void {
  const announce = useCallback(
    (f: FossilTaxon, reason: GraftRefusal) => {
      say(
        reason === "off-tree" ? (
          <>
            <strong>{f.name}</strong> is not drawn: the branch it attaches to is
            not on the canvas. Add the clade it sits in and it will appear.
          </>
        ) : reason === "no-range" ? (
          <>
            <strong>{f.name}</strong> has no appearance interval recorded, so
            there is nowhere in time to put it. PBDB records none for about a
            fifth of its taxa.
          </>
        ) : (
          <>
            <strong>{f.name}</strong> cannot be drawn: this build's fossil table
            carries no identifier for it.
          </>
        ),
        true,
      );
    },
    [say],
  );

  /**
   * Announced once per fossil per reason, and only once the view has held
   * still. Both halves of that are load-bearing. Without the dedup the message
   * repeats on every unrelated add; without the settle delay it fires into
   * every ordinary flow, because `off-tree` is *transiently true* twice over —
   * on a cold load before the paths land, and in the gap between drawing a
   * fossil and adding the clade it needs. Both were seen: `Dimetrodon` was
   * announced undrawable one frame before being drawn, twice, for two
   * different reasons. A graft that becomes drawable clears its mark, so
   * removing its clade later says so again.
   */
  const announcedRefusals = useRef(new Set<string>());
  const { grafts, refused } = set;
  useEffect(() => {
    for (const g of grafts) {
      for (const reason of REFUSAL_REASONS) {
        announcedRefusals.current.delete(`${g.fossil.pbdb_taxon_no}:${reason}`);
      }
    }
    if (loading || renderedCount === 0) return;
    if (refused.length === 0) return;
    // The cleanup is what makes the delay work: any change to the refusal set
    // cancels the pending notice, so a refusal that is being resolved never
    // reaches the screen. Nobody is waiting on this message, so waiting for the
    // set to settle costs nothing.
    const t = window.setTimeout(() => {
      for (const { fossil: f, reason } of refused) {
        const seen = `${f.pbdb_taxon_no ?? f.name}:${reason}`;
        if (announcedRefusals.current.has(seen)) continue;
        announcedRefusals.current.add(seen);
        announce(f, reason);
      }
    }, REFUSAL_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [refused, grafts, loading, renderedCount, announce]);
}
