/**
 * The bioluminescence switch, bottom left, above the axis.
 *
 * It was the second member of a set that did not exist before — *controls that
 * change how the canvas is drawn rather than what is on it* — and borrowed the
 * time-scale control's anatomy to say so. There are three of them now, so that
 * anatomy is a component: `ModeChip` carries the reasoning, and this file holds
 * what is particular to the light.
 *
 * What is particular is the accent. The other two chips light in the app's own
 * accent when they leave their default; this one lights in the mode's cyan,
 * because it is the only one of the three that changes how the whole canvas
 * looks and the chip is the one piece of chrome that can say so in advance.
 */

import { kbd } from "./bindings";
import { ModeChip } from "./ModeChip";

export function BiolumToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <ModeChip
      className="biolum-mode"
      name="bioluminescence"
      ariaLabel="Bioluminescence"
      kbd={kbd("biolum")}
      modified={on}
      value={on}
      onChange={onChange}
      segments={[
        {
          value: false,
          label: "off",
          title:
            "The plain instrument: luminous lines on a dark ground, and no light that did not come from the graph.",
        },
        {
          value: true,
          label: "on",
          title:
            "Light the canvas the way the deep sea is lit: additive bloom on the branches, light travelling down each lineage, a drifting field of plankton behind it. Nothing about the data changes — every dash, tier and figure is identical in both states.",
        },
      ]}
    />
  );
}
