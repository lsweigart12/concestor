/**
 * The about page. A page, not a panel.
 *
 * It was a modal for as long as its job was to answer a question a reader had
 * while looking at the canvas — *what do the dashes mean* — and a modal is the
 * right shape for that, because the answer is only wanted for a moment and the
 * thing it is about is still on screen behind it. It is the wrong shape for the
 * job it has now, which is to tell somebody who has not used this what it is
 * for. That reader wants room, headings they can scan, and an address they can
 * send to a colleague; a dialog gives none of those and takes the canvas
 * hostage while it fails to.
 *
 * So: a real route at `/about`, mounted instead of `App` rather than over it —
 * `route.ts` has the reason that has to be a root-level split and what it costs.
 *
 * **The page leads with a claim and not a description.** "Pick two species and
 * see where their lineages meet" is accurate, is what the empty canvas already
 * says, and answers *what does this do* without ever answering *why would I
 * open it*. The hero answers the second question and the sections under it
 * carry the evidence, in that order, because that is the order somebody
 * deciding whether to use this reads in.
 *
 * **Every claim below the hero is a list item.** The first draft of this
 * content was six sections of running prose; every sentence was true and
 * load-bearing and it was still unreadable, because an about page is *scanned*
 * and prose hides its own index. Nothing was cut for length — the two witness
 * fossils, the `Ivesia` collision and the 16,833 withdrawn matches all survive,
 * because a claim a reader cannot check is a slogan.
 *
 * Figures here are measured on the build being served and every one is checked
 * by a gate: 947 is phase 2's count of contradicted nodes, 16,833 is phase 3's
 * count of withdrawn resolutions, 523,112 is the `fossil` table.
 */

import { useEffect, useState } from "react";
import { api, type About as AboutPayload } from "../api";
import { Silhouette } from "../canvas/Silhouette";
import { SPECIES_PHRASE } from "../corpora";
import { OPENINGS } from "../openings";
import { leaveAbout } from "../route";

/**
 * A named source, linked to the page a curious reader would want.
 *
 * Each target is the thing itself rather than its homepage where the two
 * differ: Open Tree goes to the browsable tree, Duke et al. to the Zenodo
 * deposit that carries the CC-BY the ages are used under — not the preprint —
 * and the ICS to the chart rather than to the commission.
 *
 * `noreferrer noopener` and a new tab, the same as every other outbound link
 * here: a reader following a citation has not asked to leave the page.
 */
