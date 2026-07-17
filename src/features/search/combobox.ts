/**
 * Pure state machine for the address-search combobox, split out of `AppMap` so
 * the tricky transitions — generation-based staleness, suppress-after-pick, the
 * <3-char clear, and keyboard wraparound — are unit-testable without a DOM.
 *
 * The component owns the imperative pieces (the 250ms debounce timer, the
 * `AbortController`, and the actual `/api/suggest` fetch); it dispatches actions
 * here and reads the returned state. Every action returns the SAME state object
 * when it is a no-op or stale, so callers can cheaply detect a real change with
 * `next !== prev`.
 *
 * Staleness note: a fetch tags itself with the `generation` current when it was
 * scheduled and passes it back on `fetchStarted`/`suggestionsLoaded`/`fetchError`.
 * The reducer compares against the LATEST `generation` at dispatch time, so a
 * response for a superseded query (or one that arrives after `close`/`pick`,
 * both of which bump `generation`) is dropped — the dropdown never reopens.
 */

export const MIN_SUGGEST_LEN = 3;

export interface Suggestion {
  label: string;
  lat: number;
  lng: number;
}

export type ComboboxStatus = "idle" | "loading" | "error";

export interface ComboboxState {
  query: string;
  suggestions: Suggestion[];
  open: boolean;
  activeIndex: number;
  /** Bumped on every query change, close, and pick; tags in-flight fetches. */
  generation: number;
  status: ComboboxStatus;
  /** Set by `pick` so the programmatic query change it causes does not re-fetch. */
  suppress: boolean;
}

export const initialComboboxState: ComboboxState = {
  query: "",
  suggestions: [],
  open: false,
  activeIndex: -1,
  generation: 0,
  status: "idle",
  suppress: false,
};

export type ComboboxAction =
  | { type: "queryChanged"; value: string }
  | { type: "fetchStarted"; generation: number }
  | { type: "suggestionsLoaded"; generation: number; suggestions: Suggestion[] }
  | { type: "fetchError"; generation: number }
  | { type: "pick"; suggestion: Suggestion }
  | { type: "close" }
  | { type: "arrowDown" }
  | { type: "arrowUp" }
  | { type: "hover"; index: number }
  | { type: "focus" };

/** Whether the effect should issue a suggest fetch for the current state. */
export function shouldFetchSuggest(state: ComboboxState): boolean {
  return state.query.trim().length >= MIN_SUGGEST_LEN && !state.suppress;
}

export function comboboxReducer(state: ComboboxState, action: ComboboxAction): ComboboxState {
  switch (action.type) {
    case "queryChanged": {
      // A real user edit always re-enables suggesting (clears any post-pick
      // suppression) and invalidates any in-flight response by bumping the
      // generation. A <3-char query also clears/closes the dropdown; a ≥3-char
      // query keeps the existing list visible until the new fetch resolves
      // (avoids a flicker to empty mid-typing).
      const generation = state.generation + 1;
      const base = { ...state, query: action.value, suppress: false, generation };
      if (action.value.trim().length < MIN_SUGGEST_LEN) {
        return { ...base, suggestions: [], open: false, activeIndex: -1, status: "idle" };
      }
      return base;
    }
    case "fetchStarted":
      if (action.generation !== state.generation) return state; // stale
      return { ...state, status: "loading", open: true };
    case "suggestionsLoaded":
      if (action.generation !== state.generation) return state; // stale
      return { ...state, suggestions: action.suggestions, activeIndex: -1, status: "idle" };
    case "fetchError":
      if (action.generation !== state.generation) return state; // stale
      // A provider/upstream error is NOT the same as "no matches".
      return { ...state, suggestions: [], status: "error" };
    case "pick":
      // Go straight to the picked point; close and suppress the re-fetch the
      // programmatic query change would otherwise trigger.
      return {
        ...state,
        generation: state.generation + 1,
        query: action.suggestion.label,
        suppress: true,
        open: false,
        suggestions: [],
        activeIndex: -1,
      };
    case "close":
      // Always bumps the generation — its whole job is to invalidate a pending
      // or in-flight suggest fetch (blur/escape during the debounce window)
      // so a late response can't reopen the dismissed dropdown.
      return { ...state, generation: state.generation + 1, open: false, activeIndex: -1 };
    case "arrowDown": {
      if (!state.open || state.suggestions.length === 0) return state;
      return { ...state, activeIndex: (state.activeIndex + 1) % state.suggestions.length };
    }
    case "arrowUp": {
      if (!state.open || state.suggestions.length === 0) return state;
      const activeIndex = state.activeIndex <= 0 ? state.suggestions.length - 1 : state.activeIndex - 1;
      return { ...state, activeIndex };
    }
    case "hover":
      // Pointer hover highlights the item under the cursor.
      if (action.index === state.activeIndex || action.index < 0 || action.index >= state.suggestions.length)
        return state;
      return { ...state, activeIndex: action.index };
    case "focus":
      if (state.open || state.suggestions.length === 0) return state;
      return { ...state, open: true };
  }
}
