import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { walkingIsochrone } = vi.hoisted(() => ({ walkingIsochrone: vi.fn() }));
vi.mock("@/features/isochrones/server/ors", () => ({ walkingIsochrone }));

import type { BulkOverpassBody, BulkOverpassSnapshot } from "./bulk-overpass";
import {
  CatalogueImportError,
  importCatalogueSnapshot,
  refreshAmenityCatalogue,
} from "./catalogue-import";
import type { CatalogueOverrides } from "./catalogue-normalize";
import { nearbyAmenities } from "./catalogue";
import { exportCataloguePage } from "./catalogue-export";
import { queryCatalogueSummaryInRing } from "./catalogue-query";
import { withActiveDataset } from "./catalogue-store";
import { db } from "@/lib/db";

const describePostgres = process.env.POSTGIS_INTEGRATION === "1" ? describe : describe.skip;
const fixturePath = path.resolve("scripts/amenities/fixtures/catalogue-overpass.json");
const fixtureBody = JSON.parse(readFileSync(fixturePath, "utf8")) as BulkOverpassBody;
const overrides: CatalogueOverrides = { version: 1, suppress: ["node/8"] };

function bodyAt(timestamp: string): BulkOverpassBody {
  const body = structuredClone(fixtureBody);
  body.osm3s = { ...body.osm3s, timestamp_osm_base: timestamp };
  return body;
}

function snapshot(body: BulkOverpassBody): BulkOverpassSnapshot {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return { body, bytes, endpoint: "fixture://catalogue" };
}

