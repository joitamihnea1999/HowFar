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

import { DEFAULT_PACE, type Pace } from "@/features/isochrones/pace";
import { DEFAULT_TIME_CONTEXT, type TimeContext } from "@/features/isochrones/time-context";

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
  /** Monotonic; bumped by `start`, `toggle`, `setPace`, `setTimeContext` so superseded responses are dropped. */
  token: number;
  /** Snapshotted at request start; drives endpoint, colors, legend, and failure copy. */
  mode: Mode;
  /** Active walking pace — snapshotted per request; drives ORS ranges + amenity radius (both modes). */
  pace: Pace;
  /** Active transit departure context — snapshotted per request; transit-only. */
  timeContext: TimeContext;
  status: SelectionStatus;
  label: string | null;
  message: string | null;
  /** The resolved transit departure (ISO) + a short summary, surfaced so the UI can qualify the claim. */
  departure: { iso: string; summary: string } | null;
  /** The last successfully-resolved origin+label, so a mode/pace/time change recomputes it with no geocode. */
  lastSelection: { lat: number; lng: number; label: string } | null;
}

export const initialSelectionState: SelectionState = {
  token: 0,
  mode: "walk",
  pace: DEFAULT_PACE,
  timeContext: DEFAULT_TIME_CONTEXT,
  status: "idle",
  label: null,
  message: null,
  departure: null,
  lastSelection: null,
};

export type SelectionAction =
  | { type: "start"; mode: Mode; preserveLast?: boolean }
  | { type: "resolved"; token: number; origin: Origin; label: string; departure?: { iso: string; summary: string } | null }
  | { type: "failed"; token: number; stage: Stage; httpStatus: number }
  | { type: "crash"; token: number }
  | { type: "toggle"; next: Mode }
  | { type: "setPace"; pace: Pace }
  | { type: "setTimeContext"; timeContext: TimeContext };

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

/** Build the isochrone request URL for a mode + pace + (transit-only) departure
 * context. Walk carries only `pace`; transit adds `preset` or `weekday`+`time`.
 * Pure + exported so the exact query contract is unit-testable. */
export function isochroneUrl(mode: Mode, origin: Origin, pace: Pace, timeContext: TimeContext): string {
  const base = `${isochronePath(mode)}?lat=${origin.lat}&lng=${origin.lng}&pace=${pace}`;
  if (mode !== "transit") return base;
  if (timeContext.kind === "preset") return `${base}&preset=${timeContext.preset}`;
  const hh = String(timeContext.hour).padStart(2, "0");
  const mm = String(timeContext.minute).padStart(2, "0");
  return `${base}&weekday=${timeContext.weekday}&time=${hh}%3A${mm}`;
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
      // Invalidate anything in flight and snapshot the mode. A genuinely-new
      // selection (search/click/pick) forgets the prior origin so a mode toggle
      // mid-flight resets to idle rather than recomputing a stale address. A
      // toggle-driven recompute (`preserveLast`) keeps the origin so a further
      // toggle before this resolves can still re-issue it.
      return {
        ...state,
        token: state.token + 1,
        mode: action.mode,
        status: "loading",
        label: null,
        message: null,
        lastSelection: action.preserveLast ? state.lastSelection : null,
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
        // The resolved transit departure (walk selections pass null → cleared).
        departure: action.departure ?? null,
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
    case "setPace": {
      if (action.pace === state.pace) return state; // no-op
      // Bump the token to invalidate any in-flight request and snapshot the new
      // pace. The controller re-issues the pending/last selection; if none is in
      // flight or resolved yet it re-runs the pending input (finding G — a pace
      // change before the first resolution must not be lost).
      const token = state.token + 1;
      if (state.lastSelection === null && state.status !== "loading") {
        return { ...state, pace: action.pace, token, status: "idle" };
      }
      return { ...state, pace: action.pace, token };
    }
    case "setTimeContext": {
      // Deep-equal by kind (presets are cheap; custom compares fields).
      if (sameTimeContext(action.timeContext, state.timeContext)) return state; // no-op
      const token = state.token + 1;
      if (state.lastSelection === null && state.status !== "loading") {
        return { ...state, timeContext: action.timeContext, token, status: "idle" };
      }
      return { ...state, timeContext: action.timeContext, token };
    }
  }
}

/** Structural equality for a TimeContext (avoids a no-op recompute + fetch). */
export function sameTimeContext(a: TimeContext, b: TimeContext): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "preset" && b.kind === "preset") return a.preset === b.preset;
  if (a.kind === "custom" && b.kind === "custom")
    return a.weekday === b.weekday && a.hour === b.hour && a.minute === b.minute;
  return false;
}
