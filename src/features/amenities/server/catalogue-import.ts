import { createHash, randomUUID } from "node:crypto";

import { Client } from "pg";

import { AMENITY_CATEGORIES, type AmenityCategoryKey } from "@/features/amenities/amenities";
import {
  type BulkOverpassBody,
  type BulkOverpassSnapshot,
  buildBulkOverpassQuery,
  fetchBulkOverpass,
} from "@/features/amenities/server/bulk-overpass";
import {
  type CatalogueDropReason,
  type CatalogueOverrides,
  type NormalizedCataloguePlace,
  normalizeCatalogueElement,
} from "@/features/amenities/server/catalogue-normalize";
import { publishDataset } from "@/features/amenities/server/catalogue-store";
import { BUCHAREST_BBOX } from "@/lib/bounds";
import { db, poolConfig } from "@/lib/db";
import { serverEnv } from "@/lib/env";

const IMPORT_LOCK_KEY = 2_026_072_002;
const INSERT_BATCH_SIZE = 250;
export const CATALOGUE_PIPELINE_VERSION = 2;

/**
 * Live OSM routinely contains a few multipolygons whose rings will not build a
 * valid area; those individual features are dropped and counted, but the weekly
 * refresh still publishes as long as unbuildable features stay under this
 * fraction of the staged set. Above it we assume systemic corruption (or a
 * parser/geometry regression) and fail closed, retaining the last good dataset.
 */
export const MAX_UNBUILDABLE_RATIO = 0.01;

export type CategoryCounts = Record<AmenityCategoryKey, number>;

export type CatalogueValidation = {
  categoryCounts: CategoryCounts;
  dropped: Partial<
    Record<
      | CatalogueDropReason
      | "duplicate_identity"
      | "park_duplicate"
      | "unbuildable_geometry",
      number
    >
  >;
  invalidGeometryCount: number;
  outsideBoundsCount: number;
  source: {
    endpoint: string;
    payloadBytes: number;
    queryChecksum: string;
    overridesChecksum: string;
    overridesVersion: number;
    pipelineVersion: number;
    bbox: typeof BUCHAREST_BBOX;
  };
};

export type CatalogueImportResult = {
  runId: string;
  datasetId: string;
  checksum: string;
  sourceVersion: string;
  sourceTimestamp: string | null;
  rawElementCount: number;
  placeCount: number;
  validation: CatalogueValidation;
  unchanged: boolean;
};

export class CatalogueImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogueImportError";
  }
}

function emptyCategoryCounts(): CategoryCounts {
  return Object.fromEntries(AMENITY_CATEGORIES.map(({ key }) => [key, 0])) as CategoryCounts;
}

function parseSourceTimestamp(body: BulkOverpassBody): Date | null {
  const value = body.osm3s?.timestamp_osm_base;
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new CatalogueImportError("OSM source timestamp is invalid");
  }
  return parsed;
}

function validationCounts(value: unknown): CategoryCounts | null {
  if (!value || typeof value !== "object" || !("categoryCounts" in value)) return null;
  const candidate = (value as { categoryCounts?: unknown }).categoryCounts;
  if (!candidate || typeof candidate !== "object") return null;
  const counts = emptyCategoryCounts();
  for (const { key } of AMENITY_CATEGORIES) {
    const count = (candidate as Record<string, unknown>)[key];
    if (!Number.isSafeInteger(count) || Number(count) < 0) return null;
    counts[key] = Number(count);
  }
  return counts;
}

function validationPipelineVersion(value: unknown): number | null {
  if (!value || typeof value !== "object" || !("source" in value)) return null;
  const source = (value as { source?: unknown }).source;
  if (!source || typeof source !== "object" || !("pipelineVersion" in source)) return null;
  const version = (source as { pipelineVersion?: unknown }).pipelineVersion;
  return Number.isSafeInteger(version) ? Number(version) : null;
}

function validationOverridesChecksum(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("source" in value)) return null;
  const source = (value as { source?: unknown }).source;
  if (!source || typeof source !== "object" || !("overridesChecksum" in source)) return null;
  const checksum = (source as { overridesChecksum?: unknown }).overridesChecksum;
  return typeof checksum === "string" ? checksum : null;
}

