import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  comboboxReducer,
  initialComboboxState,
  MIN_SUGGEST_LEN,
  shouldFetchSuggest,
  type ComboboxState,
  type Suggestion,
} from "./combobox";

const SUGGESTIONS: Suggestion[] = [
  { label: "Union Square, Bucharest", lat: 44.428, lng: 26.1025 },
  { label: "University Square, Bucharest", lat: 44.4349, lng: 26.1008 },
  { label: "Unirii Boulevard, Bucharest", lat: 44.427, lng: 26.11 },
];

/** Convenience: run a sequence of actions from the initial state. */
function run(...actions: Parameters<typeof comboboxReducer>[1][]): ComboboxState {
  return actions.reduce((s, a) => comboboxReducer(s, a), initialComboboxState);
}

/** The realistic "dropdown open with results" state: type → fetch → load. */
function opened(): ComboboxState {
  return run(
    { type: "queryChanged", value: "Uni" },
    { type: "fetchStarted", generation: 1 },
    { type: "suggestionsLoaded", generation: 1, suggestions: SUGGESTIONS },
  );
}

describe("shouldFetchSuggest", () => {
  it("is false below the minimum length and true at/above it", () => {
    expect(shouldFetchSuggest({ ...initialComboboxState, query: "Pi" })).toBe(false);
    expect(shouldFetchSuggest({ ...initialComboboxState, query: "Pia" })).toBe(true);
    // Whitespace does not count toward the minimum.
    expect(shouldFetchSuggest({ ...initialComboboxState, query: "  a  " })).toBe(false);
  });

  it("is false while suppressed even for a long query", () => {
    expect(shouldFetchSuggest({ ...initialComboboxState, query: "Union", suppress: true })).toBe(false);
  });
});

describe("comboboxReducer — queryChanged", () => {
  it("bumps the generation on every edit (invalidates in-flight fetches)", () => {
    const s = run({ type: "queryChanged", value: "Uni" });
    expect(s.generation).toBe(initialComboboxState.generation + 1);
    expect(s.query).toBe("Uni");
  });

  it("clears suggestions, closes, and resets activeIndex below the minimum length", () => {
    const open = run(
      { type: "queryChanged", value: "Uni" },
      { type: "fetchStarted", generation: 1 },
      { type: "suggestionsLoaded", generation: 1, suggestions: SUGGESTIONS },
    );
    expect(open.open).toBe(true);
    const cleared = comboboxReducer(open, { type: "queryChanged", value: "Un" });
    expect(cleared.suggestions).toEqual([]);
    expect(cleared.open).toBe(false);
    expect(cleared.activeIndex).toBe(-1);
    expect(cleared.status).toBe("idle");
  });

  it("keeps the existing suggestions/activeIndex for a >=3-char edit (no mid-typing flicker)", () => {
    const listed = run(
      { type: "queryChanged", value: "Uni" },
      { type: "fetchStarted", generation: 1 },
      { type: "suggestionsLoaded", generation: 1, suggestions: SUGGESTIONS },
      { type: "arrowDown" },
    );
    expect(listed.activeIndex).toBe(0);
    const next = comboboxReducer(listed, { type: "queryChanged", value: "Unir" });
    // Stale list persists until the new fetch resolves.
    expect(next.suggestions).toEqual(SUGGESTIONS);
    expect(next.activeIndex).toBe(0);
  });

  it("clears a prior post-pick suppression (a user edit re-enables suggesting)", () => {
    const picked = run(
      { type: "queryChanged", value: "Uni" },
      { type: "fetchStarted", generation: 1 },
      { type: "suggestionsLoaded", generation: 1, suggestions: SUGGESTIONS },
      { type: "pick", suggestion: SUGGESTIONS[0]! },
    );
    expect(picked.suppress).toBe(true);
    const edited = comboboxReducer(picked, { type: "queryChanged", value: "Unix" });
    expect(edited.suppress).toBe(false);
    expect(shouldFetchSuggest(edited)).toBe(true);
  });
});

describe("comboboxReducer — fetch lifecycle & staleness", () => {
  it("fetchStarted opens + shows loading only for the current generation", () => {
    const s = run({ type: "queryChanged", value: "Uni" }); // generation 1
    const started = comboboxReducer(s, { type: "fetchStarted", generation: 1 });
    expect(started.status).toBe("loading");
    expect(started.open).toBe(true);
  });

  it("drops a fetchStarted whose generation is stale (returns the same state ref)", () => {
    const s = run({ type: "queryChanged", value: "Uni" }); // generation 1
    const bumped = comboboxReducer(s, { type: "queryChanged", value: "Unir" }); // generation 2
    const started = comboboxReducer(bumped, { type: "fetchStarted", generation: 1 });
    expect(started).toBe(bumped); // ignored, no reopen
  });

  it("drops suggestionsLoaded / fetchError for a stale generation", () => {
    const s = run({ type: "queryChanged", value: "Uni" }); // generation 1
    const bumped = comboboxReducer(s, { type: "queryChanged", value: "Unir" }); // generation 2
    expect(comboboxReducer(bumped, { type: "suggestionsLoaded", generation: 1, suggestions: SUGGESTIONS })).toBe(
      bumped,
    );
    expect(comboboxReducer(bumped, { type: "fetchError", generation: 1 })).toBe(bumped);
  });

  it("suggestionsLoaded stores the list and resets activeIndex; fetchError clears + flags error", () => {
    const s = run({ type: "queryChanged", value: "Uni" });
    const loaded = comboboxReducer(s, { type: "suggestionsLoaded", generation: 1, suggestions: SUGGESTIONS });
    expect(loaded.suggestions).toEqual(SUGGESTIONS);
    expect(loaded.activeIndex).toBe(-1);
    expect(loaded.status).toBe("idle");
    const errored = comboboxReducer(s, { type: "fetchError", generation: 1 });
    expect(errored.suggestions).toEqual([]);
    expect(errored.status).toBe("error");
  });

  it("a close after a fetch was scheduled drops the late fetchStarted (no reopen)", () => {
    const scheduled = run({ type: "queryChanged", value: "Uni" }); // generation 1, timer captured gen 1
    const closed = comboboxReducer(scheduled, { type: "close" }); // generation 2
    const late = comboboxReducer(closed, { type: "fetchStarted", generation: 1 });
    expect(late).toBe(closed);
    expect(late.open).toBe(false);
  });
});

