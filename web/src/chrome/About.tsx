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
import { OpeningCarousel } from "./OpeningCarousel";
import type { Opening } from "../openings";

/**
 * A named source, linked to the page a curious reader would want.
 *
 * Each target is the thing itself rather than its homepage where the two
 * differ: Open Tree goes to the browsable tree, Duke et al. to the Zenodo
 * deposit that carries the CC-BY the ages are used under — not the preprint —
 * and the ICS to the chart rather than to the commission. It replaces the
 * `<strong>` these used to be, which named every source and reached none of
 * them.
 *
 * `noreferrer noopener` and a new tab, the same as every other outbound link
 * here: the canvas is a working surface and a reader following a citation has
 * not asked to lose the tree they assembled.
 */
function Src({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="about-src" href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

export function About({
  about,
  onOpen,
  onClose,
}: {
  about: AboutPayload | null;
  onOpen: (o: Opening) => void;
  onClose: () => void;
}) {
  /**
   * Focus lands on Close, not on the first opening.
   *
   * Something inside the dialog has to take focus or Escape and Tab both start
   * outside it. Close is the one control here that cannot change what is on the
   * canvas, which makes it the safe landing: a keyboard reader who opens this
   * and hits Enter by reflex should not have their tree replaced by whichever
   * question the carousel happened to be showing.
   */
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
        {/*
          The same carousel the empty canvas shows, and not a list of all six.
          A list put the panel's own content — what the dashes mean, where the
          data comes from — below six questions and six answers, so the reader
          had to scroll past the thing they already saw on the canvas to reach
          the thing they opened this to read.

          `autoRotate` is off here, and the component says why.
        */}
        <OpeningCarousel onOpen={onOpen} autoRotate={false} />

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
          Topology from the <Src href="https://tree.opentreeoflife.org/">Open Tree of Life</Src>{" "}
          (synthesis v16.1, OTT 3.7.3). Divergence ages from{" "}
          <Src href="https://doi.org/10.5281/zenodo.19049120">Duke et al. 2026</Src>.
          Silhouettes from <Src href="https://www.phylopic.org/">PhyloPic</Src>, each
          credited to its artist on the node card. Fossil ranges from the{" "}
          <Src href="https://paleobiodb.org/">Paleobiology Database</Src>, geologic
          intervals from the <Src href="https://stratigraphy.org/chart">ICS</Src>,
          common names from <Src href="https://www.wikidata.org/">Wikidata</Src>, and
          descriptions from <Src href="https://www.wikipedia.org/">Wikipedia</Src>,
          fetched as you open a card.
        </p>

        <div className="about-foot">
          <span className="mono">
            {about ? `build ${about.build_id}` : "build unavailable"}
          </span>
          <button ref={ref} type="button" className="btn" onClick={onClose}>
            <span className="kbd">esc</span> Close
          </button>
        </div>
      </div>
    </div>
  );
}
