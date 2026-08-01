/**
 * The double-bracket mark: a faded envelope with a solid core inside it.
 *
 * This is the only place the app draws a stratigraphic range, and it is
 * separate from the drill-down lane on purpose. The fourth age tier
 * (`occurrence`, decided and unbuilt — handoff §7) puts the same mark on the
 * main canvas beside an extinct node, and it must not invent a second way to
 * draw the same uncertainty. Anything that needs a range takes `bracketGeom`
 * and this component; nothing else may draw one.
 *
 * A reader has to be able to tell "certainly present through here" from "no
 * part of this is certain" without reading a key, and for 60.4% of taxa it is
 * the second. So the envelope carries end caps whether or not a core is drawn:
 * a capped band with nothing inside reads as a complete, deliberate mark, where
 * a bare fade reads as something that failed to render.
 */

import { useId } from "react";
import type { Bracket as BracketGeom } from "./bracket";

interface Props {
  /** From `bracketGeom`. `absent` draws nothing — the caller owes it words. */
  geom: BracketGeom;
  y: number;
  /** Height of the envelope band. The core sits centred inside it. */
  height: number;
  /** Fraction of `height` the solid core takes. */
  coreRatio?: number;
  title?: string;
  className?: string;
}

export function Bracket({ geom, y, height, coreRatio = 0.52, title, className }: Props) {
  // A partial record's open end fades out rather than terminating at a
  // definite time, which is the vocabulary `.trace-unbounded` already uses on
  // the canvas for a position with no bound below it. Scoped per instance
  // rather than to a shared <defs>, so a second caller cannot inherit a
  // gradient that is not on its page.
  const gid = useId();
  if (geom.kind === "absent") return null;

  const coreH = Math.max(2, Math.round(height * coreRatio));
  const coreY = y + (height - coreH) / 2;
  const e = geom.envelope;

  return (
    <g className={["bracket", className].filter(Boolean).join(" ")}>
      {title && <title>{title}</title>}
      {geom.openYoung && (
        <defs>
          <linearGradient id={gid}>
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.34" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      <rect
        className="bracket-envelope"
        x={e.x}
        y={y}
        width={e.w}
        height={height}
        {...(geom.openYoung ? { fill: `url(#${gid})` } : {})}
      />
      {/* End caps, always. They are what makes an envelope with no core read
          as a whole mark rather than a missing one. The young cap is dropped
          where the record simply stops: capping it would claim a last
          appearance nobody recorded. */}
      <rect className="bracket-cap" x={e.x} y={y} width={1} height={height} />
      {!geom.openYoung && (
        <rect
          className="bracket-cap"
          x={e.x + e.w - 1}
          y={y}
          width={1}
          height={height}
        />
      )}
      {geom.certain && (
        <rect
          className="bracket-certain"
          x={geom.certain.x}
          y={coreY}
          width={geom.certain.w}
          height={coreH}
        />
      )}
    </g>
  );
}
