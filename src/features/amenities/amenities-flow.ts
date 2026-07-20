/**
 * Pure decision helpers for the client-side amenities fetch, split out of
 * `AppMap` so the race-sensitive rule is unit-testable (the task 012/013 lesson:
 * flow decisions live in the owning feature root, not the component).
 *
 * Amenities describe a resolved ADDRESS, not a travel mode, so they are keyed by
 * the rounded origin — NOT by the selection token, which a Walk↔Transit toggle
 * bumps. A toggle recomputes the SAME origin, so its key is unchanged and the
 * markers persist with no refetch; only a genuinely-new origin triggers a fetch.
 * `originKey` rounds to 5 decimals so the key computed from a pre-round geocode
 * result matches the one from the isochrone's already-rounded origin.
 */

/** Stable identity of an origin for "same address?" comparison (5-decimal round,
 * matching the server's `roundCoord`). */
export function originKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

/** True when a resolved origin is a genuinely-new address (⇒ fetch amenities).
 * The same origin (e.g. a mode toggle's recompute) returns false ⇒ persist. */
export function isNewAmenityOrigin(currentKey: string | null, nextKey: string): boolean {
  return currentKey !== nextKey;
}

/** Automatic retries per user-visible attempt. One is enough for a transient
 * ORS, database connection, or catalogue cutover failure; more would keep the
 * panel behind a spinner without improving deterministic empty/error states. */
export const AMENITY_MAX_AUTO_RETRIES = 1;

/** Delay before the automatic retry. Long enough for a briefly-saturated
 * provider to breathe, short enough that the panel still feels responsive. */
export const AMENITY_RETRY_DELAY_MS = 1500;

/**
 * True when a failed amenity fetch is worth retrying (automatically or via the
 * Retry button): transient provider failures only. `null` = the request never
 * completed (network drop / fetch TypeError) — transient. 5xx = upstream
 * provider trouble (the 502 all-hosts-failed race) — transient. Anything else
 * (422 out-of-area, other 4xx, a completed 200 with a malformed body) is
 * deterministic for this origin: retrying would re-fail identically.
 */
export function isRetryableAmenityFailure(httpStatus: number | null): boolean {
  return httpStatus === null || httpStatus >= 500;
}
