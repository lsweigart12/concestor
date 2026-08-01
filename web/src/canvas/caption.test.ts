/**
 * The caption is what earns the right to draw a borrowed picture.
 *
 * Almost no node has a portrait — 12,863 drawings against 2.7M nodes — so the
 * ordinary case is a drawing of a relative, and `SILHOUETTE_POLICY` draws every
 * one of them. That is only defensible while the picture says what it is of;
 * the moment a borrow renders uncaptioned it becomes the misinformation
 * architecture §7 warns about, and nothing about the screen looks wrong.
 */

import { describe, expect, it } from "vitest";
import { borrowedTitle } from "./NodeMark";

describe("borrowedTitle", () => {
  it("says nothing extra about a node's own portrait", () => {
    expect(borrowedTitle("Cetacea", null)).toBe("Silhouette of Cetacea");
  });

  it("names the group and its size when the drawing is of a relative", () => {
    // The riffle beetle: 987 tips, where the old rule offered Ecdysozoa's
    // 1,208,417 and called it a silhouette of the beetle.
    expect(borrowedTitle("Cleptelmis ornata", { name: "Elminae", tips: 987 })).toBe(
      "Not Cleptelmis ornata itself — a drawing from within Elminae, " +
        "the smallest group holding both (987 species)",
    );
  });

  it("does not repeat the name when the group is the node itself", () => {
    // Nobody drew Selachii; somebody drew a shark inside it.
    expect(borrowedTitle("Selachii", { name: "Selachii", tips: 723 })).toBe(
      "Not Selachii itself — a drawing of one of its 723 species",
    );
  });

  it("still declares the borrow when the group has no name", () => {
    // Most internal nodes are unnamed `mrcaott…` divergences. There is nothing
    // to name, and that is not a reason to imply a portrait.
    const t = borrowedTitle("Homo / Pan", { name: null, tips: 4210 });
    expect(t).toContain("Not Homo / Pan itself");
    expect(t).not.toContain("null");
  });

  it("never silently claims a portrait when the size is missing", () => {
    const t = borrowedTitle("Elminae", { name: "Elminae", tips: null });
    expect(t).toContain("Not Elminae itself");
    expect(t).not.toContain("null");
  });
});
