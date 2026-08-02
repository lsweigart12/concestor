/**
 * What this is, and a way to see it — in that order.
 *
 * It replaces two separate five-second toasts. "About" printed a build id and a
 * source-tree name; "Credits" printed a paragraph of licences too long to
 * finish before it vanished. Both answered questions a first-time reader has
 * not asked yet, and neither left them anywhere to go.
 *
 * So the panel leads with the openings — the same list the empty canvas
 * offers — because the honest answer to *what is this* is a drawn tree, not a
 * description of one. Provenance stays, moved below the fold and compressed to
 * the two facts that matter to a reader rather than to a maintainer: where the
 * data came from, and what the dashes mean. The build id is last and small; it
 * is for whoever files a bug.
 *
 * Picking an opening closes the panel. A modal that stayed open over the tree
 * it just drew would hide the answer it just gave.
 */

import { useEffect, useRef } from "react";
import type { About as AboutPayload } from "../api";
import { OPENINGS, type Opening } from "../openings";

export function About({
  about,
  onOpen,
  onClose,
}: {
  about: AboutPayload | null;
  onOpen: (o: Opening) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    requestAnimationFrame(() => ref.current?.focus());
  }, []);

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-wide about"
        role="dialog"
        aria-modal="true"
        aria-label="About Concestor"
      >
        <h2 className="modal-title">Concestor</h2>
        <p className="about-lede">
          Pick any two species and see where their lineages meet, drawn against
          deep time. <em>Concestor</em> is Dawkins' word for that meeting point.
        </p>

        <h3 className="about-h">Start here</h3>
        <ul className="openings">
          {OPENINGS.map((o, i) => (
            <li key={o.id}>
              <button
                type="button"
                className="opening"
                ref={i === 0 ? ref : undefined}
                onClick={() => onOpen(o)}
              >
                <span className="opening-q">{o.question}</span>
                <span className="opening-a">{o.reveal}</span>
              </button>
            </li>
          ))}
        </ul>

        <h3 className="about-h">Reading the tree</h3>
        <p className="about-p">
          A <strong>dashed</strong> branch means nobody has estimated that date
          — not that the date is zero. Where an age is an upper bound it is
          drawn as <span className="mono">≤</span>, and where there is no
          defensible number at all none is shown. Roughly half of the tree's
          internal nodes carry a verified divergence age; the rest is honest
          about not knowing.
        </p>

        <h3 className="about-h">Where this comes from</h3>
        <p className="about-p">
          Topology from the <strong>Open Tree of Life</strong> (synthesis v16.1,
          OTT 3.7.3). Divergence ages from <strong>Duke et al. 2026</strong>.
          Silhouettes from <strong>PhyloPic</strong>, each credited to its artist
          on the node card. Fossil ranges from the{" "}
          <strong>Paleobiology Database</strong>, geologic intervals from the{" "}
          <strong>ICS</strong>, common names from <strong>Wikidata</strong>, and
          descriptions from <strong>Wikipedia</strong>, fetched as you open a
          card.
        </p>

        <div className="about-foot">
          <span className="mono">
            {about ? `build ${about.build_id}` : "build unavailable"}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            <span className="kbd">esc</span> Close
          </button>
        </div>
      </div>
    </div>
  );
}
