import { beforeEach, describe, expect, it, vi } from "vitest";

const { withActiveDataset, queryRaw, findDataset } = vi.hoisted(() => ({
  withActiveDataset: vi.fn(),
  queryRaw: vi.fn(),
  findDataset: vi.fn(),
}));

vi.mock("@/features/amenities/server/catalogue-store", () => ({ withActiveDataset }));

import { exportCataloguePage } from "./catalogue-export";

beforeEach(() => {
  queryRaw.mockReset();
  findDataset.mockReset();
  withActiveDataset.mockReset();
  withActiveDataset.mockImplementation((read) =>
    read({ $queryRaw: queryRaw, amenityDataset: { findUniqueOrThrow: findDataset } }, "dataset-private"),
  );
  findDataset.mockResolvedValue({
    sourceVersion: "osm-v1",
    sourceTimestamp: new Date("2026-07-20T00:00:00Z"),
    sourceChecksum: "c".repeat(64),
  });
});

describe("catalogue export", () => {
  it("exports only the explicit OSM-derived GeoJSON allowlist", async () => {
    queryRaw.mockResolvedValue([{
      canonicalId: "way/42",
      sourceType: "way",
      sourceId: BigInt(42),
      category: "parks",
      name: "Park",
      accessState: "public",
      qualityState: "included",
      sourceTags: { leisure: "park" },
      sourceUpdatedAt: null,
      geometry: '{"type":"Point","coordinates":[26.1,44.4]}',
    }]);

    const page = await exportCataloguePage(null, 100);
    expect(page?.features[0]).toEqual({
      type: "Feature",
      id: "way/42",
      geometry: { type: "Point", coordinates: [26.1, 44.4] },
      properties: {
        sourceType: "way",
        sourceId: "42",
        category: "parks",
        name: "Park",
        accessState: "public",
        qualityState: "included",
        sourceTags: { leisure: "park" },
        sourceUpdatedAt: null,
      },
    });
    const serialized = JSON.stringify(page);
    for (const privateField of ["dataset-private", "email", "sessionToken", "access_token", "ApiCache"]) {
      expect(serialized).not.toContain(privateField);
    }
  });

  it("returns no page without an active dataset and emits a cursor for a full page", async () => {
    withActiveDataset.mockResolvedValueOnce(null);
    await expect(exportCataloguePage(null, 1)).resolves.toBeNull();

    queryRaw.mockResolvedValue([{
      canonicalId: "node/1", sourceType: "node", sourceId: BigInt(1), category: "schools", name: null,
      accessState: "unknown", qualityState: "included", sourceTags: {},
      sourceUpdatedAt: new Date("2026-07-19T00:00:00Z"),
      geometry: '{"type":"Point","coordinates":[26,44]}',
    }]);
    await expect(exportCataloguePage("before", 1)).resolves.toMatchObject({ nextCursor: "node/1" });

    findDataset.mockResolvedValue({
      sourceVersion: "osm-v2",
      sourceTimestamp: null,
      sourceChecksum: "d".repeat(64),
    });
    queryRaw.mockResolvedValue([]);
    await expect(exportCataloguePage(null, 10)).resolves.toMatchObject({
      features: [],
      nextCursor: null,
      catalogue: { sourceTimestamp: null },
    });
  });
});