function Src({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="about-src" href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/**
 * The running code's version, written the way the repository writes it.
 *
 * `release.config.cjs` tags `v${version}` but compiles in the bare `0.6.0`, so
 * the `v` goes on here rather than in the payload — `/v1/about`'s `release`
 * stays a plain semver that something else can parse. A `go run` has no tag
 * and reports `dev`, which is a word and takes no `v`.
 *
 * This is deliberately *not* `build_id`. That names the artifact set the
 * server has mmap'd, which moves on the pipeline's cadence and means nothing
 * to a reader; the release names the code, which is what a bug report is
 * against. `build_id` is still on `/v1/about` for whoever needs both.
 */
export function releaseLabel(release: string): string {
  return /^\d/.test(release) ? `v${release}` : release;
}

/**
 * Every drawing the openings use, once each, in the order they are authored.
 *
 * Borrowed rather than chosen, and the reason is `openings.ts`'s: every image
 * in that file was picked by **looking at it at thirty pixels**, a test its own
 * header records as having rejected more candidate taxa than every other rule
 * combined. A set picked fresh for this page would have to pass the same test
 * and has nothing to gain by it. Taking all of them rather than one opening's
 * five also makes the strip say the true thing — that this is the whole tree of
 * life and not five animals — which is the whole reason it moves.
 *
 * Deduplicated on `art`, because a drawing that recurs across openings (the
 * human is in three) would otherwise pass twice in one cycle and read as a
 * loop much shorter than it is.
 */
const STREAM_ART: readonly { id: string; label: string }[] = (() => {
  const seen = new Set<string>();
  const out: { id: string; label: string }[] = [];
  for (const o of OPENINGS) {
    for (const t of o.taxa) {
      if (seen.has(t.art)) continue;
      seen.add(t.art);
      out.push({ id: t.art, label: t.label });
    }
  }
  return out;
})();

/**
 * The strip of drifting silhouettes under the claim.
 *
 * **The track holds two copies of the pool and travels exactly -50%**, which is
 * what makes the loop seamless: at the end of the cycle the second copy sits
 * precisely where the first began, so the reset is invisible and there is no
 * seam to time. Anything other than two copies and -50% has one.
 *
 * It is `aria-hidden` and carries no labels a reader can reach. That is not an
 * omission: the strip says *many kinds of living thing*, the sentence above it
 * says the same, and a screen reader should hear it once. Making sixty
 * drawings individually announced would be the worst reading of this page
 * available.
 *
 * `prefers-reduced-motion` stops it rather than removing it — the strip is
 * still five or six drawings wide standing still, which is what it replaced.
 */
function SilhouetteStream() {
  return (
    <div className="stream" aria-hidden="true">
      <div className="stream-track">
        {[0, 1].map((copy) =>
          STREAM_ART.map((a) => (
            <Silhouette
              key={`${copy}-${a.id}`}
              phylopicId={a.id}
              size={54}
              title={a.label}
            />
          )),
        )}
      </div>
    </div>
  );
}

/** What the app does, as six claims. The order is the order it happens in. */
function Features() {
  return (
    <ul className="feature-grid">
      <li className="feature">
        <h3 className="feature-h">Any of {SPECIES_PHRASE}</h3>
        <p className="feature-p">
          Searched by the name you actually call it — <em>dog</em>,{" "}
          <em>T. rex</em>, <em>oak</em> — not just the binomial.
        </p>
      </li>
      <li className="feature">
        <h3 className="feature-h">The smallest tree that connects them</h3>
        <p className="feature-p">
          Every common ancestor on the way, and nothing else. Add one more
          species and it redraws in place rather than starting over.
        </p>
      </li>
      <li className="feature">
        <h3 className="feature-h">On real geological time</h3>
        <p className="feature-p">
          Not just branching order. The axis is millions of years, with the
          periods named underneath it.
        </p>
      </li>
      <li className="feature">
        <h3 className="feature-h">A fossil that was alive at each split</h3>
        <p className="feature-p">
          Where one exists — <em>Pakicetus</em> where whales leave the hippos,{" "}
          <em>Acanthostega</em> where our own lineage leaves the fish. Nothing
          about those animals is written into the app. They are what the dates
          pick out.
        </p>
      </li>
      <li className="feature">
        {/*
          "Every **tree** is a link", not "every view", and the one-word
          change is the whole claim. A view includes how you are reading it,
          and that half deliberately does not travel: labels, ages and the
          light live in `sessionStorage` because a setting that is a claim
          about the *reader* may not ride in a link. Saying "view" here
          promised the bioluminescent canvas somebody had just turned on, and
          the person who opened the link got daylight.
        */}
        <h3 className="feature-h">Every tree is a link</h3>
        <p className="feature-p">
          Whatever you build is in the address bar, so you can send it,
          bookmark it, or come back to it. How you are <em>reading</em> it —
          the labels, the ages, the light — stays with you instead.
        </p>
      </li>
      <li className="feature">
        <h3 className="feature-h">Free, and open about its sources</h3>
        <p className="feature-p">
          No account, no paywall. Every drawing is credited to its artist and
          every figure traces to a named dataset.
        </p>
      </li>
    </ul>
  );
}

export function AboutPage() {
  const [about, setAbout] = useState<AboutPayload | null>(null);

  useEffect(() => {
    let live = true;
    api
      .about()
      .then((a) => {
        if (live) setAbout(a);
      })
      .catch(() => {
        // The version line is the only thing this feeds and it has a resting
        // state. A page that cannot reach its own API still answers every
        // question it was opened to answer.
      });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Escape returns to the tree.
   *
   * It is not a modal any more, so this is a courtesy rather than a contract —
   * but `bindings.ts` has taught every other surface here that escape means
   * *back out of this*, and a page that ignored it would be the one exception.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        leaveAbout();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="page">
      <header className="page-bar">
        <button type="button" className="btn" onClick={leaveAbout}>
          <span className="kbd">esc</span> Back to the tree
        </button>
      </header>

      <main className="page-body">
        <section className="hero">
          <p className="hero-eyebrow">Concestor</p>
          <h1 className="hero-claim">
            The fastest way to a phylogenetic tree worth showing someone.
          </h1>
          <p className="hero-sub">
            Name the species you care about; get the tree that connects them,
            drawn against real geological time, in seconds — for a slide, a
            video, or the question you just thought of.
          </p>
          <SilhouetteStream />
          <div className="hero-actions">
            <button type="button" className="btn btn-hero" onClick={leaveAbout}>
              Draw a tree
            </button>
          </div>
        </section>

        <section className="page-section">
          <h2 className="page-h">What it draws</h2>
          <Features />
        </section>

        <section className="page-section">
          <h2 className="page-h">Where this comes from</h2>
          {/*
            The joins, not the sources. A list of seven databases says nothing a
            reader could not have guessed; what is hard here is what happens
            *between* them, and each item is the join rather than the citation.
          */}
          <ul className="page-list">
            <li>
              <strong>The tree</strong> — the{" "}
              <Src href="https://tree.opentreeoflife.org/">Open Tree of Life</Src>{" "}
              synthesis (v16.1), one topology over {SPECIES_PHRASE} and the
              groups that contain them, assembled from published studies.
            </li>
            <li>
              <strong>The dates</strong> —{" "}
              <Src href="https://doi.org/10.5281/zenodo.19049120">
                Duke et al. 2026
              </Src>
              , matched clade by clade rather than by name. Same group, and the
              age is shown; ours sitting <em>inside</em> theirs, and their
              figure is an upper bound; a genuine disagreement — 947 nodes — and
              no number is shown at all.
            </li>
            <li>
              <strong>The fossils</strong> — 523,112 taxa from the{" "}
              <Src href="https://paleobiodb.org/">Paleobiology Database</Src>,
              attached through <Src href="https://www.gbif.org/">GBIF</Src>'s
              identifiers. Names alone will not do it: their <em>Ivesia</em> is
              an Ediacaran animal and the Open Tree's is a rose-family plant, so
              a match is withdrawn wherever one catalogue calls a thing extinct
              and the other still has it living. That removes 16,833 of them.
            </li>
            <li>
              <strong>The silhouettes</strong> —{" "}
              <Src href="https://www.phylopic.org/">PhyloPic</Src>, credited to
              their artists on every card. Each also carries the size of the
              claim it makes, because a picture borrowed from a cousin should
              say so.
            </li>
            <li>
              <strong>The common names</strong> —{" "}
              <Src href="https://www.wikidata.org/">Wikidata</Src>, put in the
              order people use them by reading how English Wikipedia files them:
              a title is a name in ordinary use, a redirect is one somebody
              thought a reader would type, and a name whose article turns out to
              be about something else is demoted. It is why <em>humans</em>{" "}
              leads for our own species and <em>man</em> trails.
            </li>
            <li>
              <strong>The rest</strong> — geologic intervals from the{" "}
              <Src href="https://stratigraphy.org/chart">ICS</Src> chart, and
              card descriptions from{" "}
              <Src href="https://www.wikipedia.org/">Wikipedia</Src>, fetched as
              you open one.
            </li>
          </ul>
        </section>

        <footer className="page-foot">
          <p className="page-foot-p">
            <em>Concestor</em> is Dawkins' word for the point where two lineages
            meet, looking backward.
          </p>
          <p className="page-foot-p">
            <span className="mono">
              {about?.release ? releaseLabel(about.release) : "version unavailable"}
            </span>
          </p>
          <button type="button" className="btn" onClick={leaveAbout}>
            Back to the tree
          </button>
        </footer>
      </main>
    </div>
  );
}
