import { withActiveDataset } from "@/features/amenities/server/catalogue-store";

export const CATALOGUE_EXPORT_MAX_PAGE_SIZE = 1000;

type ExportRow = {
  canonicalId: string;
  sourceType: string;
  sourceId: bigint;
  category: string;
  name: string | null;
  accessState: string;
  qualityState: string;
  sourceTags: unknown;
  sourceUpdatedAt: Date | null;
  geometry: string;
};

export interface CatalogueExportFeature {
  type: "Feature";
  id: string;
  geometry: GeoJSON.Geometry;
  properties: {
    sourceType: string;
    sourceId: string;
    category: string;
    name: string | null;
    accessState: string;
    qualityState: string;
    sourceTags: unknown;
    sourceUpdatedAt: string | null;
  };
}

export interface CatalogueExportPage {
  type: "FeatureCollection";
  features: CatalogueExportFeature[];
  nextCursor: string | null;
  catalogue: {
    sourceVersion: string;
    sourceTimestamp: string | null;
    sourceChecksum: string;
  };
  license: {
    name: "Open Database License (ODbL) 1.0";
    attribution: "© OpenStreetMap contributors";
    url: "https://www.openstreetmap.org/copyright";
  };
}

export async function exportCataloguePage(
  after: string | null,
  limit: number,
): Promise<CatalogueExportPage | null> {
  return withActiveDataset(async (tx, datasetId) => {
    const [dataset, rows] = await Promise.all([
      tx.amenityDataset.findUniqueOrThrow({
        where: { id: datasetId },
        select: { sourceVersion: true, sourceTimestamp: true, sourceChecksum: true },
      }),
      tx.$queryRaw<ExportRow[]>`
        SELECT
          "canonicalId",
          "sourceType",
          "sourceId",
          category,
          name,
          "accessState",
          "qualityState",
          "sourceTags",
          "sourceUpdatedAt",
          ST_AsGeoJSON(geom) AS geometry
        FROM "osm_catalogue"."AmenityPlace"
        WHERE "datasetId" = ${datasetId}
          AND (${after}::text IS NULL OR "canonicalId" > ${after})
        ORDER BY "canonicalId"
        LIMIT ${limit}
      `,
    ]);

    // Expose canonicalId (public OSM identity, e.g. "relation/302"), never the
    // internal "<datasetUuid>:<canonicalId>" primary key. canonicalId is unique
    // within a dataset, so it is a stable, leak-free pagination cursor — and,
    // unlike the UUID-prefixed key, a cursor stays valid if a publish swaps the
    // active dataset mid-pagination.
    const features: CatalogueExportFeature[] = rows.map((row) => ({
      type: "Feature",
      id: row.canonicalId,
      geometry: JSON.parse(row.geometry) as GeoJSON.Geometry,
      properties: {
        sourceType: row.sourceType,
        sourceId: row.sourceId.toString(),
        category: row.category,
        name: row.name,
        accessState: row.accessState,
        qualityState: row.qualityState,
        sourceTags: row.sourceTags,
        sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
      },
    }));

    return {
      type: "FeatureCollection",
      features,
      nextCursor: rows.length === limit ? rows.at(-1)?.canonicalId ?? null : null,
      catalogue: {
        sourceVersion: dataset.sourceVersion,
        sourceTimestamp: dataset.sourceTimestamp?.toISOString() ?? null,
        sourceChecksum: dataset.sourceChecksum,
      },
      license: {
        name: "Open Database License (ODbL) 1.0",
        attribution: "© OpenStreetMap contributors",
        url: "https://www.openstreetmap.org/copyright",
      },
    };
  });
}