describePostgres("deterministic amenity catalogue import", () => {
  let priorActiveDatasetId: string | undefined;

  async function cleanFixtureRows() {
    await db().amenityDataset.deleteMany({ where: { sourceVersion: { startsWith: "2099-" } } });
    await db().amenityImportRun.deleteMany({ where: { sourceVersion: { startsWith: "2099-" } } });
  }

  beforeAll(async () => {
    const prior = await db().amenityDataset.findUnique({
      where: { activeKey: 1 },
      select: { id: true },
    });
    priorActiveDatasetId = prior?.id;
    if (priorActiveDatasetId) {
      await db().amenityDataset.update({
        where: { id: priorActiveDatasetId },
        data: { activeKey: null },
      });
    }
  });
  beforeEach(cleanFixtureRows);
  afterAll(async () => {
    await cleanFixtureRows();
    if (priorActiveDatasetId) {
      await db().amenityDataset.updateMany({
        where: { id: priorActiveDatasetId },
        data: { activeKey: 1 },
      });
    }
    await db().$disconnect();
  });

  it("imports, validates and publishes the quality-filtered geometry fixture idempotently", async () => {
    const body = bodyAt("2099-01-01T00:00:00Z");
    const first = await importCatalogueSnapshot(snapshot(body), overrides);

    expect(first).toMatchObject({
      rawElementCount: 14,
      placeCount: 7,
      unchanged: false,
      validation: {
        categoryCounts: {
          groceries: 1,
          pharmacies: 1,
          parks: 3,
          schools: 1,
          transit: 1,
        },
        invalidGeometryCount: 0,
        outsideBoundsCount: 0,
      },
    });
    expect(first.validation.dropped).toMatchObject({
      lifecycle: 1,
      unnamed_garden: 1,
      private_park: 1,
      outside_bounds: 1,
      manual_suppression: 1,
      park_duplicate: 2,
    });

    const geometry = await db().$queryRaw<Array<{ canonicalId: string; geometryType: string }>>`
      SELECT "canonicalId", GeometryType("geom") AS "geometryType"
      FROM "osm_catalogue"."AmenityPlace"
      WHERE "datasetId" = ${first.datasetId}
      ORDER BY "canonicalId"
    `;
    expect(geometry).toEqual(
      expect.arrayContaining([
        { canonicalId: "node/1", geometryType: "POINT" },
        { canonicalId: "way/101", geometryType: "POLYGON" },
        { canonicalId: "relation/301", geometryType: "POLYGON" },
        { canonicalId: "relation/302", geometryType: "POLYGON" },
        { canonicalId: "way/103", geometryType: "POLYGON" },
      ]),
    );
    expect(geometry.map(({ canonicalId }) => canonicalId)).not.toEqual(
      expect.arrayContaining(["node/9", "way/102"]),
    );
    const boundaryRepresentations = await db().amenityPlace.count({
      where: { datasetId: first.datasetId, normalizedName: "boundary park" },
    });
    expect(boundaryRepresentations).toBe(2); // overlapping duplicate merged; separate park preserved

    const ring: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [26.1, 44.422],
          [26.115, 44.422],
          [26.115, 44.432],
          [26.1, 44.432],
          [26.1, 44.422],
        ],
      ],
    };
    const origin = { lat: 44.425, lng: 26.105 };
    // Clip through the SAME query production uses. The ring's east edge
    // (26.115) cuts relation/302 (centroid east of it, asserted below), so a
    // regression in display-point derivation would move the marker out of the
    // ring and fail here.
    const inRing = await withActiveDataset((tx, datasetId) =>
      queryCatalogueSummaryInRing(tx, datasetId, ring, origin),
    );
    const boundary = inRing?.amenities.find(({ name }) => name === "Boundary Park");
    expect(boundary).toMatchObject({ osmType: "relation", osmId: 302 });
    expect(boundary!.lng).toBeLessThanOrEqual(26.115);
    expect(boundary!.lng).toBeGreaterThanOrEqual(26.1);
    expect(boundary!.lat).toBeGreaterThanOrEqual(44.422);
    expect(boundary!.lat).toBeLessThanOrEqual(44.432);

    const centre = await db().$queryRaw<Array<{ lng: number }>>`
      SELECT ST_X(ST_Centroid(geom))::double precision AS lng
      FROM "osm_catalogue"."AmenityPlace"
      WHERE "datasetId" = ${first.datasetId} AND "canonicalId" = 'relation/302'
    `;
    expect(centre[0]!.lng).toBeGreaterThan(26.115);
    expect(boundary!.distanceMeters).toBeCloseTo(haversineMeters(origin, boundary!), -1);

    const fullRing: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [25.8, 44.2],
          [26.4, 44.2],
          [26.4, 44.7],
          [25.8, 44.7],
          [25.8, 44.2],
        ],
      ],
    };
    walkingIsochrone.mockResolvedValue({
      origin,
      rings: [{ minutes: 15, geometry: fullRing }],
    });
    await expect(nearbyAmenities(origin.lat, origin.lng)).resolves.toMatchObject({
      walkMinutes: 15,
      counts: { groceries: 1, pharmacies: 1, parks: 3, schools: 1, transit: 1 },
    });

    const exported = await exportCataloguePage(null, 100);
    const boundaryFeature = exported?.features.find(
      ({ properties }) => properties.name === "Boundary Park",
    );
    expect(boundaryFeature).toMatchObject({
      properties: { category: "parks", sourceType: "relation" },
    });
    // The feature id is public OSM identity, never the internal UUID key.
    expect(boundaryFeature?.id).toBe("relation/302");
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain("datasetId");
    // The active dataset's UUID must never appear anywhere in the export.
    expect(serialized).not.toContain(first.datasetId);

    const second = await importCatalogueSnapshot(snapshot(body), overrides);
    expect(second).toMatchObject({ datasetId: first.datasetId, unchanged: true });
    await expect(
      db().amenityDataset.count({ where: { sourceVersion: first.sourceVersion } }),
    ).resolves.toBe(1);

    // Editing overrides must force a reprocess even against byte-identical OSM.
    // A no-op extra suppression changes the overrides checksum without altering
    // any category count, so it reprocesses cleanly and republishes.
    const editedOverrides: CatalogueOverrides = {
      version: 1,
      suppress: [...overrides.suppress, "node/999999"],
    };
    const third = await importCatalogueSnapshot(snapshot(body), editedOverrides);
    expect(third.unchanged).toBe(false);
    expect(third.datasetId).not.toBe(first.datasetId);
    await expect(
      db().amenityDataset.findUnique({ where: { activeKey: 1 } }),
    ).resolves.toMatchObject({ id: third.datasetId });
  });

  it("cannot replace the last good version with empty or unbuildable geometry", async () => {
    const good = await importCatalogueSnapshot(
      snapshot(bodyAt("2099-02-01T00:00:00Z")),
      overrides,
    );

    await expect(
      importCatalogueSnapshot(
        snapshot({ ...bodyAt("2099-02-02T00:00:00Z"), elements: [] }),
        overrides,
      ),
    ).rejects.toThrow(/no elements/);

    const broken = bodyAt("2099-02-03T00:00:00Z");
    const relation = broken.elements?.find(
      (element) => element.type === "relation" && element.id === 301,
    );
    if (relation?.members?.[0]) {
      relation.members[0].geometry = [
        { lat: 44.418, lon: 26.098 },
        { lat: 44.419, lon: 26.099 },
      ];
    }
    // One unbuildable feature out of seven is 14% — far above the tolerated
    // fraction — so the whole refresh still fails closed and keeps last-good.
    await expect(importCatalogueSnapshot(snapshot(broken), overrides)).rejects.toThrow(
      /Too many unbuildable geometries/,
    );

    await expect(db().amenityDataset.findUnique({ where: { activeKey: 1 } })).resolves.toMatchObject({
      id: good.datasetId,
    });
    const failed = await db().amenityImportRun.findFirstOrThrow({
      where: { sourceVersion: "2099-02-03T00:00:00.000Z" },
    });
    expect(failed).toMatchObject({ status: "failed" });
    await expect(
      db().amenityDataset.count({ where: { importRunId: failed.id } }),
    ).resolves.toBe(0);
  });

  it("rejects a concurrent refresh and releases the job lock afterward", async () => {
    const body = bodyAt("2099-03-01T00:00:00Z");
    const nextSnapshot = snapshot(body);
    let releaseFetch!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const first = refreshAmenityCatalogue(overrides, async () => {
      markStarted();
      await released;
      return nextSnapshot;
    });
    await started;

    await expect(
      refreshAmenityCatalogue(overrides, async () => nextSnapshot),
    ).rejects.toBeInstanceOf(CatalogueImportError);
    releaseFetch();
    const published = await first;

    await expect(
      refreshAmenityCatalogue(overrides, async () => nextSnapshot),
    ).resolves.toMatchObject({ datasetId: published.datasetId, unchanged: true });
  });

  it("tolerates a few unbuildable features and still publishes the rest", async () => {
    const body = bodyAt("2099-05-01T00:00:00Z");
    const elements = body.elements ?? [];
    // 160 valid stops make one broken multipolygon <1% of the staged set.
    for (let index = 0; index < 160; index += 1) {
      elements.push({
        type: "node",
        id: 60_000 + index,
        lat: 44.43 + index / 1_000_000,
        lon: 26.1 + index / 1_000_000,
        tags: { highway: "bus_stop", name: `Tolerant Stop ${index}` },
      });
    }
    const relation = elements.find(
      (element) => element.type === "relation" && element.id === 301,
    );
    if (relation?.members?.[0]) {
      relation.members[0].geometry = [
        { lat: 44.418, lon: 26.098 },
        { lat: 44.419, lon: 26.099 },
      ];
    }

    const imported = await importCatalogueSnapshot(snapshot(body), overrides);
    expect(imported.unchanged).toBe(false);
    expect(imported.validation.dropped.unbuildable_geometry).toBe(1);
    expect(imported.validation.categoryCounts.transit).toBe(161);
    expect(imported.validation.invalidGeometryCount).toBe(0);
    await expect(
      db().amenityDataset.findUnique({ where: { activeKey: 1 } }),
    ).resolves.toMatchObject({ id: imported.datasetId });
  });

  it("derives true pre-cap counts and nearest markers from one database query", async () => {
    const body = bodyAt("2099-04-01T00:00:00Z");
    const elements = body.elements ?? [];
    for (let index = 0; index < 160; index += 1) {
      elements.push({
        type: "node",
        id: 50_000 + index,
        lat: 44.43 + index / 1_000_000,
        lon: 26.1 + index / 1_000_000,
        tags: { highway: "bus_stop", name: `Extra Stop ${index}` },
      });
    }
    const imported = await importCatalogueSnapshot(snapshot(body), overrides);
    const fullRing: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [25.8, 44.2],
          [26.4, 44.2],
          [26.4, 44.7],
          [25.8, 44.7],
          [25.8, 44.2],
        ],
      ],
    };
    walkingIsochrone.mockResolvedValue({
      origin: { lat: 44.43, lng: 26.1 },
      rings: [{ minutes: 15, geometry: fullRing }],
    });

    const result = await nearbyAmenities(44.43, 26.1);
    const transit = result.amenities.filter(({ category }) => category === "transit");
    expect(result.counts.transit).toBe(161);
    expect(transit).toHaveLength(150);
    expect(transit.every((item, index) => index === 0 || item.distanceMeters >= transit[index - 1]!.distanceMeters)).toBe(true);
    expect(imported.placeCount).toBe(167);
  });
});

function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
