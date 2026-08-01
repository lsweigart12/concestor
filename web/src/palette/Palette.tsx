/**
 * The command surface. ⌘K is the root, and the palette *is* the interface —
 * not an accessory to it. Opening the app opens the palette, and the empty
 * canvas state is the command list rather than an illustration.
 *
 * Row anatomy follows Raycast: icon · title · subtitle · right-aligned
 * accessory metadata, with an inline keybind hint on every row.
 *
 * Two things make this load-bearing rather than convenient:
 *
 * 1. **Vernacular names.** OTT carries no common names, so a palette backed by
 *    scientific names alone returns nothing for "dog", "T. rex" or "shark" —
 *    broken at the front door, not merely incomplete. The search endpoint
 *    covers vernaculars; this component surfaces them as the subtitle so you
 *    can see *why* a row matched.
 *
 * 2. **Broken taxa.** 9,839 taxa are non-monophyletic and are rejected from
 *    synthesis outright. Searching one must explain that, not silently answer
 *    about a substituted MRCA the way the live Open Tree API does. It must not
 *    do it *as a result*, though — see {@link BrokenNote}.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AnyHit, type BrokenHit, type SearchHit } from "../api";
import { fuzzy, highlight, litRanges, recordUse, sessionBoost } from "./fuzzy";

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  icon: string;
  keys?: string;
  section: string;
  /** Hidden unless a node is focused — the contextual actions menu. */
  contextual?: boolean;
  run: () => void;
}

export interface Scope {
  label: string;
  /** Popped by backspace at cursor position zero. */
  onPop: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  scope: Scope | null;
  onPick: (hit: SearchHit) => void;
  /** Names already on the canvas, so the palette can say "already added". */
  present: Set<number>;
}

type Row =
  | { kind: "cmd"; cmd: Command; score: number; ranges: [number, number][] }
  | {
      kind: "hit";
      hit: SearchHit;
      score: number;
      /** Highlight on the scientific name… */
      ranges: [number, number][];
      /** …or on the vernacular, when that is what actually matched. */
      vernRanges: [number, number][];
    };

const DEBOUNCE_MS = 110;

export function Palette({ open, onClose, commands, scope, onPick, present }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<AnyHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setFailed(null);
      // Focus after paint so the caret lands in an element that exists.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await api.search(q.trim(), 24);
        if (!cancelled) {
          setHits(r.results);
          setFailed(null);
        }
      } catch (e) {
        if (!cancelled) {
          setHits([]);
          setFailed(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, open]);

  const rows: Row[] = useMemo(() => {
    const needle = q.trim();
    const cmdRows: Row[] = commands
      .map((cmd) => {
        const m = fuzzy(needle, cmd.title);
        if (!m) return null;
        return {
          kind: "cmd" as const,
          cmd,
          score: m.score + sessionBoost(cmd.id) + (needle ? 0 : 50),
          ranges: m.ranges,
        };
      })
      .filter((r): r is Extract<Row, { kind: "cmd" }> => r !== null);

    // The server has already ranked on corpus signals it can see and we
    // cannot — subtree size, silhouette coverage, age quality. Preserve that
    // order and layer the session signal on top rather than re-sorting from
    // scratch, which would throw away the better signal of the two.
    //
    // Broken taxa are excluded here rather than styled differently: they are
    // not answers, they cannot be added, and anything in this list is
    // something Enter will act on. They render as a note below the list.
    const hitRows: Row[] = hits.map((hit, i) => {
      if (hit.kind === "broken") return null;
      const hay = hit.name ?? hit.key;
      const m = fuzzy(needle, hay) ?? fuzzy(needle, hit.vernacular ?? "");
      return {
        kind: "hit" as const,
        hit,
        score: 4000 - i * 10 + sessionBoost(`n:${hit.idx}`) + (m?.score ?? 0) / 40,
        // Show the reader why this row is here — on whichever field it is
        // actually true of, and not at all when neither contains what they
        // typed (a synonym or an abbreviation got them here instead).
        ranges: litRanges(needle, hay),
        vernRanges: hit.vernacular ? litRanges(needle, hit.vernacular) : [],
      };
    }).filter((r): r is Extract<Row, { kind: "hit" }> => r !== null);

    return [...hitRows, ...cmdRows].sort((a, b) => b.score - a.score);
  }, [q, commands, hits]);

  const notes: BrokenHit[] = useMemo(
    () => hits.filter((h): h is BrokenHit => h.kind === "broken"),
    [hits],
  );

  useEffect(() => setActive(0), [q]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(".row.active");
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const commit = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === "cmd") {
        recordUse(row.cmd.id);
        row.cmd.run();
      } else {
        recordUse(`n:${row.hit.idx}`);
        onPick(row.hit);
      }
    },
    [onPick],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, rows.length - 1));
      } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        commit(rows[active]);
      } else if (
        e.key === "Backspace" &&
        scope &&
        e.currentTarget.selectionStart === 0 &&
        e.currentTarget.selectionEnd === 0
      ) {
        // Backspace at position zero pops the scope, per design-reference.md.
        e.preventDefault();
        scope.onPop();
      }
    },
    [rows, active, commit, onClose, scope],
  );

  if (!open) return null;

  return (
    <div
      className="palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input-row">
          {scope && <span className="scope-chip">{scope.label}</span>}
          <input
            ref={inputRef}
            className="palette-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              scope ? "Action…" : "Search a species, or type a command — try “dog”"
            }
            spellCheck={false}
            autoComplete="off"
            aria-label="Search or command"
          />
          {searching && <span className="kbd">…</span>}
        </div>

        <div className="palette-list" ref={listRef}>
          {failed && (
            <div className="palette-empty">
              Search is unreachable — <span className="mono">{failed}</span>
              <br />
              Start the read API with{" "}
              <span className="kbd">go run ./server -build ./build</span>.
            </div>
          )}

          {!failed && rows.length === 0 && notes.length === 0 && (
            <div className="palette-empty">
              {q.trim().length >= 2 ? (
                <>
                  Nothing matched <strong>{q.trim()}</strong>.
                  <br />
                  Scientific names always work; common names depend on the
                  vernacular index having been built.
                </>
              ) : (
                <>Type to search 2.4 million species, or pick a command.</>
              )}
            </div>
          )}

          {rows.map((row, i) => (
            <RowView
              // `key` is the node key, not the idx: it is the only field that
              // is both present and unique on every hit the server can send.
              key={row.kind === "cmd" ? `c${row.cmd.id}` : `h${row.hit.key}`}
              row={row}
              active={i === active}
              present={present}
              onHover={() => setActive(i)}
              onClick={() => commit(row)}
            />
          ))}

          {notes.map((n) => (
            <BrokenNote key={`b${n.key}`} hit={n} />
          ))}
        </div>
      </div>
    </div>
  );
}

