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
import { datasetMatchesExtent, readValidationBbox } from "./catalogue-region";
import { nearbyAmenities } from "./catalogue";
import { exportCataloguePage } from "./catalogue-export";
import { LAUNCH_BBOX } from "@/lib/bounds";
import { queryCatalogueSummaryInRing } from "./catalogue-query";
import { withActiveDataset } from "./catalogue-store";
import { MAX_PER_CATEGORY_PER_BAND } from "@/features/amenities/amenities";
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
    // ring and fail here. Passed as three NESTED rings (task 065): here they are
    // degenerate — all three identical — so every place lands in the innermost
    // band and the historical clip assertions below keep their original meaning.
    const inRing = await withActiveDataset((tx, datasetId) =>
      queryCatalogueSummaryInRing(tx, datasetId, [ring, ring, ring], origin),
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
      rings: [
        { minutes: 15, geometry: ring },
        { minutes: 30, geometry: ring },
        { minutes: 45, geometry: fullRing },
      ],
    });
    await expect(nearbyAmenities(origin.lat, origin.lng)).resolves.toMatchObject({
      clip: { mode: "walk", band: 45, minutes: 45 },
      // Whole-clip totals are stated by summing the bands — the flat `counts` field was
      // dropped so there is exactly one count contract.
      countsByBand: expect.any(Object),
    });

    // ——— Task 065: banding, per-band counts and stratified caps, against REAL SQL ———

    // Genuinely nested rings: `ring` (the tight clip above) is the inner band, a
    // slightly larger box is the mid band, and `fullRing` (city-wide) is the outer.
    // Every fixture place is inside `fullRing`; only some are inside `ring`.
    const midRing: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [26.09, 44.415],
          [26.125, 44.415],
          [26.125, 44.44],
          [26.09, 44.44],
          [26.09, 44.415],
        ],
      ],
    };
    const banded = await withActiveDataset((tx, datasetId) =>
      queryCatalogueSummaryInRing(tx, datasetId, [ring, midRing, fullRing], origin),
    );

    // Every returned place carries one of the three band ids…
    expect(banded!.amenities.length).toBeGreaterThan(0);
    for (const a of banded!.amenities) expect([15, 30, 45]).toContain(a.band);

    // …and the per-band totals reconcile EXACTLY with the whole-clip per-category
    // totals. This is the invariant that breaks first if banding double-counts or
    // drops a row (reflection question 3).
    for (const category of ["groceries", "pharmacies", "parks", "schools", "transit"] as const) {
      const summed =
        banded!.countsByBand[15][category] +
        banded!.countsByBand[30][category] +
        banded!.countsByBand[45][category];
      expect(summed).toBe(banded!.counts[category]);
    }

    // A place inside the innermost ring must be attributed to band 15 — not to the
    // outer band merely because the clip is the outer ring.
    const bandOfBoundary = banded!.amenities.find(({ name }) => name === "Boundary Park")?.band;
    expect(bandOfBoundary).toBe(15);

    // Pre-cap, not a recount of returned rows: with the fixture's tiny catalogue
    // nothing is capped, so the two agree — asserted so the CAPPED case below is
    // meaningful rather than incidental.
    const returnedParks = banded!.amenities.filter((a) => a.category === "parks").length;
    expect(banded!.counts.parks).toBe(returnedParks);

    // A polygon spanning bands must keep its marker INSIDE the band it was attributed
    // to. `Boundary Park` (relation/302) is a real multi-vertex polygon in the fixture;
    // with a tight inner ring that only clips its western edge, the park is band 15 and
    // its display point must therefore land inside that inner ring — not somewhere in
    // the band-30/45 zone where the outer-ring clip used to put it. Six of seven
    // this is the fixture that makes that defect fail.
    const parkInnerRing: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [26.1, 44.422],
          [26.118, 44.422],
          [26.118, 44.432],
          [26.1, 44.432],
          [26.1, 44.422],
        ],
      ],
    };
    const spanning = (await withActiveDataset((tx, datasetId) =>
      queryCatalogueSummaryInRing(tx, datasetId, [parkInnerRing, midRing, fullRing], origin),
    ))!;
    const spanningPark = spanning.amenities.find(({ name }) => name === "Boundary Park");
    expect(spanningPark).toBeDefined();
    expect(spanningPark!.band).toBe(15);
    // The decisive assertion: the marker sits inside the ring of its OWN band, so it can
    // never be drawn over unshaded map at the default inner-band filter.
    // Boundary Park spans lon 26.113→26.13 (read from the fixture), so the inner ring
    // (…→26.118) overlaps only its WESTERN strip: lon 26.113–26.118. Under the previous
    // outer-ring clip the display point came from the whole park and landed east of
    // 26.118, outside the band-15 ring — which is exactly what this asserts against.
    expect(spanningPark!.lng).toBeGreaterThanOrEqual(26.113);
    expect(spanningPark!.lng).toBeLessThanOrEqual(26.118);
    expect(spanningPark!.lat).toBeGreaterThanOrEqual(44.423);
    expect(spanningPark!.lat).toBeLessThanOrEqual(44.431);
    // And PostGIS agrees the point is covered by that exact ring.
    const covered = (await withActiveDataset(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ inside: boolean }>>`
        SELECT ST_Covers(
          ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(parkInnerRing)}), 4326),
          ST_SetSRID(ST_Point(${spanningPark!.lng}, ${spanningPark!.lat}), 4326)
        ) AS inside`;
      return rows[0]!.inside;
    }))!;
    expect(covered).toBe(true);

    // Non-nested rings must not lose a place (nesting-violation rule): with the
    // inner ring OUTSIDE the outer one, membership is still decided by the outer
    // ring and every surviving row still gets a legal band.
    const disjointInner: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [25.0, 43.0],
          [25.1, 43.0],
          [25.1, 43.1],
          [25.0, 43.1],
          [25.0, 43.0],
        ],
      ],
    };
    const nonNested = await withActiveDataset((tx, datasetId) =>
      queryCatalogueSummaryInRing(tx, datasetId, [disjointInner, midRing, fullRing], origin),
    );
    expect(nonNested!.amenities.length).toBe(banded!.amenities.length);
    for (const a of nonNested!.amenities) expect([30, 45]).toContain(a.band);

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
    // Degenerate rings (all three identical) put every place in band 15, so this
    // isolates the PER-BAND cap: 161 stops in one band ⇒ exactly the cap is returned.
    walkingIsochrone.mockResolvedValue({
      origin: { lat: 44.43, lng: 26.1 },
      rings: [
        { minutes: 15, geometry: fullRing },
        { minutes: 30, geometry: fullRing },
        { minutes: 45, geometry: fullRing },
      ],
    });

    const result = await nearbyAmenities(44.43, 26.1);
    const transit = result.amenities.filter(({ category }) => category === "transit");
    // The count stays the TRUE pre-cap total (minus coincident-stop merges), which is
    // the whole point: it must never degrade into a recount of the capped rows.
    expect(
      result.countsByBand[15].transit +
        result.countsByBand[30].transit +
        result.countsByBand[45].transit,
    ).toBe(161);
    expect(transit).toHaveLength(MAX_PER_CATEGORY_PER_BAND);
    expect(result.countsByBand[15].transit).toBe(161);
    expect(result.countsByBand[30].transit).toBe(0);
    expect(result.countsByBand[45].transit).toBe(0);
    // Rows are still delivered nearest-first for the browse list and label sort key,
    // even though ADMISSION is spatially stratified.
    expect(transit.every((item, index) => index === 0 || item.distanceMeters >= transit[index - 1]!.distanceMeters)).toBe(true);
    expect(imported.placeCount).toBe(167);

    // Now genuinely nested rings: an inner band holding roughly HALF the generated
    // stops, the rest of the city in the outer band. Each band caps INDEPENDENTLY, so
    // the returned set can legitimately exceed a single band's cap — and, decisively,
    // the outer band is not starved by the inner one (the failure mode a flat
    // nearest-first cap has).
    //
    // The 160 generated stops sit on a diagonal from (44.43, 26.1) stepping 1e-6 per
    // index — a line only ~18 m long — so the inner box has to be drawn in the SAME
    // 1e-6 scale to split them. A degree-scale box (my first attempt) contained every
    // one of them and left the outer band empty, which is why this comment exists.
    const tightInner: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [26.09999, 44.42999],
          [26.10008, 44.42999],
          [26.10008, 44.43008],
          [26.09999, 44.43008],
          [26.09999, 44.42999],
        ],
      ],
    };
    // Queried DIRECTLY rather than through `nearbyAmenities`: the result cache is real
    // in this integration test and is keyed by clip IDENTITY (mode + pace), not by ring
    // geometry — so a second same-origin walk call legitimately returns the first
    // call's cached answer. That is correct in production (rings are deterministic for
    // a given mode/pace/time) but it would have made this assertion test the cache
    // instead of the SQL. Found by watching this very assertion fail.
    const split = (await withActiveDataset((tx, datasetId) =>
      queryCatalogueSummaryInRing(tx, datasetId, [tightInner, tightInner, fullRing], {
        lat: 44.43,
        lng: 26.1,
      }),
    ))!;
    const splitTransit = split.amenities.filter(({ category }) => category === "transit");
    expect(split.countsByBand[15].transit).toBeGreaterThan(0);
    expect(split.countsByBand[45].transit).toBeGreaterThan(0);
    // Per-band totals reconcile against the KNOWN fixture total, not against themselves.
    // The first version of this assertion compared the sum to a copy of itself — a
    // tautology introduced while migrating off the dropped flat `counts` field, and
    // 161 is the fixture's transit stop count (160
    // generated + 1 base), and this direct query is capped-free, so it is the
    // independent figure the per-band sums must add up to.
    expect(
      split.countsByBand[15].transit +
        split.countsByBand[30].transit +
        split.countsByBand[45].transit,
    ).toBe(161);
    // Markers were admitted from BOTH bands — outer coverage is not sacrificed.
    expect(splitTransit.some((a) => a.band === 15)).toBe(true);
    expect(splitTransit.some((a) => a.band === 45)).toBe(true);
    // Decisive: MORE stops come back than a single band's cap allows, which is only
    // possible if each band is capped on its own. Under the pre-065 flat cap the same
    // catalogue returned at most one cap's worth in total.
    expect(splitTransit.length).toBeGreaterThan(MAX_PER_CATEGORY_PER_BAND);
  });

  // ---- region cross-check (task 013) through the REAL Json column ----

  it("records source.bbox that round-trips the Json column byte-exact and matches the configured extent", async () => {
    const result = await importCatalogueSnapshot(snapshot(bodyAt("2099-03-01T00:00:00Z")), overrides);
    // Reload from the DB — proves the persisted value, not the in-memory one.
    const reloaded = await db().amenityDataset.findUniqueOrThrow({
      where: { id: result.datasetId },
      select: { validation: true },
    });
    // Exact round-trip: the four doubles survive JSONB unchanged, so exact equality
    // (the production comparison) is safe.
    expect(readValidationBbox(reloaded.validation)).toEqual(LAUNCH_BBOX);
    expect(datasetMatchesExtent(reloaded.validation)).toBe(true);
    // A legacy dataset (validation with no source.bbox) is grandfathered under the
    // default extent — the un-brick-prod path.
    expect(datasetMatchesExtent({ categoryCounts: {} })).toBe(true);
  });

  it("region change disables the category-delta baseline so fail-closed can be cleared by re-import", async () => {
    // Seed an active dataset, then rewrite its stored region to ANOTHER city and blow
    // up its category counts, so a fresh (small-count) import would trip the >50%-drop
    // delta guard IF the old-city counts were used as a baseline.
    const seeded = await importCatalogueSnapshot(snapshot(bodyAt("2099-04-01T00:00:00Z")), overrides);
    await db().amenityDataset.update({
      where: { id: seeded.datasetId },
      data: {
        validation: {
          categoryCounts: { groceries: 500, pharmacies: 500, parks: 500, schools: 500, transit: 500 },
          source: {
            bbox: { minLng: 23.4, minLat: 46.6, maxLng: 23.7, maxLat: 46.9 },
            pipelineVersion: -1, // force the idempotency short-circuit off too
          },
        },
      },
    });

    // A genuinely different snapshot (new bytes ⇒ new checksum ⇒ not "unchanged").
    // With the seeded dataset's region ≠ the configured extent, the baseline is null,
    // so the huge→small category deltas must NOT abort the import.
    const reimport = await importCatalogueSnapshot(
      snapshot(bodyAt("2099-04-02T00:00:00Z")),
      overrides,
    );
    expect(reimport.unchanged).toBe(false);
    // New active dataset is region-correct again — fail-closed has been cleared.
    const active = await db().amenityDataset.findUniqueOrThrow({
      where: { id: reimport.datasetId },
      select: { activeKey: true, validation: true },
    });
    expect(active.activeKey).toBe(1);
    expect(datasetMatchesExtent(active.validation)).toBe(true);
  });

  it("STILL enforces the category-delta guard when the active dataset's region matches (proves the baseline-null is region-gated, not removed)", async () => {
    const seeded = await importCatalogueSnapshot(snapshot(bodyAt("2099-05-01T00:00:00Z")), overrides);
    // Keep the region matching the configured extent, but inflate the baseline counts.
    await db().amenityDataset.update({
      where: { id: seeded.datasetId },
      data: {
        validation: {
          categoryCounts: { groceries: 500, pharmacies: 500, parks: 500, schools: 500, transit: 500 },
          source: { bbox: LAUNCH_BBOX, pipelineVersion: -1 },
        },
      },
    });
    // Same-region baseline is used ⇒ the huge→small drop trips the delta guard.
    await expect(
      importCatalogueSnapshot(snapshot(bodyAt("2099-05-02T00:00:00Z")), overrides),
    ).rejects.toBeInstanceOf(CatalogueImportError);
  });

  it("does NOT short-circuit as 'unchanged' when the active dataset's region no longer matches (defensive)", async () => {
    const first = await importCatalogueSnapshot(snapshot(bodyAt("2099-06-01T00:00:00Z")), overrides);
    // Rewrite ONLY the recorded region to another city, preserving the checksum /
    // pipeline version / overrides checksum, so the idempotency short-circuit WOULD
    // fire on an identical re-import but for the region gate.
    const row = await db().amenityDataset.findUniqueOrThrow({
      where: { id: first.datasetId },
      select: { validation: true },
    });
    const mutated = structuredClone(row.validation) as { source: { bbox: unknown } };
    mutated.source.bbox = { minLng: 23.4, minLat: 46.6, maxLng: 23.7, maxLat: 46.9 };
    await db().amenityDataset.update({
      where: { id: first.datasetId },
      data: { validation: mutated as object },
    });
    // Re-import the IDENTICAL bytes + overrides: same checksum, pipeline, overrides —
    // the short-circuit would return unchanged, but the active region no longer
    // matches, so it must reprocess instead (clearing fail-closed).
    const second = await importCatalogueSnapshot(snapshot(bodyAt("2099-06-01T00:00:00Z")), overrides);
    expect(second.unchanged).toBe(false);
    const active = await db().amenityDataset.findUniqueOrThrow({
      where: { id: second.datasetId },
      select: { validation: true },
    });
    expect(datasetMatchesExtent(active.validation)).toBe(true);
  });

  it("withActiveDataset FAILS CLOSED by construction: a region-mismatched active dataset yields null and the read callback never runs", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await importCatalogueSnapshot(snapshot(bodyAt("2099-07-01T00:00:00Z")), overrides);
    // Rewrite the active dataset's recorded region to another city.
    const row = await db().amenityDataset.findUniqueOrThrow({
      where: { id: first.datasetId },
      select: { validation: true },
    });
    const mutated = structuredClone(row.validation) as { source: { bbox: unknown } };
    mutated.source.bbox = { minLng: 23.4, minLat: 46.6, maxLng: 23.7, maxLat: 46.9 };
    await db().amenityDataset.update({
      where: { id: first.datasetId },
      data: { validation: mutated as object },
    });

    let readRan = false;
    const result = await withActiveDataset(async () => {
      readRan = true;
      return "SERVED";
    });
    // The gate refuses the wrong-region dataset without ever running the read — no
    // wrong-city rows can be queried by any place-serving caller.
    expect(result).toBeNull();
    expect(readRan).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("does not match the configured extent"));
    errSpy.mockRestore();
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
