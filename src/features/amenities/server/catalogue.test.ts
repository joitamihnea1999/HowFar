import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  walkingIsochrone,
  withActiveDataset,
  querySummary,
  amenityCacheRead,
  amenityCacheWrite,
  raceOverpass,
  findActiveDataset,
} = vi.hoisted(() => ({
  walkingIsochrone: vi.fn(),
  withActiveDataset: vi.fn(),
  querySummary: vi.fn(),
  amenityCacheRead: vi.fn(),
  amenityCacheWrite: vi.fn(),
  raceOverpass: vi.fn(),
  findActiveDataset: vi.fn(),
}));

vi.mock("@/features/isochrones/server/ors", () => ({ walkingIsochrone }));
vi.mock("@/features/amenities/server/catalogue-store", () => ({ withActiveDataset }));
vi.mock("@/features/amenities/server/catalogue-query", () => ({
  queryCatalogueSummaryInRing: querySummary,
}));
vi.mock("@/lib/api-cache", () => ({
  getCachedSafe: amenityCacheRead,
  setCachedSafe: amenityCacheWrite,
}));
vi.mock("@/lib/db", () => ({
  db: () => ({
    amenityDataset: { findUnique: findActiveDataset },
  }),
}));
// Runtime discovery must never reintroduce interactive Overpass for amenities.
vi.mock("@/features/amenities/server/overpass-client", () => ({ raceOverpass }));

import {
  amenityResultCacheKey,
  CatalogueUnavailableError,
  isCatalogueStale,
  nearbyAmenities,
  rehydrateCachedNearby,
} from "./catalogue";

const ring: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [26.09, 44.42],
      [26.12, 44.42],
      [26.12, 44.45],
      [26.09, 44.45],
      [26.09, 44.42],
    ],
  ],
};
const emptyCounts = { groceries: 0, pharmacies: 0, parks: 0, schools: 0, transit: 0 };
const freshSource = new Date("2099-07-20T06:45:42.000Z");

beforeEach(() => {
  walkingIsochrone.mockReset();
  withActiveDataset.mockReset();
  querySummary.mockReset();
  amenityCacheRead.mockReset();
  amenityCacheWrite.mockReset();
  raceOverpass.mockReset();
  findActiveDataset.mockReset();
  findActiveDataset.mockResolvedValue({ id: "dataset-1" });
  walkingIsochrone.mockResolvedValue({
    origin: { lat: 44.4268, lng: 26.1025 },
    rings: [{ minutes: 15, geometry: ring }],
  });
  querySummary.mockResolvedValue({ counts: emptyCounts, amenities: [] });
  amenityCacheRead.mockResolvedValue(null);
  amenityCacheWrite.mockResolvedValue(undefined);
  withActiveDataset.mockImplementation(async (read) =>
    read(
      {
        amenityDataset: {
          findUniqueOrThrow: () => Promise.resolve({ sourceTimestamp: freshSource }),
        },
      },
      "dataset-1",
    ),
  );
});

