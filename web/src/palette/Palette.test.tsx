/**
 * The palette's search effect, rendered.
 *
 * This is about the two guards around `/v1/search` — the 110 ms debounce that
 * stops a request being *sent* per keystroke, and the `AbortController` that
 * stops one already sent from being paid for after it stops mattering. Neither
 * is arithmetic that could be lifted into a pure module: both are properties of
 * an effect's cleanup running when React decides to run it, and the only honest
 * way to see them is to type into the real input.
 *
 * It matters more than it looks. `/v1/search` is served by one container with
 * half a vCPU, so a superseded request is not idle waiting — it holds the only
 * CPU there is while the keystroke the reader is actually waiting on queues
 * behind it. A regression here is invisible locally and costs a second in
 * production, which is the exact shape of the two performance bugs this project
 * has already paid for.
 *
 * The api method is stubbed and nothing else is. The component under test is
 * the real 1,180-line `Palette`, mounted with the props `App` gives it.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type SearchHit } from "../api";
import { Palette, MIN_QUERY, type CladeScope, type Command } from "./Palette";

/** A node hit, with every field the row actually reads. */
function hit(
  name: string,
  idx: number,
  vernacular: string | null = null,
): SearchHit {
  return {
    kind: "node",
    key: `n${idx}`,
    idx,
    ott_id: idx,
    name,
    vernacular,
    rank: "species",
    tip_count: 1,
    has_age: true,
    has_image: false,
    matched_on: "name",
  };
}

/** `api.search`'s envelope, reduced to what the palette destructures. */
function answer(...hits: SearchHit[]) {
  return { query: hits[0]?.name ?? "", results: hits, fossils: [] };
}

const noop = () => {};

function mount(overrides: Partial<Parameters<typeof Palette>[0]> = {}) {
  const props = {
    open: true,
    onClose: noop,
    commands: [] as Command[],
    filter: null,
    onFilter: noop,
    scopes: [] as CladeScope[],
    onScopes: noop,
    onPick: noop,
    onPickFossil: noop,
    present: new Set<number>(),
    presentFossils: new Set<number>(),
    suggestions: { recent: [], starters: [] },
    ...overrides,
  };
  return render(<Palette {...props} />);
}

/**
 * Put `text` in the field as if it had been typed.
 *
 * One call is one keystroke as far as the effect is concerned — the field is
 * controlled, so what the debounce counts is renders of a changed `q`, not
 * characters. Setting the whole string at once therefore models typing the last
 * character of it, which is the only one that matters here.
 */
function type(text: string): void {
  const input = screen.getByLabelText("Search or command");
  fireEvent.change(input, { target: { value: text } });
}

