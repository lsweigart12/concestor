/**
 * The species this browser has added before.
 *
 * On every visit after the first this is the highest-hit-rate content an empty
 * palette can hold, and it is the one band that costs no request at all —
 * Raycast, Notion, Slack and Vercel's own command-menu guidance all lead with
 * recents for exactly that pair of reasons. It is also the band that is *empty*
 * on the visit that matters most, which is why it sits above the starters
 * rather than instead of them.
 *
 * ## `localStorage`, and the precedent is `fuzzy.ts`
 *
 * The *modes* — the light, the labels, the ages — are `sessionStorage`, and
 * `state/store.ts` is emphatic about why: a setting is a claim about the
 * reader, so it must be per-tab or a shared link opens looking like whatever
 * the recipient last chose. That rule is about settings and does not reach
 * here. A recent pick changes nothing about how a canvas is drawn, so it cannot
 * leak into a link, and history that dies with the tab is not history.
 *
 * **This is not the first `localStorage` value in the app and must not be
 * argued as an exception.** `fuzzy.ts` has persisted a recency-and-frequency
 * table under `concestor.usage.v1` since the palette got its ranking, on the
 * same distinction and with the same decay-over-days reasoning. This file is
 * the visible half of a thing that was already here.
 *
 * Which is why {@link forgetRecent} exists and why it is wired to the same
 * command as `resetUsage`: the two stores are one promise to a reader, and that
 * promise was written before this band was.
 *
 * Nothing is sent anywhere. Same posture as `analytics/beacon.ts`, which stores
 * a per-tab id and no cookie: the reader's own browser is allowed to remember
 * what the reader did in it.
 *
 * ## Whole rows, and the build they belong to
 *
 * The stored value is the full {@link SearchHit}, not a list of keys, because a
 * key alone would mean the recents band could not draw until a round trip came
 * back — and the row is already in hand at the moment it is stored, having just
 * been picked out of a result list. So recents render on the first frame, with
 * no network, which is the whole reason they beat every other band on perceived
 * speed.
 *
 * The cost of storing derived data is that it can go stale, and here it goes
 * stale in the silent way: `idx` and `tip_count` are facts about one build, and
 * a rebuilt dataset renumbers them. An `idx` from an old build resolves cleanly
 * against the new one and describes **a different animal** — the same trap
 * `fossil_fts`'s rowid proof exists for, and `hits.go`'s refusal to let the
 * client bake dataset facts. So the blob carries the build it was written
 * against and is dropped whole on any mismatch. Losing six rows to a deploy is
 * not a cost worth engineering around; showing the wrong six is.
 */

import type { SearchHit } from "../api";
import { displayCommonNameOrNull } from "../vernacular";
import { RECENT_LIMIT } from "./starters";

const KEY = "concestor.recent";

/**
 * The stored shape.
 *
 * `build` is the dataset build id from `/v1/about`, and the version tag is the
 * *format* — the two go stale for different reasons and a single field could
 * not say which happened. Neither is optional: a blob with no build is a blob
 * from before this check existed, and it is exactly as untrustworthy as one
 * with the wrong build.
 */
interface Stored {
  v: 1;
  build: string;
  hits: SearchHit[];
}

const VERSION = 1;

/**
 * The recent picks that belong to this build, most recent first.
 *
 * Returns nothing rather than throwing on every failure there is — blocked
 * storage, a truncated write, a blob this app did not author, a build that has
 * moved on. This band is optional by construction, so every doubt resolves to
 * the empty list and the starters below it still answer the reader.
 */
export function loadRecent(buildID: string | null): SearchHit[] {
  if (!buildID) return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Stored).v !== VERSION ||
      (parsed as Stored).build !== buildID ||
      !Array.isArray((parsed as Stored).hits)
    ) {
      return [];
    }
    // Trimmed on read as well as on write. The cap is a display decision and
    // may fall; a blob written under a larger one would otherwise keep
    // overflowing the band until the reader happened to pick something.
    //
    // Cased on read for the same reason and against the same kind of staleness.
    // This is the one path in the app where a row reaches the screen without
    // passing `api.ts`, so it is the one place the boundary cannot reach: the
    // build stamp above catches a *dataset* that moved on, and a common name
    // cased by an older build of this *code* is a different sort of stale that
    // no stamp here would catch. Without it the recents band would sit directly
    // above a fresh result list, printing "aardvark" beside its "Aardvark".
    return (parsed as Stored).hits
      .filter((h): h is SearchHit => isUsableHit(h))
      .slice(0, RECENT_LIMIT)
      .map((h) => ({ ...h, vernacular: displayCommonNameOrNull(h.vernacular) }));
  } catch {
    return [];
  }
}

/**
 * Put a pick at the top of the list.
 *
 * De-duplicated on `key` rather than `idx`, because `key` is the field the
 * server guarantees on every hit and the one that survives a rebuild. Picking
 * something already in the list *moves* it up rather than doubling it, which is
 * what "recent" means.
 */
export function rememberRecent(hit: SearchHit, buildID: string | null): void {
  if (!buildID || !isUsableHit(hit)) return;
  try {
    const kept = loadRecent(buildID).filter((h) => h.key !== hit.key);
    const next: Stored = {
      v: VERSION,
      build: buildID,
      hits: [hit, ...kept].slice(0, RECENT_LIMIT),
    };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* blocked storage, or the quota. The band is optional; the pick still lands. */
  }
}

/**
 * Forget every stored pick.
 *
 * Called from the same command as {@link resetUsage}, and it has to be: that
 * command already said *"Forget recency and frequency history"* before this
 * band existed, and a reader pressing it is asking the app to stop remembering
 * what they have looked at. Clearing only the invisible half — the ranking
 * boost — while leaving a list captioned **Recent** standing on screen is the
 * worst of both, because the one the reader can actually see is the one that
 * appears to have ignored them.
 *
 * Two stores rather than one, because a usage count and a whole search row are
 * different shapes with different staleness rules, and the build stamp belongs
 * to only one of them. One *command*, because to a reader they are a single
 * thing: what this browser remembers about their searching.
 */
export function forgetRecent(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored is nothing to clear */
  }
}

/**
 * Whether a stored row can still be drawn and added.
 *
 * The band renders through the same `RowView` as a search result, and every
 * row in that list is one Enter will act on — so a row that cannot be added is
 * worse than a row that is missing. `idx` is what the add path resolves and
 * what `present` is keyed on; a hit without one is a broken taxon that should
 * never have been stored.
 */
function isUsableHit(h: unknown): h is SearchHit {
  if (typeof h !== "object" || h === null) return false;
  const hit = h as Partial<SearchHit>;
  return (
    hit.kind === "node" &&
    typeof hit.key === "string" &&
    hit.key !== "" &&
    typeof hit.idx === "number"
  );
}