describe("comboboxReducer — pick / close", () => {
  it("pick sets the query, suppresses, closes, and bumps the generation", () => {
    const listed = opened();
    const picked = comboboxReducer(listed, { type: "pick", suggestion: SUGGESTIONS[1]! });
    expect(picked.query).toBe("University Square, Bucharest");
    expect(picked.suppress).toBe(true);
    expect(picked.open).toBe(false);
    expect(picked.suggestions).toEqual([]);
    expect(picked.activeIndex).toBe(-1);
    expect(picked.generation).toBe(listed.generation + 1);
    // A picked suggestion must not trigger another suggest fetch.
    expect(shouldFetchSuggest(picked)).toBe(false);
  });

  it("close hides the dropdown and always bumps the generation (invalidates late fetches)", () => {
    const open = opened();
    const closed = comboboxReducer(open, { type: "close" });
    expect(closed.open).toBe(false);
    expect(closed.activeIndex).toBe(-1);
    expect(closed.generation).toBe(open.generation + 1);
    // A second close bumps again — never a no-op, since a fetch may have been
    // scheduled in between and must be invalidated too.
    expect(comboboxReducer(closed, { type: "close" }).generation).toBe(closed.generation + 1);
  });
});

describe("comboboxReducer — keyboard navigation", () => {
  const listed = opened();

  it("ArrowDown advances and wraps past the end back to 0", () => {
    let s = listed;
    s = comboboxReducer(s, { type: "arrowDown" });
    expect(s.activeIndex).toBe(0);
    s = comboboxReducer(s, { type: "arrowDown" });
    expect(s.activeIndex).toBe(1);
    s = comboboxReducer(s, { type: "arrowDown" });
    expect(s.activeIndex).toBe(2);
    s = comboboxReducer(s, { type: "arrowDown" });
    expect(s.activeIndex).toBe(0); // wrapped
  });

  it("ArrowUp from -1 wraps to the last item and decrements from there", () => {
    let s = comboboxReducer(listed, { type: "arrowUp" });
    expect(s.activeIndex).toBe(SUGGESTIONS.length - 1);
    s = comboboxReducer(s, { type: "arrowUp" });
    expect(s.activeIndex).toBe(SUGGESTIONS.length - 2);
  });

  it("arrow keys are a no-op when closed or empty (same ref)", () => {
    expect(comboboxReducer(initialComboboxState, { type: "arrowDown" })).toBe(initialComboboxState);
    const closed = comboboxReducer(listed, { type: "close" });
    expect(comboboxReducer(closed, { type: "arrowDown" })).toBe(closed);
    // Open but still loading (no results yet): arrows have nothing to move over.
    const loading = run({ type: "queryChanged", value: "Uni" }, { type: "fetchStarted", generation: 1 });
    expect(loading.open).toBe(true);
    expect(comboboxReducer(loading, { type: "arrowUp" })).toBe(loading);
  });

  it("hover sets the active index to the pointed item; out-of-range or same is a no-op", () => {
    const hovered = comboboxReducer(listed, { type: "hover", index: 2 });
    expect(hovered.activeIndex).toBe(2);
    expect(comboboxReducer(hovered, { type: "hover", index: 2 })).toBe(hovered); // same → no-op
    expect(comboboxReducer(listed, { type: "hover", index: 9 })).toBe(listed); // out of range
    expect(comboboxReducer(listed, { type: "hover", index: -1 })).toBe(listed);
  });

  it("activeIndex always stays within [-1, length) under any arrow sequence (property)", () => {
    const arrow = fc.constantFrom<{ type: "arrowDown" | "arrowUp" }>({ type: "arrowDown" }, { type: "arrowUp" });
    fc.assert(
      fc.property(fc.array(arrow, { maxLength: 50 }), (actions) => {
        const s = actions.reduce((acc, a) => comboboxReducer(acc, a), listed);
        return s.activeIndex >= -1 && s.activeIndex < SUGGESTIONS.length;
      }),
    );
  });
});

describe("comboboxReducer — focus", () => {
  it("opens on focus only when there are suggestions to show", () => {
    expect(comboboxReducer(initialComboboxState, { type: "focus" })).toBe(initialComboboxState); // nothing to show
    const closed = comboboxReducer(opened(), { type: "close" });
    const focused = comboboxReducer(closed, { type: "focus" });
    expect(focused.open).toBe(true);
    // Focusing an already-open dropdown is a no-op (same ref).
    expect(comboboxReducer(focused, { type: "focus" })).toBe(focused);
  });

  it("uses MIN_SUGGEST_LEN of 3", () => {
    expect(MIN_SUGGEST_LEN).toBe(3);
  });
});
