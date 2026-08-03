/**
 * Application state.
 *
 * The selected set *is* the application state, and design-reference.md extends
 * that to all view state: any view must be a shareable link. So the URL is the
 * store's serialisation, not a mirror of it — everything that changes what you
 * see round-trips through `encode`/`decode`, and the back button is correct by
 * construction.
 *
 *   /?n=770315,153563,664349&axis=log&sel=770315&iso=1
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type FossilTaxon, type PathNode, type Resolved } from "../api";
import { addDelta, induced, type AddDelta, type Induced } from "../tree/induced";
import type { AxisMode } from "../tree/layout";

// One definition, in the module that does the mapping. The axis mode is view
// state, but it is *also* the scale the layout is computed on, and two copies
// of the union is how the toggle became a caption in the first place.
export type { AxisMode };

export interface ViewState {
  /** OTT ids or node keys, in selection order (which is *not* render order). */
  keys: string[];
  axis: AxisMode;
  selected: string | null;
  isolate: boolean;
  /**
   * The segment whose drill-down lane is open, as two node indices.
   *
   * Indices rather than keys, because that is what `/v1/segment` takes and
   * what the induced subtree is keyed on — and unlike a selection, a segment
   * has no name of its own to put in the URL. Architecture §7 spells this
   * parameter `seg=upper-lower`.
   */
  drill: { upper: number; lower: number } | null;
  /**
   * Fossils drawn against the tree, as PBDB taxon numbers. `f=108454,91487`.
   *
   * A separate list from `keys`, and it has to be: a selection is a node and
   * induces a subtree, while a graft is an annotation on one and induces
   * nothing. Putting a fossil in `keys` would send `pbdb108454` to
   * `/v1/paths`, which would correctly fail to resolve it — and if it ever
   * stopped failing, a fossil would start contributing to an MRCA.
   */
  fossils: number[];
}

/**
 * `axis: "linear"` is the default, and it is an audience decision rather than a
 * technical one.
 *
 * The symlog scale is the better *instrument* — it is the only way a tree
 * spanning 6.7 Ma and 1.3 Ga puts both divergences somewhere readable, and
 * `symlogFrac` exists for exactly that. But this app is for curious people
 * rather than systematists (handoff.md §1), and two things follow.
 *
 * A log axis is a specialist convention that a layman does not read natively,
 * and — the part that matters more — **linear is the honest one about scale.**
 * Log flatters recent divergences: it gives human-and-chimp a share of the
 * width comparable to eukaryotes, when the true ratio is nearer 1:200. Deep
 * time being genuinely that vast is the thing this app is for, and the crushing
 * is the message rather than a defect.
 *
 * It also suits what the reader now arrives through. Every opening in
 * `openings.ts` is a comparison, and a comparison is only interesting when its
 * two ages are close — which is precisely when symlog collapses them. The fish
 * rungs at 409/455/491 Ma span 2.9% of the log portion and 16.7% linear.
 *
 * `L` still switches, one opening asks for symlog by name, and nothing about
 * the scale itself changed.
 */
const DEFAULT: ViewState = {
  keys: [],
  axis: "linear",
  selected: null,
  isolate: false,
  drill: null,
  fossils: [],
};

