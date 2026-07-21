import { WALK_CLIP_MINUTES, type AmenityCounts } from "@/features/amenities/amenities";
import {
  queryCatalogueSummaryInRing,
  type CatalogueAmenity,
} from "@/features/amenities/server/catalogue-query";
import { withActiveDataset } from "@/features/amenities/server/catalogue-store";
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

/** Bump when the cached JSON shape changes. Includes datasetId so a publish invalidates. */
const AMENITY_RESULT_CACHE_PREFIX = "amenity:local:v1:";

export function amenityResultCacheKey(
  datasetId: string,
  lat: number,
  lng: number,
): string {
  return `${AMENITY_RESULT_CACHE_PREFIX}${datasetId}:${roundCoord(lat)},${roundCoord(lng)}`;
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

/** Runtime discovery uses only ORS for the walking ring and local PostGIS. */
export async function nearbyAmenities(
  latRaw: number,
  lngRaw: number,
): Promise<NearbyAmenitiesResult> {
  const lat = Number(roundCoord(latRaw));
  const lng = Number(roundCoord(lngRaw));
  const flightKey = `${lat},${lng}`;

  const existing = inFlight.get(flightKey);
  if (existing) return existing;

  const promise = computeNearbyAmenities(latRaw, lngRaw, lat, lng);
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
): Promise<NearbyAmenitiesResult> {
  // Cheap active-pointer + ApiCache probe OUTSIDE any long interactive
  // transaction so cache hits never hold a pool slot across a second client
  // (impl panel: pool starvation on concurrent warm origins).
  const active = await db().amenityDataset.findUnique({
    where: { activeKey: 1 },
    select: { id: true },
  });
  if (!active) throw new CatalogueUnavailableError("No active amenity catalogue");

  const cacheKey = amenityResultCacheKey(active.id, lat, lng);
  const hit = await getCachedSafe<CachedNearbyAmenities>(cacheKey);
  if (hit && hit.datasetId === active.id) {
    // Warm path: skip ORS + PostGIS. Stale is recomputed at read time.
    return rehydrateCachedNearby(hit);
  }

  // Miss path: need the walk ring for spatial clip, then a pinned dataset read.
  const isochrone = await walkingIsochrone(latRaw, lngRaw);
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

  const sourceIso = summary.sourceTimestamp?.toISOString() ?? null;
  const payload: NearbyAmenitiesResult = {
    origin: { lat, lng },
    walkMinutes: WALK_CLIP_MINUTES,
    counts: summary.counts,
    amenities: summary.amenities,
    catalogue: {
      sourceTimestamp: sourceIso,
      stale: isCatalogueStale(summary.sourceTimestamp),
    },
  };

  // Only successful results are stored. Empty markers are legitimate hits.
  const body: CachedNearbyAmenities = {
    origin: payload.origin,
    walkMinutes: payload.walkMinutes,
    counts: payload.counts,
    amenities: payload.amenities,
    sourceTimestamp: sourceIso,
    datasetId: summary.datasetId,
  };
  await setCachedSafe(
    amenityResultCacheKey(summary.datasetId, lat, lng),
    body,
    new Date(Date.now() + AMENITY_RESULT_TTL_MS),
  );

  return payload;
}
