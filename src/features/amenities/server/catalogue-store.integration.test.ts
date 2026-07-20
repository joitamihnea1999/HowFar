import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";

import {
  CataloguePublicationError,
  publishDataset,
  withActiveDataset,
} from "./catalogue-store";

const describePostgres = process.env.POSTGIS_INTEGRATION === "1" ? describe : describe.skip;

describePostgres("versioned amenity catalogue publication", () => {
  const prefix = `catalogue-integration-${randomUUID()}`;
  let sequence = 0;

  async function cleanFixtureRows() {
    await db().amenityDataset.deleteMany({ where: { id: { startsWith: prefix } } });
    await db().amenityImportRun.deleteMany({ where: { id: { startsWith: prefix } } });
  }

  async function makeDataset(
    label: string,
    options: { validationPassed?: boolean; placeCount?: number } = {},
  ): Promise<string> {
    sequence += 1;
    const runId = `${prefix}-run-${label}-${sequence}`;
    const datasetId = `${prefix}-dataset-${label}-${sequence}`;
    const checksum = sequence.toString(16).padStart(64, "0");

    await db().amenityImportRun.create({
      data: {
        id: runId,
        status: "validated",
        source: "fixture",
        sourceVersion: `fixture-${label}`,
        sourceChecksum: checksum,
        finishedAt: new Date(),
        rawElementCount: 1,
        acceptedPlaceCount: 1,
        rejectedElementCount: 0,
        validation: { fixture: true },
      },
    });
    await db().amenityDataset.create({
      data: {
        id: datasetId,
        importRunId: runId,
        sourceVersion: `fixture-${label}`,
        sourceChecksum: checksum,
        placeCount: options.placeCount ?? 1,
        validationPassed: options.validationPassed ?? true,
        validation: { fixture: true },
      },
    });

    const placeId = `${prefix}-place-${label}-${sequence}`;
    const sourceId = BigInt(9_000_000 + sequence);
    const lng = 26.1 + sequence / 100_000;
    const lat = 44.43 + sequence / 100_000;
    await db().$executeRaw`
      INSERT INTO "osm_catalogue"."AmenityPlace" (
        "id", "datasetId", "sourceType", "sourceId", "canonicalId",
        "category", "name", "normalizedName", "accessState", "qualityState",
        "sourceTags", "representativePoint", "geom"
      ) VALUES (
        ${placeId}, ${datasetId}, 'node', ${sourceId}, ${`node/${sourceId}`},
        'groceries', ${`Fixture ${label}`}, ${`fixture ${label}`}, 'public', 'included',
        ${JSON.stringify({ shop: "supermarket" })}::jsonb,
        ST_SetSRID(ST_Point(${lng}, ${lat}), 4326),
        ST_SetSRID(ST_Point(${lng}, ${lat}), 4326)
      )
    `;

    return datasetId;
  }

  beforeEach(cleanFixtureRows);
  afterAll(async () => {
    await cleanFixtureRows();
    await db().$disconnect();
  });

  it("keeps the last good dataset active when validation or an in-transaction check fails", async () => {
    const first = await makeDataset("first");
    await publishDataset(first);

    const invalid = await makeDataset("invalid", { validationPassed: false });
    await expect(publishDataset(invalid)).rejects.toBeInstanceOf(CataloguePublicationError);
    await expect(db().amenityDataset.findUnique({ where: { activeKey: 1 } })).resolves.toMatchObject({
      id: first,
    });

    const interrupted = await makeDataset("interrupted");
    await expect(
      publishDataset(interrupted, {
        verifyBeforeCommit: async () => {
          throw new Error("simulated final validation failure");
        },
      }),
    ).rejects.toThrow("simulated final validation failure");

    await expect(db().amenityDataset.findUnique({ where: { activeKey: 1 } })).resolves.toMatchObject({
      id: first,
    });
    await expect(
      db().amenityImportRun.findUniqueOrThrow({
        where: { id: `${prefix}-run-interrupted-${sequence}` },
      }),
    ).resolves.toMatchObject({ status: "validated", publishedAt: null });
  });

  it("pins a reader to one dataset while a new version is published", async () => {
    const original = await makeDataset("original");
    await publishDataset(original);

    let releaseReader!: () => void;
    const readerReleased = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    let readerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readerStarted = resolve;
    });

    const pinnedRead = withActiveDataset(async (tx, datasetId) => {
      readerStarted();
      await readerReleased;
      const count = await tx.amenityPlace.count({ where: { datasetId } });
      return { datasetId, count };
    });

    await started;
    const replacement = await makeDataset("replacement");
    await publishDataset(replacement);
    releaseReader();

    await expect(pinnedRead).resolves.toEqual({ datasetId: original, count: 1 });
    await expect(db().amenityDataset.findUnique({ where: { activeKey: 1 } })).resolves.toMatchObject({
      id: replacement,
    });
  });

  it("enforces one active version and prunes old inactive place snapshots", async () => {
    const published: string[] = [];
    for (const label of ["one", "two", "three", "four"]) {
      const datasetId = await makeDataset(label);
      published.push(datasetId);
      await publishDataset(datasetId, { retainInactiveDatasets: 1 });
    }

    const datasets = await db().amenityDataset.findMany({
      where: { id: { startsWith: prefix } },
      orderBy: { createdAt: "asc" },
    });
    const places = await db().amenityPlace.count({
      where: { datasetId: { startsWith: prefix } },
    });

    expect(datasets).toHaveLength(2);
    expect(datasets.filter(({ activeKey }) => activeKey === 1)).toHaveLength(1);
    expect(datasets.find(({ activeKey }) => activeKey === 1)?.id).toBe(published.at(-1));
    expect(places).toBe(2);
  });

  it("drops crash-orphaned datasets instead of evicting a real published backup", async () => {
    const keep = await makeDataset("keep");
    await publishDataset(keep, { retainInactiveDatasets: 1 });

    // A dataset created but never published (process killed before publish):
    // activeKey and publishedAt both null.
    const orphan = await makeDataset("orphan");
    await expect(
      db().amenityDataset.findUniqueOrThrow({ where: { id: orphan } }),
    ).resolves.toMatchObject({ activeKey: null, publishedAt: null });

    const next = await makeDataset("next");
    await publishDataset(next, { retainInactiveDatasets: 1 });

    // Orphan is gone (its places cascade away); the genuine published backup
    // survives even though it published earlier than the orphan was created.
    await expect(
      db().amenityDataset.findUnique({ where: { id: orphan } }),
    ).resolves.toBeNull();
    await expect(
      db().amenityDataset.findUnique({ where: { id: keep } }),
    ).resolves.not.toBeNull();
    await expect(
      db().amenityDataset.findUnique({ where: { activeKey: 1 } }),
    ).resolves.toMatchObject({ id: next });
    await expect(
      db().amenityPlace.count({ where: { datasetId: orphan } }),
    ).resolves.toBe(0);
  });

  it("keeps the OSM-derived tables isolated from public application data", async () => {
    const rows = await db().$queryRaw<Array<{ tableName: string }>>`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = 'osm_catalogue'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;

    expect(rows.map(({ tableName }) => tableName)).toEqual([
      "AmenityDataset",
      "AmenityImportRun",
      "AmenityPlace",
    ]);
    expect(rows.map(({ tableName }) => tableName)).not.toEqual(
      expect.arrayContaining(["Account", "ApiCache", "Session", "User"]),
    );
  });
});
