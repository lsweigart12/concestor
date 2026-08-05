/**
 * That the app subscribes to the keyboard once, and hears the current handler.
 *
 * This is the half of the keyboard surface neither `bindings.test.ts` nor
 * `keyboard.test.tsx` can see. Those two answer what a press *means* and whether
 * it survives to the browser; this answers whether the app was listening at the
 * moment it happened.
 *
 * It is worth a file of its own because the bug it pins passes every other
 * check. A handler rebuilt on every render is correct — it closes over current
 * state, it matches the right key, it runs the right callback — and a
 * subscription rebuilt with it is also *correct*, in the sense that no assertion
 * about a single press can fail. What it is not is continuous: this canvas
 * renders constantly, so the listener was being torn off and put back dozens of
 * times a second, and a press landing in one of those gaps did nothing. The
 * symptom is "it only fires the second time", which is unreproducible by hand
 * and invisible to a test that presses one key on a still page.
 *
 * So the claim under test is a count, not a behaviour: **one** registration, no
 * matter how many times the handler changes identity.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWindowKeys } from "./keys";

afterEach(() => vi.restoreAllMocks());

/**
 * Every `keydown` registration made on the window while the spy was up.
 *
 * Typed structurally rather than through vitest's `MockInstance`, because
 * `addEventListener` is overloaded and the inferred call tuple is not worth
 * naming for a length check.
 */
function keydownRegistrations(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) => call[0] === "keydown").length;
}

const press = () =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "f" }));

describe("the window is told once", () => {
  it("registers one listener across a hundred handler identities", () => {
    const add = vi.spyOn(window, "addEventListener");
    const { rerender } = renderHook(
      ({ onKey }: { onKey: (e: KeyboardEvent) => void }) =>
        useWindowKeys(onKey),
      { initialProps: { onKey: () => {} } },
    );
    // A fresh function every time, which is exactly what `App.tsx` produces:
    // its handler depends on `tree`, and `useTree()` builds a new object per
    // render.
    for (let i = 0; i < 100; i += 1) rerender({ onKey: () => {} });
    expect(keydownRegistrations(add)).toBe(1);
  });

  it("never unsubscribes while it is still mounted", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { rerender } = renderHook(
      ({ onKey }: { onKey: (e: KeyboardEvent) => void }) =>
        useWindowKeys(onKey),
      { initialProps: { onKey: () => {} } },
    );
    for (let i = 0; i < 100; i += 1) rerender({ onKey: () => {} });
    expect(keydownRegistrations(remove)).toBe(0);
  });
});

describe("and hears the handler the last render gave it", () => {
  /**
   * The other half of the trade. Subscribing once is only safe because the ref
   * is rewritten — a listener pinned to the *first* handler would be stable and
   * permanently stale, which is a worse bug than the one being fixed and looks
   * identical from a count.
   */
  it("calls the current handler and not the one it subscribed with", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = renderHook(
      ({ onKey }: { onKey: (e: KeyboardEvent) => void }) =>
        useWindowKeys(onKey),
      { initialProps: { onKey: first } },
    );
    rerender({ onKey: latest });
    press();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("hands the handler the event itself", () => {
    const onKey = vi.fn();
    renderHook(() => useWindowKeys(onKey));
    press();
    expect(onKey.mock.calls[0]?.[0]).toBeInstanceOf(KeyboardEvent);
    expect((onKey.mock.calls[0]?.[0] as KeyboardEvent).key).toBe("f");
  });

  it("stops listening once the app is gone", () => {
    const onKey = vi.fn();
    const { unmount } = renderHook(() => useWindowKeys(onKey));
    unmount();
    press();
    expect(onKey).not.toHaveBeenCalled();
  });
});
