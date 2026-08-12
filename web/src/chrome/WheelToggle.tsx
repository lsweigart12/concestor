/**
 * The switch for what a plain scroll does to the canvas: pan (the trackpad
 * convention) or zoom (the mouse one). `canvas/wheel.ts` holds the whole
 * argument, including why this is the one mode a classifier sets on its own —
 * the chip shows whatever is currently in charge, and a press here pins the
 * mode and retires the classifier for good. No key badge: this is a claim
 * about the pointer in the hand, and a keyboard is the one device it is
 * never about.
 */

import { ModeChip } from "./ModeChip";
import type { WheelMode } from "../canvas/wheel";

export function WheelToggle({
  mode,
  onChange,
}: {
  mode: WheelMode;
  onChange: (m: WheelMode) => void;
}) {
  return (
    <ModeChip
      className="wheel-mode"
      name="scroll"
      ariaLabel="Scroll"
      value={mode}
      onChange={onChange}
      segments={[
        { value: "pan", label: "pan" },
        { value: "zoom", label: "zoom" },
      ]}
    />
  );
}
