import { describe, expect, it } from "vitest";

import {
  buildAmenityFeatures,
  categoryForTags,
  countByCategory,
  deriveTransitModes,
  parseAmenityMembers,
  type Amenity,
  type TransitStopMember,
  AMENITY_CATEGORIES,
  countsForBands,
  emptyCountsByBand,
} from "./amenities";

describe("categoryForTags", () => {
  it("maps each category's representative tag to its key", () => {
    expect(categoryForTags({ shop: "supermarket" })).toBe("groceries");
    expect(categoryForTags({ shop: "convenience" })).toBe("groceries");
    expect(categoryForTags({ amenity: "pharmacy" })).toBe("pharmacies");
    expect(categoryForTags({ leisure: "park" })).toBe("parks");
    expect(categoryForTags({ amenity: "kindergarten" })).toBe("schools");
    expect(categoryForTags({ highway: "bus_stop" })).toBe("transit");
    expect(categoryForTags({ railway: "tram_stop" })).toBe("transit");
    expect(categoryForTags({ station: "subway" })).toBe("transit");
  });

  it("returns null for unmatched or absent tags", () => {
    expect(categoryForTags({ amenity: "bank" })).toBeNull();
    expect(categoryForTags({ building: "yes" })).toBeNull();
    expect(categoryForTags({ shop: "clothes" })).toBeNull();
    expect(categoryForTags(undefined)).toBeNull();
    expect(categoryForTags({})).toBeNull();
  });

  it("assigns a multi-tag element to exactly the FIRST matching category (no double count)", () => {
    // A supermarket that also carries a pharmacy counter → groceries wins (order).
    expect(categoryForTags({ shop: "supermarket", amenity: "pharmacy" })).toBe("groceries");
  });
});

describe("countByCategory", () => {
  it("counts per key and zero-fills every category", () => {
    const items: Amenity[] = [
      { lat: 1, lng: 1, name: "a", category: "groceries" },
      { lat: 1, lng: 1, name: "b", category: "groceries" },
      { lat: 1, lng: 1, name: "c", category: "transit" },
    ];
    expect(countByCategory(items)).toEqual({
      groceries: 2,
      pharmacies: 0,
      parks: 0,
      schools: 0,
      transit: 1,
    });
  });

  it("sums to the input length (no element lost or double-counted)", () => {
    const items: Amenity[] = Array.from({ length: 37 }, (_, i) => ({
      lat: 1,
      lng: 1,
      name: `n${i}`,
      category: (["groceries", "pharmacies", "parks", "schools", "transit"] as const)[i % 5],
    }));
    const counts = countByCategory(items);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(items.length);
  });
});

describe("buildAmenityFeatures", () => {
  it("emits GeoJSON points with per-category color and [lng,lat] coordinates", () => {
    const features = buildAmenityFeatures([{ lat: 44.4, lng: 26.1, name: "Kaufland", category: "groceries" }]);
    expect(features).toHaveLength(1);
    const f = features[0];
    expect(f.geometry).toEqual({ type: "Point", coordinates: [26.1, 44.4] });
    expect(f.properties).toMatchObject({ category: "groceries", color: "#e69f00", name: "Kaufland" });
  });

  it("maps empty input to empty features", () => {
    expect(buildAmenityFeatures([])).toEqual([]);
  });

  it("carries osmType/osmId into properties so a transit click can look up its lines", () => {
    const [f] = buildAmenityFeatures([
      { lat: 44.44, lng: 26.09, name: "Piața Romană", category: "transit", osmType: "node", osmId: 444384784 },
    ]);
    expect(f.properties).toMatchObject({
      category: "transit",
      name: "Piața Romană",
      osmType: "node",
      osmId: 444384784,
    });
  });

  it("omits osmType/osmId entirely when absent (never a stringified undefined)", () => {
    const [f] = buildAmenityFeatures([{ lat: 1, lng: 1, name: "x", category: "parks" }]);
    expect(f.properties).not.toHaveProperty("osmType");
    expect(f.properties).not.toHaveProperty("osmId");
  });

  it("stringifies members (task 047) so the flat-prop contract holds; round-trips via parseAmenityMembers", () => {
    const members: TransitStopMember[] = [
      { osmType: "node", osmId: 1, name: "A", lat: 44.4, lng: 26.1 },
      { osmType: "node", osmId: 2, name: "B", lat: 44.4001, lng: 26.1001 },
    ];
    const [f] = buildAmenityFeatures([
      { lat: 44.4, lng: 26.1, name: "A", category: "transit", osmType: "node", osmId: 1, members, mergedCount: 2 },
    ]);
    expect(typeof f.properties!.members).toBe("string");
    expect(f.properties!.mergedCount).toBe(2);
    expect(parseAmenityMembers(f.properties!.members)).toEqual(members);
  });

  it("omits members for an unmerged (single-stop) marker", () => {
    const [f] = buildAmenityFeatures([
      { lat: 44.4, lng: 26.1, name: "A", category: "transit", osmType: "node", osmId: 1 },
    ]);
    expect(f.properties).not.toHaveProperty("members");
    expect(f.properties).not.toHaveProperty("mergedCount");
  });
});

