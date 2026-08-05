/**
 * How long the opening carousel rests on a question, and how long it keeps
 * moving at all.
 *
 * Its own module rather than three constants in `OpeningCarousel.tsx` because
 * it is a policy rather than a rendering detail, and because it is the half a
 * test can reach: vitest runs `environment: "node"` here, so a component is a
 * file a test may read as text but not mount. The same split `fullscreen.ts`,
 * `tip.ts` and `bindings.ts` already make.
 *
 * **What it replaces was one number for sixteen questions** — `DWELL_MS = 7600`,
 * paced, its comment said, "for somebody who has not started reading yet".
 * Measured against the copy it actually shows, that is short: an opening runs
 * 22 to 32 words of question plus reveal, and 32 words is 9.6 s of silent
 * reading at 200 wpm *before* the reader has decided anything or moved a hand.
 * So the app's primary call to action was a moving target. Driving the running
 * app, "Are you a fish?" was read, "Explore this question" was pressed, and the
 * tree that drew was the two pandas'.
 *
 * Two rules fix it and they answer different halves of the failure:
 *
 * 1. **A question rests for as long as its own words take to read.**
 *    {@link dwellFor} is reading time plus a reach, so the koala's 22 words and
 *    the woodlouse's 32 are not given the same second and a half. One constant
 *    cannot be right for both — it can only be wrong for the longer one, which
 *    is the one a reader is most likely to still be inside.
 * 2. **The rotation is an introduction, and stops after {@link AUTO_ADVANCES}.**
 *    This is the half that answers touch. There is no `mouseenter` on a phone,
 *    so the carousel's rule 1 — hover pauses it — is not a rule that exists
 *    there at all, and a phone reader had no way to stop it by any means. A
 *    surface that goes still on its own needs no gesture.
 *
 * **A full pass was written and refused.** With sixteen openings that is over
 * three minutes of movement: the same moving target with an end nobody waits
 * for. What auto-rotation is *for* on this surface is saying that the card is
 * alive and that there is more than one way in, and a few changes says that
 * completely. Everything after is motion with no remaining job — and the
 * arrows and the dots reach all sixteen directly, which is the carousel's own
 * rule 4: nothing here is reachable only by waiting.
 */

import type { Opening } from "../openings";

/**
 * Silent reading, at 200 words per minute.
 *
 * Deliberately the slow end of the usual 200–300 range, because a reader on
 * this surface is not only reading. They have just arrived at an app they have
 * never seen, the card carries four silhouettes they are looking at, and there
 * is a deep-time axis underneath asking to be understood. The prose is
 * competing for the seconds this number is spending.
 */
export const READ_MS_PER_WORD = 300;

/**
 * Having read it, deciding and getting to the card.
 *
 * The floor under every dwell, and the part {@link READ_MS_PER_WORD} cannot
 * express: a question answered "yes, show me" still needs the reader to move a
 * pointer across the canvas or a thumb up the screen, and the press is what
 * the whole surface is for.
 */
export const REACH_MS = 4000;

/**
 * How many times the card advances on its own before it rests for good.
 *
 * Three, which shows four questions. Enough that a reader watching sees the
 * surface change and learns there are more; few enough that it is still long
 * before anybody has finished deciding about the one in front of them. It is
 * checked against `OPENINGS.length` in the tests rather than derived from it,
 * because the bound is a claim about attention and not about the corpus — the
 * seventeenth opening should not buy the reader another twelve seconds of
 * movement.
 */
export const AUTO_ADVANCES = 3;

/** Question and reveal together, which is what the card puts on screen. */
export function wordsIn(o: Opening): number {
  return `${o.question} ${o.reveal}`.trim().split(/\s+/).length;
}

/**
 * How long this question stays on screen when nobody has touched anything.
 *
 * A pure function of the copy, so an opening that gains a clause gains the
 * seconds to read it without anyone remembering to retune a constant.
 */
export function dwellFor(o: Opening): number {
  return REACH_MS + wordsIn(o) * READ_MS_PER_WORD;
}
