/**
 * Where this came from, in the corner where a reader finishes reading.
 *
 * Two links and one object. About is an internal route and the source is an
 * outbound one, which is normally reason enough to draw them apart — but the
 * question they answer is the same question, asked at two depths: *what am I
 * looking at, and who says so.* A reader who wants either wants them from the
 * same place, so they share one hairline rule and light together on hover, and
 * the divider between them is the whole of the distinction the layout makes.
 *
 * It sat at the right end of the axis footer for a long time, under the
 * present, on the argument that the eye finishes a lineage there and the pixels
 * after it are the least valuable on that edge. It is at the foot of the
 * sidebar now, for a plainer reason: a reader looking for what this is does not
 * look at the bottom of a ruler. What survives the move is the register — this
 * is not chrome the reader operates the canvas with, so it stays below the
 * canvas's own contrast until it is pointed at.
 *
 * `share` sits opposite it in the same row, in the same anatomy, and is *not*
 * in this component: this one answers *where did this come from* and that one
 * sends it on. They are two groups in one strip rather than one group of
 * three, which is what the space between them says. `sidebar/Sidebar.tsx`
 * draws it.
 *
 * **About is a `button`, not an `a`.** `goAbout` pushes history and swaps the
 * root, so an `href` would offer a middle-click that reloads the whole app and
 * throws away the tree the reader assembled. The source is a real anchor with
 * a real `href`, because it genuinely leaves.
 *
 * The mark is inlined rather than fetched: this app ships no icon set, and a
 * remote asset for eleven paths on the critical path of every view is a
 * request nobody should pay for.
 */

import { goAbout } from "../route";
import { useTip } from "./Tooltip";

/** The public repository. One place, so a rename cannot leave a dead link. */
const SOURCE_URL = "https://github.com/lsweigart12/concestor";

/** GitHub's mark, at 14px. `currentColor` so it inherits the hover state. */
function GitHubMark() {
  return (
    <svg
      className="src-mark"
      viewBox="0 0 16 16"
      width="13"
      height="13"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

export function SourceLinks() {
  const tip = useTip("Read the source on GitHub");
  return (
    <div className="side-links">
      <button type="button" className="side-link" onClick={goAbout}>
        about
      </button>
      <span className="side-link-rule" aria-hidden="true" />
      <a
        className="side-link"
        href={SOURCE_URL}
        target="_blank"
        rel="noreferrer noopener"
        // The mark carries no text, so the label is the only thing a screen
        // reader gets, and "source" alone would not say it leaves the site.
        aria-label="Source code on GitHub"
        {...tip}
      >
        <GitHubMark />
        <span className="side-link-word">source</span>
      </a>
    </div>
  );
}