function RowView({
  row,
  active,
  present,
  onHover,
  onClick,
}: {
  row: Row;
  active: boolean;
  present: Set<number>;
  onHover: () => void;
  onClick: () => void;
}) {
  if (row.kind === "cmd") {
    const c = row.cmd;
    return (
      <div
        className={`row${active ? " active" : ""}`}
        onMouseMove={onHover}
        onClick={onClick}
      >
        <span className="row-icon">{c.icon}</span>
        <span className="row-body">
          <span className="row-title">{parts(c.title, row.ranges)}</span>
          {c.subtitle && <span className="row-sub">{c.subtitle}</span>}
        </span>
        <span className="row-accessory">
          {c.keys && <span className="kbd">{c.keys}</span>}
        </span>
      </div>
    );
  }

  const h = row.hit;
  const already = present.has(h.idx);
  const italic = h.rank === "species" || h.rank === "genus";

  return (
    <div
      className={`row${active ? " active" : ""}`}
      onMouseMove={onHover}
      onClick={onClick}
    >
      <span className="row-icon">◦</span>
      <span className="row-body">
        <span className={`row-title${italic ? " sci-italic" : ""}`}>
          {parts(h.name ?? h.key, row.ranges)}
        </span>
        <span className="row-sub">
          {h.vernacular && <>{parts(h.vernacular, row.vernRanges)} · </>}
          {h.rank && <>{h.rank} · </>}
          {h.tip_count.toLocaleString()} species
        </span>
      </span>
      <span className="row-accessory">
        {already && <span className="kbd">on canvas</span>}
        {active && !already && <span className="kbd">↵ add</span>}
      </span>
    </div>
  );
}

/**
 * The answer to "you typed the name of something that is not in the tree".
 *
 * Deliberately not a row. A broken taxon cannot be selected, cannot be added
 * and has no position to draw, so offering it in the ranked list was offering
 * a dead end: picking one put a key in the URL that resolved to nothing, and
 * because nothing was ever drawn there was no node to select and remove — the
 * warning came back on every subsequent add with no way to clear it. A note
 * says the same true thing and cannot be picked.
 */
function BrokenNote({ hit }: { hit: BrokenHit }) {
  const n = hit.n_attachment_points;
  return (
    <div className="palette-note" role="note">
      <span className="row-icon">!</span>
      <span className="row-body">
        <span className="row-title">
          <strong className="sci-italic">{hit.name ?? hit.key}</strong> is not
          monophyletic
        </span>
        <span className="row-sub">
          Its members are scattered across the tree
          {n ? ` — ${n.toLocaleString()} separate places` : ""}, so it has no
          single position and is left out of the synthesis. Search for one of
          the groups inside it instead.
        </span>
      </span>
    </div>
  );
}

function parts(text: string, ranges: [number, number][]) {
  return highlight(text, ranges).map((p, i) =>
    p.hit ? (
      <span className="hl" key={i}>
        {p.text}
      </span>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  );
}
