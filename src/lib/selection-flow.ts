/**
 * Pure state machine for the map's selection flow (search / map-click / picked
 * suggestion → geocode → isochrone), split out of `AppMap` so the race-sensitive
 * decisions are unit-testable without a browser: monotonic token accept/reject,
 * the mode snapshotted at request start, the `lastSelection` rules that let a
 * Walk/Transit toggle recompute the same origin, and the status→message mapping.
 *
 * The component keeps the imperative parts (fetch, AbortController, MapLibre
 * rendering). It dispatches actions through `selectionReducer` via a
 * synchronously-updated ref so `select()` can read the fresh token in the same
 * tick, and detects whether a `resolved` was accepted (not stale) with the
 * shared convention: a no-op/stale action returns the SAME state object.
 */

export type Mode = "walk" | "transit";
export type SelectionStatus = "idle" | "loading" | "error";
export type Stage = "geocode" | "reverse" | "isochrone";

export interface Origin {
  lat: number;
  lng: number;
}

export interface Ring {
  minutes: number;
  geometry: unknown;
}

/** A picked suggestion / map click / search box submission. */
export type SelectInput =
  | { kind: "search"; query: string }
  | { kind: "click"; lat: number; lng: number }
  | { kind: "point"; lat: number; lng: number; label: string };

export interface SelectionState {
  /** Monotonic; bumped by `start` and `toggle` so superseded responses are dropped. */
  token: number;
  /** Snapshotted at request start; drives endpoint, colors, legend, and failure copy. */
  mode: Mode;
  status: SelectionStatus;
  label: string | null;
  message: string | null;
  /** The last successfully-resolved origin+label, so a mode toggle recomputes it with no geocode. */
  lastSelection: { lat: number; lng: number; label: string } | null;
}

export const initialSelectionState: SelectionState = {
  token: 0,
  mode: "walk",
  status: "idle",
  label: null,
  message: null,
  lastSelection: null,
};

export type SelectionAction =
  | { type: "start"; mode: Mode }
  | { type: "resolved"; token: number; origin: Origin; label: string }
  | { type: "failed"; token: number; stage: Stage; httpStatus: number }
  | { type: "crash"; token: number }
  | { type: "toggle"; next: Mode };

export const GENERIC_ERROR = "Something went wrong. Try again.";
const OUT_OF_AREA = "That spot is outside Bucharest.";

/** Human word for the active travel mode, used in copy. */
export function modeWord(mode: Mode): string {
  return mode === "transit" ? "transit" : "walking";
}

/** The API route that computes reach for the mode. */
export function isochronePath(mode: Mode): string {
  return mode === "transit" ? "/api/transit" : "/api/isochrone";
}

/**
 * A reverse-geocode failure is NOT fatal unless the point is out of area: a
 * missing/500 address just means the click keeps its generic label and the
 * isochrone still renders. Only 422 aborts the selection.
 */
export function reverseIsFatal(httpStatus: number): boolean {
  return httpStatus === 422;
}

/** User-facing copy for a fatal selection failure. Only called for fatal stages. */
export function failureMessage(stage: Stage, httpStatus: number, mode: Mode): string {
  if (httpStatus === 422) return OUT_OF_AREA;
  if (stage === "geocode" && httpStatus === 404) return "No place found there.";
  if (stage === "isochrone") return `Could not compute ${modeWord(mode)} reach. Try again.`;
  return "Could not look that up. Try again.";
}

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case "start":
      // New selection: invalidate anything in flight, snapshot the mode, and
      // forget the prior origin so a mode toggle mid-flight resets to idle
      // rather than recomputing a stale address.
      return {
        ...state,
        token: state.token + 1,
        mode: action.mode,
        status: "loading",
        label: null,
        message: null,
        lastSelection: null,
      };
    case "resolved":
      if (action.token !== state.token) return state; // superseded — ignore
      return {
        ...state,
        status: "idle",
        label: action.label,
        // Clear any error banner locally so success is self-contained, not
        // dependent on `start` having run first.
        message: null,
        // The isochrone's rounded origin, so a toggle recompute agrees with the marker/rings.
        lastSelection: { lat: action.origin.lat, lng: action.origin.lng, label: action.label },
      };
    case "failed":
      if (action.token !== state.token) return state; // superseded — ignore
      // mode is read from state, which token-staleness guarantees is the mode
      // this request started with.
      return { ...state, status: "error", message: failureMessage(action.stage, action.httpStatus, state.mode) };
    case "crash":
      // An unexpected (non-HTTP) error — network drop, bad JSON. Distinct from a
      // stage failure, so it gets the generic copy rather than a stage message.
      if (action.token !== state.token) return state;
      return { ...state, status: "error", message: GENERIC_ERROR };
    case "toggle": {
      if (action.next === state.mode) return state; // no-op
      const token = state.token + 1; // invalidate any in-flight request
      if (state.lastSelection === null) {
        // Nothing to recompute (e.g. toggled while the first search was still
        // loading) — don't strand the UI in "loading".
        return { ...state, mode: action.next, token, status: "idle", message: null };
      }
      return { ...state, mode: action.next, token };
    }
  }
}
