/**
 * The palette draws a silhouette per hit, and the interesting cases are the
 * ones where it must not.
 *
 * These pin `hitSilhouette` to the same rule the canvas uses. The failure this
 * guards against is quiet: a borrowed picture always renders *something*, so a
 * regression here does not look broken — it looks like a beetle wearing a mole.
 */

import { describe, expect, it } from "vitest";
import {
  hitSilhouette,
  SILHOUETTE_POLICY,
  type SearchHit,
  type SilhouettePolicy,
} from "../api";

/** The setting the dial came from, and the one to return to. */
const CAUTIOUS: SilhouettePolicy = { maxSourceTips: 250_000, allowRootSource: false };

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
        hit({ silhouette_source_idx: 588427, silhouette_source_tips: 249_999 }),
        CAUTIOUS,
      ),
    ).toBe("abc-123");
  });

  // The rule the dial exists to relax. Coverage climbs to the nearest ancestor
  // with an image, so at the top of the climb a species inherits the picture
  // attached to something kingdom-sized. Under CAUTIOUS that is withheld.
  it("suppresses an image borrowed from a kingdom-sized ancestor", () => {
    expect(
      hitSilhouette(
        hit({ silhouette_source_idx: 588427, silhouette_source_tips: 250_001 }),
        CAUTIOUS,
      ),
    ).toBeNull();
  });

  it("suppresses the root's image under a cautious policy", () => {
    expect(
      hitSilhouette(
        hit({ silhouette_source_idx: 0, silhouette_source_tips: 2_400_000 }),
        CAUTIOUS,
      ),
    ).toBeNull();
  });

  // What the app currently ships. Both of the cases above now draw, and the
  // honesty they used to buy has to come from the caption instead — NodeMark
  // says what the picture depicts whenever the source is not the node itself.
  describe("dialled to maximum, which is the shipped default", () => {
    it("is in fact at maximum", () => {
      expect(SILHOUETTE_POLICY).toEqual({
        maxSourceTips: Number.POSITIVE_INFINITY,
        allowRootSource: true,
      });
    });

    it("draws an image borrowed from a kingdom-sized ancestor", () => {
      expect(
        hitSilhouette(
          hit({ silhouette_source_idx: 588427, silhouette_source_tips: 2_000_000 }),
        ),
      ).toBe("abc-123");
    });

    it("draws even the root's image", () => {
      expect(
        hitSilhouette(
          hit({ silhouette_source_idx: 0, silhouette_source_tips: 2_400_000 }),
        ),
      ).toBe("abc-123");
    });

    it("still draws nothing when there is no image to draw", () => {
      expect(hitSilhouette(hit({ phylopic_id: null, has_image: false }))).toBeNull();
    });
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
