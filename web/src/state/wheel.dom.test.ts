/**
 * The wheel mode's storage, which breaks both rules the other canvas modes
 * follow — `localStorage` rather than `sessionStorage`, and two keys rather
 * than one — because it is a claim about the machine rather than the reader.
 * `WHEEL_KEY` in `store.ts` is the argument; these pin the mechanics.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  loadWheelChoice,
  loadWheelSeed,
  saveWheelChoice,
  saveWheelSeed,
  WHEEL_DEFAULT,
} from "./store";

afterEach(() => localStorage.clear());

describe("the pin and the seed", () => {
  it("starts with no pin and the trackpad-first default", () => {
    expect(loadWheelChoice()).toBe(null);
    expect(loadWheelSeed()).toBe(WHEEL_DEFAULT);
  });

  it("keeps a pinned choice, and the pin does not disturb the seed", () => {
    saveWheelChoice("zoom");
    expect(loadWheelChoice()).toBe("zoom");
    expect(loadWheelSeed()).toBe(WHEEL_DEFAULT);
  });

  it("keeps a seed, which is not a pin", () => {
    saveWheelSeed("zoom");
    expect(loadWheelSeed()).toBe("zoom");
    expect(loadWheelChoice()).toBe(null);
  });

  it("stores the seed only when it says something the default does not", () => {
    saveWheelSeed("zoom");
    saveWheelSeed(WHEEL_DEFAULT);
    // Cleared rather than written: a value this app did not have to write is
    // one a future default change does not have to migrate.
    expect(localStorage.getItem("concestor.wheel.auto")).toBe(null);
  });

  it("answers a value it did not write with the default", () => {
    localStorage.setItem("concestor.wheel", "sideways");
    localStorage.setItem("concestor.wheel.auto", "1");
    expect(loadWheelChoice()).toBe(null);
    expect(loadWheelSeed()).toBe(WHEEL_DEFAULT);
  });
});
