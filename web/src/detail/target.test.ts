import { describe, expect, it } from "vitest";
import type { PathNode } from "../api";
import { fossilTarget, idxFromKey, selectionKeyFor } from "./target";

function node(idx: number, key: string): PathNode {
  return {
    idx,
    key,
    ott_id: null,
    name: null,
    rank: null,
    age_ma: null,
    age_layout: 0,
    tier: 2,
    tip_count: 1,
    depth: 0,
    phylopic_id: null,
    silhouette_source_idx: null,
  };
}

const NODES = new Map([[588427, node(588427, "ott244265")]]);

describe("selectionKeyFor", () => {
  it("passes a key through untouched", () => {
    expect(selectionKeyFor("ott770315", NODES)).toBe("ott770315");
    expect(selectionKeyFor("pbdb54833", NODES)).toBe("pbdb54833");
  });

  it("prefers a node's own key over its index", () => {
    // Both open the same card. This is about the link a reader copies:
    // `ott244265` names a taxonomy, `idx:588427` names a position in this
    // build's arrays and means nothing outside it.
    expect(selectionKeyFor(588427, NODES)).toBe("ott244265");
  });

  it("falls back to the index for a node we hold no key for", () => {
    // The ordinary case for a silhouette's subject or a witness's attachment
    // point: they arrive as bare references into the arrays.
    expect(selectionKeyFor(999999, NODES)).toBe("idx:999999");
  });
});

describe("fossilTarget", () => {
  it("keys a fossil in its own namespace", () => {
    // `pbdb54833` cannot collide with an OTT id, which is what lets one `sel=`
    // parameter carry both corpora.
    expect(fossilTarget(54833)).toBe("pbdb54833");
  });
});

describe("idxFromKey", () => {
  it("reads back what selectionKeyFor wrote", () => {
    expect(idxFromKey("idx:588427")).toBe(588427);
    expect(idxFromKey(selectionKeyFor(4242, new Map()))).toBe(4242);
  });

  it("claims nothing that is not an index key", () => {
    // A false positive here would light the wrong mark on the canvas, which is
    // worse than lighting none.
    for (const k of ["ott770315", "pbdb54833", "mrcaott123ott456", "idx:", "idx:x", "idx:-3"]) {
      expect(idxFromKey(k)).toBeNull();
    }
  });
});