export function validateCategoryDeltas(
  previous: CategoryCounts | null,
  current: CategoryCounts,
): void {
  for (const { key } of AMENITY_CATEGORIES) {
    if (current[key] <= 0) {
      throw new CatalogueImportError(`Category ${key} is empty`);
    }
    const before = previous?.[key];
    if (before === undefined || before < 10) continue;
    if (current[key] < Math.floor(before * 0.5)) {
      throw new CatalogueImportError(
        `Category ${key} dropped from ${before} to ${current[key]} (more than 50%)`,
      );
    }
    if (current[key] > Math.ceil(before * 3)) {
      throw new CatalogueImportError(
        `Category ${key} grew from ${before} to ${current[key]} (more than 3x)`,
      );
    }
  }
}

function normalizeElements(
  body: BulkOverpassBody,
  overrides: CatalogueOverrides,
): {
  places: NormalizedCataloguePlace[];
  counts: CategoryCounts;
  dropped: CatalogueValidation["dropped"];
} {
  if (overrides.version !== 1 || !Array.isArray(overrides.suppress)) {
    throw new CatalogueImportError("Amenity overrides must use schema version 1");
  }
  if (!Array.isArray(body.elements) || body.elements.length === 0) {
    throw new CatalogueImportError("OSM snapshot contains no elements");
  }

  const suppressed = new Set(overrides.suppress);
  const seen = new Set<string>();
  const places: NormalizedCataloguePlace[] = [];
  const counts = emptyCategoryCounts();
  const dropped: CatalogueValidation["dropped"] = {};
  const drop = (reason: CatalogueDropReason | "duplicate_identity") => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };

  for (const element of body.elements) {
    const normalized = normalizeCatalogueElement(element, suppressed);
    if (!normalized.place) {
      drop(normalized.dropReason);
      continue;
    }
    const identity = normalized.place.canonicalId;
    if (seen.has(identity)) {
      drop("duplicate_identity");
      continue;
    }
    seen.add(identity);
    places.push(normalized.place);
    counts[normalized.place.category] += 1;
  }

  return { places, counts, dropped };
}

type InsertPlace = ReturnType<typeof serializePlace>;

function serializePlace(datasetId: string, place: NormalizedCataloguePlace) {
  return {
    id: `${datasetId}:${place.canonicalId}`,
    datasetId,
    sourceType: place.sourceType,
    sourceId: String(place.sourceId),
    canonicalId: place.canonicalId,
    category: place.category,
    name: place.name,
    normalizedName: place.normalizedName,
    accessState: place.accessState,
    qualityState: place.qualityState,
    sourceTags: place.sourceTags,
    sourceUpdatedAt: place.sourceUpdatedAt?.toISOString() ?? null,
    geometry: place.geometry,
    buildArea: place.buildArea,
  };
}

async function insertBatch(batch: InsertPlace[]): Promise<number> {
  const inserted = await db().$queryRaw<Array<{ id: string }>>`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS x(
        "id" text,
        "datasetId" text,
        "sourceType" text,
        "sourceId" text,
        "canonicalId" text,
        "category" text,
        "name" text,
        "normalizedName" text,
        "accessState" text,
        "qualityState" text,
        "sourceTags" jsonb,
        "sourceUpdatedAt" text,
        "geometry" jsonb,
        "buildArea" boolean
      )
    ), parsed AS (
      SELECT input.*,
        ST_SetSRID(ST_GeomFromGeoJSON("geometry"::text), 4326) AS raw_geom
      FROM input
    ), shaped AS (
      SELECT parsed.*,
        CASE
          WHEN "buildArea" THEN ST_BuildArea(ST_UnaryUnion(raw_geom))
          ELSE raw_geom
        END AS shaped_geom
      FROM parsed
    ), valid AS (
      SELECT shaped.*, ST_Force2D(ST_MakeValid(shaped_geom)) AS final_geom
      FROM shaped
      WHERE shaped_geom IS NOT NULL AND NOT ST_IsEmpty(shaped_geom)
    )
    INSERT INTO "osm_catalogue"."AmenityPlace" (
      "id", "datasetId", "sourceType", "sourceId", "canonicalId", "category",
      "name", "normalizedName", "accessState", "qualityState", "sourceTags",
      "representativePoint", "geom", "sourceUpdatedAt"
    )
    SELECT
      "id", "datasetId", "sourceType", "sourceId"::bigint, "canonicalId", "category",
      "name", "normalizedName", "accessState", "qualityState", "sourceTags",
      ST_PointOnSurface(final_geom), final_geom, "sourceUpdatedAt"::timestamp
    FROM valid
    WHERE NOT ST_IsEmpty(final_geom)
    RETURNING "id"
  `;
  return inserted.length;
}

