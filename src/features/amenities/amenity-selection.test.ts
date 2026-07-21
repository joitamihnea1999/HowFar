import { describe, expect, it } from "vitest";

import type { Amenity } from "./amenities";
import {
  ALL_AMENITY_CATEGORY_KEYS,
  amenityMapCategoryFilter,
  filterAmenityItems,
  normalizeAmenitySelection,
  parseAmenitySelection,
  serializeAmenitySelection,
  toggleAmenityCategory,
} from "./amenity-selection";

const items: Amenity[] = [
  { lat: 1, lng: 1, name: "Central Market", category: "groceries" },
  { lat: 2, lng: 2, name: "Central Park", category: "parks" },
  { lat: 3, lng: 3, name: "School 1", category: "schools" },
];

describe("amenity category selection", () => {
  it("defaults to every category and toggles in canonical display order", () => {
    expect(ALL_AMENITY_CATEGORY_KEYS).toEqual([
      "groceries",
      "pharmacies",
      "parks",
      "schools",
      "transit",
    ]);
    expect(toggleAmenityCategory(ALL_AMENITY_CATEGORY_KEYS, "parks")).toEqual([
      "groceries",
      "pharmacies",
      "schools",
      "transit",
    ]);
    expect(toggleAmenityCategory([], "parks")).toEqual(["parks"]);
  });

  it("composes category selection AND text filtering", () => {
    expect(filterAmenityItems(items, ["groceries", "schools"], "central")).toEqual([items[0]]);
    expect(filterAmenityItems(items, [], "central")).toEqual([]);
    expect(filterAmenityItems(items, ALL_AMENITY_CATEGORY_KEYS)).toEqual(items);
  });

  it("round-trips empty and partial versioned preferences", () => {
    expect(parseAmenitySelection(serializeAmenitySelection([]))).toEqual([]);
    expect(parseAmenitySelection(serializeAmenitySelection(["parks", "groceries"]))).toEqual([
      "groceries",
      "parks",
    ]);
  });

  it("rejects malformed/unknown preference versions and drops unknown keys", () => {
    expect(parseAmenitySelection(null)).toBeNull();
    expect(parseAmenitySelection(""), "empty storage value").toBeNull();
    expect(parseAmenitySelection("not-json")).toBeNull();
    expect(parseAmenitySelection('{"version":2,"selected":["parks"]}')).toBeNull();
    expect(parseAmenitySelection('{"version":1}')).toBeNull();
    expect(parseAmenitySelection('{"version":1,"selected":[7]}')).toBeNull();
    expect(parseAmenitySelection('{"version":1,"selected":["parks","bogus"]}')).toEqual([
      "parks",
    ]);
    expect(normalizeAmenitySelection(["transit", "transit", "bogus"])).toEqual(["transit"]);
  });

  it("builds a MapLibre category filter that matches list visibility rules", () => {
    expect(amenityMapCategoryFilter(ALL_AMENITY_CATEGORY_KEYS)).toBeNull();
    expect(amenityMapCategoryFilter([])).toEqual(["boolean", false]);
    const partial = amenityMapCategoryFilter(["parks", "transit"]);
    expect(partial).toEqual([
      "match",
      ["get", "category"],
      "parks",
      true,
      "transit",
      true,
      false,
    ]);
    // Same selection drives list filtering (shared SSOT).
    expect(filterAmenityItems(items, ["parks", "transit"]).map((i) => i.category)).toEqual([
      "parks",
    ]);
  });
});
