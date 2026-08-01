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

/**
 * A dial position the app does not ship, kept exercised so that turning it
 * back on is a one-line change rather than an archaeology exercise. 10,000 is
 * the same threshold phase 5a's blocking gate uses for "a group a reader can
 * picture".
 */
const CAUTIOUS: SilhouettePolicy = { maxCladeTips: 10_000 };

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
    silhouette_clade_tips: 1,
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

  it("draws a picture shared with a group small enough to recognise", () => {
    // Elminae: 987 riffle beetles, the case the resolution change exists for.
    expect(
      hitSilhouette(
        hit({ silhouette_source_idx: 588427, silhouette_clade_tips: 987 }),
        CAUTIOUS,
      ),
    ).toBe("abc-123");
  });

  it("suppresses a picture shared with a superphylum under a cautious policy", () => {
    // Ecdysozoa: 1,208,417 tips. This was 65.3% of the tree before resolution
    // started looking sideways for a cousin; it is now 0%.
    expect(
      hitSilhouette(
        hit({ silhouette_source_idx: 588427, silhouette_clade_tips: 1_208_417 }),
        CAUTIOUS,
      ),
    ).toBeNull();
  });

  // What the app ships, and now on evidence rather than on nerve: measured
  // over the built corpus no node borrows from a clade of over a million tips,
  // so there is no population of misinforming pictures left for a threshold to
  // catch. The honesty comes from the caption — NodeMark names the clade and
  // its size whenever the picture is not the node's own.
  describe("dialled to maximum, which is the shipped default", () => {
    it("is in fact at maximum", () => {
      expect(SILHOUETTE_POLICY).toEqual({ maxCladeTips: Number.POSITIVE_INFINITY });
    });

    it("draws a picture shared with a superphylum", () => {
      expect(
        hitSilhouette(
          hit({ silhouette_source_idx: 588427, silhouette_clade_tips: 2_000_000 }),
        ),
      ).toBe("abc-123");
    });

    it("still draws nothing when there is no image to draw", () => {
      expect(hitSilhouette(hit({ phylopic_id: null, has_image: false }))).toBeNull();
    });
  });

  // An older server sends no clade. The image is still worth drawing — absent
  // evidence of a bad borrow is not evidence of one — but the size test above
  // must keep working the moment the field appears.
  it("draws when the server sends no clade at all", () => {
    const h = hit();
    delete h.silhouette_clade_tips;
    expect(hitSilhouette(h, CAUTIOUS)).toBe("abc-123");
  });
});
