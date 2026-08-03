/**
 * The bioluminescence switch, bottom left, above the axis.
 *
 * It was the second member of a set that did not exist before — *controls that
 * change how the canvas is drawn rather than what is on it* — and borrowed the
 * time-scale control's anatomy to say so. There are three of them now, so that
 * anatomy is a component: `ModeChip` carries the reasoning, and this file holds
 * what is particular to the light.
 *
 * What is particular is that it lights at all. The other two chips state their
 * position and stop; this one glows, in the mode's own cyan, because glowing is
 * literally what it does — the chip is the one piece of chrome that can show a
 * reader what the mode is before they commit to it, and a switch that turns the
 * canvas into a lit instrument while looking exactly like the switch beside it
 * is withholding the only preview available.
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
      // The one lit state left on this panel, and it composes its own class
      // because it is the only control that earns one. See `.biolum-mode.is-lit`.
      className={`biolum-mode${on ? " is-lit" : ""}`}
      name="bioluminescence"
      ariaLabel="Bioluminescence"
      kbd={kbd("biolum")}
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