describe("nearbyAmenities local catalogue flow", () => {
  it("uses ORS + local dataset on a cache miss, then writes the result cache", async () => {
    const result = await nearbyAmenities(44.426801, 26.102499);
    expect(result).toEqual({
      origin: { lat: 44.4268, lng: 26.1025 },
      walkMinutes: 15,
      counts: emptyCounts,
      amenities: [],
      catalogue: { sourceTimestamp: "2099-07-20T06:45:42.000Z", stale: false },
    });
    expect(walkingIsochrone).toHaveBeenCalledWith(44.426801, 26.102499, "normal");
    expect(querySummary).toHaveBeenCalledWith(
      expect.anything(),
      "dataset-1",
      ring,
      { lat: 44.4268, lng: 26.1025 },
    );
    expect(amenityCacheRead).toHaveBeenCalledWith(amenityResultCacheKey("dataset-1", 44.4268, 26.1025, "normal"));
    expect(amenityCacheWrite).toHaveBeenCalledWith(
      amenityResultCacheKey("dataset-1", 44.4268, 26.1025, "normal"),
      expect.objectContaining({
        datasetId: "dataset-1",
        origin: { lat: 44.4268, lng: 26.1025 },
        counts: emptyCounts,
      }),
      expect.any(Date),
    );
    expect(raceOverpass).not.toHaveBeenCalled();
  });

  it("serves a cache hit without ORS or PostGIS and recomputes stale at read time", async () => {
    amenityCacheRead.mockResolvedValue({
      origin: { lat: 44.4268, lng: 26.1025 },
      walkMinutes: 15,
      counts: { ...emptyCounts, parks: 3 },
      amenities: [{ lat: 44.43, lng: 26.1, name: "Park", category: "parks" }],
      sourceTimestamp: "2020-01-01T00:00:00.000Z",
      datasetId: "dataset-1",
    });
    const result = await nearbyAmenities(44.4268, 26.1025);
    expect(result.counts.parks).toBe(3);
    expect(result.catalogue.stale).toBe(true);
    expect(walkingIsochrone).not.toHaveBeenCalled();
    expect(withActiveDataset).not.toHaveBeenCalled();
    expect(querySummary).not.toHaveBeenCalled();
    expect(amenityCacheWrite).not.toHaveBeenCalled();
  });

  it("ignores a cache row for a different datasetId (post-publish safety)", async () => {
    amenityCacheRead.mockResolvedValue({
      origin: { lat: 44.4268, lng: 26.1025 },
      walkMinutes: 15,
      counts: emptyCounts,
      amenities: [],
      sourceTimestamp: "2099-07-20T06:45:42.000Z",
      datasetId: "old-dataset",
    });
    await nearbyAmenities(44.4268, 26.1025);
    expect(walkingIsochrone).toHaveBeenCalled();
    expect(querySummary).toHaveBeenCalled();
    expect(amenityCacheWrite).toHaveBeenCalled();
  });

  it("marks missing or older-than-grace source timestamps stale", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    expect(isCatalogueStale(null, now)).toBe(true);
    expect(isCatalogueStale(new Date("2026-07-01T00:00:00.000Z"), now)).toBe(true);
    expect(isCatalogueStale(new Date("2026-07-15T00:00:00.000Z"), now)).toBe(false);
  });

  it("rehydrateCachedNearby always recomputes stale from wall clock", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const fresh = rehydrateCachedNearby(
      {
        origin: { lat: 1, lng: 2 },
        walkMinutes: 15,
        counts: emptyCounts,
        amenities: [],
        sourceTimestamp: "2026-07-18T00:00:00.000Z",
        datasetId: "d",
      },
      now,
    );
    expect(fresh.catalogue.stale).toBe(false);
    const old = rehydrateCachedNearby(
      {
        origin: { lat: 1, lng: 2 },
        walkMinutes: 15,
        counts: emptyCounts,
        amenities: [],
        sourceTimestamp: "2026-01-01T00:00:00.000Z",
        datasetId: "d",
      },
      now,
    );
    expect(old.catalogue.stale).toBe(true);
  });

  it("returns a legitimate zero-result response when an active dataset has no intersections", async () => {
    await expect(nearbyAmenities(44.4268, 26.1025)).resolves.toMatchObject({
      counts: emptyCounts,
      amenities: [],
    });
  });

  it("distinguishes a missing active catalogue from an empty result", async () => {
    findActiveDataset.mockResolvedValue(null);
    await expect(nearbyAmenities(44.4268, 26.1025)).rejects.toBeInstanceOf(
      CatalogueUnavailableError,
    );
    expect(walkingIsochrone).not.toHaveBeenCalled();
    expect(amenityCacheWrite).not.toHaveBeenCalled();
  });

  it("wraps a database query failure as catalogue unavailable and does not cache", async () => {
    withActiveDataset.mockRejectedValue(new Error("connection reset"));
    await expect(nearbyAmenities(44.4268, 26.1025)).rejects.toThrow(
      /Amenity catalogue query failed/,
    );
    expect(amenityCacheWrite).not.toHaveBeenCalled();
  });

  it("keeps an ORS ring-contract failure as an upstream provider error", async () => {
    walkingIsochrone.mockResolvedValue({
      origin: { lat: 44.4268, lng: 26.1025 },
      rings: [{ minutes: 30, geometry: ring }],
    });
    await expect(nearbyAmenities(44.4268, 26.1025)).rejects.toThrow(/15-min ring/);
    expect(withActiveDataset).not.toHaveBeenCalled();
    expect(amenityCacheWrite).not.toHaveBeenCalled();
  });

  it("single-flights concurrent callers for the same rounded origin", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    withActiveDataset.mockImplementation(async (read) => {
      await gate;
      return read(
        {
          amenityDataset: {
            findUniqueOrThrow: () => Promise.resolve({ sourceTimestamp: freshSource }),
          },
        },
        "dataset-1",
      );
    });
    const a = nearbyAmenities(44.4268, 26.1025);
    const b = nearbyAmenities(44.4268, 26.1025);
    release();
    await Promise.all([a, b]);
    expect(findActiveDataset).toHaveBeenCalledTimes(1);
    expect(walkingIsochrone).toHaveBeenCalledTimes(1);
    expect(withActiveDataset).toHaveBeenCalledTimes(1);
  });

  it("does NOT coalesce different paces for the same origin (task 051 — a Brisk request must not get Relaxed counts)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    withActiveDataset.mockImplementation(async (read) => {
      await gate;
      return read(
        { amenityDataset: { findUniqueOrThrow: () => Promise.resolve({ sourceTimestamp: freshSource }) } },
        "dataset-1",
      );
    });
    const relaxed = nearbyAmenities(44.4268, 26.1025, "relaxed");
    const brisk = nearbyAmenities(44.4268, 26.1025, "brisk");
    release();
    await Promise.all([relaxed, brisk]);
    // Distinct flight keys ⇒ two independent computations, each with its OWN pace
    // threaded into the ORS walk-ring call (no coalescing onto a wrong-pace ring).
    expect(walkingIsochrone).toHaveBeenCalledTimes(2);
    const paces = (walkingIsochrone as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[2]);
    expect(paces).toContain("relaxed");
    expect(paces).toContain("brisk");
  });
});

