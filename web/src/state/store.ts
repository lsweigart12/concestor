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
import { api, type PathNode, type Resolved } from "../api";
import { addDelta, induced, type AddDelta, type Induced } from "../tree/induced";

export type AxisMode = "log" | "linear";

export interface ViewState {
  /** OTT ids or node keys, in selection order (which is *not* render order). */
  keys: string[];
  axis: AxisMode;
  selected: string | null;
  isolate: boolean;
}

const DEFAULT: ViewState = { keys: [], axis: "log", selected: null, isolate: false };

export function decode(search: string): ViewState {
  const p = new URLSearchParams(search);
  const raw = p.get("n");
  return {
    keys: raw ? raw.split(",").filter(Boolean) : [],
    axis: p.get("axis") === "linear" ? "linear" : "log",
    selected: p.get("sel"),
    isolate: p.get("iso") === "1",
  };
}

export function encode(v: ViewState): string {
  const p = new URLSearchParams();
  if (v.keys.length) p.set("n", v.keys.join(","));
  if (v.axis !== "log") p.set("axis", v.axis);
  if (v.selected) p.set("sel", v.selected);
  if (v.isolate) p.set("iso", "1");
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
  loading: boolean;
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
  const prevInduced = useRef<Induced | null>(null);
  const token = useRef(0);

  // URL is the serialisation. Push on change, and honour back/forward.
  useEffect(() => {
    const url = encode(view);
    if (url !== window.location.search && url !== window.location.pathname) {
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
    induced: ind,
    selectionIdx,
    idxOf,
    delta,
    loading,
    broken,
    unresolved,
    error,
    add,
    remove,
    clear,
    setAxis,
    select,
    toggleIsolate,
    dismissBroken,
    dismissUnresolved,
    consumeDelta,
  };
}

export type Tree = ReturnType<typeof useTree>;
