/**
 * The two switches that decide what a mark *says*.
 *
 * They replace semantic zoom. The canvas used to make this choice on the
 * reader's behalf out of how far they had zoomed — names under 0.55, the age
 * row under 0.62 — which is a rule about legibility being used to answer a
 * question about intent. Pulling back to see the whole shape of a tree is the
 * most ordinary thing anyone does here, and it silently took every name away;
 * reading one name meant zooming in until the tree no longer fitted. Neither
 * was ever asked for. `NodeMark.tsx`'s header has the rest, including the
 * threshold that the fit kept landing either side of.
 *
 * Two switches and not one, because the rows answer different questions. The
 * age is the only thing on a label the canvas already states another way — x is
 * time and there is a ruler under it — so it is the row a reader can spend and
 * still know what they are looking at. The rank travels with the name rather
 * than getting a third switch: it is what says a derived name is derived, and a
 * control whose only honest setting is on is not a control.
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
      // Three states on one key, so `L` cycles where every other toggle on this
      // edge flips. That is legible only because the chip is beside it: the
      // reader sees where the press landed and what the next one will do, which
      // a key with no visible state could not tell them.
      kbd={kbd("labels")}
      value={mode}
      onChange={onChange}
      /*
        Ordered by how much of the canvas they take away, with the default in
        the middle. A reader lands on `common`, and the two things they might
        want next sit either side of it: one step right for the formal name, one
        step left for no words at all. Off is at the end because it is the
        furthest thing from what they arrived at, and the key cycles through this
        order left to right, so the chip is a picture of what `L` does.
      */
      segments={[
        {
          value: "off",
          label: "off",
          title:
            "Take the words off the canvas: no rank, no name, no figure. The marks, the traces and the silhouettes stay, which is the tree as a shape — where the forks are, how far apart, and what the animals looked like. The labels are what make that hard to see.",
        },
        {
          value: "common",
          label: "common",
          title:
            "The name people use, where there is one — 'Human', 'Dog', 'blue whale' — ranked first by what English Wikipedia titles and redirects say is most used. Only species, genera and subspecies get one, because a common name higher up names a group rather than a kind of animal. Everything else keeps its scientific name, in italics, so you can always tell which you are reading.",
        },
        {
          value: "scientific",
          label: "scientific",
          title:
            "The name in the taxonomy, italic for a genus, species or subspecies as convention has it. It is the name that is never absent and never ambiguous: every node has one, and no two taxa share one.",
        },
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
      name="ages"
      ariaLabel="Ages"
      kbd={kbd("ages")}
      value={on}
      onChange={onChange}
      segments={[
        {
          value: false,
          label: "off",
          title:
            "Drop the figure from every label. The tree still says when — x is time and the ruler is under it — so this trades the number for a canvas of names.",
        },
        {
          value: true,
          label: "on",
          title:
            "Print each mark's age: a divergence's date, an upper bound where the estimate is one, and a fossil taxon's range beside the ammonite. A node nobody has dated shows nothing, in either state.",
        },
      ]}
    />
  );
}
