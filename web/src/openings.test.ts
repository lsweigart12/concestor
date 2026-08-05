import { describe, expect, it } from "vitest";
import { OPENINGS, keysOf, nextOpening } from "./openings";

describe("openings", () => {
  it("has a unique id per opening", () => {
    const ids = OPENINGS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The triple rule, which is the design and not a style preference: two
   * species draw one number, and a number is not an argument. "You are a fish"
   * is only visible once the shark is on the canvas failing to join first.
   */
  it("draws at least three taxa, so the nesting carries the claim", () => {
    for (const o of OPENINGS) {
      expect(o.taxa.length, o.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("names each taxon once — a repeat is one mark and two React keys", () => {
    for (const o of OPENINGS) {
      expect(new Set(keysOf(o)).size, o.id).toBe(o.taxa.length);
    }
  });

  it("uses resolvable ott keys", () => {
    for (const o of OPENINGS) {
      for (const k of keysOf(o)) expect(k, o.id).toMatch(/^ott\d+$/);
    }
  });

  /**
   * The preview draws `art` straight off `/v1/silhouette/{id}.svg` with no
   * lookup, so a malformed id is a silently missing picture rather than an
   * error. Every taxon carries one, and no two taxa in an opening share a
   * drawing — a repeated silhouette would quietly claim two of the four things
   * on screen look identical.
   */
  it("carries a distinct, well-formed silhouette per taxon", () => {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const o of OPENINGS) {
      const art = o.taxa.map((t) => t.art);
      for (const t of o.taxa) {
        expect(t.art, `${o.id}/${t.label}`).toMatch(uuid);
        expect(t.label.trim().length, `${o.id}/${t.key}`).toBeGreaterThan(0);
      }
      expect(new Set(art).size, o.id).toBe(art.length);
    }
  });

  /**
   * The honesty guard, and the reason it is a test rather than a comment.
   *
   * Ages are tiered: `interpolated` nodes render as `≤ N Ma` and `structural`
   * ones render no number at all. Copy promising "1.1 billion years ago" beside
   * a canvas drawing "≤ 1314.8 Ma" makes the app contradict itself on the one
   * axis it exists to be careful about — so the openings claim branching order,
   * which is exact, and leave every figure to the axis.
   */
  it("claims relationships, never dates", () => {
    for (const o of OPENINGS) {
      const copy = `${o.question} ${o.reveal}`;
      expect(copy, o.id).not.toMatch(/\d+(\.\d+)?\s*(Ma|million|billion)/i);
    }
  });

  it("asks a question and answers it", () => {
    for (const o of OPENINGS) {
      expect(o.question, o.id).toMatch(/\?$/);
      expect(o.reveal.length, o.id).toBeGreaterThan(20);
    }
  });
});

/**
 * What the flyout offers once one has been answered.
 *
 * The array order again, which is this file's own ranking by pull on a
 * first-time visitor. A reader who keeps pressing *Next* and a reader who lets
 * the carousel rotate meet these questions in the same sequence, and neither is
 * handed back the one they have just watched draw itself.
 */
describe("nextOpening", () => {
  it("follows the file order", () => {
    for (let i = 0; i < OPENINGS.length - 1; i++) {
      expect(nextOpening(OPENINGS[i]!)?.id, OPENINGS[i]!.id).toBe(
        OPENINGS[i + 1]!.id,
      );
    }
  });

  it("wraps, so the last question is not a dead end", () => {
    expect(nextOpening(OPENINGS[OPENINGS.length - 1]!)?.id).toBe(
      OPENINGS[0]!.id,
    );
  });

  it("never offers the question just answered", () => {
    for (const o of OPENINGS) expect(nextOpening(o)?.id, o.id).not.toBe(o.id);
  });

  it("reaches every opening, so none is unreachable by pressing on", () => {
    const seen = new Set<string>();
    let at = OPENINGS[0]!;
    for (let i = 0; i < OPENINGS.length; i++) {
      seen.add(at.id);
      at = nextOpening(at)!;
    }
    expect(seen.size).toBe(OPENINGS.length);
  });
});
