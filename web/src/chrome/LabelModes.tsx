/**
 * The two switches that decide what a mark says: which name, and whether the
 * date shows. Two switches rather than one because the age is the only thing on
 * a label the axis already states, so it is the row a reader can turn off and
 * still read the canvas.
 */

import { kbd } from "./bindings";
import { ModeChip } from "./ModeChip";
import type { LabelMode } from "../tree/naming";

export function LabelsToggle({
  mode,
  onChange,
}: {
  mode: LabelMode;
  onChange: (m: LabelMode) => void;
}) {
  return (
    <ModeChip
      className="labels-mode"
      name="labels"
      ariaLabel="Labels"
      // `L` cycles these three states; the chip shows where the press landed.
      kbd={kbd("labels")}
      value={mode}
      onChange={onChange}
      segments={[
        { value: "off", label: "off" },
        { value: "common", label: "common" },
        { value: "scientific", label: "scientific" },
      ]}
    />
  );
}

export function AgesToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <ModeChip
      className="ages-mode"
      // Labelled "Dates" but the internal name stays `ages`.
      name="dates"
      ariaLabel="Dates"
      kbd={kbd("ages")}
      value={on}
      onChange={onChange}
      segments={[
        { value: false, label: "off" },
        { value: true, label: "on" },
      ]}
    />
  );
}