/**
 * Conservative park canonicalization. It only merges representations which
 * have the same normalized name and physically contain/overlap one another;
 * proximity alone never merges polygons, so separate same-name parks survive.
 */
export async function deduplicateParks(datasetId: string): Promise<number> {
  const containedNodes = await db().$queryRaw<Array<{ id: string }>>`
    DELETE FROM "osm_catalogue"."AmenityPlace" AS node
    USING "osm_catalogue"."AmenityPlace" AS area
    WHERE node."datasetId" = ${datasetId}
      AND area."datasetId" = node."datasetId"
      AND node.category = 'parks'
      AND area.category = 'parks'
      AND node."sourceType" = 'node'
      AND area."sourceType" IN ('way', 'relation')
      AND ST_Dimension(area.geom) = 2
      AND ST_Covers(area.geom, node.geom)
      AND (
        node."normalizedName" IS NULL
        OR node."normalizedName" = area."normalizedName"
      )
    RETURNING node.id
  `;

  const overlappingAreas = await db().$queryRaw<Array<{ id: string }>>`
    DELETE FROM "osm_catalogue"."AmenityPlace" AS candidate
    USING "osm_catalogue"."AmenityPlace" AS preferred
    WHERE candidate."datasetId" = ${datasetId}
      AND preferred."datasetId" = candidate."datasetId"
      AND candidate.id <> preferred.id
      AND candidate.category = 'parks'
      AND preferred.category = 'parks'
      AND candidate."normalizedName" IS NOT NULL
      AND candidate."normalizedName" = preferred."normalizedName"
      AND ST_Dimension(candidate.geom) = 2
      AND ST_Dimension(preferred.geom) = 2
      AND ST_Intersects(candidate.geom, preferred.geom)
      AND ST_Area(ST_Intersection(candidate.geom, preferred.geom)::geography)
          / NULLIF(
              LEAST(
                ST_Area(candidate.geom::geography),
                ST_Area(preferred.geom::geography)
              ),
              0
            ) >= 0.6
      AND (
        CASE preferred."sourceType"
          WHEN 'relation' THEN 3 WHEN 'way' THEN 2 ELSE 1
        END
        > CASE candidate."sourceType"
            WHEN 'relation' THEN 3 WHEN 'way' THEN 2 ELSE 1
          END
        OR (
          preferred."sourceType" = candidate."sourceType"
          AND preferred."sourceId" < candidate."sourceId"
        )
      )
    RETURNING candidate.id
  `;

  const nearbyPoints = await db().$queryRaw<Array<{ id: string }>>`
    DELETE FROM "osm_catalogue"."AmenityPlace" AS candidate
    USING "osm_catalogue"."AmenityPlace" AS preferred
    WHERE candidate."datasetId" = ${datasetId}
      AND preferred."datasetId" = candidate."datasetId"
      AND candidate.category = 'parks'
      AND preferred.category = 'parks'
      AND candidate."sourceType" = 'node'
      AND preferred."sourceType" = 'node'
      AND candidate."normalizedName" IS NOT NULL
      AND candidate."normalizedName" = preferred."normalizedName"
      AND candidate."sourceId" > preferred."sourceId"
      AND ST_DWithin(
        candidate."representativePoint"::geography,
        preferred."representativePoint"::geography,
        10
      )
    RETURNING candidate.id
  `;

  return containedNodes.length + overlappingAreas.length + nearbyPoints.length;
}

