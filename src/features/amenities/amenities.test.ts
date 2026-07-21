import { describe, expect, it } from "vitest";

import {
  buildAmenityFeatures,
  categoryForTags,
  countByCategory,
  type Amenity,
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
});
