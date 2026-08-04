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
 *
 * Outside that sit the three **canvas modes** — bioluminescence, the labels and
 * the ages — in `sessionStorage` and never in a link. The line is what a setting
 * is *about*: everything in `ViewState` is a claim about taxa, and a link
 * carrying it hands the recipient the sender's finding. These three say how one
 * reader wants the canvas drawn, which is a fact about the reader. A tree shared
 * with `names=common` would impose one person's reading habit on somebody who
 * did not ask for it, and — the sharper case — a link made while the labels were
 * *off* would open on a canvas of unnamed dots.
 *
 * `sessionStorage` rather than `localStorage`, per-tab, so a link always opens
 * at the defaults in a fresh tab while a reader who chose something keeps it
 * across reloads and across every link they follow in that tab. {@link BIOLUM_KEY}
 * carries the rest of the argument; the labels and the ages joined it, and
 * nothing that makes a claim about the *data* may follow them out.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { beacon, type Cause } from "../analytics/beacon";
import { api, type FossilTaxon, type PathNode, type Resolved } from "../api";
import { addDelta, induced, type AddDelta, type Induced } from "../tree/induced";
import type { AxisMode } from "../tree/layout";
import type { LabelMode } from "../tree/naming";
import { plan, remaining, step, type Sequence } from "./sequence";

// One definition, in the module that does the mapping. The axis mode is view
// state, but it is *also* the scale the layout is computed on, and two copies
// of the union is how the toggle became a caption in the first place. The label
// mode is the same shape of thing: `naming.ts` resolves a mark's string from it
// and the layout is measured against that string, so the union belongs there.
export type { AxisMode, LabelMode };

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
 * The three canvas modes: the light, the labels and the ages. Deliberately
 * **not** in {@link ViewState}, and so deliberately not in the URL.
 *
 * Every member of `ViewState` is a claim about *taxa* — which ones, on what
 * scale, with what dimmed — and a link carrying them hands the recipient the
 * sender's finding. These three are claims about the reader: how they want light
 * drawn, which name they read a taxon by, whether they want the figure. Putting
 * them in the link means sharing a tree also imposes the habits somebody
 * happened to be using on a reader who did not ask for them — and one of the
 * three fails louder than the others, because a link made while the labels were
 * *off* opens on a canvas of unnamed dots.
 *
 * `sessionStorage` rather than `localStorage`, and the difference is the whole
 * point: it is per-tab, so a shared link opened in a new tab starts at the
 * defaults below, while a reader who chose something keeps it across reloads and
 * across every link they follow in that tab. That also answers the objection to
 * a stored preference, which was that a link would arrive looking like whatever
 * the *recipient* last chose: a fresh tab has chosen nothing.
 *
 * Consequences worth knowing. The modes are outside history, so back and forward
 * no longer step through them — correct, because pressing back is a request for
 * a previous *view*. And a canvas somebody lit, or read in English, is not a
 * canvas they can send; that is the trade this makes on purpose.
 */
const BIOLUM_KEY = "concestor.biolum";
const LABELS_KEY = "concestor.labels";
const AGES_KEY = "concestor.ages";

/**
 * Every value the labels mode may take, most importantly for *reading one back*.
 *
 * Three states rather than two, which adds a failure the booleans cannot have:
 * a stored value this app did not write has somewhere wrong to land. So the
 * loader looks it up in this list and falls to the default, rather than falling
 * through a chain of comparisons.
 */
export const LABEL_MODES = ["off", "scientific", "common"] as const;

/**
 * Common, on, off — and a default is an answer to *who arrives here*.
 *
 * Nobody sees a default having chosen it, so the question is what a stranger
 * should meet rather than what an enthusiast would pick. **This product is for
 * curious people interested in evolution, not for evolutionary biologists**, and
 * the whole of the labels default follows from that one sentence: `Human` and
 * `Chimpanzee` tell a stranger what they are looking at, where `Homo sapiens`
 * and `Pan troglodytes` tell a specialist something they already knew. The
 * scientific name is one press away and is what a reader who wants it goes
 * looking for; a reader who does not know they want it will never find the tree
 * legible.
 *
 * The mixture is the cost rather than the argument against. 110,794 nodes of
 * 2.7M carry an English name, so most of a deep tree falls back to Latin anyway
 * — which means this default is free where there is no common name and pays
 * where there is, and the italics say which is which.
 *
 * Ages on because deep time is what this app is *for*: the figure beside a fork
 * is the finding, and a first view without it is a shape. The light off because
 * the plain instrument is what a reader arrives at.
 *
 * They are exported because the chips read them. Which value is the default
 * decides which way `is-modified` lights, and a control with its own copy of
 * that is a control that can disagree with the store about what it is showing.
 */
