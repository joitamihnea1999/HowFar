import {
  MAX_PER_CATEGORY,
  WALK_CLIP_MINUTES,
  type AmenityCounts,
} from "@/features/amenities/amenities";
import {
  queryCatalogueSummaryInRing,
  type CatalogueAmenity,
} from "@/features/amenities/server/catalogue-query";
import { mergeCoincidentTransitStops } from "@/features/amenities/server/merge-transit-stops";
import { withActiveDataset } from "@/features/amenities/server/catalogue-store";
import { DEFAULT_PACE, type Pace } from "@/features/isochrones/pace";
import { walkingIsochrone } from "@/features/isochrones/server/ors";
import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { db } from "@/lib/db";
import { ProviderError, roundCoord } from "@/lib/provider-http";

export interface NearbyAmenitiesResult {
  origin: { lat: number; lng: number };
  walkMinutes: number;
  counts: AmenityCounts;
  amenities: CatalogueAmenity[];
  catalogue: {
    sourceTimestamp: string | null;
    stale: boolean;
  };
}

/** Payload stored in ApiCache — freshness (`stale`) is recomputed on every read. */
interface CachedNearbyAmenities {
  origin: { lat: number; lng: number };
  walkMinutes: number;
  counts: AmenityCounts;
  amenities: CatalogueAmenity[];
  sourceTimestamp: string | null;
  datasetId: string;
}

export const CATALOGUE_STALE_AFTER_MS = 10 * 24 * 60 * 60 * 1_000;

/**
 * Result-cache TTL for a successful nearby query. Shorter than the 10-day
 * catalogue stale window and the weekly importer so a reseed (new datasetId)
 * naturally misses. Errors are never written here (fail-through).
 */
export const AMENITY_RESULT_TTL_MS = 24 * 60 * 60 * 1_000;

/** Bump when the cached JSON shape changes. Includes datasetId so a publish
 * invalidates. v2 (task 047): merged-transit `members`. v3 (task 051): the walk
 * ring used for the clip is PACE-dependent, so the pace is part of the key —
 * Relaxed and Brisk must never share a cache entry (or counts would be wrong). */
const AMENITY_RESULT_CACHE_PREFIX = "amenity:local:v3:";

export function amenityResultCacheKey(
  datasetId: string,
  lat: number,
  lng: number,
  pace: Pace,
): string {
  return `${AMENITY_RESULT_CACHE_PREFIX}${datasetId}:${pace}:${roundCoord(lat)},${roundCoord(lng)}`;
}

export function isCatalogueStale(sourceTimestamp: Date | null, now = new Date()): boolean {
  if (!sourceTimestamp) return true;
  return now.getTime() - sourceTimestamp.getTime() > CATALOGUE_STALE_AFTER_MS;
}

export class CatalogueUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CatalogueUnavailableError";
  }
}

export function rehydrateCachedNearby(
  cached: CachedNearbyAmenities,
  now = new Date(),
): NearbyAmenitiesResult {
  let sourceOk: Date | null = null;
  if (cached.sourceTimestamp) {
    const parsed = new Date(cached.sourceTimestamp);
    if (!Number.isNaN(parsed.getTime())) sourceOk = parsed;
  }
  return {
    origin: cached.origin,
    walkMinutes: cached.walkMinutes,
    counts: cached.counts,
    amenities: cached.amenities,
    catalogue: {
      sourceTimestamp: sourceOk?.toISOString() ?? null,
      stale: isCatalogueStale(sourceOk, now),
    },
  };
}

// Concurrent cold callers for the same rounded origin share one catalogue
// query (and one ORS walk-ring fetch underneath), mirroring ORS single-flight.
const inFlight = new Map<string, Promise<NearbyAmenitiesResult>>();

/** Runtime discovery uses only ORS for the walking ring (at the active `pace`)
 * and local PostGIS. The `pace` widens the counting radius, so it is part of the
 * cache key AND the single-flight key — otherwise a concurrent Brisk request
 * could coalesce onto an in-flight Relaxed promise and render wrong counts. */
export async function nearbyAmenities(
  latRaw: number,
  lngRaw: number,
  pace: Pace = DEFAULT_PACE,
): Promise<NearbyAmenitiesResult> {
  const lat = Number(roundCoord(latRaw));
  const lng = Number(roundCoord(lngRaw));
  const flightKey = `${pace}:${lat},${lng}`;

  const existing = inFlight.get(flightKey);
  if (existing) return existing;

  const promise = computeNearbyAmenities(latRaw, lngRaw, lat, lng, pace);
  inFlight.set(flightKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(flightKey);
  }
}

