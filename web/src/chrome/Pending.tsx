/**
 * What the app says while it is waiting — and when it says nothing at all.
 *
 * ## A sentence, not a spinner
 *
 * styles.css's opening rules forbid ambient animation: "the glow comes from the
 * data, nowhere else". The encyclopaedia block had already settled what that
 * leaves, and its note is the rule for every surface here — *a sentence rather
 * than a shimmer*, breathing rather than spinning, because a skeleton block is
 * a promise that something is definitely coming and for much of this corpus
 * nothing is. This is that decision lifted out of one card into the one place
 * everything that waits now reads it from.
 *
 * A sentence also carries what a spinner cannot: **which** slow thing is slow.
 * Searching 2.4 million species, reading the fossil record and resolving the
 * lineages in a shared link are three different waits of three different
 * lengths, and a reader who knows which one they are in waits differently.
 *
 * ## Delayed, and that is the load-bearing half
 *
 * Everything the API serves is immutable within a build and memoised for the
 * session (api.ts), so most requests here answer in the same frame as the click
 * that made them. An indicator on those is not feedback — it is a flash of
 * chrome over facts the app already holds, and `detail/hooks.ts` refuses
 * exactly that in as many words: *a spinner over facts we already have would be
 * a regression dressed as feedback.*
 *
 * So {@link usePending} reports nothing until a request has outlived
 * {@link PENDING_DELAY_MS}. A cached node, a warm search, a reopened drill-down
 * lane: none of them says anything, which is the honest rendering of a wait
 * nobody experienced. Only a request genuinely making somebody wait announces
 * itself, and by then the announcement is worth its own arrival.
 *
 * That is also why the delay is the *component's* business rather than each
 * caller's. Every call site had the same choice to make and would have made it
 * differently, and the failure mode of getting it wrong is invisible in
 * development — where the API is on localhost and every request is instant.
 */

import { useEffect, useState } from "react";

/**
 * How long a request may take before it has to admit it is taking a while.
 *
 * Measured from the state going busy rather than from the fetch, so the
 * palette's own debounce counts against it — the reader has been waiting since
 * the keystroke either way, and which part of the wait belongs to which
 * mechanism is not their problem.
 *
 * Under 200 ms reads as a response rather than a delay, and everything the
 * local build serves is far inside that: an FTS query is single-digit
 * milliseconds and the fossil full-scan is about 40. So on a developer's own
 * machine this component is very nearly invisible, which is the intended
 * behaviour and the reason it must not be tuned by looking at one.
 */
export const PENDING_DELAY_MS = 180;

/**
 * True once `active` has been continuously true for `delayMs`.
 *
 * Resets on every falling edge, so a second request restarts the clock rather
 * than inheriting the first one's — two fast round trips in a row must look
 * like two fast round trips, not like one slow one.
 */
export function usePending(
  active: boolean,
  delayMs: number = PENDING_DELAY_MS,
): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const t = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(t);
  }, [active, delayMs]);
  // `&& active` rather than `shown` alone, because the reset above happens in
  // an effect and effects run after the render that caused them: for one frame
  // after the answer lands, `shown` still says a request is out. One frame of
  // a breathing line nobody sees is harmless; one frame of *withholding the
  // answer that just arrived* is not, and both callers of this that gate a
  // card on it would do exactly that.
  return shown && active;
}

/**
 * The line itself.
 *
 * `role="status"` is the part that is not decoration: a purely visual indicator
 * tells a screen reader nothing, and "the answer is on its way" is precisely
 * the kind of thing a polite live region exists for. The text is therefore
 * written to be heard as well as read — a clause, not a participle with an
 * ellipsis standing in for the verb.
 *
 * A `<span>` rather than a paragraph so it can sit inside the palette's input
 * row and inside a card's prose flow without either one being wrong; callers
 * that want it to occupy a line of its own say so with a class.
 *
 * `PendingLine` and not `Pending`, because `detail/hooks.ts` already owns that
 * word for something adjacent and different — `Pending<T>` is the *state* of a
 * value that may still be coming, and this is what one of its three cases looks
 * like. A card holds both at once, and two things called `Pending` in one file
 * is how the state and its rendering end up confused for each other.
 */
export function PendingLine({
  children,
  className,
}: {
  children: React.ReactNode;
  /** Placement only. Everything about how it *looks* belongs to `.pending`. */
  className?: string;
}) {
  return (
    <span className={className ? `pending ${className}` : "pending"} role="status">
      {children}
    </span>
  );
}
