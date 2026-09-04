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

export type Mode = "walk" | "transit" | "car";
export const MODES = ["walk", "transit", "car"] as const;

/**
 * Parse a travel mode from a query string — fail-loud, and **required** (task 065).
 *
 * Unlike `parsePaceStrict`, an ABSENT value is rejected rather than defaulted. The
 * amenity clip is now mode-dependent, so a missing `mode` from an un-updated client
 * would silently reproduce exactly the pre-065 walk-clip bug this task removes: a
 * transit map with markers covering only a 15-minute walk, and nothing anywhere
 * reporting a problem. A 400 makes that impossible to miss. Same house rule as task
 * 059's retired pace/preset ids — no live users, so no silent-alias shim.
 */
export function parseModeStrict(raw: string | null | undefined): Mode | null {
  if (raw === null || raw === undefined || raw === "") return null;
  return (MODES as readonly string[]).includes(raw) ? (raw as Mode) : null;
}

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

/** Honest car-reach metadata echoed by /api/car (task 058): the basis is always
 * "estimate" (typical-congestion adjustment, not live traffic), plus the traffic
 * slot the rings were computed for so the UI can say WHICH traffic it assumed. */
export interface CarMeta {
  basis: "estimate";
  slotId: string;
  slotLabel: string;
}

export interface SelectionState {
  /** Monotonic; bumped by `start`, `toggle`, `setPace`, `setTimeContext` so superseded responses are dropped. */
  token: number;
  /** Snapshotted at request start; drives endpoint, colors, legend, and failure copy. */
  mode: Mode;
  /** Active walking pace — snapshotted per request; drives ORS ranges + amenity radius (both modes). */
  pace: Pace;
  /** Active departure context — snapshotted per request; used by transit AND car (task 058). */
  timeContext: TimeContext;
  status: SelectionStatus;
  label: string | null;
  message: string | null;
  /** The resolved transit departure (ISO) + a short summary, surfaced so the UI can qualify the claim. */
  departure: { iso: string; summary: string } | null;
  /** The resolved car-reach basis + traffic slot (task 058) — car-only, else null. */
  car: CarMeta | null;
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
  car: null,
  lastSelection: null,
};

export type SelectionAction =
  | { type: "start"; mode: Mode; preserveLast?: boolean }
  | { type: "resolved"; token: number; origin: Origin; label: string; departure?: { iso: string; summary: string } | null; car?: CarMeta | null }
  | { type: "failed"; token: number; stage: Stage; httpStatus: number }
  | { type: "crash"; token: number }
  | { type: "toggle"; next: Mode }
  | { type: "setPace"; pace: Pace }
  | { type: "setTimeContext"; timeContext: TimeContext };

export const GENERIC_ERROR = "Something went wrong. Try again.";
const OUT_OF_AREA = "That spot is outside Bucharest.";

/** Human word for the active travel mode, used in copy. Exhaustive switch: a
 * new Mode without a case here is a compile error (the `never` assignment), so
 * car can never silently borrow walk's word. */
export function modeWord(mode: Mode): string {
  switch (mode) {
    case "walk":
      return "walking";
    case "transit":
      return "transit";
    case "car":
      return "driving";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/** The API route that computes reach for the mode. Exhaustive switch so a
 * missing car branch is a compile error, not a silent fall-through to the walk
 * endpoint (which would render walk rings mislabeled as car). */
export function isochronePath(mode: Mode): string {
  switch (mode) {
    case "walk":
      return "/api/isochrone";
    case "transit":
      return "/api/transit";
    case "car":
      return "/api/car";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/**
 * Pace is a WALKING concept (task 052): it scales the walk isochrone and the
 * amenity clip radius. In any non-walk mode the user never sets a pace (the
 * control is walk-only), so every request in a non-walk mode behaves as Normal —
 * regardless of a pace the user picked earlier in Walk (which we remember, to
 * restore when they switch back). This is the SINGLE source of that rule: the
 * isochrone URL, the amenity fetch, the amenity dedupe key, the manual retry,
 * and the AmenityPanel remount key all derive their pace through here, so they
 * can never disagree (plan-panel P4).
 */
export function effectivePace(mode: Mode, pace: Pace): Pace {
  return mode === "walk" ? pace : "normal";
}

/** Build the isochrone request URL for a mode + pace + departure context.
 * Walk carries only `pace`; transit carries `pace` + time; car carries time but
 * NO pace (task 058 — car is time-aware for traffic realism, but pace is a
 * walking concept that must never leak into a car request, plan-panel C-E).
 *
 * The phone-first client is PRESET-ONLY: every request carries
 * `&model=preset`, so the server serves the calibrated preset contours (walk
 * [10,20] / transit [20,40] / car [10,25]) instead of the legacy 15/30/45 bands.
 * The `model` param is APPENDED to every mode's URL — the legacy path stays
 * byte-identical for any caller that omits it (task 020's additive serving).
 * Pure + exported so the exact query contract is unit-testable. */
export function isochroneUrl(mode: Mode, origin: Origin, pace: Pace, timeContext: TimeContext): string {
  const coords = `?lat=${origin.lat}&lng=${origin.lng}`;
  // Preset-only since task 059 (Custom weekday/time was removed).
  const withTime = (base: string) => `${base}&preset=${timeContext.preset}`;
  const withModel = (base: string) => `${base}&model=preset`;
  // Car: time params only, NO pace (a Slow pace left over from Walk can
  // never reach /api/car — it doesn't accept pace and we don't emit it).
  if (mode === "car") return withModel(withTime(`${isochronePath(mode)}${coords}`));
  const base = `${isochronePath(mode)}${coords}&pace=${pace}`;
  if (mode !== "transit") return withModel(base); // walk: pace only
  return withModel(withTime(base)); // transit: pace + time
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
        // Clear the previously-resolved departure the moment a (re)compute
        // starts: a right-click DURING the recompute must not plan against a
        // stale ISO (e.g. Crowded→Not-crowded then right-click before the new
        // transit rings land). `handleReach` falls back to the CURRENT preset
        // until the fresh transit response re-sets `departure` (task 060 impl
        // panel: stale-departure race, codex×3).
        departure: null,
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
        // The resolved transit departure (walk/car selections pass null → cleared).
        departure: action.departure ?? null,
        // The resolved car basis + slot (walk/transit selections pass null → cleared).
        car: action.car ?? null,
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

/** Structural equality for a TimeContext (avoids a no-op recompute + fetch).
 * Preset-only since task 059 (Custom weekday/time was removed). */
export function sameTimeContext(a: TimeContext, b: TimeContext): boolean {
  return a.preset === b.preset;
}
