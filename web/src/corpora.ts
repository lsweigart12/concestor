/**
 * What separates a species the tree has from one it does not. The app searches
 * two catalogues — the synthesis tree (nodes with an ancestry and an MRCA) and
 * the Paleobiology Database (taxa with an observed stratigraphic extent) — and
 * a reader should not have to know which is which. Where both hold a taxon the
 * node wins and the server drops the fossil (`store.notInTree`), so the one
 * remaining difference is: a fossil row is a species the tree has no lineage
 * for. Everything downstream reads that relationship from here.
 */

import type { RandomKind } from "./api";

/**
 * Number of species to search, as told to a reader: the `rank='species'` count,
 * not the node total (which also includes genera and higher groups). Since the
 * infraspecific collapse the tree stops at species, so tips and species nearly
 * coincide; the residue is groups that are themselves tips. It is a phrase
 * rather than a number so no caller reinvents the wording; `corpora.test.ts`
 * pins it to `docs/data-sources.md` and forbids hardcoded counts elsewhere.
 */
export const TREE_SPECIES = 2_295_800;

/** {@link TREE_SPECIES}, as it prints. */
export const SPECIES_PHRASE = "2.3 million species";

/** How often the one random pick draws from the fossil corpus. */
export const RANDOM_FOSSIL_CHANCE = 0.2;

/** Which corpus a press of `R` draws from, given a roll in [0, 1). */
export function randomKind(roll: number): RandomKind {
  return roll < RANDOM_FOSSIL_CHANCE ? "fossil" : "species";
}

/**
 * Draw one identifier from a pool, never one the canvas already holds. `null`
 * means the pool is exhausted (distinct from empty). `roll` is injected so the
 * draw is testable.
 */
export function pickFrom(
  pool: readonly number[],
  taken: (n: number) => boolean,
  roll: number,
): number | null {
  const free = pool.filter((n) => !taken(n));
  if (free.length === 0) return null;
  // Clamp: roll can be 1 via the injected value, and an index past the end
  // would return undefined through a signature that promises it cannot.
  const i = Math.min(
    free.length - 1,
    Math.max(0, Math.floor(roll * free.length)),
  );
  return free[i] ?? null;
}

/** The badge a fossil row wears. "on a branch", not "fossil": T. rex is a node. */
export const FOSSIL_BADGE = "on a branch";
export const FOSSIL_BADGE_HINT =
  "The tree has no lineage for it, so it is pinned to the branch it belongs " +
  "below, at its own date, rather than joining the tree as a species does.";

/**
 * Where a search row sits in the one ranking covering both corpora. `order` is
 * the server's position from `store.Interleave`; the client must not re-sort.
 * `fallback` (the row's index in its own array) serves a server predating
 * `order`, where the two corpora cannot interleave.
 */
export function rowScore(
  order: number | null | undefined,
  fallback: number,
): number {
  return 4000 - (order ?? fallback) * 10;
}
