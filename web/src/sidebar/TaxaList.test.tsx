/**
 * The list of what is on the canvas, which is the sidebar's reason to exist.
 *
 * Two claims are worth holding here and both fail quietly.
 *
 * **A row and its remove control are siblings, never nested.** A `<button>`
 * inside a `<button>` is invalid markup that browsers resolve differently, and
 * the failure mode is the worst one available: pressing *remove* also selects,
 * so the card opens on the taxon that has just been taken off the canvas.
 * Nothing errors, and in a rendered app it looks like a flicker.
 *
 * **A fossil row says what it is.** `docs/fossil-grafts.md` §9 is the argument:
 * the two catalogues overlap, so "extinct" would be wrong about *T. rex*, and
 * what the badge has to carry is *a species the tree has no lineage for* —
 * shortened to where it hangs instead. That badge is the only sentence a reader
 * is asked to hold about the second corpus.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FossilTaxon, PathNode } from "../api";
import { TaxaList, type TaxaListProps } from "./TaxaList";

const node = (over: Partial<PathNode> & { idx: number }): PathNode => ({
  key: `ott${over.idx}`,
  ott_id: over.idx,
  name: `Taxon ${over.idx}`,
  rank: "species",
  age_ma: null,
  age_layout: 0,
  tier: 0,
  tip_count: 1,
  depth: 1,
  phylopic_id: null,
  silhouette_source_idx: null,
  ...over,
});

const fossil = (over: Partial<FossilTaxon> = {}): FossilTaxon => ({
  name: "Stegosaurus",
  pbdb_taxon_no: 1,
  rank: "genus",
  order: 0,
  attach_idx: 1,
  n_occs: 86,
  is_extant: false,
  fea: 161.5,
  fla: null,
  lea: null,
  lla: 93.9,
  ...over,
});

function props(over: Partial<TaxaListProps> = {}): TaxaListProps {
  return {
    nodes: [],
    fossils: [],
    selectedIdx: null,
    selectedTaxonNo: null,
    labels: "common",
    onSelectNode: vi.fn(),
    onRemoveNode: vi.fn(),
    onSelectFossil: vi.fn(),
    onRemoveFossil: vi.fn(),
    onAdd: vi.fn(),
    onRandom: vi.fn(),
    onClear: vi.fn(),
    picking: false,
    ...over,
  };
}

function draw(over: Partial<TaxaListProps> = {}): TaxaListProps {
  const p = props(over);
  render(<TaxaList {...p} />);
  return p;
}

describe("a row selects and a row removes, and never both", () => {
  it("draws the remove control outside the row's own button", () => {
    draw({ nodes: [node({ idx: 7, name: "Homo sapiens" })] });
    const remove = screen.getByRole("button", { name: /Remove/ });
    expect(remove.closest("button")).toBe(remove);
  });

  it("selects on the row and removes on the control, separately", () => {
    const p = draw({ nodes: [node({ idx: 7, name: "Homo sapiens" })] });
    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
    expect(p.onRemoveNode).toHaveBeenCalledTimes(1);
    expect(p.onSelectNode).not.toHaveBeenCalled();

    const row = document.querySelector<HTMLElement>(".side-row-main");
    fireEvent.click(row!);
    expect(p.onSelectNode).toHaveBeenCalledTimes(1);
    expect(p.onRemoveNode).toHaveBeenCalledTimes(1);
  });

  it("lights the row the card is open on", () => {
    draw({ nodes: [node({ idx: 7 }), node({ idx: 8 })], selectedIdx: 8 });
    const lit = [...document.querySelectorAll(".side-row")].filter((r) =>
      r.className.includes("is-on"),
    );
    expect(lit).toHaveLength(1);
  });
});

describe("the words on a row", () => {
  /**
   * The list follows the canvas's own labels setting, with one exception:
   * `off` falls back to the scientific name rather than to nothing. `off` is a
   * statement about the *canvas*, where the shape of the tree is the subject
   * and the names are in the way — a list of blank rows is not the quieter
   * version of this list, it is a broken one.
   */
  it("prints the common name in common mode", () => {
    draw({
      nodes: [node({ idx: 7, name: "Homo sapiens", vernacular: "Human" })],
    });
    expect(document.querySelector(".side-row-name")?.textContent).toBe("Human");
  });

  it("never leaves a row with no words at all, in any labels mode", () => {
    const n = node({ idx: 7, name: "Homo sapiens", vernacular: "Human" });
    for (const labels of ["off", "common", "scientific"] as const) {
      const { unmount } = render(
        <TaxaList {...props({ nodes: [n], labels })} />,
      );
      const name = document.querySelector(".side-row-name")?.textContent ?? "";
      expect(name.length, `${labels} drew an empty row`).toBeGreaterThan(0);
      unmount();
    }
  });

  /**
   * A tip count is the honest size of a selection and the one number a reader
   * cannot get any other way — a mark on the canvas is the same dot whether it
   * holds one species or ninety thousand.
   */
  it("says how much of the tree a clade stands for", () => {
    draw({ nodes: [node({ idx: 7, rank: "infraorder", tip_count: 171 })] });
    expect(document.querySelector(".side-row-meta")?.textContent).toContain(
      "171 species",
    );
  });

  it("says only the rank where the row is one species", () => {
    draw({ nodes: [node({ idx: 7, rank: "species", tip_count: 1 })] });
    expect(document.querySelector(".side-row-meta")?.textContent).toBe(
      "species",
    );
  });
});

