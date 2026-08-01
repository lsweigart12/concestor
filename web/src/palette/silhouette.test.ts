/**
 * The palette draws a silhouette per hit, and the interesting cases are the
 * ones where it must not.
 *
 * These pin `hitSilhouette` to the same rule the canvas uses. The failure this
 * guards against is quiet: a borrowed picture always renders *something*, so a
 * regression here does not look broken — it looks like a beetle wearing a mole.
 */

import { describe, expect, it } from "vitest";
import { hitSilhouette, SILHOUETTE_MAX_SOURCE_TIPS, type SearchHit } from "../api";

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    kind: "node",
    key: "ott770315",
    idx: 594485,
    ott_id: 770315,
    name: "Homo sapiens",
    vernacular: "human",
    rank: "species",
    tip_count: 1,
    has_age: true,
    has_image: true,
    matched_on: "name",
    phylopic_id: "abc-123",
    silhouette_source_idx: 594485,
    silhouette_source_tips: 1,
    ...over,
  };
}

describe("hitSilhouette", () => {
  it("draws a node's own image", () => {
    expect(hitSilhouette(hit())).toBe("abc-123");
  });

  it("draws nothing when the server resolved no image", () => {
    expect(hitSilhouette(hit({ phylopic_id: null, has_image: false }))).toBeNull();
  });

  it("draws an image borrowed from a clade small enough to recognise", () => {
    expect(
      hitSilhouette(
        hit({
          silhouette_source_idx: 588427,
          silhouette_source_tips: SILHOUETTE_MAX_SOURCE_TIPS - 1,
        }),
      ),
    ).toBe("abc-123");
  });

  // The one that matters. Coverage climbs to the nearest ancestor with an
  // image, so at the top of the climb a species inherits the picture attached
  // to something kingdom-sized. Rendering it misinforms; blank withholds.
  it("suppresses an image borrowed from a kingdom-sized ancestor", () => {
    expect(
      hitSilhouette(
        hit({
          silhouette_source_idx: 588427,
          silhouette_source_tips: SILHOUETTE_MAX_SOURCE_TIPS + 1,
        }),
      ),
    ).toBeNull();
  });

  it("suppresses the root's image, whose subject is everything", () => {
    expect(
      hitSilhouette(hit({ silhouette_source_idx: 0, silhouette_source_tips: 2_400_000 })),
    ).toBeNull();
  });

  // An older server sends neither field. The image is still worth drawing —
  // absent evidence of a bad borrow is not evidence of one — but the root and
  // the size test above must keep working the moment the fields appear.
  it("draws when the server sends no provenance at all", () => {
    const h = hit();
    delete h.silhouette_source_idx;
    delete h.silhouette_source_tips;
    expect(hitSilhouette(h)).toBe("abc-123");
  });
});