export const BIOLUM_DEFAULT = false;
export const LABELS_DEFAULT: LabelMode = "common";
export const AGES_DEFAULT = true;

/**
 * Read one stored mode, or the default.
 *
 * One function for all three, because the failure they share is the one worth
 * handling: private browsing and blocked-storage settings **throw** on access
 * rather than returning null, and a mode that is optional by design must not
 * take the app down with it. Falling back is free — the default is the canvas
 * as it was.
 */
function readMode<T>(key: string, parse: (raw: string) => T | null, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? fallback : (parse(raw) ?? fallback);
  } catch {
    return fallback;
  }
}

/** Write one, or clear it where it is back at its default. */
function writeMode(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* private browsing; the mode still works, it just will not outlive a reload */
  }
}

export function loadBiolum(): boolean {
  // Only an exact "1" is on. Anything else is a value this app did not write,
  // and the benefit of the doubt goes to the plain instrument.
  return readMode(BIOLUM_KEY, (raw) => raw === "1", BIOLUM_DEFAULT);
}

/**
 * Exported for one caller that is not the canvas: the about page's offer.
 *
 * `/about` is a route and `main.tsx` unmounts the app to show it, so there is
 * no store there to toggle — but the light is `sessionStorage` and the canvas
 * reads it on mount, so writing it and then leaving is the whole of "try it".
 * That is the same path a reader who set the mode, followed a link and came
 * back already takes, which is why the offer needs no new plumbing.
 */
export function saveBiolum(on: boolean): void {
  writeMode(BIOLUM_KEY, on ? "1" : null);
}

export function loadLabels(): LabelMode {
  return readMode(
    LABELS_KEY,
    (raw) => LABEL_MODES.find((m) => m === raw) ?? null,
    LABELS_DEFAULT,
  );
}

function saveLabels(mode: LabelMode): void {
  writeMode(LABELS_KEY, mode === LABELS_DEFAULT ? null : mode);
}

export function loadAges(): boolean {
  // Spelled as the negative, because on is the default: only an exact "0"
  // turns them off, so a stored value we did not write leaves them on.
  return readMode(AGES_KEY, (raw) => raw !== "0", AGES_DEFAULT);
}

