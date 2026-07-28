/**
 * Import-cycle guard for the amenities module graph.
 *
 * `amenity-cluster.ts` reads `AMENITY_CATEGORIES` from `amenities.ts` at MODULE
 * INIT (to build its category order and colour lookup). If `amenities.ts` ever
 * imports back from `amenity-cluster.ts`, ESM hands the partially-initialised
 * namespace to whichever module loads second, and that top-level `.map(...)`
 * throws `Cannot read properties of undefined`.
 *
 * That is not theoretical — task 061 introduced exactly this cycle by putting a
 * shared sort-key constant in `amenity-cluster.ts`, and it crashed with that
 * error whenever `amenities.ts` was the entry module. Typecheck passed and the
 * per-module unit tests passed, because they happened to import in the safe
 * order; only entry-order mattered.
 *
 * This file's FIRST import is deliberately the base module, reproducing the
 * failing order, so a reintroduced cycle fails here instead of at runtime.
 */

// NOTE: this import must stay FIRST — import order is the thing under test.
import { buildAmenityFeatures, countByCategory, UNKNOWN_DISTANCE_SORT } from "@/features/amenities/amenities";

import { describe, expect, it } from "vitest";

import { clusterCategoryCounts, donutArcs } from "./amenity-cluster";
import { amenityIconSvg } from "./amenity-icons";

describe("amenities module graph", () => {
  it("initialises when the base domain module is the entry point (no import cycle)", () => {
    const features = buildAmenityFeatures([
      { lat: 44.4, lng: 26.1, name: "Mega Image", category: "groceries", distanceMeters: 120 },
    ]);
    expect(features).toHaveLength(1);
    expect(features[0].properties?.distanceSort).toBeCloseTo(120, 3);
    expect(UNKNOWN_DISTANCE_SORT).toBeGreaterThan(0);
  });

  it("leaves the display modules fully initialised under that same order", () => {
    // If a cycle were reintroduced, these would be the throwing call sites.
    expect(clusterCategoryCounts({ groceries: 2 })).toEqual([{ category: "groceries", count: 2 }]);
    expect(donutArcs([{ category: "groceries", count: 2 }], 16)).toHaveLength(1);
    expect(amenityIconSvg("groceries", { sizePx: 24, color: "#000" })).toContain("<svg");
    expect(countByCategory([{ lat: 0, lng: 0, name: "", category: "parks" }]).parks).toBe(1);
  });
});