describe("deriveTransitModes", () => {
  it("maps single-tag stops to their mode", () => {
    expect(deriveTransitModes({ highway: "bus_stop" })).toEqual(["bus"]);
    expect(deriveTransitModes({ railway: "tram_stop" })).toEqual(["tram"]);
    expect(deriveTransitModes({ railway: "station", station: "subway" })).toEqual(["metro"]);
    expect(deriveTransitModes({ railway: "station" })).toEqual(["rail"]);
  });

  it("returns a SET for a dual-tagged platform (bus_stop + tram=yes)", () => {
    expect(deriveTransitModes({ highway: "bus_stop", tram: "yes" })).toEqual(["bus", "tram"]);
  });

  it("returns [] for null/empty or non-transit tags", () => {
    expect(deriveTransitModes(null)).toEqual([]);
    expect(deriveTransitModes(undefined)).toEqual([]);
    expect(deriveTransitModes({ amenity: "cafe" })).toEqual([]);
  });
});

describe("parseAmenityMembers", () => {
  const valid: TransitStopMember = { osmType: "node", osmId: 5, name: "X", lat: 44.4, lng: 26.1 };

  it("accepts both a JSON string (WebGL feature) and a raw array (keyboard feature)", () => {
    expect(parseAmenityMembers(JSON.stringify([valid]))).toEqual([valid]);
    expect(parseAmenityMembers([valid])).toEqual([valid]);
  });

  it("drops members without a usable identity or coords, and returns [] for garbage", () => {
    expect(parseAmenityMembers([{ osmType: "node", osmId: 0, name: "", lat: 1, lng: 1 }])).toEqual([]);
    expect(parseAmenityMembers([{ osmType: "node", osmId: 5, name: "", lat: NaN, lng: 1 }])).toEqual([]);
    expect(parseAmenityMembers("not json")).toEqual([]);
    expect(parseAmenityMembers(undefined)).toEqual([]);
    expect(parseAmenityMembers(42)).toEqual([]);
  });
});

describe("per-band count helpers (task 065)", () => {
  it("emptyCountsByBand zero-fills every band and category", () => {
    const empty = emptyCountsByBand();
    expect(Object.keys(empty).map(Number).sort((a, b) => a - b)).toEqual([15, 30, 45]);
    for (const band of [15, 30, 45] as const) {
      for (const { key } of AMENITY_CATEGORIES) expect(empty[band][key]).toBe(0);
    }
  });

  it("countsForBands sums only the bands asked for — the honest chip figure", () => {
    const byBand = {
      15: { groceries: 1, pharmacies: 2, parks: 0, schools: 0, transit: 3 },
      30: { groceries: 10, pharmacies: 0, parks: 5, schools: 0, transit: 0 },
      45: { groceries: 100, pharmacies: 0, parks: 0, schools: 7, transit: 0 },
    };
    // Default view (inner band only) must NOT include the outer bands' places.
    expect(countsForBands(byBand, [15])).toEqual({
      groceries: 1, pharmacies: 2, parks: 0, schools: 0, transit: 3,
    });
    // Cumulative widening adds them.
    expect(countsForBands(byBand, [15, 30])).toEqual({
      groceries: 11, pharmacies: 2, parks: 5, schools: 0, transit: 3,
    });
    expect(countsForBands(byBand, [15, 30, 45])).toEqual({
      groceries: 111, pharmacies: 2, parks: 5, schools: 7, transit: 3,
    });
    // No bands visible → all zeros, never a leftover total.
    expect(countsForBands(byBand, [])).toEqual({
      groceries: 0, pharmacies: 0, parks: 0, schools: 0, transit: 0,
    });
  });

  it("tolerates a malformed payload missing a band or a category", () => {
    // A bad response must degrade to an undercount, never throw or produce NaN in a chip.
    const partial = { 15: { groceries: 4 } } as unknown as Parameters<typeof countsForBands>[0];
    expect(countsForBands(partial, [15, 30, 45])).toEqual({
      groceries: 4, pharmacies: 0, parks: 0, schools: 0, transit: 0,
    });
  });
});
