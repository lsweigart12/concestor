/**
 * A fossil arrives like a species.
 *
 * `encode`/`decode` are pinned next door in `store.test.ts`; what is here is
 * the part that cannot be — the *timing* of a graft reaching the canvas, which
 * used to be "whenever its fetch happened to land".
 *
 * Three claims, and each one was a real defect:
 *
 *   - `addFossil` goes through the draw queue, so a fossil cannot be seated on
 *     a canvas that is mid-draw. It wrote straight to the view, which is how a
 *     fossil came to reflow a tree that was drawing itself on (#138).
 *   - `view.fossils` is what the reader asked for and `graftSet` is what the
 *     canvas has drawn, and a graft is promoted between them only when the
 *     canvas is idle. A cold load holding `f=` never passes the queue at all,
 *     so the queue alone cannot carry this.
 *   - the promotion emits a delta naming the graft, which is what draws the
 *     connector on and blooms the mark.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type FossilDetail, type PathNode, type Resolved } from "../api";
import { graftIdx } from "../tree/graft";
import { useTree } from "./store";

/**
 * A root and two leaves below it — the smallest thing that induces a subtree,
 * since one taxon alone is its own MRCA and renders no branch to hang from.
 */
const ROOT = 100;
const LEAF = 200;
const LEAF2 = 300;
const TAXON = 55058;

function node(idx: number, age: number, tier: number): PathNode {
  return {
    idx,
    key: `ott${idx}`,
    ott_id: idx,
    name: `n${idx}`,
    rank: null,
    age_ma: age,
    age_layout: age,
    tier,
    tip_count: 1,
    depth: 0,
    phylopic_id: null,
    silhouette_source_idx: null,
    silhouette_clade_idx: null,
    silhouette_clade_tips: null,
    silhouette_clade_name: null,
  } as unknown as PathNode;
}

function lineage(leaf: number): Resolved {
  return {
    idx: leaf,
    name: `n${leaf}`,
    broken: false,
    path: [node(ROOT, 500, 1), node(leaf, 0, 1)],
  } as unknown as Resolved;
}

const fossil: FossilDetail = {
  name: "Attercopus",
  pbdb_taxon_no: TAXON,
  rank: "genus",
  attach_idx: ROOT,
  attach_walk: 2,
  n_occs: 4,
  is_extant: false,
  phylopic_id: null,
  fea: 390,
  fla: 380,
  lea: 388,
  lla: 379,
  lla_drawn: 379,
  lea_drawn: 388,
} as unknown as FossilDetail;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(api, "path").mockImplementation(async (key: string) =>
    lineage(key.endsWith(String(LEAF2)) ? LEAF2 : LEAF),
  );
  vi.spyOn(api, "paths").mockResolvedValue({
    paths: {
      [`ott${LEAF}`]: lineage(LEAF),
      [`ott${LEAF2}`]: lineage(LEAF2),
    },
  } as unknown as Awaited<ReturnType<typeof api.paths>>);
  vi.spyOn(api, "fossil").mockResolvedValue(fossil);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

/** A tree with a real subtree on it, settled and its delta consumed. */
async function settled() {
  const h = renderHook(() => useTree());
  await act(async () => {
    h.result.current.open([`ott${LEAF}`, `ott${LEAF2}`]);
  });
  await waitFor(() => expect(h.result.current.induced.rendered.length).toBe(3));
  // The canvas reports back: the draw landed, then the whole sequence played.
  await act(async () => {
    h.result.current.deltaLanded();
    h.result.current.consumeDelta();
  });
  return h;
}

describe("a fossil goes through the draw queue", () => {
  it("does not seat itself in the view on the press", async () => {
    const h = await settled();
    act(() => {
      h.result.current.addFossil(TAXON);
    });
    // The press is not the arrival. It was, and that is the whole defect.
    expect(h.result.current.view.fossils).toEqual([]);
    await waitFor(() => expect(h.result.current.view.fossils).toEqual([TAXON]));
  });

  it("draws it once its row lands, and names it in a delta", async () => {
    const h = await settled();
    await act(async () => {
      h.result.current.addFossil(TAXON);
    });
    await waitFor(() =>
      expect(h.result.current.graftSet.grafts.length).toBe(1),
    );
    const delta = h.result.current.delta;
    expect(delta).not.toBeNull();
    // One connector is one wave, and the flare belongs on the branch it leaves.
    expect(delta?.drawOrder).toEqual([[graftIdx(TAXON)]]);
    expect(delta?.leaf).toBe(graftIdx(TAXON));
    expect(delta?.flare).toBe(h.result.current.graftSet.grafts[0]?.anchor);
  });

  it("asks for the row while the fossil is still queued", async () => {
    const h = await settled();
    await act(async () => {
      h.result.current.addFossil(TAXON);
    });
    // Arrival is the queue's gate, so a fossil nobody had asked to resolve
    // until its turn came would stall the queue for a round trip.
    expect(api.fossil).toHaveBeenCalledWith(TAXON);
  });

  /**
   * `pbdb…` is not an OTT id and `/v1/paths` has never heard of it. Sending it
   * there would also record the miss in `answered`, which is the queue's escape
   * hatch for a key that resolved to nothing — the fossil would be released as
   * unresolvable one tick before its own fetch landed.
   */
  it("never sends a fossil key to the path resolver", async () => {
    const h = await settled();
    await act(async () => {
      h.result.current.addFossil(TAXON);
    });
    for (const call of vi.mocked(api.paths).mock.calls) {
      expect(call[0].join(",")).not.toContain("pbdb");
    }
    for (const call of vi.mocked(api.path).mock.calls) {
      expect(call[0]).not.toContain("pbdb");
    }
  });
});

describe("what the reader asked for is not yet what is drawn", () => {
  /**
   * The cold-load case, which the queue cannot cover: the URL seats `f=`
   * directly. The fossil resolves midway through the tree's own draw, and
   * announcing it there would strand every trace that had not left yet.
   */
  it("holds a resolved fossil off the canvas while a delta is playing", async () => {
    window.history.replaceState(null, "", `/?n=${LEAF},${LEAF2}&f=${TAXON}`);
    const h = renderHook(() => useTree());
    await waitFor(() =>
      expect(h.result.current.induced.rendered.length).toBe(3),
    );
    // The tree's own delta is on screen, so the fossil waits — even though its
    // row has arrived and the URL has always said it was wanted.
    await waitFor(() => expect(h.result.current.fossils.has(TAXON)).toBe(true));
    expect(h.result.current.view.fossils).toEqual([TAXON]);
    expect(h.result.current.graftSet.grafts).toEqual([]);

    await act(async () => {
      h.result.current.deltaLanded();
      h.result.current.consumeDelta();
    });
    await waitFor(() =>
      expect(h.result.current.graftSet.grafts.length).toBe(1),
    );
  });

  it("takes it off the canvas the moment it is removed, with no beat", async () => {
    const h = await settled();
    await act(async () => {
      h.result.current.addFossil(TAXON);
    });
    await waitFor(() =>
      expect(h.result.current.graftSet.grafts.length).toBe(1),
    );
    act(() => {
      h.result.current.removeFossil(TAXON);
    });
    // Removal is not an arrival and waits for nothing.
    expect(h.result.current.graftSet.grafts).toEqual([]);
  });
});