export function decode(search: string): ViewState {
  const p = new URLSearchParams(search);
  const raw = p.get("n");
  const seg = (p.get("seg") ?? "").split("-").map(Number);
  const fossils = (p.get("f") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  return {
    keys: raw ? raw.split(",").filter(Boolean) : [],
    // Both directions name the non-default explicitly, so the pair stays
    // reversible: an absent `axis` is the default, whatever the default is.
    axis: p.get("axis") === "log" ? "log" : "linear",
    selected: p.get("sel"),
    isolate: p.get("iso") === "1",
    drill:
      seg.length === 2 && Number.isInteger(seg[0]) && Number.isInteger(seg[1])
        ? { upper: seg[0]!, lower: seg[1]! }
        : null,
    // Deduplicated on the way in rather than on the way out: the same taxon
    // twice would be two React keys for one mark and two rows for one fossil.
    fossils: [...new Set(fossils)],
  };
}

export function encode(v: ViewState): string {
  const p = new URLSearchParams();
  if (v.keys.length) p.set("n", v.keys.join(","));
  if (v.axis !== "linear") p.set("axis", v.axis);
  if (v.selected) p.set("sel", v.selected);
  if (v.isolate) p.set("iso", "1");
  if (v.drill) p.set("seg", `${v.drill.upper}-${v.drill.lower}`);
  if (v.fossils.length) p.set("f", v.fossils.join(","));
  const q = p.toString();
  return q ? `?${q}` : "/";
}

/** A key the API accepts: bare OTT ids in the URL become `ott…` on the wire. */
export function toApiKey(key: string): string {
  return /^\d+$/.test(key) ? `ott${key}` : key;
}

/** The compact form we put in URLs. */
export function toUrlKey(key: string): string {
  return key.startsWith("ott") && /^\d+$/.test(key.slice(3)) ? key.slice(3) : key;
}

export interface Broken {
  key: string;
  name: string | null;
  mrcaKey: string;
  mrcaIdx: number | null;
  attachmentPoints: number;
}

export interface TreeState {
  view: ViewState;
  /** Every node we have ever seen, by idx. The API is immutable, so this only grows. */
  nodes: Map<number, PathNode>;
  induced: Induced;
  /** Most recent add, driving the signature animation. Cleared once played. */
  delta: (AddDelta & { token: number }) | null;
  /** The *tree* is resolving. Not fossils — see `fossilsLoading`. */
  loading: boolean;
  fossilsLoading: boolean;
  /** Selections that resolved to a non-monophyletic taxon and were not added. */
  broken: Broken[];
  /** Selections the API could not resolve at all — a stale or mistyped id. */
  unresolved: string[];
  error: string | null;
}

export function useTree() {
  const [view, setView] = useState<ViewState>(() => decode(window.location.search));
  const [nodes, setNodes] = useState<Map<number, PathNode>>(() => new Map());
  const [paths, setPaths] = useState<Map<string, number[]>>(() => new Map());
  const [idxOf, setIdxOf] = useState<Map<string, number>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [broken, setBroken] = useState<Broken[]>([]);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [delta, setDelta] = useState<(AddDelta & { token: number }) | null>(null);
  // Resolved fossils, by PBDB taxon number. Like `nodes`, this only grows: the
  // API is immutable within a build, so removing a graft from the view need
  // not throw away the row it was drawn from.
  const [fossils, setFossils] = useState<Map<number, FossilTaxon>>(() => new Map());
  const [fossilsLoading, setFossilsLoading] = useState(false);
  const prevInduced = useRef<Induced | null>(null);
  const token = useRef(0);

  // URL is the serialisation. Push on change, and honour back/forward.
  //
  // The comparison is against the search string *or* the path, in that order,
  // because `encode` returns "/" for an empty view and "?…" for every other
  // one. Testing both independently — `url !== search && url !== pathname` —
  // silently swallowed exactly one transition: clearing a full canvas produced
  // "/", which differs from "?n=247333" but equals the pathname, so nothing was
  // pushed. The URL kept a selection that was no longer on screen, reloading
  // brought back what had just been cleared, and back went somewhere else
  // entirely. It only ever mattered on clear, which is why it survived until
  // clear grew a confirmation promising the back button would work.
  useEffect(() => {
    const url = encode(view);
    if (url !== (window.location.search || window.location.pathname)) {
      window.history.pushState(null, "", url);
    }
  }, [view]);

  useEffect(() => {
    const onPop = () => setView(decode(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const ingest = useCallback((key: string, r: Resolved): number | null => {
    if (r.broken) {
      setBroken((b) =>
        b.some((x) => x.key === key)
          ? b
          : [
              ...b,
              {
                key,
                name: r.name,
                mrcaKey: r.mrca_node_key,
                mrcaIdx: r.mrca_idx,
                attachmentPoints: r.n_attachment_points,
              },
            ],
      );
      // Drop it from the selection once it has been reported. A broken taxon
      // never enters `paths` or `idxOf`, so a key that stays in the view stays
      // *unresolved* — it is re-fetched and re-announced on every subsequent
      // add, and since nothing is ever drawn for it there is no node to select
      // and remove. The explanation is worth saying once; the key is not worth
      // keeping. The palette no longer offers these at all, so this only fires
      // for a link made before that was true.
      setView((v) => ({ ...v, keys: v.keys.filter((x) => x !== key) }));
      return null;
    }
    // A key that resolved to nothing. `/v1/paths` reports these per-key rather
    // than failing the whole batch, so one bad id in a pasted URL must cost
    // that one lineage and nothing else — reading `r.path` blindly here threw
    // a TypeError during render and blanked the entire app, which for a
    // product whose distribution *is* shared links is the worst possible
    // failure mode.
    if (!Array.isArray(r.path)) {
      setUnresolved((u) => (u.includes(key) ? u : [...u, key]));
      return null;
    }
    setNodes((m) => {
      const next = new Map(m);
      for (const n of r.path) next.set(n.idx, n);
      return next;
    });
    setPaths((m) => new Map(m).set(key, r.path.map((n) => n.idx)));
    setIdxOf((m) => new Map(m).set(key, r.idx));
    return r.idx;
  }, []);

  // Resolve anything in the view we do not already hold.
  useEffect(() => {
    const missing = view.keys.filter((k) => !paths.has(k) && !idxOf.has(k));
    if (missing.length === 0) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res =
          missing.length === 1
            ? { [missing[0]!]: await api.path(toApiKey(missing[0]!)) }
            : (await api.paths(missing.map(toApiKey))).paths;
        if (cancelled) return;
        for (const k of missing) {
          const r = res[toApiKey(k)] ?? res[k];
          if (r) ingest(k, r);
        }
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view.keys, paths, idxOf, ingest]);

  // Resolve any fossil in the view we do not already hold. Separate from the
  // path fetch above and deliberately so: a fossil has no path, and a failure
  // to resolve one must cost that fossil rather than the tree it annotates.
  useEffect(() => {
    const missing = view.fossils.filter((n) => !fossils.has(n));
    // Cleared here as well as on completion, because a cancelled run never
    // reaches its own reset: the deps changed under it, and the run that
    // replaces it may have nothing left to fetch. Without this the control bar
    // would report a fetch that finished two views ago.
    if (missing.length === 0) {
      setFossilsLoading(false);
      return;
    }
    let cancelled = false;
    // Its own flag rather than a second writer of `loading`, which means "the
    // *tree* is resolving" and is read as that: the graft-refusal announcer
    // waits on it, and a fossil fetch flipping it would suppress notices about
    // grafts that had already settled. Both feed the control bar, which is
    // asking a broader question — is anything still in flight.
    setFossilsLoading(true);
    (async () => {
      const got = await Promise.all(
        missing.map((n) => api.fossil(n).catch(() => null)),
      );
      if (cancelled) return;
      setFossilsLoading(false);
      const found = new Map<number, FossilTaxon>();
      const lost: number[] = [];
      missing.forEach((n, i) => {
        const f = got[i];
        if (f) found.set(n, f);
        else lost.push(n);
      });
      if (found.size) setFossils((m) => new Map([...m, ...found]));
      // A fossil id that resolves to nothing is dropped from the view rather
      // than retried forever. Same reasoning as a broken taxon: the id came
      // from a hand-edited or stale URL, nothing will ever be drawn for it, and
      // leaving it in means re-requesting it on every subsequent render.
      if (lost.length) {
        setView((v) => ({ ...v, fossils: v.fossils.filter((n) => !lost.includes(n)) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view.fossils, fossils]);

  const selectionIdx = useMemo(
    () => view.keys.map((k) => idxOf.get(k)).filter((v): v is number => v !== undefined),
    [view.keys, idxOf],
  );

  const ind = useMemo(() => {
    const byIdx = new Map<number, number[]>();
    for (const [k, p] of paths) {
      const i = idxOf.get(k);
      if (i !== undefined) byIdx.set(i, p);
    }
    return induced(selectionIdx, (i) => byIdx.get(i));
  }, [selectionIdx, paths, idxOf]);

  // Compute the animation delta whenever the rendered set grows. The MRCA is
  // the last common element of paths already in memory (architecture §2), so
  // this costs nothing and can fire in the same frame as the click.
  const lastCount = useRef(0);
  useEffect(() => {
    const grew = selectionIdx.length > lastCount.current;
    lastCount.current = selectionIdx.length;
    if (grew && ind.rendered.length) {
      const added = selectionIdx[selectionIdx.length - 1];
      const newest = ind.leaves.find((l) => !prevInduced.current?.leaves.includes(l));
      const target = newest ?? added;
      if (target !== undefined) {
        setDelta({ ...addDelta(prevInduced.current, ind, target), token: ++token.current });
      }
    }
    prevInduced.current = ind;
  }, [ind, selectionIdx]);

  const add = useCallback((key: string) => {
    const k = toUrlKey(key);
    setView((v) => (v.keys.includes(k) ? v : { ...v, keys: [...v.keys, k] }));
  }, []);

  const remove = useCallback((key: string) => {
    const k = toUrlKey(key);
    setView((v) => ({
      ...v,
      keys: v.keys.filter((x) => x !== k),
      selected: v.selected === k ? null : v.selected,
    }));
  }, []);

  /**
   * Draw a whole selection at once — an *opening*, not a sequence of adds.
   *
   * Replaces rather than appends, and resets the rest of the view with it. An
   * opening is a claim about a specific set of taxa ("a coelacanth is closer to
   * you than to a shark"), and it is only true of that set: added on top of a
   * canvas already holding a mushroom, the MRCA moves and the picture stops
   * showing what the copy promised. `DEFAULT` also clears `isolate` and `drill`,
   * either of which would hide the very branch the opening exists to display.
   *
   * Not expressible as repeated `add`: that would leave whatever was there,
   * and would fire {@link addDelta} once per key, so the signature animation
   * would play from a different MRCA three times instead of framing one tree.
   */
  const open = useCallback((keys: readonly string[], axis?: AxisMode) => {
    // Reset the animation baseline with the view, and this is load-bearing
    // rather than tidy. The signature draw is an *add*: `addDelta` splits the
    // new tree into waves by how far each node sits from the branch the added
    // leaf joined, and everything already on screen is excluded as `prior`.
    //
    // An opening shares no leaf with what it replaces, and its paths arrive
    // from the API one at a time — so leaving these refs pointing at the old
    // tree makes every intermediate delta compute waves against a baseline
    // that is neither the old tree nor the new one. Nodes land in waves whose
    // turn never comes and their traces stay at zero opacity: the marks and
    // labels draw, the branches connecting them do not.
    //
    // Nulling both puts this on exactly the path a cold load with `?n=…` takes,
    // which is the one that renders correctly.
    prevInduced.current = null;
    lastCount.current = 0;
    setView({
      ...DEFAULT,
      keys: [...new Set(keys.map(toUrlKey))],
      ...(axis ? { axis } : {}),
    });
  }, []);

  /**
   * Draw a fossil against the tree, or stop drawing it.
   *
   * Additive like `add`, and pointedly *not* a selection: `keys` is untouched,
   * so the induced subtree and therefore every MRCA on screen is exactly what
   * it was before. A graft cannot move a divergence, which is the whole reason
   * the two lists are separate.
   */
  const addFossil = useCallback((taxonNo: number) => {
    setView((v) =>
      v.fossils.includes(taxonNo) ? v : { ...v, fossils: [...v.fossils, taxonNo] },
    );
  }, []);

  const removeFossil = useCallback((taxonNo: number) => {
    setView((v) => ({ ...v, fossils: v.fossils.filter((n) => n !== taxonNo) }));
  }, []);

  const clear = useCallback(() => setView({ ...DEFAULT }), []);
  const setAxis = useCallback((axis: AxisMode) => setView((v) => ({ ...v, axis })), []);
  const select = useCallback(
    (key: string | null) => setView((v) => ({ ...v, selected: key && toUrlKey(key) })),
    [],
  );
  const toggleIsolate = useCallback(
    () => setView((v) => ({ ...v, isolate: !v.isolate })),
    [],
  );
  const setDrill = useCallback(
    (drill: ViewState["drill"]) => setView((v) => ({ ...v, drill })),
    [],
  );
  const dismissBroken = useCallback(
    (key: string) => setBroken((b) => b.filter((x) => x.key !== key)),
    [],
  );
  const dismissUnresolved = useCallback(
    (key: string) => setUnresolved((u) => u.filter((x) => x !== key)),
    [],
  );
  const consumeDelta = useCallback(() => setDelta(null), []);

  return {
    view,
    nodes,
    /** Resolved fossil rows, by PBDB taxon number. `view.fossils` is the order. */
    fossils,
    induced: ind,
    selectionIdx,
    idxOf,
    delta,
    loading,
    /** Grafts in the view whose PBDB rows have not arrived. Never `loading`. */
    fossilsLoading,
    broken,
    unresolved,
    error,
    add,
    open,
    remove,
    clear,
    setAxis,
    select,
    toggleIsolate,
    setDrill,
    addFossil,
    removeFossil,
    dismissBroken,
    dismissUnresolved,
    consumeDelta,
  };
}

export type Tree = ReturnType<typeof useTree>;