/** Let the debounce elapse and the stubbed promise settle. */
async function settle(ms = 200): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    // Two turns: one for the awaited `api.search`, one for the state updates
    // its `then` schedules.
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Palette search", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the search field and its rows", async () => {
    const search = vi
      .spyOn(api, "search")
      .mockResolvedValue(answer(hit("Canis lupus", 7, "Grey Wolf")));

    const { container } = mount();
    // The harness's own smoke test: if this element is not here, nothing below
    // proves anything, because a test that passes without mounting is the
    // failure mode this whole suite exists to avoid.
    expect(screen.getByLabelText("Search or command")).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: "Command palette" }),
    ).toBeTruthy();

    type("wolf");
    await settle();

    expect(search).toHaveBeenCalledOnce();
    // `parts()` splits a title across `<mark>`s where the query lit it, so the
    // row is read as text rather than matched as one string.
    const titles = [...container.querySelectorAll(".row-title")].map(
      (el) => el.textContent,
    );
    expect(titles).toContain("Canis lupus");
  });

  it("asks nothing below the minimum query length", async () => {
    const search = vi.spyOn(api, "search").mockResolvedValue(answer());
    mount();

    type("w".repeat(MIN_QUERY - 1));
    await settle();

    expect(search).not.toHaveBeenCalled();
  });

  it("sends one request for a burst of keystrokes, and it is the last one", async () => {
    const search = vi.spyOn(api, "search").mockResolvedValue(answer());
    mount();

    // Four keystrokes inside the debounce window. Without it this is four
    // searches of a 523,112-row corpus for one word.
    for (const s of ["wh", "wha", "whal", "whale"]) {
      type(s);
      act(() => {
        vi.advanceTimersByTime(40);
      });
    }
    await settle();

    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0]?.[0]).toBe("whale");
  });

  it("aborts a request the next keystroke has superseded", async () => {
    // Never resolves: the point is what happens to a request still in flight,
    // and a promise that settles would hide it.
    const search = vi
      .spyOn(api, "search")
      .mockReturnValue(new Promise(() => {}));
    mount();

    type("whale");
    // Past the debounce, so this one is genuinely sent.
    await settle();
    expect(search).toHaveBeenCalledOnce();
    const first = search.mock.calls[0]?.[2];
    expect(first).toBeInstanceOf(AbortSignal);
    expect(first?.aborted).toBe(false);

    type("whales");
    await settle();

    expect(search).toHaveBeenCalledTimes(2);
    expect(first?.aborted).toBe(true);
    // The replacement is its own signal and is still live.
    expect(search.mock.calls[1]?.[2]?.aborted).toBe(false);
  });

  it("aborts on close, so a palette nobody is looking at holds no request", async () => {
    const search = vi
      .spyOn(api, "search")
      .mockReturnValue(new Promise(() => {}));
    const { rerender } = mount();

    type("whale");
    await settle();
    const signal = search.mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);

    rerender(
      <Palette
        open={false}
        onClose={noop}
        commands={[]}
        filter={null}
        onFilter={noop}
        scopes={[]}
        onScopes={noop}
        onPick={noop}
        onPickFossil={noop}
        present={new Set()}
        presentFossils={new Set()}
        suggestions={{ recent: [], starters: [] }}
      />,
    );

    expect(signal?.aborted).toBe(true);
  });

  // Both captions credit a name the row does not print, and they must not say
  // the same thing. OTT filing a name is a claim about the taxonomy; PBDB using
  // one is a claim about a second catalogue, and the rows that need the caption
  // most are exactly the ones where the tree prints neither.
  it("credits a synonym as the taxonomy's filing", async () => {
    vi.spyOn(api, "search").mockResolvedValue(
      answer({
        ...hit("Homo sapiens", 1),
        matched_on: "synonym",
        matched_name: "Homo floresiensis",
      }),
    );
    mount();
    type("Homo floresiensis");
    await settle();

    expect(
      screen.getByText(/which the taxonomy files under this name/),
    ).toBeTruthy();
    expect(screen.getByText("Homo floresiensis")).toBeTruthy();
  });

  it("credits a fossil-record name as the fossil record's usage, not the taxonomy's", async () => {
    vi.spyOn(api, "search").mockResolvedValue(
      answer({
        ...hit("Opisthobranchia", 2),
        matched_on: "fossil-name",
        matched_name: "Opisthobranchiata",
      }),
    );
    mount();
    type("Opisthobranchiata");
    await settle();

    expect(
      screen.getByText(/the name the fossil record uses for this taxon/),
    ).toBeTruthy();
    expect(
      screen.queryByText(/which the taxonomy files under this name/),
    ).toBeNull();
  });

  it("says nothing matched only once a search has settled", async () => {
    vi.spyOn(api, "search").mockReturnValue(new Promise(() => {}));
    mount();

    type("zzzqqq");
    await settle();
    // The request is out and unanswered. "Nothing matched" here would be a flat
    // statement that the corpus lacks the thing, sitting on screen for the whole
    // of a cold container's round trip and then replaced by rows.
    expect(screen.queryByText(/Nothing matched/)).toBeNull();
  });
});

/** A group row — something Tab can step into. */
function genus(name: string, idx: number, tips: number): SearchHit {
  return { ...hit(name, idx), rank: "genus", tip_count: tips };
}

/**
 * `Palette` is controlled — `App` owns the chips — so the drill-down needs the
 * loop closed: what `onScopes` reports is what `scopes` becomes, exactly as
 * `App.tsx` wires it. Without this, Tab fires the callback and nothing on
 * screen changes, and every assertion below would pass against a component
 * that cannot actually drill.
 */
