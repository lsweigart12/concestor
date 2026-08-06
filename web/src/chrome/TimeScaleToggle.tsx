/**
 * The time-scale switch: a `ModeChip` like the other three, but sitting under
 * the timeline (on the ruler it redraws) rather than in the mode panel.
 */

import { kbd } from "./bindings";
import { ModeChip } from "./ModeChip";
import type { AxisMode } from "../tree/layout";

export function TimeScaleToggle({
  mode,
  onChange,
}: {
  mode: AxisMode;
  onChange: (m: AxisMode) => void;
}) {
  return (
    <ModeChip
      className="scale-mode"
      name="time scale"
      ariaLabel="Time scale"
      kbd={kbd("axis")}
      value={mode}
      onChange={onChange}
      // Linear first, being the default.
      segments={[
        {
          value: "linear",
          label: "linear",
          tip: "True proportions: twice as old is drawn twice as far out. Recent splits crowd together.",
        },
        {
          value: "log",
          label: "log",
          tip: "Room for recent splits alongside deep time. The scale bends at 1 Ma, where the axis says.",
        },
      ]}
    />
  );
}
