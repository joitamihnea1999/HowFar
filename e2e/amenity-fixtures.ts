import type { AmenityCounts, AmenityCountsByBand } from "@/features/amenities/amenities";

/**
 * Shared shape helpers for stubbed `/api/amenities` responses.
 *
 * Task 065 made the payload band-aware: it carries a `clip` descriptor and per-(category,
 * band) pre-cap totals, and the client now REJECTS a response without a usable
 * `countsByBand` rather than recounting the rows it received. Every spec that stubs the
 * endpoint therefore has to produce the real shape — these helpers keep that in one place
 * so the contract can move again without touching a dozen specs.
 */

/** The default clip descriptor: a walk selection's outermost band. */
export const WALK_CLIP = { mode: "walk", band: 45, minutes: 45 } as const;

/**
 * Put a fixture's whole per-category total in the INNER band.
 *
 * Right for these fixtures because their places sit within a few hundred metres of the
 * origin, so they are all inside band 15 — which also means the counts a spec asserts are
 * unchanged at the default ring filter (15). A fixture that deliberately spreads places
 * across bands should build its own `AmenityCountsByBand` instead.
 */
export function innerBandCounts(counts: AmenityCounts): AmenityCountsByBand {
  const zero: AmenityCounts = {
    groceries: 0,
    pharmacies: 0,
    parks: 0,
    schools: 0,
    transit: 0,
  };
  return { 15: { ...counts }, 30: { ...zero }, 45: { ...zero } };
}

/** All-zero per-category totals. */
export const EMPTY_COUNTS: AmenityCounts = {
  groceries: 0,
  pharmacies: 0,
  parks: 0,
  schools: 0,
  transit: 0,
};

/**
 * A valid EMPTY amenity response for the many specs that stub this endpoint only to
 * keep a real provider call from happening. It must still be shape-valid: an empty
 * area is a legitimate answer, whereas a payload missing `countsByBand` is now an
 * error, and a spec asserting unrelated UI should not accidentally be asserting
 * against an amenity error state.
 */
export function emptyAmenities(origin: { lat: number; lng: number }) {
  // No flat `counts`: task 065 dropped it from the contract, so a fixture that still sent
  // one would re-document a field the app no longer has.
  return {
    origin,
    clip: WALK_CLIP,
    countsByBand: innerBandCounts(EMPTY_COUNTS),
    amenities: [],
  };
}

/**
 * Ensure every stubbed amenity row carries a ring band.
 *
 * The client REJECTS a payload whose rows lack one (task 065): a band-less marker would be
 * drawn under every ring filter, including outside the shading, which the band contract
 * exists to prevent. Applied at payload-assembly sites so it holds
 * for programmatically generated fixtures too, not just object literals. Defaults to the
 * inner band, which is where these near-origin fixtures sit.
 */
export function withBands<T extends object>(items: readonly T[]): (T & { band: number })[] {
  return items.map((item) => ({ band: 15, ...item }) as T & { band: number });
}