async function computeNearbyAmenities(
  latRaw: number,
  lngRaw: number,
  lat: number,
  lng: number,
  pace: Pace,
): Promise<NearbyAmenitiesResult> {
  // Cheap active-pointer + ApiCache probe OUTSIDE any long interactive
  // transaction so cache hits never hold a pool slot across a second client
  // (impl panel: pool starvation on concurrent warm origins).
  const active = await db().amenityDataset.findUnique({
    where: { activeKey: 1 },
    select: { id: true },
  });
  if (!active) throw new CatalogueUnavailableError("No active amenity catalogue");

  const cacheKey = amenityResultCacheKey(active.id, lat, lng, pace);
  const hit = await getCachedSafe<CachedNearbyAmenities>(cacheKey);
  if (hit && hit.datasetId === active.id) {
    // Warm path: skip ORS + PostGIS. Stale is recomputed at read time.
    return rehydrateCachedNearby(hit);
  }

  // Miss path: need the walk ring for spatial clip, then a pinned dataset read.
  const isochrone = await walkingIsochrone(latRaw, lngRaw, pace);
  const ring = isochrone.rings.find(({ minutes }) => minutes === WALK_CLIP_MINUTES);
  if (!ring?.geometry) {
    throw new ProviderError(`walk isochrone missing the ${WALK_CLIP_MINUTES}-min ring for clipping`);
  }

  let summary: {
    datasetId: string;
    counts: AmenityCounts;
    amenities: CatalogueAmenity[];
    sourceTimestamp: Date | null;
  } | null;
  try {
    summary = await withActiveDataset(async (tx, datasetId) => {
      const result = await queryCatalogueSummaryInRing(
        tx,
        datasetId,
        ring.geometry as GeoJSON.Geometry,
        { lat, lng },
      );
      const dataset = await tx.amenityDataset.findUniqueOrThrow({
        where: { id: datasetId },
        select: { sourceTimestamp: true },
      });
      return {
        datasetId,
        counts: result.counts,
        amenities: result.amenities,
        sourceTimestamp: dataset.sourceTimestamp,
      };
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new CatalogueUnavailableError("Amenity catalogue query failed", { cause: error });
  }
  if (!summary) throw new CatalogueUnavailableError("No active amenity catalogue");

  // Fuse coincident transit stops into single markers (task 047). Read-time only.
  const merged = mergeCoincidentTransitStops(summary.amenities);
  const absorbedTransit = merged.absorbedTransit;
  // `modes` is a server-only merge input; drop it so it never enters the client
  // payload/cache contract (a merged marker carries everything the popup needs in
  // `members`). (impl-panel finding F5.)
  const amenities: CatalogueAmenity[] = merged.amenities.map((a) => {
    const copy = { ...a };
    delete copy.modes;
    return copy;
  });
  const counts: AmenityCounts = { ...summary.counts };
  // The count is the pre-cap in-ring total; only adjust it for merges when the
  // whole transit category fit under the cap (so the visible set is complete and
  // `absorbedTransit` accounts for every duplicate). When capped (>150 in ring)
  // leave the raw node total — a documented best-effort (task 047 Parked).
  if (counts.transit <= MAX_PER_CATEGORY) {
    counts.transit = Math.max(0, counts.transit - absorbedTransit);
  }

  const sourceIso = summary.sourceTimestamp?.toISOString() ?? null;
  const payload: NearbyAmenitiesResult = {
    origin: { lat, lng },
    walkMinutes: WALK_CLIP_MINUTES,
    counts,
    amenities,
    catalogue: {
      sourceTimestamp: sourceIso,
      stale: isCatalogueStale(summary.sourceTimestamp),
    },
  };

  // Only successful results are stored. Empty markers are legitimate hits.
  const body: CachedNearbyAmenities = {
    origin: payload.origin,
    walkMinutes: payload.walkMinutes,
    counts,
    amenities,
    sourceTimestamp: sourceIso,
    datasetId: summary.datasetId,
  };
  await setCachedSafe(
    amenityResultCacheKey(summary.datasetId, lat, lng, pace),
    body,
    new Date(Date.now() + AMENITY_RESULT_TTL_MS),
  );

  return payload;
}
