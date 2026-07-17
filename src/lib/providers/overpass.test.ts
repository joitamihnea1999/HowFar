import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, providerFetch, walkingIsochrone } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  providerFetch: vi.fn(),
  walkingIsochrone: vi.fn(),
}));

vi.mock("@/lib/api-cache", () => ({
  getCachedSafe: (key: string) => Promise.resolve(store.has(key) ? store.get(key) : null),
  setCachedSafe: (key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  },
}));

vi.mock("@/lib/providers/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  providerFetch,
}));

vi.mock("@/lib/providers/ors", () => ({ walkingIsochrone }));

import { clipToRing, fetchOverpassAmenities, nearbyAmenities } from "./overpass";
import type { Amenity } from "@/lib/amenities";

type Tags = Record<string, string>;
const node = (id: number, lat: number, lon: number, tags: Tags) => ({ type: "node", id, lat, lon, tags });
const way = (id: number, lat: number, lon: number, tags: Tags) => ({
  type: "way",
  id,
  center: { lat, lon },
  tags,
});
const resp = (elements: unknown, remark?: string, ok = true, status = 200) => ({
  ok,
  status,
  json: () => Promise.resolve({ elements, remark }),
});

beforeEach(() => {
  store.clear();
  providerFetch.mockReset();
  walkingIsochrone.mockReset();
});

describe("fetchOverpassAmenities (parse / classify / dedup / cap)", () => {
  it("parses node coords AND way/relation centers, classified by tags", async () => {
    providerFetch.mockResolvedValue(
      resp([
        node(1, 44.44, 26.12, { shop: "supermarket", name: "Kaufland" }),
        way(2, 44.45, 26.11, { leisure: "park", name: "Cișmigiu" }),
      ]),
    );
    const out = await fetchOverpassAmenities(44.4268, 26.1025);
    expect(out).toEqual([
      { lat: 44.44, lng: 26.12, name: "Kaufland", category: "groceries" },
      { lat: 44.45, lng: 26.11, name: "Cișmigiu", category: "parks" },
    ]);
  });

  it("drops uncategorized, non-finite, (0,0), and out-of-area elements", async () => {
    providerFetch.mockResolvedValue(
      resp([
        node(1, 44.44, 26.12, { amenity: "bank" }), // uncategorized
        node(2, Number.NaN, 26.12, { amenity: "pharmacy" }), // non-finite
        node(3, 0, 0, { amenity: "pharmacy" }), // bogus (0,0)
        node(4, 46.77, 23.6, { amenity: "pharmacy" }), // Cluj — out of area
        node(5, 44.44, 26.12, { amenity: "pharmacy", name: "Catena" }), // the only valid one
      ]),
    );
    const out = await fetchOverpassAmenities(44.4268, 26.1025);
    expect(out).toEqual([{ lat: 44.44, lng: 26.12, name: "Catena", category: "pharmacies" }]);
  });

  it("does not throw on null/garbled array entries; still parses the valid ones", async () => {
    providerFetch.mockResolvedValue(
      resp([null, "nope", { center: null }, node(1, 44.44, 26.12, { amenity: "pharmacy", name: "OK" })]),
    );
    expect(await fetchOverpassAmenities(44.4268, 26.1025)).toEqual([
      { lat: 44.44, lng: 26.12, name: "OK", category: "pharmacies" },
    ]);
  });

  it("dedups a duplicated element by OSM type/id", async () => {
    providerFetch.mockResolvedValue(
      resp([
        node(7, 44.44, 26.12, { amenity: "pharmacy" }),
        node(7, 44.44, 26.12, { amenity: "pharmacy" }),
      ]),
    );
    expect(await fetchOverpassAmenities(44.4268, 26.1025)).toHaveLength(1);
  });

  it("does NOT cap the raw envelope (the cap is applied post-clip, not here)", async () => {
    const busStops = Array.from({ length: 400 }, (_, i) => node(1000 + i, 44.44, 26.12, { highway: "bus_stop" }));
    const parks = Array.from({ length: 10 }, (_, i) => way(2000 + i, 44.45, 26.11, { leisure: "park" }));
    providerFetch.mockResolvedValue(resp([...busStops, ...parks]));
    const out = await fetchOverpassAmenities(44.4268, 26.1025);
    const counts = out.reduce<Record<string, number>>((m, a) => ({ ...m, [a.category]: (m[a.category] ?? 0) + 1 }), {});
    expect(counts.transit).toBe(400); // uncapped — distance-fair capping happens after the clip
    expect(counts.parks).toBe(10);
  });

  it("names default to empty string when the element has no name tag", async () => {
    providerFetch.mockResolvedValue(resp([node(1, 44.44, 26.12, { amenity: "pharmacy" })]));
    expect((await fetchOverpassAmenities(44.4268, 26.1025))[0].name).toBe("");
  });

  it("serves a cache hit without a second race", async () => {
    providerFetch.mockResolvedValue(resp([node(1, 44.44, 26.12, { amenity: "pharmacy" })]));
    await fetchOverpassAmenities(44.4, 26.1);
    await fetchOverpassAmenities(44.4, 26.1);
    // One race = 3 endpoints queried; the 2nd call is served from cache (adds 0).
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });
});

