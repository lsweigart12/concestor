/**
 * The time-scale switch: bottom left, under the timeline, in the panel's
 * clothes.
 *
 * Two separate questions, and they got separate answers.
 *
 * **What it looks like.** It used to have an anatomy of its own — its own
 * border, its own `.axis-seg` segments, and an `is-modified` state that took
 * the app's accent whenever the axis was logarithmic. That was defensible when
 * it was the only control on this edge. It stopped being once there were four
 * of these, because the scale answers exactly the question the labels, the ages
 * and the light answer — *how is the canvas drawn, rather than what is on it* —
 * and a set of four whose fourth member is furnished differently is a set the
 * reader has to be told about rather than shown. So it is a `ModeChip` now.
 *
 * **Where it lives.** Not in that panel, though, and the pull to put it there
 * was strong enough to be worth writing down: the set argument says group them,
 * and the stronger rule says a control belongs on the thing it changes. This
 * one redraws the ruler. Sitting on the ruler, it is the only control down here
 * and the reader who wonders about the axis looks at the axis; sitting in the
 * panel, it is a fourth row of a stack about labels. Family resemblance is
 * cheaper to carry than proximity, so it took the anatomy and stayed put.
 *
 * Two things about the shared anatomy are deliberate losses rather than
 * oversights:
 *
 * **It takes a caption.** `ModeChip`'s note calls this the one chip that needs
 * no word outside its segments, because "linear" and "log" name themselves
 * where "off" and "on" do not. True of the words, and beside the point now: the
 * caption is what makes it read as one of the four at a glance, and on the
 * footer's single line it costs a few characters rather than a row.
 *
 * **It gives up `is-modified`.** A log axis used to announce itself in the
 * accent, on the argument that a reader arriving on a shared `axis=log` link
 * did not choose the scale. The panel's rule is the stronger one: exactly one
 * of these may glow, and it is the light, because glowing is what that one
 * *does*. The switch still states its position, which is what a reader needs in
 * order to know they are not on the default — and the axis labels its own knee.
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
      /*
        Linear first, because it is the default and the panel reads left to
        right from where a reader starts. `symlog` stays out of the words — it
        is the name of a transform, not of anything on screen — and the knee is
        labelled on the axis at the place it actually happens.
      */
      segments={[
        // "Ticks are millions of years before present" came off both. It is a
        // fact about the axis rather than about either setting, so it was the
        // same clause twice in a control that switches between them — and the
        // axis already prints `Ma` under its own numbers.
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
