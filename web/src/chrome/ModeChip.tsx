/**
 * One canvas mode: a key, a caption, and a switch. There are four — labels,
 * dates, time scale, bioluminescence — drawn as one set (controls that change
 * how the canvas is drawn, not what is on it). The three cells are always
 * supplied in the same order; a missing cell pulls a row out of the shared
 * grid. `.side-modes` in styles.css places them.
 */

interface ModeSegment<T> {
  value: T;
  /** What the segment prints. Also what the key badge would have to match. */
  label: string;
}

export function ModeChip<T extends string | boolean>({
  className,
  name,
  ariaLabel,
  kbd,
  value,
  segments,
  onChange,
}: {
  /** The variant's class, plus any state class the variant composes in. */
  className: string;
  /** The word outside the segments, saying what is being switched. */
  name: string;
  ariaLabel: string;
  /** The key badge. Always from `bindings.ts` via `kbd()`, never a literal. */
  kbd?: string;
  value: T;
  segments: readonly ModeSegment<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      className={`mode-chip ${className}`}
      role="group"
      aria-label={ariaLabel}
    >
      {/* Caption outside the track: "off"/"on"/"common" name nothing alone. */}
      <span className="mode-name">{name}</span>
      {/*
        Badge after the caption in source order (the caption spans both columns),
        and rendered even when empty so the shared grid stays aligned.
      */}
      <span className="mode-key">{kbd}</span>
      <span className="mode-track">
        {segments.map((s) => (
          <button
            key={String(s.value)}
            type="button"
            className={`mode-seg${value === s.value ? " is-on" : ""}`}
            aria-pressed={value === s.value}
            onClick={() => onChange(s.value)}
          >
            {s.label}
          </button>
        ))}
      </span>
    </div>
  );
}
