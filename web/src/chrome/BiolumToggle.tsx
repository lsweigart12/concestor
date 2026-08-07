/**
 * The bioluminescence switch, bottom left, above the axis. A `ModeChip` like
 * its two neighbours, but the one that glows (in the mode's own cyan) — the
 * chip is the only preview of what the mode does.
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
      className={`biolum-mode${on ? " is-lit" : ""}`}
      name="bioluminescence"
      ariaLabel="Bioluminescence"
      kbd={kbd("biolum")}
      value={on}
      onChange={onChange}
      segments={[
        { value: false, label: "off" },
        { value: true, label: "on" },
      ]}
    />
  );
}
