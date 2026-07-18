import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";

import {
  AMENITY_ENVELOPE_M,
  MAX_PER_CATEGORY,
  WALK_CLIP_MINUTES,
  buildOverpassQuery,
  capPerCategory,
  categoryForTags,
  countByCategory,
  sortByDistance,
  type Amenity,
  type AmenityCounts,
} from "@/features/amenities/amenities";
import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { inBucharest } from "@/lib/bounds";
import { ProviderError, roundCoord } from "@/lib/provider-http";
import { raceOverpass, type OverpassElement } from "@/features/amenities/server/overpass-client";
import { walkingIsochrone } from "@/features/isochrones/server/ors";

/**
 * OpenStreetMap amenities via the Overpass API (server-side, cached). One merged
 * QL query returns the five brief categories within a generous radius envelope;
 * `nearbyAmenities` then clips them to the real walking isochrone so the counts
 * are "within the walking isochrone" (brief §5), not "within a circle".
 *
 * The keyless, fair-use endpoint race (POST + identifying UA, Promise.any over a
 * small pool, abort-on-win) lives in `overpass-client.ts` (shared with the
 * per-stop route query, task 021). This module owns the amenity query, the parse
 * /classify/dedup, the 30-day cache and single-flight. The amenity envelope is
 * never legitimately empty, so it keeps the default `treatEmptyAsFailure`.
 */

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // amenities change slowly

export interface NearbyAmenitiesResult {
  /** The rounded origin (== cache key basis). */
  origin: { lat: number; lng: number };
  /** The walk-isochrone ring the amenities are clipped to. */
  walkMinutes: number;
  /** True per-category counts of ALL amenities in the ring (before the marker cap). */
  counts: AmenityCounts;
  /** Nearest-first amenities inside the ring, capped per category for rendering. */
  amenities: Amenity[];
}

/** Classify + clean the raw elements into flat amenities: first-match category,
 * node coords or way/relation `center`, drop non-finite/(0,0)/out-of-area,
 * dedup by OSM `type/id`. No cap here — the per-category cap is applied to the
 * CLIPPED set (see capPerCategory) so it can't drop a near item for a far one. */
function parseElements(elements: OverpassElement[]): Amenity[] {
  const seen = new Set<string>();
  const out: Amenity[] = [];
  for (const el of elements) {
    // A malformed array may contain null/non-object entries — never let one
    // throw here (this runs outside the ProviderError try/catch → would be a 500).
    if (!el || typeof el !== "object") continue;
    const category = categoryForTags(el.tags);
    if (!category) continue;
    const lat = Number(el.lat ?? el.center?.lat);
    const lng = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat === 0 && lng === 0) continue;
    if (!inBucharest(lat, lng)) continue;

    const dedupKey = `${el.type ?? "?"}/${el.id ?? `${lat},${lng}`}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const name = typeof el.tags?.name === "string" ? el.tags.name : "";
    // Carry the OSM identity (task 021: a transit-stop click looks up its lines
    // by type/id). Only when both are real — a synthetic dedup key must not
    // masquerade as an OSM id downstream.
    const osmType = typeof el.type === "string" ? el.type : undefined;
    const osmId = typeof el.id === "number" ? el.id : undefined;
    out.push({ lat, lng, name, category, osmType, osmId });
  }
  return out;
}

/** Keep only amenities whose point falls inside the walk-isochrone ring
 * geometry. This is what makes counts "within the walking isochrone" (§5)
 * rather than "within a radius". A malformed ring yields [] (no throw). Lives
 * server-side (turf) so the client bundle never pulls in the geometry lib. */
export function clipToRing(items: Amenity[], ring: GeoJSON.Geometry | null | undefined): Amenity[] {
  if (!ring) return [];
  return items.filter((a) => {
    try {
      return booleanPointInPolygon([a.lng, a.lat], ring as GeoJSON.Polygon | GeoJSON.MultiPolygon);
    } catch {
      return false;
    }
  });
}

// In-flight envelopes, keyed by cache key, so two concurrent cold callers for
// the same origin share ONE 3-endpoint race instead of each fanning out to all
// three public instances (which would triple the load on keyless community
// servers). Mirrors the single-flight in ors.ts. Cleared on settle.
const inFlight = new Map<string, Promise<Amenity[]>>();

/** Fetch + parse the raw (unclipped) envelope of amenities around a point,
 * cached (best-effort) and single-flighted. Mode-independent, so it's shared
 * across walk/transit views. Exported for tests (the clip is applied by
 * `nearbyAmenities`). */
export async function fetchOverpassAmenities(lat: number, lng: number): Promise<Amenity[]> {
  // v2: the parsed Amenity gained osmType/osmId (task 021). The bump keeps prod's
  // 30-day v1 hits (parsed before identity existed) from serving inert markers
  // whose transit clicks could never resolve their lines.
  const key = `amenities:v2:${AMENITY_ENVELOPE_M}:${roundCoord(lat)},${roundCoord(lng)}`;
  const hit = await getCachedSafe<Amenity[]>(key);
  if (hit) return hit;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchParseCache(lat, lng, key);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function fetchParseCache(lat: number, lng: number, key: string): Promise<Amenity[]> {
  const query = buildOverpassQuery(Number(roundCoord(lat)), Number(roundCoord(lng)));
  const elements = await raceOverpass(query); // amenity envelope: empty = degraded → default guard
  const amenities = parseElements(elements);
  await setCachedSafe(key, amenities, new Date(Date.now() + TTL_MS));
  return amenities;
}

/** Amenities within the walking isochrone (brief §5). Fetches the walk isochrone
 * and the Overpass envelope IN PARALLEL, then clips POIs to the 15-min ring. */
export async function nearbyAmenities(latRaw: number, lngRaw: number): Promise<NearbyAmenitiesResult> {
  const lat = Number(roundCoord(latRaw));
  const lng = Number(roundCoord(lngRaw));

  const [iso, all] = await Promise.all([
    walkingIsochrone(latRaw, lngRaw),
    fetchOverpassAmenities(latRaw, lngRaw),
  ]);

  const ring = iso.rings.find((r) => r.minutes === WALK_CLIP_MINUTES);
  if (!ring?.geometry) {
    throw new ProviderError(`walk isochrone missing the ${WALK_CLIP_MINUTES}-min ring for clipping`);
  }
  const clipped = clipToRing(all, ring.geometry as GeoJSON.Geometry);
  // Counts are the TRUE clipped totals (before the cap) so a category exceeding
  // the marker cap still reports its real number; markers are the nearest N.
  const counts = countByCategory(clipped);
  const amenities = capPerCategory(sortByDistance(clipped, { lat, lng }), MAX_PER_CATEGORY);
  return { origin: { lat, lng }, walkMinutes: WALK_CLIP_MINUTES, counts, amenities };
}
