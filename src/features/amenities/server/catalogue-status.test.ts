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
