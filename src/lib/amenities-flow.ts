/**
 * Pure decision helpers for the client-side amenities fetch, split out of
 * `AppMap` so the race-sensitive rule is unit-testable (the task 012/013 lesson:
 * flow decisions live in lib, not the component).
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
