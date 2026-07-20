import { beforeEach, describe, expect, it, vi } from "vitest";

const { walkingIsochrone, withActiveDataset, querySummary, amenityCacheRead, raceOverpass } =
  vi.hoisted(() => ({
    walkingIsochrone: vi.fn(),
    withActiveDataset: vi.fn(),
    querySummary: vi.fn(),
    amenityCacheRead: vi.fn(),
    raceOverpass: vi.fn(),
  }));

vi.mock("@/features/isochrones/server/ors", () => ({ walkingIsochrone }));
vi.mock("@/features/amenities/server/catalogue-store", () => ({ withActiveDataset }));
vi.mock("@/features/amenities/server/catalogue-query", () => ({
  queryCatalogueSummaryInRing: querySummary,
}));
// Regression sentinels: runtime amenity discovery must never reintroduce either
// the provider cache or the shared interactive Overpass transport.
vi.mock("@/lib/api-cache", () => ({ getCachedSafe: amenityCacheRead }));
vi.mock("@/features/amenities/server/overpass-client", () => ({ raceOverpass }));

import { CatalogueUnavailableError, isCatalogueStale, nearbyAmenities } from "./catalogue";

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

beforeEach(() => {
  walkingIsochrone.mockReset();
  withActiveDataset.mockReset();
  querySummary.mockReset();
  amenityCacheRead.mockReset();
  raceOverpass.mockReset();
  walkingIsochrone.mockResolvedValue({
    origin: { lat: 44.4268, lng: 26.1025 },
    rings: [{ minutes: 15, geometry: ring }],
  });
  querySummary.mockResolvedValue({ counts: emptyCounts, amenities: [] });
  withActiveDataset.mockImplementation(async (read) =>
    read(
      {
        amenityDataset: {
          findUniqueOrThrow: () =>
            Promise.resolve({ sourceTimestamp: new Date("2099-07-20T06:45:42.000Z") }),
        },
      },
      "dataset-1",
    ),
  );
});

describe("nearbyAmenities local catalogue flow", () => {
  it("uses the server ORS ring and one pinned local dataset, with no amenity cache/Overpass call", async () => {
    const result = await nearbyAmenities(44.426801, 26.102499);
    expect(result).toEqual({
      origin: { lat: 44.4268, lng: 26.1025 },
      walkMinutes: 15,
      counts: emptyCounts,
      amenities: [],
      catalogue: { sourceTimestamp: "2099-07-20T06:45:42.000Z", stale: false },
    });
    expect(walkingIsochrone).toHaveBeenCalledWith(44.426801, 26.102499);
    expect(querySummary).toHaveBeenCalledWith(
      expect.anything(),
      "dataset-1",
      ring,
      { lat: 44.4268, lng: 26.1025 },
    );
    expect(amenityCacheRead).not.toHaveBeenCalled();
    expect(raceOverpass).not.toHaveBeenCalled();
  });

  it("marks missing or older-than-grace source timestamps stale", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    expect(isCatalogueStale(null, now)).toBe(true);
    expect(isCatalogueStale(new Date("2026-07-01T00:00:00.000Z"), now)).toBe(true);
    expect(isCatalogueStale(new Date("2026-07-15T00:00:00.000Z"), now)).toBe(false);
  });

  it("returns a legitimate zero-result response when an active dataset has no intersections", async () => {
    await expect(nearbyAmenities(44.4268, 26.1025)).resolves.toMatchObject({
      counts: emptyCounts,
      amenities: [],
    });
  });

  it("distinguishes a missing active catalogue from an empty result", async () => {
    withActiveDataset.mockResolvedValue(null);
    await expect(nearbyAmenities(44.4268, 26.1025)).rejects.toBeInstanceOf(
      CatalogueUnavailableError,
    );
  });

  it("wraps a database query failure as catalogue unavailable", async () => {
    withActiveDataset.mockRejectedValue(new Error("connection reset"));
    await expect(nearbyAmenities(44.4268, 26.1025)).rejects.toThrow(
      /Amenity catalogue query failed/,
    );
  });

  it("keeps an ORS ring-contract failure as an upstream provider error", async () => {
    walkingIsochrone.mockResolvedValue({
      origin: { lat: 44.4268, lng: 26.1025 },
      rings: [{ minutes: 30, geometry: ring }],
    });
    await expect(nearbyAmenities(44.4268, 26.1025)).rejects.toThrow(/15-min ring/);
    expect(withActiveDataset).not.toHaveBeenCalled();
  });
});