describe("fetchOverpassAmenities (endpoint race)", () => {
  it("races all pool endpoints in parallel and returns a healthy result", async () => {
    providerFetch.mockResolvedValue(resp([node(1, 44.44, 26.12, { amenity: "pharmacy" })]));
    const out = await fetchOverpassAmenities(44.4, 26.1);
    expect(out).toHaveLength(1);
    expect(providerFetch).toHaveBeenCalledTimes(3); // all pool endpoints raced, not sequential
  });

  it("wins from a healthy host when siblings return non-ok or a soft timeout remark", async () => {
    providerFetch
      .mockResolvedValueOnce(resp([], undefined, false, 504)) // host 1: hard fail
      .mockResolvedValueOnce(resp([], "runtime error: Query timed out")) // host 2: soft-remark fail
      .mockResolvedValueOnce(resp([node(1, 44.44, 26.12, { amenity: "pharmacy" })])); // host 3: wins
    const out = await fetchOverpassAmenities(44.4, 26.1);
    expect(out).toHaveLength(1);
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it("wins despite a sibling network error and a non-array body", async () => {
    providerFetch
      .mockRejectedValueOnce(new TypeError("network down")) // host 1
      .mockResolvedValueOnce(resp("nope")) // host 2: not an array
      .mockResolvedValueOnce(resp([node(1, 44.44, 26.12, { amenity: "pharmacy" })])); // host 3 wins
    expect(await fetchOverpassAmenities(44.4, 26.1)).toHaveLength(1);
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it("throws ProviderError only when EVERY endpoint fails", async () => {
    providerFetch.mockResolvedValue(resp([], undefined, false, 504));
    await expect(fetchOverpassAmenities(44.4, 26.1)).rejects.toThrow(/overpass unavailable/i);
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it("treats an empty envelope (no remark) as a race loss so a healthy host wins", async () => {
    providerFetch
      .mockResolvedValueOnce(resp([])) // host 1: degraded — empty, no remark
      .mockResolvedValueOnce(resp([node(1, 44.44, 26.12, { amenity: "pharmacy" })])) // host 2 wins
      .mockResolvedValueOnce(resp([node(2, 44.45, 26.13, { amenity: "pharmacy" })]));
    expect(await fetchOverpassAmenities(44.4, 26.1)).toHaveLength(1);
  });

  it("throws when EVERY endpoint returns an empty envelope (never caches empty)", async () => {
    providerFetch.mockResolvedValue(resp([]));
    await expect(fetchOverpassAmenities(44.4, 26.1)).rejects.toThrow(/overpass unavailable/i);
  });

  it("aborts the losing hosts once one wins (fair-use: don't leave 2 queries running)", async () => {
    providerFetch.mockResolvedValue(resp([node(1, 44.44, 26.12, { amenity: "pharmacy" })]));
    await fetchOverpassAmenities(44.4, 26.1);
    const signals = providerFetch.mock.calls.map((c) => (c[1] as { signal: AbortSignal }).signal);
    expect(signals).toHaveLength(3);
    // The race controller is aborted in `finally` once Promise.any settles, so
    // every per-host signal (merged with the race signal) ends up aborted.
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("coalesces concurrent cache misses for one origin into a SINGLE race", async () => {
    providerFetch.mockResolvedValue(resp([node(1, 44.44, 26.12, { amenity: "pharmacy" })]));
    const [a, b] = await Promise.all([
      fetchOverpassAmenities(44.4, 26.1),
      fetchOverpassAmenities(44.4, 26.1),
    ]);
    expect(a).toEqual(b);
    // Single-flight: two concurrent cold callers share ONE 3-endpoint race (3
    // upstream calls), not 6 — otherwise we'd triple-hammer the public mirrors.
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });
});

describe("nearbyAmenities (clip to the 15-min walk ring)", () => {
  const ring15: GeoJSON.Polygon = {
    type: "Polygon",
    coordinates: [
      [
        [26.05, 44.4],
        [26.15, 44.4],
        [26.15, 44.5],
        [26.05, 44.5],
        [26.05, 44.4],
      ],
    ],
  };
  const isoResult = {
    origin: { lat: 44.4268, lng: 26.1025 },
    rings: [
      { minutes: 15, geometry: ring15 },
      { minutes: 30, geometry: ring15 },
      { minutes: 45, geometry: ring15 },
    ],
  };

  it("returns only amenities inside the 15-min ring, in the flat DTO shape", async () => {
    walkingIsochrone.mockResolvedValue(isoResult);
    providerFetch.mockResolvedValue(
      resp([
        node(1, 44.45, 26.1, { amenity: "pharmacy", name: "In" }), // inside
        node(2, 44.45, 26.4, { amenity: "pharmacy", name: "Out" }), // outside the ring
      ]),
    );
    const result = await nearbyAmenities(44.4268, 26.1025);
    expect(result.walkMinutes).toBe(15);
    expect(result.origin).toEqual({ lat: 44.4268, lng: 26.1025 });
    expect(result.amenities).toEqual([{ lat: 44.45, lng: 26.1, name: "In", category: "pharmacies" }]);
    expect(result.counts.pharmacies).toBe(1);
  });

  it("runs the isochrone and Overpass fetch in parallel", async () => {
    walkingIsochrone.mockResolvedValue(isoResult);
    providerFetch.mockResolvedValue(resp([node(1, 44.44, 26.12, { amenity: "pharmacy" })]));
    await nearbyAmenities(44.4268, 26.1025);
    expect(walkingIsochrone).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledTimes(3); // one Overpass race (3 endpoints), run parallel to the isochrone
  });

  it("caps RENDERED markers per category but reports the TRUE clipped counts", async () => {
    walkingIsochrone.mockResolvedValue(isoResult);
    // 200 bus stops all inside ring15 → 150 markers, but the count stays 200.
    const busStops = Array.from({ length: 200 }, (_, i) => node(3000 + i, 44.45, 26.1, { highway: "bus_stop" }));
    const parks = Array.from({ length: 3 }, (_, i) => way(4000 + i, 44.45, 26.11, { leisure: "park" }));
    providerFetch.mockResolvedValue(resp([...busStops, ...parks]));
    const result = await nearbyAmenities(44.4268, 26.1025);
    const markerCounts = result.amenities.reduce<Record<string, number>>(
      (m, a) => ({ ...m, [a.category]: (m[a.category] ?? 0) + 1 }),
      {},
    );
    expect(markerCounts.transit).toBe(150); // capped markers
    expect(result.counts.transit).toBe(200); // true count (uncapped)
    expect(result.counts.parks).toBe(3);
  });

  it("keeps the NEAREST markers when a category is capped", async () => {
    walkingIsochrone.mockResolvedValue(isoResult);
    // A far-but-still-in-ring stop plus 150 near stops: the far one must be dropped.
    const near = Array.from({ length: 150 }, (_, i) => node(5000 + i, 44.4269, 26.1026, { highway: "bus_stop" }));
    const far = node(9999, 44.499, 26.149, { highway: "bus_stop", name: "FarStop" });
    providerFetch.mockResolvedValue(resp([far, ...near])); // far first in envelope order
    const result = await nearbyAmenities(44.4268, 26.1025);
    expect(result.amenities).toHaveLength(150);
    expect(result.amenities.some((a) => a.name === "FarStop")).toBe(false); // nearest-sort dropped it
    expect(result.counts.transit).toBe(151); // but the true count still includes it
  });

  it("throws ProviderError when the walk isochrone has no 15-min ring", async () => {
    walkingIsochrone.mockResolvedValue({
      origin: { lat: 44.4268, lng: 26.1025 },
      rings: [{ minutes: 30, geometry: ring15 }],
    });
    providerFetch.mockResolvedValue(resp([node(1, 44.44, 26.12, { amenity: "pharmacy" })]));
    await expect(nearbyAmenities(44.4268, 26.1025)).rejects.toThrow(/15-min ring/);
  });
});

describe("clipToRing", () => {
  const ring: GeoJSON.Polygon = {
    type: "Polygon",
    coordinates: [
      [
        [26.05, 44.4],
        [26.15, 44.4],
        [26.15, 44.5],
        [26.05, 44.5],
        [26.05, 44.4],
      ],
    ],
  };
  const inside: Amenity = { lat: 44.45, lng: 26.1, name: "in", category: "parks" };
  const outside: Amenity = { lat: 44.45, lng: 26.5, name: "out", category: "parks" };

  it("keeps points inside the ring and drops points outside it", () => {
    expect(clipToRing([inside, outside], ring)).toEqual([inside]);
  });

  it("drops a large way whose center lands outside the ring (point-based clip)", () => {
    // A big park whose OSM `center` is east of the ring is excluded — documented
    // behaviour of clipping by the representative center point.
    const bigParkCenterOutside: Amenity = { lat: 44.45, lng: 26.3, name: "Big Park", category: "parks" };
    expect(clipToRing([bigParkCenterOutside], ring)).toEqual([]);
  });

  it("returns [] for a null/undefined ring rather than throwing", () => {
    expect(clipToRing([inside], null)).toEqual([]);
    expect(clipToRing([inside], undefined)).toEqual([]);
  });
});
