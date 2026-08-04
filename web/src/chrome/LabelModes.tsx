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
          tip: "No words on the canvas — just the shape of the tree and the silhouettes.",
        },
        {
          value: "common",
          label: "common",
          // The rule about which taxa get one, and how the ranking is derived,
          // is the header above and `docs/name-ranking.md`. What a reader at
          // the switch needs is that the canvas will be a mixture and how to
          // read it, which is one clause.
          tip: "Everyday names where there is one — Human, Dog, blue whale. Anything without one keeps its scientific name, in italics.",
        },
        {
          value: "scientific",
          label: "scientific",
          tip: "The formal name, in italics. Every taxon has one and no two share one.",
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
          tip: "Hide the dates. The ruler underneath still says when.",
        },
        {
          value: true,
          label: "on",
          // The caveat stays, shorter: a reader who sees a blank where they
          // expected a number should know it is the data and not the switch.
          tip: "Print each mark's date, and a fossil's range. Undated nodes stay blank either way.",
        },
      ]}
    />
  );
}