describe("a fossil row is a species the tree has no lineage for", () => {
  it("says where it hangs rather than that it is extinct", () => {
    draw({ fossils: [fossil()] });
    const meta = document.querySelector(".side-row-meta")?.textContent ?? "";
    expect(meta).toContain("on a branch");
    expect(meta.toLowerCase()).not.toContain("extinct");
  });

  /**
   * **`lla_drawn`, never `lla`.** PBDB's young end can be a fact about the
   * catalogue rather than the animal: *Stegosaurus* stops at 93.9 Ma on one
   * `Stegosaurus sp.` from the Mussentuchit Member and would be drawn 50 Myr
   * after it lived. Every surface that prints the pair has to read the
   * corrected one, and missing it once already put `162–94 Ma` on a node
   * directly above a graft reading `162–143`.
   */
  it("prints the corrected young end and not PBDB's own", () => {
    draw({ fossils: [fossil({ lla_drawn: 143.1, lea_drawn: 150 })] });
    const meta = document.querySelector(".side-row-meta")?.textContent ?? "";
    expect(meta).toContain("143");
    expect(meta).not.toContain("94");
  });

  it("says less rather than guessing where a bracket is missing", () => {
    draw({ fossils: [fossil({ fea: null })] });
    const meta = document.querySelector(".side-row-meta")?.textContent ?? "";
    expect(meta).toContain("on a branch");
    expect(meta).not.toContain("Ma");
  });
});

describe("the two doors are how the list stops being empty", () => {
  it("offers both, with their keys printed on them", () => {
    draw();
    const add = screen.getByRole("button", { name: /Add a taxon/ });
    expect(within(add).getByText("A")).toBeTruthy();
    const die = screen.getByRole("button", { name: /Surprise me/ });
    expect(within(die).getByText("R")).toBeTruthy();
  });

  /**
   * **Large while the list is short, and the same two controls either way.**
   * The rule is about vertical space rather than expertise: a short list leaves
   * the column mostly empty, and an empty column under two small buttons is the
   * product failing to say what it is for at the one moment a reader has not
   * decided yet. What the tiles carry that the row cannot is a line saying what
   * is *behind* each door.
   *
   * Asserted from both ends, because the failure that matters is a state that
   * never arrives — a threshold off by one would leave the tiles up forever or
   * never draw them at all, and neither errors.
   */
  it("draws tiles while the list is short and a row once it is not", () => {
    const short = render(
      <TaxaList {...props({ nodes: [node({ idx: 1 })] })} />,
    );
    expect(document.querySelectorAll(".side-door")).toHaveLength(2);
    expect(document.querySelector(".side-add")).toBeNull();
    // The description is the whole point of the large state.
    expect(screen.getByText(/living or fossil/)).toBeTruthy();
    short.unmount();

    render(
      <TaxaList
        {...props({
          nodes: [node({ idx: 1 }), node({ idx: 2 }), node({ idx: 3 })],
        })}
      />,
    );
    expect(document.querySelectorAll(".side-door")).toHaveLength(0);
    expect(document.querySelector(".side-add")).not.toBeNull();
  });

  /** Same two keys at both sizes, or the badges teach a press that moves. */
  it("keeps both keys at both sizes", () => {
    const short = render(<TaxaList {...props()} />);
    expect(
      within(
        screen.getByRole("button", { name: /Add a taxon/ }).parentElement!,
      ).getAllByText(/^[AR]$/),
    ).toHaveLength(2);
    short.unmount();
    render(
      <TaxaList
        {...props({
          nodes: [node({ idx: 1 }), node({ idx: 2 }), node({ idx: 3 })],
        })}
      />,
    );
    const badges = [...document.querySelectorAll(".side-add .kbd")].map(
      (b) => b.textContent,
    );
    expect(badges).toEqual(["A", "R"]);
  });

  /**
   * The cell is always drawn and its *contents* are what go at zero.
   *
   * `Legend.tsx` made this rule on the axis footer for the same reason: the
   * header is a three-column grid and an absent middle cell lets the row
   * collapse, so the count would stop being centred the moment it appeared.
   */
  it("counts what is on the canvas, and says nothing at zero", () => {
    const { unmount } = render(
      <TaxaList
        {...props({ nodes: [node({ idx: 1 })], fossils: [fossil()] })}
      />,
    );
    expect(document.querySelector(".side-count")?.textContent).toBe("2");
    unmount();
    draw();
    expect(document.querySelector(".side-count")?.textContent).toBe("");
  });

  /**
   * **Clear is on this caption and it goes with the count**, which is the one
   * place this app's *disabled rather than hidden* rule gives way. That rule
   * exists so a control does not move out from under a hand reaching for it,
   * and a greyed one over an empty list says what the list already says;
   * neither applies here. Nothing reaches for clear on an empty canvas, and
   * "the canvas is already empty" is the list itself.
   */
  it("offers clear beside the count, and neither over an empty list", () => {
    const p = draw({ nodes: [node({ idx: 1 })] });
    const clear = screen.getByRole("button", { name: "Clear" });
    fireEvent.click(clear);
    expect(p.onClear).toHaveBeenCalledTimes(1);
  });

  it("draws no clear at all when there is nothing to clear", () => {
    draw();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });
});