function Harness({ initial }: { initial: CladeScope[] }) {
  const [scopes, setScopes] = useState(initial);
  const [filter, setFilter] = useState<"species" | null>("species");
  return (
    <Palette
      open
      onClose={noop}
      commands={[]}
      filter={filter}
      onFilter={setFilter}
      scopes={scopes}
      onScopes={setScopes}
      onPick={noop}
      onPickFossil={noop}
      present={new Set()}
      presentFossils={new Set()}
      suggestions={{ recent: [], starters: [] }}
    />
  );
}

describe("Palette drill-down", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const homo: CladeScope = { key: "ott770309", name: "Homo", rank: "genus" };

  it("lists the clade's children before anything is typed", async () => {
    const search = vi.spyOn(api, "search").mockResolvedValue(answer());
    const children = vi.spyOn(api, "children").mockResolvedValue({
      results: [hit("Homo sapiens", 10), hit("Homo erectus", 11)],
      total: 2,
    });
    const { container } = render(<Harness initial={[homo]} />);
    await settle();

    // The requirement in one line: a scoped palette has no empty state.
    expect(children).toHaveBeenCalledWith("ott770309");
    expect(search).not.toHaveBeenCalled();
    const titles = [...container.querySelectorAll(".row-title")].map(
      (el) => el.textContent,
    );
    expect(titles).toContain("Homo sapiens");
    expect(titles).toContain("Homo erectus");
    expect(screen.queryByText(/Type to search/)).toBeNull();
  });

  it("names the cut when the children list is a page of a larger one", async () => {
    vi.spyOn(api, "search").mockResolvedValue(answer());
    vi.spyOn(api, "children").mockResolvedValue({
      results: [hit("Homo sapiens", 10)],
      total: 41,
    });
    render(<Harness initial={[homo]} />);
    await settle();

    expect(screen.getByText(/largest of 41 groups inside Homo/)).toBeTruthy();
  });

  it("Tab on a group pushes its chip, clears the field, and fences the search", async () => {
    const search = vi
      .spyOn(api, "search")
      .mockResolvedValue(answer(genus("Homo", 5, 7)));
    vi.spyOn(api, "children").mockResolvedValue({ results: [], total: 0 });
    render(<Harness initial={[]} />);

    type("homo");
    await settle();
    const input = screen.getByLabelText<HTMLInputElement>("Search or command");
    fireEvent.keyDown(input, { key: "Tab" });
    await settle();

    // The chip is the path in: rank-prefixed, beside the Species filter chip.
    expect(screen.getByText(/genus:/)).toBeTruthy();
    expect(input.value).toBe("");
    // The next search is fenced to the clade the reader stepped into.
    type("er");
    await settle();
    const last = search.mock.calls.at(-1);
    expect(last?.[3]).toBe("n5");
  });

  it("Tab on a lone species is swallowed and drills nowhere", async () => {
    vi.spyOn(api, "search").mockResolvedValue(answer(hit("Homo sapiens", 9)));
    const children = vi
      .spyOn(api, "children")
      .mockResolvedValue({ results: [], total: 0 });
    render(<Harness initial={[]} />);

    type("sapiens");
    await settle();
    fireEvent.keyDown(screen.getByLabelText("Search or command"), {
      key: "Tab",
    });
    await settle();

    expect(children).not.toHaveBeenCalled();
    expect(screen.queryByText(/species:/)).toBeNull();
  });

  it("backspace at position zero pops the innermost chip first", async () => {
    vi.spyOn(api, "search").mockResolvedValue(answer());
    vi.spyOn(api, "children").mockResolvedValue({
      results: [hit("Homo sapiens", 10)],
      total: 1,
    });
    render(<Harness initial={[homo]} />);
    await settle();
    expect(screen.getByText(/genus:/)).toBeTruthy();

    const input = screen.getByLabelText("Search or command");
    fireEvent.keyDown(input, { key: "Backspace" });
    await settle();
    // The clade chip went; the Species filter is still on.
    expect(screen.queryByText(/genus:/)).toBeNull();
    expect(screen.getByText("Species")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.queryByText("Species")).toBeNull();
  });
});
