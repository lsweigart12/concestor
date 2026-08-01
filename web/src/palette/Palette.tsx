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
 *    about a substituted MRCA the way the live Open Tree API does.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type SearchHit } from "../api";
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
  const [hits, setHits] = useState<SearchHit[]>([]);
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
    const hitRows: Row[] = hits.map((hit, i) => {
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
    });

    return [...hitRows, ...cmdRows].sort((a, b) => b.score - a.score);
  }, [q, commands, hits]);

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

          {!failed && rows.length === 0 && (
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
              key={row.kind === "cmd" ? row.cmd.id : `h${row.hit.idx}`}
              row={row}
              active={i === active}
              present={present}
              onHover={() => setActive(i)}
              onClick={() => commit(row)}
            />
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
  const broken = h.kind === "broken";

  return (
    <div
      className={`row${active ? " active" : ""}`}
      onMouseMove={onHover}
      onClick={onClick}
    >
      <span className="row-icon">
        {broken ? "!" : "◦"}
      </span>
      <span className="row-body">
        <span className={`row-title${italic ? " sci-italic" : ""}`}>
          {parts(h.name ?? h.key, row.ranges)}
        </span>
        <span className="row-sub">
          {broken ? (
            "not monophyletic — has no single position in the tree"
          ) : (
            <>
              {h.vernacular && <>{parts(h.vernacular, row.vernRanges)} · </>}
              {h.rank && <>{h.rank} · </>}
              {h.tip_count.toLocaleString()} species
            </>
          )}
        </span>
      </span>
      <span className="row-accessory">
        {already && <span className="kbd">on canvas</span>}
        {active && !already && <span className="kbd">↵ add</span>}
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
