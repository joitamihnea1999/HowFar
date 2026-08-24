import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  walkingIsochrone,
  drivingIsochrone,
  transitIsochrone,
  withActiveDataset,
  querySummary,
  amenityCacheRead,
  amenityCacheWrite,
  raceOverpass,
  findActiveDataset,
} = vi.hoisted(() => ({
  walkingIsochrone: vi.fn(),
  drivingIsochrone: vi.fn(),
  transitIsochrone: vi.fn(),
  withActiveDataset: vi.fn(),
  querySummary: vi.fn(),
  amenityCacheRead: vi.fn(),
  amenityCacheWrite: vi.fn(),
  raceOverpass: vi.fn(),
  findActiveDataset: vi.fn(),
}));

vi.mock("@/features/isochrones/server/ors", () => ({ walkingIsochrone, drivingIsochrone }));
vi.mock("@/features/isochrones/server/transit", () => ({ transitIsochrone }));
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

/** A square ring polygon `scale` degrees wide around the fixture origin. Rings are
 * NESTED cumulative polygons, so the fixtures must nest too (bands.ts). */
function squareRing(scale: number): GeoJSON.Polygon {
  const [lng, lat] = [26.1025, 44.4268];
  return {
    type: "Polygon",
    coordinates: [
      [
        [lng - scale, lat - scale],
        [lng + scale, lat - scale],
        [lng + scale, lat + scale],
        [lng - scale, lat + scale],
        [lng - scale, lat - scale],
      ],
    ],
  };
}

const ring15 = squareRing(0.01);
const ring30 = squareRing(0.02);
const ring45 = squareRing(0.03);
/** The clip = the OUTERMOST ring, whichever mode's labels it carries. */
const ring = ring45;

/** Three nested walk/transit rings (labels 15/30/45). */
const walkRings = [
  { minutes: 15, geometry: ring15 },
  { minutes: 30, geometry: ring30 },
  { minutes: 45, geometry: ring45 },
];
/** Car labels the SAME three band positions 10/20/30 — a minute-keyed clip lookup
 * would find no "45-min ring" here and fail every car request (task 065 P4). */
const carRings = [
  { minutes: 10, geometry: ring15 },
  { minutes: 20, geometry: ring30 },
  { minutes: 30, geometry: ring45 },
];

const emptyCounts = { groceries: 0, pharmacies: 0, parks: 0, schools: 0, transit: 0 };
/** Zero-filled per-band counts, mirroring the query's `countsByBand` shape. */
const emptyByBand = { 15: { ...emptyCounts }, 30: { ...emptyCounts }, 45: { ...emptyCounts } };
const freshSource = new Date("2099-07-20T06:45:42.000Z");
const walkClip = { mode: "walk", band: 45, minutes: 45 } as const;
/** Whole-clip total for a category = the sum over bands. The flat `counts` field was
 * dropped: summing the bands is now the only way to state it, which is the
 * point — there is one count contract, not two that can drift. */
const totalFor = (
  byBand: { 15: Record<string, number>; 30: Record<string, number>; 45: Record<string, number> },
  category: string,
) => byBand[15][category]! + byBand[30][category]! + byBand[45][category]!;

