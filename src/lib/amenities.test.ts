import { describe, expect, it } from "vitest";

import {
  AMENITY_ENVELOPE_M,
  buildAmenityFeatures,
  buildOverpassQuery,
  capPerCategory,
  categoryForTags,
  countByCategory,
  type Amenity,
} from "./amenities";

describe("buildOverpassQuery", () => {
  const q = buildOverpassQuery(44.4268, 26.1025);

  it("wraps the union in a json/timeout envelope and emits `out center;` (not `out tags;`)", () => {
    expect(q.startsWith("[out:json][timeout:25];(")).toBe(true);
    expect(q.endsWith(");out center;")).toBe(true);
    // `out tags;` would drop node coordinates — the bug this guards against.
    expect(q).not.toMatch(/out\s+tags;/);
  });

  it("interpolates the around:radius,lat,lng triple into every clause", () => {
    const clauses = q.match(new RegExp(`nwr\\(around:${AMENITY_ENVELOPE_M},44.4268,26.1025\\)`, "g"));
    // groceries(1) + pharmacies(1) + parks(1) + schools(1) + transit(3) = 7 predicates.
    expect(clauses).toHaveLength(7);
  });

  it("carries each category's tag predicate and excludes subway_entrance", () => {
    expect(q).toContain(`[shop~"^(supermarket|convenience|greengrocer)$"]`);
    expect(q).toContain(`[amenity~"^(pharmacy)$"]`);
    expect(q).toContain(`[leisure~"^(park|garden)$"]`);
    expect(q).toContain(`[amenity~"^(school|kindergarten|university)$"]`);
    expect(q).toContain(`[highway~"^(bus_stop)$"]`);
    expect(q).toContain(`[railway~"^(station|tram_stop)$"]`);
    expect(q).not.toContain("subway_entrance");
  });
});

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

describe("capPerCategory", () => {
  it("keeps at most `max` per category and never starves a sparse category", () => {
    const transit: Amenity[] = Array.from({ length: 400 }, (_, i) => ({
      lat: 1,
      lng: 1,
      name: `t${i}`,
      category: "transit",
    }));
    const parks: Amenity[] = Array.from({ length: 3 }, (_, i) => ({
      lat: 1,
      lng: 1,
      name: `p${i}`,
      category: "parks",
    }));
    const capped = capPerCategory([...transit, ...parks], 150);
    const counts = countByCategory(capped);
    expect(counts.transit).toBe(150);
    expect(counts.parks).toBe(3);
  });

  it("preserves input order within a category", () => {
    const items: Amenity[] = [
      { lat: 1, lng: 1, name: "first", category: "parks" },
      { lat: 2, lng: 2, name: "second", category: "parks" },
    ];
    expect(capPerCategory(items, 1)).toEqual([items[0]]);
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
});
