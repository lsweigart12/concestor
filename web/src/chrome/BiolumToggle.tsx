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
          tip: "A plain dark canvas. Nothing glows but the tree itself.",
        },
        {
          value: true,
          label: "on",
          // Two sentences, and the second is the one that matters: a reader who
          // suspects the pretty mode of also being the inaccurate one will
          // leave it off. "The plain instrument" — this project's own name for
          // the other setting — is in the header above, where it belongs.
          tip: "Lights the branches the way the deep sea is lit, with drifting plankton behind them. Nothing about the data changes.",
        },
      ]}
    />
  );
}