async function databaseValidation(datasetId: string): Promise<{
  placeCount: number;
  invalidGeometryCount: number;
  outsideBoundsCount: number;
  categoryCounts: CategoryCounts;
}> {
  const { minLng, minLat, maxLng, maxLat } = BUCHAREST_BBOX;
  const rows = await db().$queryRaw<
    Array<{ placeCount: number; invalidGeometryCount: number; outsideBoundsCount: number }>
  >`
    SELECT
      COUNT(*)::integer AS "placeCount",
      COUNT(*) FILTER (WHERE NOT ST_IsValid("geom"))::integer AS "invalidGeometryCount",
      COUNT(*) FILTER (
        WHERE NOT ST_Intersects(
          "geom",
          ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)
        )
      )::integer AS "outsideBoundsCount"
    FROM "osm_catalogue"."AmenityPlace"
    WHERE "datasetId" = ${datasetId}
  `;
  const categories = await db().$queryRaw<Array<{ category: AmenityCategoryKey; count: number }>>`
    SELECT category, COUNT(*)::integer AS count
    FROM "osm_catalogue"."AmenityPlace"
    WHERE "datasetId" = ${datasetId}
    GROUP BY category
  `;
  const categoryCounts = emptyCategoryCounts();
  for (const row of categories) categoryCounts[row.category] = row.count;
  return {
    ...(rows[0] ?? { placeCount: 0, invalidGeometryCount: 0, outsideBoundsCount: 0 }),
    categoryCounts,
  };
}

function checksumBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checksumText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "unknown";
  }
}

