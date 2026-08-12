import { describe, expect, it } from "vitest";
import { makeWheelClassifier } from "./wheel";

/** A pixel-mode, no-modifier event, the common case, with overrides. */
function ev(
  deltaY: number,
  rest: Partial<Parameters<ReturnType<typeof makeWheelClassifier>>[0]> = {},
) {
  return { deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false, ...rest };
}

describe("telling a wheel from a trackpad", () => {
  it("calls line-mode deltas a wheel", () => {
    // Firefox with a real mouse is the only source of non-pixel deltas.
    const classify = makeWheelClassifier();
    expect(classify(ev(3, { deltaMode: 1 }), 0)).toBe("zoom");
  });

  it("calls any horizontal component a trackpad", () => {
    // A wheel has one axis; a second one is two fingers moving freely.
    const classify = makeWheelClassifier();
    expect(classify(ev(-2, { deltaX: 1 }), 0)).toBe("pan");
  });

  it("calls a fractional delta a trackpad", () => {
    // Detents arrive whole; gesture-scaled deltas arrive with remainders.
    const classify = makeWheelClassifier();
    expect(classify(ev(4.5), 0)).toBe("pan");
  });

  it("calls an isolated hard detent a wheel", () => {
    // Chrome and Edge send ≥100 per click, and a resting hand is quiet
    // between clicks.
    const classify = makeWheelClassifier();
    expect(classify(ev(100), 1000)).toBe("zoom");
    expect(classify(ev(-120), 2000)).toBe("zoom");
  });

  it("does not call a hard delta mid-stream a wheel", () => {
    // A trackpad flick reaches detent magnitude only with events a frame
    // apart. The magnitude alone must not decide.
    const classify = makeWheelClassifier();
    expect(classify(ev(20), 1000)).toBe(null);
    expect(classify(ev(120), 1016)).toBe(null);
  });

  it("has no opinion on a small, whole, vertical, isolated delta", () => {
    // Both a slow mac mouse and a careful trackpad. Whatever the canvas is
    // doing, keep doing it.
    const classify = makeWheelClassifier();
    expect(classify(ev(8), 1000)).toBe(null);
  });

  it("has no opinion under ctrl, whatever the deltas look like", () => {
    // A pinch is delivered as a ctrl+wheel, and a mouse under a held Ctrl
    // looks the same. Neither says what the device is.
    const classify = makeWheelClassifier();
    expect(classify(ev(120, { ctrlKey: true }), 1000)).toBe(null);
    expect(classify(ev(4.5, { ctrlKey: true }), 2000)).toBe(null);
  });

  it("measures quiet from the previous event even when that event decided nothing", () => {
    // The unsure events still mark time passing: a detent right after a
    // trackpad stream is not isolated, however the stream classified.
    const classify = makeWheelClassifier();
    expect(classify(ev(8), 1000)).toBe(null);
    expect(classify(ev(120), 1040)).toBe(null);
    // …and once the hand has genuinely rested, the same delta is a detent.
    expect(classify(ev(120), 1500)).toBe("zoom");
  });
});