describe("nearbyAmenities merges coincident transit stops (task 047)", () => {
  // Two transit stops ~1m apart, different modes → one merged marker.
  const coincident = [
    { id: "a", lat: 44.4268, lng: 26.1025, name: "Stadion", category: "transit", osmType: "node", osmId: 1, distanceMeters: 10, modes: ["bus"] },
    { id: "b", lat: 44.42681, lng: 26.1025, name: "Savinesti", category: "transit", osmType: "node", osmId: 2, distanceMeters: 12, modes: ["tram"] },
  ];

  it("fuses them into one marker with members, and reduces counts.transit when under the 150 cap", async () => {
    querySummary.mockResolvedValue({ counts: { ...emptyCounts, transit: 2 }, amenities: coincident });
    const result = await nearbyAmenities(44.426801, 26.102499);

    expect(result.amenities).toHaveLength(1);
    expect(result.amenities[0].mergedCount).toBe(2);
    expect(result.amenities[0].members).toHaveLength(2);
    // count reflects the merge (2 stops → 1 distinct place)
    expect(result.counts.transit).toBe(1);
    // server-only `modes` never reaches the client payload (F5)
    expect(result.amenities[0]).not.toHaveProperty("modes");
    // and the merged payload is what gets cached
    expect(amenityCacheWrite).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ counts: expect.objectContaining({ transit: 1 }) }),
      expect.any(Date),
    );
  });

  it("leaves counts.transit as the raw pre-cap total when the category is capped (>150)", async () => {
    querySummary.mockResolvedValue({ counts: { ...emptyCounts, transit: 200 }, amenities: coincident });
    const result = await nearbyAmenities(44.426801, 26.102499);

    expect(result.amenities).toHaveLength(1); // still visually merged
    expect(result.counts.transit).toBe(200); // but the count is left raw (documented best-effort)
  });
});