beforeEach(() => {
  walkingIsochrone.mockReset();
  drivingIsochrone.mockReset();
  transitIsochrone.mockReset();
  withActiveDataset.mockReset();
  querySummary.mockReset();
  amenityCacheRead.mockReset();
  amenityCacheWrite.mockReset();
  raceOverpass.mockReset();
  findActiveDataset.mockReset();
  findActiveDataset.mockResolvedValue({ id: "dataset-1" });
  walkingIsochrone.mockResolvedValue({
    origin: { lat: 44.4268, lng: 26.1025 },
    rings: walkRings,
  });
  drivingIsochrone.mockResolvedValue({
    origin: { lat: 44.4268, lng: 26.1025 },
    rings: carRings,
  });
  transitIsochrone.mockResolvedValue({
    origin: { lat: 44.4268, lng: 26.1025 },
    rings: walkRings,
    departure: "2026-08-05T05:30:00.000Z",
  });
  querySummary.mockResolvedValue({ counts: emptyCounts, countsByBand: emptyByBand, amenities: [] });
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
      clip: walkClip,
      countsByBand: emptyByBand,
      amenities: [],
      catalogue: { sourceTimestamp: "2099-07-20T06:45:42.000Z", stale: false },
    });
    expect(walkingIsochrone).toHaveBeenCalledWith(44.426801, 26.102499, "normal");
    // The clip is the OUTERMOST ring, not the 15-minute one it used to be.
    expect(querySummary).toHaveBeenCalledWith(
      expect.anything(),
      "dataset-1",
      [ring15, ring30, ring45],
      { lat: 44.4268, lng: 26.1025 },
    );
    // LITERAL key, not `amenityResultCacheKey(...)` — deriving the expectation
    // from the implementation would stay green if the version were reverted,
    // and a stale prefix serves amenities clipped to the pre-065 15-minute WALK
    // ring (in every mode) for up to 24h.
    expect(amenityCacheRead).toHaveBeenCalledWith("amenity:local:v5:dataset-1:walk:normal:44.42680,26.10250");
    expect(amenityCacheRead).toHaveBeenCalledWith(amenityResultCacheKey("dataset-1", 44.4268, 26.1025, "walk:normal"));
    expect(amenityCacheWrite).toHaveBeenCalledWith(
      amenityResultCacheKey("dataset-1", 44.4268, 26.1025, "walk:normal"),
      expect.objectContaining({
        datasetId: "dataset-1",
        origin: { lat: 44.4268, lng: 26.1025 },
        countsByBand: emptyByBand,
      }),
      expect.any(Date),
    );
    expect(raceOverpass).not.toHaveBeenCalled();
    // The flat whole-clip `counts` is GONE from the real service output, so chips cannot
    // reattach to an un-scoped total. Asserted here rather than in the route test, whose
    // mock-echo shape could never catch a service-side reintroduction.
    expect(result).not.toHaveProperty("counts");
    expect(Object.keys(result).sort()).toEqual([
      "amenities",
      "catalogue",
      "clip",
      "countsByBand",
      "origin",
    ]);
  });

  it("serves a cache hit without ORS or PostGIS and recomputes stale at read time", async () => {
    amenityCacheRead.mockResolvedValue({
      origin: { lat: 44.4268, lng: 26.1025 },
      clip: walkClip,
      countsByBand: { ...emptyByBand, 15: { ...emptyCounts, parks: 3 } },
      amenities: [{ lat: 44.43, lng: 26.1, name: "Park", category: "parks" }],
      sourceTimestamp: "2020-01-01T00:00:00.000Z",
      datasetId: "dataset-1",
    });
    const result = await nearbyAmenities(44.4268, 26.1025);
    expect(totalFor(result.countsByBand, "parks")).toBe(3);
    expect(result.catalogue.stale).toBe(true);
    expect(walkingIsochrone).not.toHaveBeenCalled();
    expect(withActiveDataset).not.toHaveBeenCalled();
    expect(querySummary).not.toHaveBeenCalled();
    expect(amenityCacheWrite).not.toHaveBeenCalled();
  });

  it("ignores a cache row for a different datasetId (post-publish safety)", async () => {
    amenityCacheRead.mockResolvedValue({
      origin: { lat: 44.4268, lng: 26.1025 },
      clip: walkClip,
      countsByBand: emptyByBand,
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
        clip: walkClip,
        countsByBand: emptyByBand,
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
        clip: walkClip,
        countsByBand: emptyByBand,
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
      countsByBand: emptyByBand,
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

  it("answers catalogue-unavailable WITHOUT calling a ring provider, in every mode", async () => {
    // The clip used to be resolved before the catalogue was checked, so a transit
    // request hit MOTIS — and could return a provider 502 — when the deterministic answer
    // was 503. An unavailable catalogue must cost zero upstream calls.
    findActiveDataset.mockResolvedValue(null);
    for (const mode of ["walk", "transit", "car"] as const) {
      await expect(nearbyAmenities(44.4268, 26.1025, "normal", mode)).rejects.toBeInstanceOf(
        CatalogueUnavailableError,
      );
    }
    expect(walkingIsochrone).not.toHaveBeenCalled();
    expect(transitIsochrone).not.toHaveBeenCalled();
    expect(drivingIsochrone).not.toHaveBeenCalled();
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
    await expect(nearbyAmenities(44.4268, 26.1025)).rejects.toThrow(/need 3 ring geometries/);
    expect(withActiveDataset).not.toHaveBeenCalled();
    expect(amenityCacheWrite).not.toHaveBeenCalled();
  });

  it("rejects a ring set with a missing geometry rather than clipping to undefined", async () => {
    walkingIsochrone.mockResolvedValue({
      origin: { lat: 44.4268, lng: 26.1025 },
      rings: [{ minutes: 15, geometry: ring15 }, { minutes: 30 }, { minutes: 45, geometry: ring45 }],
    });
    await expect(nearbyAmenities(44.4268, 26.1025)).rejects.toThrow(/unusable for the amenity clip/);
    expect(withActiveDataset).not.toHaveBeenCalled();
  });
});

describe("nearbyAmenities clips to the CURRENT mode's reach (task 065)", () => {
  it("walk clips to the outermost WALK ring at the requested pace", async () => {
    const result = await nearbyAmenities(44.4268, 26.1025, "slow", "walk");
    expect(walkingIsochrone).toHaveBeenCalledWith(44.4268, 26.1025, "slow");
    expect(transitIsochrone).not.toHaveBeenCalled();
    expect(drivingIsochrone).not.toHaveBeenCalled();
    expect(result.clip).toEqual({ mode: "walk", band: 45, minutes: 45 });
    expect(amenityCacheRead).toHaveBeenCalledWith("amenity:local:v5:dataset-1:walk:slow:44.42680,26.10250");
  });

  it("transit clips to the MOTIS reach and keys the cache by the RESOLVED departure", async () => {
    const result = await nearbyAmenities(44.4268, 26.1025, "normal", "transit");
    expect(transitIsochrone).toHaveBeenCalledWith(44.4268, 26.1025, "normal", {
      kind: "preset",
      preset: "crowded",
    });
    expect(walkingIsochrone).not.toHaveBeenCalled();
    expect(result.clip).toEqual({ mode: "transit", band: 45, minutes: 45 });
    // The departure in the key is the one the RINGS resolved to — not a preset id,
    // which would survive the weekly strictly-future roll and serve a clip computed
    // against last week's rings (task 065 P13/P14).
    expect(amenityCacheRead).toHaveBeenCalledWith(
      "amenity:local:v5:dataset-1:transit:normal:2026-08-05T05:30:00.000Z:44.42680,26.10250",
    );
  });

  it("reuses the transit rings it already fetched — one provider call, not two", async () => {
    await nearbyAmenities(44.4268, 26.1025, "normal", "transit");
    // The departure needed for the cache key comes off the SAME call whose rings
    // are used for the clip (`resolveClip`), so a cold transit origin never asks
    // MOTIS twice.
    expect(transitIsochrone).toHaveBeenCalledTimes(1);
  });

  it("car clips to the outermost DRIVING ring, whose label is 30 — not 45 (P4 regression)", async () => {
    const result = await nearbyAmenities(44.4268, 26.1025, "normal", "car");
    expect(drivingIsochrone).toHaveBeenCalledTimes(1);
    // The clip is the outer BAND POSITION; its displayed minute is the car label.
    expect(result.clip).toEqual({ mode: "car", band: 45, minutes: 30 });
    expect(querySummary).toHaveBeenCalledWith(
      expect.anything(),
      "dataset-1",
      [ring15, ring30, ring45],
      expect.anything(),
    );
    // The car key carries the factor revision: a recalibration changes the ring
    // geometry, so slot-only keying would serve amenities clipped to old rings.
    expect(amenityCacheRead).toHaveBeenCalledWith(
      "amenity:local:v5:dataset-1:car:c1:am-peak:44.42680,26.10250",
    );
  });

  it("forces Normal pace outside walk (a Slow pace must never leak into a transit or car clip)", async () => {
    await nearbyAmenities(44.4268, 26.1025, "slow", "transit");
    expect(transitIsochrone).toHaveBeenCalledWith(44.4268, 26.1025, "normal", expect.anything());
    await nearbyAmenities(44.4268, 26.1025, "slow", "car");
    expect(amenityCacheRead).toHaveBeenCalledWith(
      "amenity:local:v5:dataset-1:car:c1:am-peak:44.42680,26.10250",
    );
  });

  it("does NOT coalesce different MODES for the same origin (P1 — a transit request must not get the walk clip)", async () => {
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
    const walk = nearbyAmenities(44.4268, 26.1025, "normal", "walk");
    const transit = nearbyAmenities(44.4268, 26.1025, "normal", "transit");
    release();
    const [walkResult, transitResult] = await Promise.all([walk, transit]);
    // Two independent computations, each against its OWN provider.
    expect(withActiveDataset).toHaveBeenCalledTimes(2);
    expect(walkingIsochrone).toHaveBeenCalledTimes(1);
    expect(transitIsochrone).toHaveBeenCalledTimes(1);
    expect(walkResult.clip.mode).toBe("walk");
    expect(transitResult.clip.mode).toBe("transit");
  });

  it("does NOT coalesce two transit callers whose RESOLVED departures differ (weekly roll)", async () => {
    // Same preset, different resolved departure — the window this key closes.
    // The flight key is the resolved clip identity, so these must not share a computation:
    // otherwise the second caller gets amenities clipped to the first caller's departure
    // while its own rings were drawn for the new one.
    let call = 0;
    transitIsochrone.mockImplementation(async () => ({
      origin: { lat: 44.4268, lng: 26.1025 },
      rings: walkRings,
      departure: (call += 1) === 1 ? "2026-08-05T05:30:00.000Z" : "2026-08-12T05:30:00.000Z",
    }));
    const a = await nearbyAmenities(44.4268, 26.1025, "normal", "transit");
    const b = await nearbyAmenities(44.4268, 26.1025, "normal", "transit");
    expect(a.clip.mode).toBe("transit");
    expect(b.clip.mode).toBe("transit");
    // Two distinct cache identities ⇒ two independent computations, one per departure.
    const keys = amenityCacheRead.mock.calls.map((c) => c[0] as string);
    expect(keys.some((k) => k.includes("2026-08-05T05:30:00.000Z"))).toBe(true);
    expect(keys.some((k) => k.includes("2026-08-12T05:30:00.000Z"))).toBe(true);
    expect(withActiveDataset).toHaveBeenCalledTimes(2);
  });

  it("does NOT coalesce different TIME CONTEXTS for the same origin and mode", async () => {
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
    const crowded = nearbyAmenities(44.4268, 26.1025, "normal", "car", { kind: "preset", preset: "crowded" });
    const quiet = nearbyAmenities(44.4268, 26.1025, "normal", "car", { kind: "preset", preset: "quiet" });
    release();
    await Promise.all([crowded, quiet]);
    expect(withActiveDataset).toHaveBeenCalledTimes(2);
    const slotKeys = amenityCacheRead.mock.calls.map((c) => c[0] as string);
    expect(slotKeys.some((k) => k.includes(":car:c1:am-peak:"))).toBe(true);
    expect(slotKeys.some((k) => k.includes(":car:c1:midday:"))).toBe(true);
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
    // The active-catalogue probe now runs per request, BEFORE the flight is registered:
    // resolving the clip first let a transit request call MOTIS (and
    // answer 502) when the deterministic answer was 503 catalogue-unavailable. A cheap
    // indexed local read per caller is the accepted price.
    expect(findActiveDataset).toHaveBeenCalledTimes(2);
    // The EXPENSIVE work is still coalesced to one: the ring provider and the pinned
    // dataset read each happen once for the two callers.
    expect(walkingIsochrone).toHaveBeenCalledTimes(1);
    expect(withActiveDataset).toHaveBeenCalledTimes(1);
  });

  it("does NOT coalesce different paces for the same origin (task 051 — a Slow request must not get Normal counts)", async () => {
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
    const slow = nearbyAmenities(44.4268, 26.1025, "slow");
    const normal = nearbyAmenities(44.4268, 26.1025, "normal");
    release();
    await Promise.all([slow, normal]);
    // Distinct flight keys ⇒ two independent computations, each with its OWN pace
    // threaded into the ORS walk-ring call (no coalescing onto a wrong-pace ring).
    expect(walkingIsochrone).toHaveBeenCalledTimes(2);
    const paces = (walkingIsochrone as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[2]);
    expect(paces).toContain("slow");
    expect(paces).toContain("normal");
  });
});

describe("nearbyAmenities merges coincident transit stops (task 047 + per-band counts, task 065)", () => {
  // Two transit stops ~1m apart, different modes → one merged marker. Both in band 15.
  const coincident = [
    { id: "a", lat: 44.4268, lng: 26.1025, name: "Stadion", category: "transit", osmType: "node", osmId: 1, distanceMeters: 10, modes: ["bus"], band: 15 },
    { id: "b", lat: 44.42681, lng: 26.1025, name: "Savinesti", category: "transit", osmType: "node", osmId: 2, distanceMeters: 12, modes: ["tram"], band: 15 },
  ];
  /** Same pair, but the absorbed member sits in the OUTER band — 18m is small, yet it
   * is easily enough to straddle a ring boundary, so a merged group can legitimately
   * span two bands. */
  const straddling = [
    coincident[0],
    { ...coincident[1], band: 45 },
  ];
  const bandCounts = (perBand: Partial<Record<15 | 30 | 45, number>>) => ({
    15: { ...emptyCounts, transit: perBand[15] ?? 0 },
    30: { ...emptyCounts, transit: perBand[30] ?? 0 },
    45: { ...emptyCounts, transit: perBand[45] ?? 0 },
  });

  it("fuses them into one marker with members, and decrements the band the duplicate was counted in", async () => {
    querySummary.mockResolvedValue({
      countsByBand: bandCounts({ 15: 2 }),
      amenities: coincident,
    });
    const result = await nearbyAmenities(44.426801, 26.102499);

    expect(result.amenities).toHaveLength(1);
    expect(result.amenities[0].mergedCount).toBe(2);
    expect(result.amenities[0].members).toHaveLength(2);
    // Both the band chip and the whole-clip total reflect the merge (2 stops → 1 place).
    expect(result.countsByBand[15].transit).toBe(1);
    expect(totalFor(result.countsByBand, "transit")).toBe(1);
    // server-only `modes` never reaches the client payload (F5)
    expect(result.amenities[0]).not.toHaveProperty("modes");
    // and the merged payload is what gets cached
    expect(amenityCacheWrite).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        countsByBand: expect.objectContaining({ 15: expect.objectContaining({ transit: 1 }) }),
      }),
      expect.any(Date),
    );
  });

  it("charges an absorbed stop to ITS OWN band when a merged group straddles a boundary", async () => {
    querySummary.mockResolvedValue({
      countsByBand: bandCounts({ 15: 1, 45: 1 }),
      amenities: straddling,
    });
    const result = await nearbyAmenities(44.426801, 26.102499);

    expect(result.amenities).toHaveLength(1);
    // The representative stays in band 15 and keeps its count; the duplicate is
    // removed from band 45, where it was counted — NOT from the representative's band,
    // which would have driven band 15 to zero while a marker was still drawn in it.
    expect(result.countsByBand[15].transit).toBe(1);
    expect(result.countsByBand[45].transit).toBe(0);
    expect(totalFor(result.countsByBand, "transit")).toBe(1);
  });

  it("keeps the whole-clip transit total equal to the sum of its bands", async () => {
    querySummary.mockResolvedValue({
      // Band 15 counts exactly the 2 rows returned ⇒ COMPLETE, so its duplicate is
      // observable and gets subtracted. Bands 30/45 hold no returned rows here.
      countsByBand: bandCounts({ 15: 2, 30: 3, 45: 5 }),
      amenities: coincident,
    });
    const result = await nearbyAmenities(44.426801, 26.102499);
    const summed =
      result.countsByBand[15].transit +
      result.countsByBand[30].transit +
      result.countsByBand[45].transit;
    expect(totalFor(result.countsByBand, "transit")).toBe(summed);
    // One duplicate absorbed from the complete band 15 ⇒ (2−1) + 3 + 5.
    expect(summed).toBe(9);
  });

  it("moves the representative to the innermost band — band AND point from the SAME row", async () => {
    // The inverted straddle, which is the ONLY case that exercises the round-2 Critical
    // fix: the NEAREST row (distance 10) sits in the OUTER band and its twin ~11m away is
    // inner-band. An earlier version relabelled the nearest row's `band` and kept its coordinates,
    // so a band-15 marker rendered outside the 15-minute shading; the representative now
    // moves instead.
    //
    // Asserts the full row identity, not just the band label: a relabel-only regression
    // must fail here.
    querySummary.mockResolvedValue({
      countsByBand: bandCounts({ 15: 1, 45: 1 }),
      amenities: [
        { ...coincident[0], band: 45, lat: 44.4268, lng: 26.1025, distanceMeters: 10 },
        // ~11 m away: inside the 18 m merge radius (a first attempt used 0.00015° on both
        // axes ≈ 20.5 m and the pair stopped merging at all), yet far enough for a
        // 5-decimal assertion to tell the rows apart.
        { ...coincident[1], band: 15, lat: 44.42688, lng: 26.10258, distanceMeters: 12 },
      ],
    });
    const result = await nearbyAmenities(44.426801, 26.102499);

    expect(result.amenities).toHaveLength(1);
    // Every field of the emitted marker must come from the inner-band row — not just the
    // band label alone.
    expect(result.amenities[0].band).toBe(15);
    expect(result.amenities[0].lat).toBeCloseTo(44.42688, 5);
    expect(result.amenities[0].lng).toBeCloseTo(26.10258, 5);
    expect(result.amenities[0].osmId).toBe(2);
    expect(result.amenities[0].distanceMeters).toBe(12);
    // Both bands were complete, so the duplicate is observable: the outer band loses its
    // row and the inner band keeps the surviving place.
    expect(result.countsByBand[15].transit).toBe(1);
    expect(result.countsByBand[45].transit).toBe(0);
  });

  it("keeps the payload nearest-first after the representative moves outward", async () => {
    // The merge emits the chosen representative at the NEAREST member's array position, so
    // moving the representative to the innermost band can push a farther row ahead of a
    // nearer non-transit one, which the re-sort repairs. Interleaved fixture: transit A (10m, band
    // 45) merges with transit B (14m, band 15) → B represents, so without the re-sort the
    // output would read [B(14), grocery(12)].
    querySummary.mockResolvedValue({
      countsByBand: bandCounts({ 15: 1, 45: 1 }),
      amenities: [
        { ...coincident[0], band: 45, lat: 44.4268, lng: 26.1025, distanceMeters: 10 },
        {
          id: "g",
          lat: 44.4269,
          lng: 26.1027,
          name: "Mega Image",
          category: "groceries",
          osmType: "node",
          osmId: 9,
          distanceMeters: 12,
          band: 15,
        },
        { ...coincident[1], band: 15, lat: 44.42688, lng: 26.10258, distanceMeters: 14 },
      ],
    });
    const result = await nearbyAmenities(44.426801, 26.102499);

    const distances = result.amenities.map((a) => a.distanceMeters);
    expect(distances).toEqual([...distances].sort((x, y) => x - y));
    expect(result.amenities.map((a) => a.name)).toEqual(["Mega Image", "Savinesti"]);
  });

  it("leaves a CAPPED band's transit total RAW, because its duplicates are unobservable", async () => {
    // The "only adjust an uncapped band" gate is deliberate: in a capped band only the duplicates among the returned
    // rows are observable, so subtracting them mixes two bases — part de-duplicated,
    // part raw — into one number that cannot be described honestly. The gate is back:
    // one basis per band. A capped band reports raw stop records (some of which may be
    // the same physical place); the proper fix is merging before capping, which needs
    // the coincident-stop rule inside SQL and is Parked.
    querySummary.mockResolvedValue({
      countsByBand: bandCounts({ 15: 200 }),
      amenities: coincident, // 2 rows returned against a band total of 200 ⇒ capped
    });
    const result = await nearbyAmenities(44.426801, 26.102499);

    expect(result.amenities).toHaveLength(1); // still visually merged
    expect(result.countsByBand[15].transit).toBe(200);
    expect(totalFor(result.countsByBand, "transit")).toBe(200);
  });

  it("never lets a count go negative, and ignores an absorbed stop with no band", async () => {
    querySummary.mockResolvedValue({
      countsByBand: bandCounts({}),
      amenities: [coincident[0], { ...coincident[1], band: undefined }],
    });
    const result = await nearbyAmenities(44.426801, 26.102499);
    expect(result.countsByBand[15].transit).toBe(0);
    expect(totalFor(result.countsByBand, "transit")).toBe(0);
  });
});

describe("amenityResultCacheKey config namespacing (task 007)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is byte-identical on default config", () => {
    expect(amenityResultCacheKey("dataset-1", 44.4268, 26.1025, "walk:normal")).toBe(
      "amenity:local:v5:dataset-1:walk:normal:44.42680,26.10250",
    );
  });

  it("gets a fresh namespace once a ring provider is overridden (amenities are derived from the rings)", () => {
    const def = amenityResultCacheKey("dataset-1", 44.4268, 26.1025, "walk:normal");
    vi.stubEnv("ORS_BASE_URL", "https://ors.internal");
    const overridden = amenityResultCacheKey("dataset-1", 44.4268, 26.1025, "walk:normal");
    expect(overridden).not.toBe(def);
    expect(overridden.endsWith(def)).toBe(true); // tag is a prefix; base key unchanged
  });
});
