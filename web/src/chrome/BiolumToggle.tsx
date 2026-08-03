/**
 * The bioluminescence switch, bottom left, above the axis.
 *
 * It borrows the time-scale control's anatomy on purpose — key badge, then the
 * state — because it is the second member of a set that did not exist before:
 * *controls that change how the canvas is drawn rather than what is on it*.
 * Those belong on the bottom edge with the axis, and the actions that change
 * the selection belong on the control bar at the top. One reading of that split
 * already existed (`.axis-mode`'s note); this is the rule it implied.
 *
 * Two segments rather than one label, for the same reason the scale has two: a
 * one-sided toggle never says whether the word on it is the state or the
 * destination, and a reader who wants the plain instrument back should be able
 * to press *off* rather than have to know the button reverses.
 *
 * `is-modified` is the quiet-default rule, shared with the scale: off is the
 * default, so off is plain ink and the control says nothing about itself. On is
 * a departure the reader chose, and the whole chip picks up the light.
 */

import { kbd } from "./bindings";

export function BiolumToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className={`biolum-mode${on ? " is-modified" : ""}`}
      role="group"
      aria-label="Bioluminescence"
    >
      <span className="kbd">{kbd("biolum")}</span>
      {/* The label is outside both segments, unlike the scale's, because "off"
          and "on" name nothing on their own. The scale's segments are "linear"
          and "log", which do. */}
      <span className="biolum-name">bioluminescence</span>
      {([false, true] as const).map((v) => (
        <button
          key={String(v)}
          type="button"
          className={`biolum-seg${on === v ? " is-on" : ""}`}
          aria-pressed={on === v}
          onClick={() => onChange(v)}
          title={
            v
              ? "Light the canvas the way the deep sea is lit: additive bloom on the branches, light travelling down each lineage, a drifting field of plankton behind it. Nothing about the data changes — every dash, tier and figure is identical in both states."
              : "The plain instrument: luminous lines on a dark ground, and no light that did not come from the graph."
          }
        >
          {v ? "on" : "off"}
        </button>
      ))}
    </div>
  );
}
