import { WALK_CLIP_MINUTES, type AmenityCounts } from "@/features/amenities/amenities";
import {
  queryCatalogueSummaryInRing,
  type CatalogueAmenity,
} from "@/features/amenities/server/catalogue-query";
import { withActiveDataset } from "@/features/amenities/server/catalogue-store";
import { walkingIsochrone } from "@/features/isochrones/server/ors";
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

export const CATALOGUE_STALE_AFTER_MS = 10 * 24 * 60 * 60 * 1_000;

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

/** Runtime discovery uses only ORS for the walking ring and local PostGIS. */
export async function nearbyAmenities(
  latRaw: number,
  lngRaw: number,
): Promise<NearbyAmenitiesResult> {
  const lat = Number(roundCoord(latRaw));
  const lng = Number(roundCoord(lngRaw));
  const isochrone = await walkingIsochrone(latRaw, lngRaw);
  const ring = isochrone.rings.find(({ minutes }) => minutes === WALK_CLIP_MINUTES);
  if (!ring?.geometry) {
    throw new ProviderError(`walk isochrone missing the ${WALK_CLIP_MINUTES}-min ring for clipping`);
  }

  let summary;
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
      return { ...result, sourceTimestamp: dataset.sourceTimestamp };
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new CatalogueUnavailableError("Amenity catalogue query failed", { cause: error });
  }
  if (!summary) throw new CatalogueUnavailableError("No active amenity catalogue");

  return {
    origin: { lat, lng },
    walkMinutes: WALK_CLIP_MINUTES,
    counts: summary.counts,
    amenities: summary.amenities,
    catalogue: {
      sourceTimestamp: summary.sourceTimestamp?.toISOString() ?? null,
      stale: isCatalogueStale(summary.sourceTimestamp),
    },
  };
}
