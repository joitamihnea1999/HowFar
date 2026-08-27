import { beforeEach, describe, expect, it, vi } from "vitest";

const { findActive, findFailure } = vi.hoisted(() => ({
  findActive: vi.fn(),
  findFailure: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: () => ({
    amenityDataset: { findUnique: findActive },
    amenityImportRun: { findFirst: findFailure },
  }),
}));

import { getCatalogueStatus } from "./catalogue-status";

beforeEach(() => {
  findActive.mockReset();
  findFailure.mockReset();
  findFailure.mockResolvedValue(null);
});

describe("catalogue operational status", () => {
  it("reports a fresh active snapshot and its immutable audit fields", async () => {
    findActive.mockResolvedValue({
      sourceTimestamp: new Date("2026-07-19T00:00:00Z"),
      sourceVersion: "osm-2026-07-19",
      sourceChecksum: "a".repeat(64),
      publishedAt: new Date("2026-07-19T01:00:00Z"),
      placeCount: 8342,
    });
    await expect(getCatalogueStatus(new Date("2026-07-20T00:00:00Z"))).resolves.toMatchObject({
      available: true,
      stale: false,
      sourceVersion: "osm-2026-07-19",
      placeCount: 8342,
    });
  });

  it("reports stale/missing data and the most recent import failure", async () => {
    findActive.mockResolvedValue(null);
    findFailure.mockResolvedValue({
      failedAt: new Date("2026-07-20T01:00:00Z"),
      failureMessage: "snapshot timed out",
    });
    await expect(getCatalogueStatus()).resolves.toEqual({
      available: false,
      stale: true,
      sourceTimestamp: null,
      sourceVersion: null,
      sourceChecksum: null,
      publishedAt: null,
      placeCount: 0,
      lastFailureAt: "2026-07-20T01:00:00.000Z",
      lastFailureMessage: "snapshot timed out",
    });
  });

  it("region cross-check (task 013): an active dataset from another city reports available:false and logs why", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findActive.mockResolvedValue({
      sourceTimestamp: new Date("2026-07-19T00:00:00Z"),
      sourceVersion: "osm-2026-07-19",
      sourceChecksum: "a".repeat(64),
      publishedAt: new Date("2026-07-19T01:00:00Z"),
      placeCount: 8342,
      validation: { source: { bbox: { minLng: 23.4, minLat: 46.6, maxLng: 23.7, maxLat: 46.9 } } },
    });
    const status = await getCatalogueStatus(new Date("2026-07-20T00:00:00Z"));
    expect(status.available).toBe(false);
    // The foreign dataset's metadata must NOT leak — this surface's job is to never
    // describe the wrong city's data.
    expect(status.placeCount).toBe(0);
    expect(status.sourceVersion).toBeNull();
    expect(status.sourceChecksum).toBeNull();
    expect(status.sourceTimestamp).toBeNull();
    expect(status.publishedAt).toBeNull();
    // Operator-visible discriminator between "wrong region" and "no catalogue".
    expect(status.reason).toBe("region-mismatch");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("does not match the configured extent"));
    errSpy.mockRestore();
    // Guard against a silent regression that drops the region read from the select.
    expect(findActive).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ validation: true }) }),
    );
  });

  it("region cross-check (task 013): an active dataset recorded for the configured (default) extent stays available", async () => {
    findActive.mockResolvedValue({
      sourceTimestamp: new Date("2026-07-19T00:00:00Z"),
      sourceVersion: "osm-2026-07-19",
      sourceChecksum: "a".repeat(64),
      publishedAt: new Date("2026-07-19T01:00:00Z"),
      placeCount: 8342,
      validation: { source: { bbox: { minLng: 25.8, minLat: 44.2, maxLng: 26.4, maxLat: 44.7 } } },
    });
    const status = await getCatalogueStatus(new Date("2026-07-20T00:00:00Z"));
    expect(status.available).toBe(true);
    expect(status.reason).toBeUndefined(); // no discriminator when the region matches
  });

  it("marks an active snapshot stale when its source timestamp is absent", async () => {
    findActive.mockResolvedValue({
      sourceTimestamp: null,
      sourceVersion: "unknown-date",
      sourceChecksum: "e".repeat(64),
      publishedAt: null,
      placeCount: 1,
    });
    await expect(getCatalogueStatus()).resolves.toMatchObject({
      available: true,
      stale: true,
      sourceTimestamp: null,
      publishedAt: null,
      lastFailureAt: null,
    });
  });
});