export async function importCatalogueSnapshot(
  snapshot: BulkOverpassSnapshot,
  overrides: CatalogueOverrides,
): Promise<CatalogueImportResult> {
  const checksum = checksumBytes(snapshot.bytes);
  const overridesChecksum = checksumText(JSON.stringify(overrides));
  const sourceTimestamp = parseSourceTimestamp(snapshot.body);
  const sourceVersion = sourceTimestamp?.toISOString() ?? `checksum:${checksum.slice(0, 16)}`;
  const active = await db().amenityDataset.findUnique({
    where: { activeKey: 1 },
    include: { importRun: true },
  });

  // Idempotent only when the source bytes, the transformation pipeline, AND the
  // override list are all unchanged. Comparing overrides here means editing
  // scripts/amenities/overrides.json (e.g. a new manual suppression) forces a
  // reprocess even against byte-identical OSM, instead of silently deferring
  // until next week's snapshot happens to differ.
  if (
    active?.sourceChecksum === checksum &&
    validationPipelineVersion(active.validation) === CATALOGUE_PIPELINE_VERSION &&
    validationOverridesChecksum(active.validation) === overridesChecksum
  ) {
    return {
      runId: active.importRunId,
      datasetId: active.id,
      checksum,
      sourceVersion,
      sourceTimestamp: sourceTimestamp?.toISOString() ?? null,
      rawElementCount: active.importRun.rawElementCount ?? active.placeCount,
      placeCount: active.placeCount,
      validation: active.validation as CatalogueValidation,
      unchanged: true,
    };
  }

  const normalized = normalizeElements(snapshot.body, overrides);
  const previousCounts = validationCounts(active?.validation);

  const runId = randomUUID();
  const datasetId = randomUUID();
  const rawElementCount = snapshot.body.elements?.length ?? 0;
  await db().amenityImportRun.create({
    data: {
      id: runId,
      status: "running",
      source: "overpass",
      sourceTimestamp,
      sourceVersion,
      sourceChecksum: checksum,
      rawElementCount,
    },
  });

  try {
    await db().amenityDataset.create({
      data: {
        id: datasetId,
        importRunId: runId,
        sourceTimestamp,
        sourceVersion,
        sourceChecksum: checksum,
        placeCount: normalized.places.length,
        validationPassed: false,
        validation: {},
      },
    });

    let insertedCount = 0;
    for (let offset = 0; offset < normalized.places.length; offset += INSERT_BATCH_SIZE) {
      const batch = normalized.places
        .slice(offset, offset + INSERT_BATCH_SIZE)
        .map((place) => serializePlace(datasetId, place));
      insertedCount += await insertBatch(batch);
    }
    // insertBatch drops any feature whose geometry cannot build a valid,
    // non-empty area. A handful is normal for a city-scale OSM extract, so
    // tolerate them below MAX_UNBUILDABLE_RATIO; only a large gap (systemic
    // corruption or a regression) aborts the refresh and keeps the last good
    // dataset.
    const unbuildableCount = normalized.places.length - insertedCount;
    if (unbuildableCount < 0) {
      throw new CatalogueImportError(
        `Geometry insertion overflow: staged ${normalized.places.length}, inserted ${insertedCount}`,
      );
    }
    if (
      unbuildableCount > 0 &&
      unbuildableCount / normalized.places.length > MAX_UNBUILDABLE_RATIO
    ) {
      throw new CatalogueImportError(
        `Too many unbuildable geometries: ${unbuildableCount} of ${normalized.places.length} exceeds the ${Math.round(MAX_UNBUILDABLE_RATIO * 100)}% tolerance`,
      );
    }
    if (unbuildableCount > 0) normalized.dropped.unbuildable_geometry = unbuildableCount;

    const parkDuplicateCount = await deduplicateParks(datasetId);

    const database = await databaseValidation(datasetId);
    if (
      database.placeCount !== insertedCount - parkDuplicateCount ||
      database.invalidGeometryCount !== 0 ||
      database.outsideBoundsCount !== 0
    ) {
      throw new CatalogueImportError(
        `Database validation failed: ${JSON.stringify(database)}`,
      );
    }
    validateCategoryDeltas(previousCounts, database.categoryCounts);

    if (parkDuplicateCount > 0) normalized.dropped.park_duplicate = parkDuplicateCount;

    const validation: CatalogueValidation = {
      categoryCounts: database.categoryCounts,
      dropped: normalized.dropped,
      invalidGeometryCount: database.invalidGeometryCount,
      outsideBoundsCount: database.outsideBoundsCount,
      source: {
        endpoint: safeEndpoint(snapshot.endpoint),
        payloadBytes: snapshot.bytes.byteLength,
        queryChecksum: checksumText(buildBulkOverpassQuery()),
        overridesChecksum,
        overridesVersion: overrides.version,
        pipelineVersion: CATALOGUE_PIPELINE_VERSION,
        bbox: BUCHAREST_BBOX,
      },
    };
    const finishedAt = new Date();
    await db().$transaction([
      db().amenityDataset.update({
        where: { id: datasetId },
        data: { placeCount: database.placeCount, validationPassed: true, validation },
      }),
      db().amenityImportRun.update({
        where: { id: runId },
        data: {
          status: "validated",
          finishedAt,
          acceptedPlaceCount: database.placeCount,
          rejectedElementCount: rawElementCount - database.placeCount,
          validation,
        },
      }),
    ]);
    await publishDataset(datasetId);

    return {
      runId,
      datasetId,
      checksum,
      sourceVersion,
      sourceTimestamp: sourceTimestamp?.toISOString() ?? null,
      rawElementCount,
      placeCount: database.placeCount,
      validation,
      unchanged: false,
    };
  } catch (error) {
    await db().amenityDataset.deleteMany({ where: { id: datasetId } });
    await db().amenityImportRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        failedAt: new Date(),
        finishedAt: new Date(),
        failureMessage: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      },
    });
    throw error;
  }
}

async function withImportLock<T>(work: () => Promise<T>): Promise<T> {
  const config = poolConfig(serverEnv().databaseUrl);
  const client = new Client({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    statement_timeout: config.statement_timeout,
    application_name: "howfar-amenity-import",
  });
  await client.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [IMPORT_LOCK_KEY],
    );
    if (!result.rows[0]?.locked) {
      throw new CatalogueImportError("Another amenity import is already running");
    }
    try {
      return await work();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [IMPORT_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

export async function refreshAmenityCatalogue(
  overrides: CatalogueOverrides,
  fetchSnapshot: () => Promise<BulkOverpassSnapshot> = fetchBulkOverpass,
): Promise<CatalogueImportResult> {
  return withImportLock(async () => importCatalogueSnapshot(await fetchSnapshot(), overrides));
}