function saveAges(on: boolean): void {
  writeMode(AGES_KEY, on ? null : "0");
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

/**
 * A URL back into a view.
 *
 * Every key is put through {@link toUrlKey} on the way in, so `view.keys` has
 * **one spelling by construction** rather than every consumer remembering to
 * normalise. `ott770315` and `770315` are the same taxon and `idxOf` resolves
 * both, so `?n=ott770315` drew the right tree — but `add`, `remove` and
 * `select` all compare against the compact form, so pressing remove on that
 * lineage filtered `keys` for `770315`, matched nothing, and did nothing: the
 * mark stayed, the card stayed open, `selected` was never cleared, and nothing
 * on screen said why. `add` on the same key was worse — it appended a second,
 * differently-spelled entry for one taxon.
 *
 * Only a hand-written or externally-edited link can carry the prefixed form,
 * since `encode` always writes the compact one. That is not a reason to leave
 * it: a link is how this app is distributed, and the ones people type by hand
 * are the ones written from the API's own spelling.
 */
export function decode(search: string): ViewState {
  const p = new URLSearchParams(search);
  const raw = p.get("n");
  const sel = p.get("sel");
  const seg = (p.get("seg") ?? "").split("-").map(Number);
  const fossils = (p.get("f") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  return {
    // Deduplicated after normalising, for the same reason `fossils` is below
    // and on the same principle `add` and `open` already hold to: `?n=ott770315,770315`
    // is one taxon, and two entries for it is two React keys for one mark.
    keys: [...new Set(raw ? raw.split(",").filter(Boolean).map(toUrlKey) : [])],
    // Both directions name the non-default explicitly, so the pair stays
    // reversible: an absent `axis` is the default, whatever the default is.
    axis: p.get("axis") === "log" ? "log" : "linear",
    // Normalised with `keys`, and it has to be: `remove` clears the selection
    // by comparing it against the key it just took out, so a `sel=` spelled the
    // other way leaves the card open over a lineage no longer on the canvas.
    // An empty `sel=` is no selection rather than the empty string.
    selected: sel ? toUrlKey(sel) : null,
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
  // Not part of `view`, and so not in the URL or in history. See `BIOLUM_KEY`.
  const [biolum, setBiolum] = useState<boolean>(loadBiolum);
  const [labels, setLabelsState] = useState<LabelMode>(loadLabels);
  const [ages, setAgesState] = useState<boolean>(loadAges);
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
  /** An opening being drawn one taxon at a time, or null. See `sequence.ts`. */
  const [sequence, setSequence] = useState<Sequence | null>(null);
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
  //
  // A view that came *from* the URL replaces rather than pushes, and that is
  // not tidiness. `decode` canonicalises what it reads, so a link nobody's
  // `encode` wrote — `?n=ott770315`, a stale `?bio=1`, a trailing comma —
  // produces a view whose serialisation differs from the URL it arrived in.
  // Pushing that made the back button a no-op: back landed on the hand-written
  // entry, `onPop` decoded it, and this pushed the canonical form straight back
  // on top. The reader pressed back and stayed exactly where they were, with no
  // way past the page they had opened. Replacing rewrites the entry that
  // produced the view instead of adding one, which is what canonicalising *is*.
  const fromUrl = useRef(true);
  useEffect(() => {
    const url = encode(view);
    if (url !== (window.location.search || window.location.pathname)) {
      if (fromUrl.current) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    }
    // Consumed by the run it was set for, so the next change — which can only
    // be a mutator's — pushes.
    fromUrl.current = false;
  }, [view]);

  /**
   * What put the current selection on screen. See `docs/analytics.md` §2.
   *
   * A ref rather than state, because it is not a claim about the view and
   * nothing renders from it — and because setting it must not cost a render.
   * It starts at `"link"`, which is what a cold load *is*: `decode` reading
   * `?n=…` out of a URL somebody sent.
   *
   * It exists because a tree that was made and a tree that was received are
   * different facts, and counting them together would make one popular link
   * look like a thing readers keep independently discovering.
   */
  const cause = useRef<Cause>("link");
  const priorKeys = useRef<string[]>(view.keys);

  useEffect(() => {
    const onPop = () => {
      cause.current = "back";
      // The entry we just landed on is the one to canonicalise, not one to
      // stack another on top of. See `fromUrl`.
      fromUrl.current = true;
      setView(decode(window.location.search));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The one place the beacon is fed the selection. Every mutator below sets
  // `cause` and changes `view.keys`; none of them reports anything itself, so
  // there is no path that can change the canvas without this seeing it — and
  // an add that changed nothing (a key already selected) is not recorded,
  // because the diff is against what was actually on screen.
  useEffect(() => {
    if (cause.current === "add") {
      for (const k of view.keys) {
        if (!priorKeys.current.includes(k)) beacon.add(toApiKey(k));
      }
    }
    priorKeys.current = view.keys;
    // `toApiKey` on both, so one convention reaches the dataset. The URL's
    // compact form is a URL decision; a row in the answer should join against
    // `/v1/path/{key}` and against the edge log without anybody having to know
    // that `770315` and `ott770315` are the same taxon.
    beacon.tree(view.keys.map(toApiKey), cause.current);
  }, [view.keys]);

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
    cause.current = "add";
    setView((v) => (v.keys.includes(k) ? v : { ...v, keys: [...v.keys, k] }));
  }, []);

  const remove = useCallback((key: string) => {
    const k = toUrlKey(key);
    cause.current = "remove";
    setView((v) => ({
      ...v,
      keys: v.keys.filter((x) => x !== k),
      selected: v.selected === k ? null : v.selected,
    }));
  }, []);

  /**
   * Open on a selection — an *opening*'s first frame, and the reset it needs.
   *
   * Replaces rather than appends, and resets the rest of the view with it. An
   * opening is a claim about a specific set of taxa ("a coelacanth is closer to
   * you than to a shark"), and it is only true of that set: added on top of a
   * canvas already holding a mushroom, the MRCA moves and the picture stops
   * showing what the copy promised. `DEFAULT` also clears `isolate` and `drill`,
   * either of which would hide the very branch the opening exists to display.
   *
   * **What this may not be replaced by is repeated `add`**, and the two refs
   * nulled below are why. `add` leaves whatever was already on the canvas
   * standing, and it computes its delta against a baseline that is neither the
   * old tree nor the new one — see the note in the body. What this is *not* is
   * the whole of drawing an opening: {@link openSequenced} calls it with the
   * first taxon only and then steps the rest through `add` on purpose, because
   * the per-key delta this comment used to list as a defect is exactly the
   * animation the sequence exists to show. Reset once, here, then step.
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
    // An opening's taxa are never recorded as adds — not here and not on the
    // sequenced path, which is why {@link drawStep} sets its own cause rather
    // than calling `add`. They are one of a handful of canned comparisons, so
    // counting them as species people went looking for would put whatever the
    // openings happen to name at the top of that list for ever.
    cause.current = "open";
    // Everything an opening resets is a claim about *taxa*, which is everything
    // `DEFAULT` holds. Bioluminescence is not one of them and is no longer in
    // here to be reset — pressing "Are you a fish?" leaves the lights as the
    // reader set them, which is the same reasoning that moved it out of the URL.
    setView(() => ({
      ...DEFAULT,
      keys: [...new Set(keys.map(toUrlKey))],
      ...(axis ? { axis } : {}),
    }));
  }, []);

  /**
   * Resolve keys without drawing them.
   *
   * The whole of a sequence's network cost, paid on the press. One `/v1/paths`
   * for the set rather than one `/v1/path` per step, so the sequence is never
   * waiting on a round trip it could have started three beats ago — and so that
   * every step after the first is a pure state change against paths already in
   * memory. `ingest` keys on the URL form, which is what the resolve effect
   * above tests, so a subsequent `add` of the same key finds nothing missing
   * and fetches nothing.
   */
  const prefetch = useCallback(
    async (keys: readonly string[]): Promise<void> => {
      if (keys.length === 0) return;
      const res = (await api.paths(keys.map(toApiKey))).paths;
      for (const k of keys) {
        const r = res[toApiKey(k)] ?? res[k];
        if (r) ingest(toUrlKey(k), r);
      }
    },
    [ingest],
  );

  /**
   * One step of a sequence: a taxon joining a canvas that is already drawn.
   *
   * Deliberately not `add`. The only difference is the cause, and the cause is
   * the difference that matters — see {@link Cause}. A sequenced taxon is one
   * of ours, so it emits no `add` event, exactly as the whole-set `open` does
   * not.
   */
  const drawStep = useCallback((key: string) => {
    const k = toUrlKey(key);
    cause.current = "sequence";
    setView((v) => (v.keys.includes(k) ? v : { ...v, keys: [...v.keys, k] }));
  }, []);

  /**
   * Draw an opening, one taxon at a time. `sequence.ts` is the reasoning.
   *
   * Returns whether a sequence actually started, which is the caller's cue to
   * hold the `reveal` back: with reduced motion, or an opening too short to
   * have an ordering, this is today's single `open()` and the copy has nothing
   * to wait for.
   *
   * **Nothing calls this on boot**, and nothing may. It is reached from the two
   * surfaces that offer an opening and from no other path.
   */
  const openSequenced = useCallback(
    (keys: readonly string[], axis: AxisMode | undefined, reduced: boolean): boolean => {
      const p = plan(keys, reduced);
      open(p.first, axis);
      if (p.rest.length === 0) return false;
      setSequence({ keys: [...keys], drawn: p.first.length, since: Date.now(), settled: false });
      // `finally`, not `then`: a batch that fails is still an answer about
      // every key in it. Without this a dead API would leave the canvas holding
      // one taxon and an animation that never ends.
      void prefetch(p.rest)
        .catch(() => {})
        .finally(() => setSequence((s) => (s ? { ...s, settled: true } : s)));
      return true;
    },
    [open, prefetch],
  );

  /**
   * End a sequence at the finished tree, now.
   *
   * The other half of `sequence.ts`'s rule 2, and the reason an abort adds the
   * remaining keys rather than simply stopping: the reader interrupted the
   * *telling* of the argument, not the argument. Leaving a half-drawn opening
   * on the canvas would answer "are you a fish?" with two species and no shark.
   *
   * Idempotent, because it is wired to every interaction there is and several
   * of them arrive together.
   */
  const cutSequence = useCallback(() => {
    if (!sequence) return;
    const rest = remaining(sequence).map(toUrlKey);
    setSequence(null);
    if (rest.length === 0) return;
    cause.current = "sequence-cut";
    setView((v) => ({
      ...v,
      keys: [...v.keys, ...rest.filter((k) => !v.keys.includes(k))],
    }));
  }, [sequence]);

  /**
   * The driver. Every decision in it belongs to `sequence.ts`; what lives here
   * is the clock, the arrival test and the timer.
   *
   * Two wake-ups and no polling: `paths` changing is the arrival, and a timer
   * armed only when the floor is the thing being waited on. A step whose path
   * has not landed schedules nothing at all, which is what makes a cold cache
   * delay the sequence instead of running it ahead of the canvas.
   */
  useEffect(() => {
    if (!sequence) return;
    const now = Date.now();
    const next = step(sequence, now, (k) => paths.has(toUrlKey(k)));
    if (next.kind === "done") {
      setSequence(null);
      return;
    }
    // Advancing is keyed on *which* taxon landed rather than on a count, so
    // applying it twice is applying it once. That is not defensive: `StrictMode`
    // double-invokes an effect on mount, both invocations land in one commit,
    // and two composed `drawn + 1` updates would step the sequence past a taxon
    // that was never drawn.
    const land = (key: string, at: number) => {
      drawStep(key);
      setSequence((s) =>
        s && s.keys[s.drawn] === key ? { ...s, drawn: s.drawn + 1, since: at } : s,
      );
    };
    if (next.kind === "draw") {
      land(next.key, now);
      return;
    }
    if (next.after === null) return;
    // Draws directly rather than waking to re-ask. Arrival is monotone — a path
    // in the map stays in it — so the only condition left when this fires is
    // the one it was armed for.
    const t = window.setTimeout(() => land(next.key, Date.now()), next.after);
    return () => window.clearTimeout(t);
  }, [sequence, paths, drawStep]);

  /**
   * The age the axis is held out to while a sequence runs, or null.
   *
   * The final extent, computed once every lineage has arrived: the induced
   * subtree of the *whole* opening, and the oldest `age_layout` in it. That is
   * the same number `layout` would compute on the last step, which is the
   * point — see the note on `holdMaxAge` in `tree/layout.ts` for why the axis
   * is pinned rather than tweened.
   *
   * Null until the prefetch settles, and it costs nothing: the first step is a
   * single species at the present, which sits at the right-hand edge of the
   * plot under any scale.
   */
  const holdMaxAge = useMemo(() => {
    if (!sequence?.settled) return null;
    const byIdx = new Map<number, number[]>();
    const sel: number[] = [];
    for (const k of sequence.keys) {
      const u = toUrlKey(k);
      const i = idxOf.get(u);
      const p = paths.get(u);
      if (i === undefined || p === undefined) continue;
      sel.push(i);
      byIdx.set(i, p);
    }
    if (sel.length < 2) return null;
    let oldest = 1;
    for (const i of induced(sel, (v) => byIdx.get(v)).rendered) {
      oldest = Math.max(oldest, nodes.get(i)?.age_layout ?? 0);
    }
    return oldest;
  }, [sequence, idxOf, paths, nodes]);

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

  // Same reasoning as `open`: clearing takes the taxa off the canvas, and the
  // lighting is not one of them. The confirmation dialog promises this removes
  // species and fossils and that "nothing else is affected".
  const clear = useCallback(() => {
    // Any interaction has already cut a running sequence, so this is the belt
    // to that brace: a driver still stepping onto a canvas somebody has just
    // emptied would put the opening back one taxon at a time.
    setSequence(null);
    cause.current = "clear";
    setView(DEFAULT);
  }, []);
  const setAxis = useCallback((axis: AxisMode) => setView((v) => ({ ...v, axis })), []);
  // Written through on the setter, like the light above, so the store is the
  // only thing that touches the key and a render can never overwrite a choice.
  const setLabels = useCallback((mode: LabelMode) => {
    saveLabels(mode);
    setLabelsState(mode);
  }, []);
  const setAges = useCallback((on: boolean) => {
    saveAges(on);
    setAgesState(on);
  }, []);
  // Written through on the toggle rather than in an effect, so the store is the
  // only thing that touches the key and a render can never overwrite a choice.
  const toggleBiolum = useCallback(
    () =>
      setBiolum((on) => {
        saveBiolum(!on);
        return !on;
      }),
    [],
  );
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
    /**
     * The three canvas modes. Session state, not view state — none is in `view`,
     * so none is in a link. See `BIOLUM_KEY`.
     */
    biolum,
    labels,
    ages,
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
    /** An opening is drawing itself one taxon at a time. */
    sequencing: sequence !== null,
    /** The age the axis is held at while it does. See `tree/layout.ts`. */
    holdMaxAge,
    add,
    open,
    openSequenced,
    cutSequence,
    remove,
    clear,
    setAxis,
    setLabels,
    setAges,
    select,
    toggleIsolate,
    toggleBiolum,
    setDrill,
    addFossil,
    removeFossil,
    dismissBroken,
    dismissUnresolved,
    consumeDelta,
  };
}

export type Tree = ReturnType<typeof useTree>;
