import {
  AMENITY_CATEGORIES,
  MAX_PER_CATEGORY,
  type Amenity,
  type AmenityCounts,
} from "@/features/amenities/amenities";
import type { Prisma } from "@/generated/prisma/client";

export interface CatalogueAmenity extends Amenity {
  id: string;
  distanceMeters: number;
}

type CatalogueRow = {
  id: string;
  name: string | null;
  category: Amenity["category"];
  sourceType: string;
  sourceId: bigint;
  lat: number;
  lng: number;
  distanceMeters: number;
};

type SummaryRow = CatalogueRow & { categoryTotal: number };

export type CatalogueRingSummary = {
  counts: AmenityCounts;
  amenities: CatalogueAmenity[];
};

function mapRow(row: CatalogueRow): CatalogueAmenity {
  return {
    id: row.id,
    lat: row.lat,
    lng: row.lng,
    name: row.name ?? "",
    category: row.category,
    osmType: row.sourceType,
    osmId: Number(row.sourceId),
    distanceMeters: row.distanceMeters,
  };
}

/**
 * One SQL snapshot produces both pre-cap category totals and nearest markers.
 * This is the sole runtime clip path: it intersects each stored geometry with
 * the server-owned walking ring, derives an in-ring display point, measures
 * geographic distance from it, and caps per category. Because production and
 * the boundary-clipping test both call it, a regression in the display-point
 * derivation cannot ship green.
 */
export async function queryCatalogueSummaryInRing(
  tx: Prisma.TransactionClient,
  datasetId: string,
  ring: GeoJSON.Geometry,
  origin: { lat: number; lng: number },
): Promise<CatalogueRingSummary> {
  if (ring.type !== "Polygon" && ring.type !== "MultiPolygon") {
    throw new TypeError("Amenity ring must be a Polygon or MultiPolygon");
  }

  const rows = await tx.$queryRaw<SummaryRow[]>`
    WITH params AS (
      SELECT
        ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(ring)}), 4326) AS ring,
        ST_SetSRID(ST_Point(${origin.lng}, ${origin.lat}), 4326) AS origin
    ), intersections AS (
      SELECT
        place.id,
        place.name,
        place.category,
        place."sourceType",
        place."sourceId",
        params.ring,
        params.origin,
        ST_Intersection(place.geom, params.ring) AS clipped
      FROM "osm_catalogue"."AmenityPlace" AS place
      CROSS JOIN params
      WHERE place."datasetId" = ${datasetId}
        AND ST_Intersects(place.geom, params.ring)
    ), display_points AS (
      SELECT intersections.*, ST_PointOnSurface(clipped) AS display_point
      FROM intersections
      WHERE NOT ST_IsEmpty(clipped)
    ), measured AS (
      SELECT
        id,
        name,
        category,
        "sourceType",
        "sourceId",
        ST_Y(display_point)::double precision AS lat,
        ST_X(display_point)::double precision AS lng,
        ST_Distance(display_point::geography, origin::geography)::double precision AS distance
      FROM display_points
      WHERE ST_Covers(ring, display_point)
    ), ranked AS (
      SELECT
        measured.*,
        COUNT(*) OVER (PARTITION BY category)::integer AS category_total,
        ROW_NUMBER() OVER (PARTITION BY category ORDER BY distance, id) AS category_rank
      FROM measured
    )
    SELECT
      id,
      name,
      category,
      "sourceType",
      "sourceId",
      lat,
      lng,
      distance AS "distanceMeters",
      category_total AS "categoryTotal"
    FROM ranked
    WHERE category_rank <= ${MAX_PER_CATEGORY}
    ORDER BY distance, category, id
  `;

  const counts = Object.fromEntries(
    AMENITY_CATEGORIES.map(({ key }) => [key, 0]),
  ) as AmenityCounts;
  for (const row of rows) counts[row.category] = row.categoryTotal;
  return { counts, amenities: rows.map(mapRow) };
}
