import { describe, expect, it } from "vitest";

import {
  amenityDistanceSort,
  formatDistance,
  UNKNOWN_DISTANCE_SORT,
  type Amenity,
} from "./amenities";
import {
  ALL_AMENITY_CATEGORY_KEYS,
  cappedAmenityTotal,
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

describe("cappedAmenityTotal", () => {
  const counts = (o: Partial<Record<string, number>>) => ({
    groceries: 0, pharmacies: 0, parks: 0, schools: 0, transit: 0, ...o,
  }) as never;

  it("returns null when nothing was capped, so the note never appears falsely", () => {
    expect(cappedAmenityTotal(counts({ groceries: 3, parks: 2 }), 5)).toBeNull();
  });

  it("returns the TRUE in-ring total when the server capped the markers", () => {
    // The chips report pre-cap totals while the payload is capped per category, so
    // summing donut counts on the map disagrees with the chips — the note explains it.
    expect(cappedAmenityTotal(counts({ groceries: 200, transit: 91 }), 155)).toBe(291);
  });

  it("is exact at the boundary (no off-by-one note when totals equal the payload)", () => {
    expect(cappedAmenityTotal(counts({ groceries: 10 }), 10)).toBeNull();
    expect(cappedAmenityTotal(counts({ groceries: 11 }), 10)).toBe(11);
  });

  it("returns null with no counts at all", () => {
    expect(cappedAmenityTotal(null, 0)).toBeNull();
  });

  it("counts ONLY the selected categories, so a filtered map is not described by hidden ones", () => {
    // Hiding a category used to leave the note quoting places the user could not
    // see: "the nearest N of M" summed every category (found in review). An honesty note
    // that is itself misleading is worse than no note.
    const c = counts({ groceries: 200, parks: 300 });
    expect(cappedAmenityTotal(c, 150, ["groceries"])).toBe(200);
    expect(cappedAmenityTotal(c, 150, ["parks"])).toBe(300);
    expect(cappedAmenityTotal(c, 150, ["groceries", "parks"])).toBe(500);
  });

  it("shows no note when the SELECTED categories were not capped, even though others were", () => {
    // Groceries is capped, pharmacies is not. Viewing pharmacies alone must not
    // inherit the groceries cap.
    const c = counts({ groceries: 400, pharmacies: 3 });
    expect(cappedAmenityTotal(c, 3, ["pharmacies"])).toBeNull();
    expect(cappedAmenityTotal(c, 153, ["groceries", "pharmacies"])).toBe(403);
  });

  it("defaults to every category, which is the all-on default selection", () => {
    const c = counts({ groceries: 200, parks: 300 });
    expect(cappedAmenityTotal(c, 150)).toBe(cappedAmenityTotal(c, 150, ALL_AMENITY_CATEGORY_KEYS));
  });
});

describe("formatDistance", () => {
  it("rounds to 10 m below a kilometre — metre precision would overstate accuracy", () => {
    expect(formatDistance(0)).toBe("10 m");
    expect(formatDistance(214)).toBe("210 m");
    expect(formatDistance(999)).toBe("1000 m");
  });

  it("switches to km with one decimal, then whole km when far", () => {
    expect(formatDistance(1000)).toBe("1.0 km");
    expect(formatDistance(1240)).toBe("1.2 km");
    expect(formatDistance(15400)).toBe("15 km");
  });

  it("returns an empty string for unusable input rather than visible nonsense", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(formatDistance(bad)).toBe("");
    }
  });
});

describe("amenityDistanceSort", () => {
  it("sorts a missing distance LAST so unmeasured places never outrank measured ones", () => {
    expect(amenityDistanceSort(undefined, 0)).toBeGreaterThan(amenityDistanceSort(99999, 0));
    expect(amenityDistanceSort(Number.NaN, 0)).toBeGreaterThanOrEqual(UNKNOWN_DISTANCE_SORT);
  });

  it("breaks ties deterministically by index without reordering real distances", () => {
    // A raw tie lets MapLibre thin labels arbitrarily, so the surviving label set
    // could differ between repaints of identical data.
    const a = amenityDistanceSort(300, 0);
    const b = amenityDistanceSort(300, 1);
    expect(a).toBeLessThan(b);
    expect(amenityDistanceSort(300, 999)).toBeLessThan(amenityDistanceSort(301, 0));
  });

  it("passes a valid distance through as its integer part", () => {
    expect(Math.floor(amenityDistanceSort(420, 0))).toBe(420);
  });

  it("preserves order for FRACTIONAL near-ties at far-apart indices", () => {
    // The tie-break is a sub-metre nudge, so a review asked the obvious question:
    // can it invert two places whose distances differ by less than the nudge? The
    // answer depends on a precondition -- `items` reaches `buildAmenityFeatures`
    // already distance-sorted (SQL `ORDER BY distance, category, id`, and both
    // `mergeCoincidentTransitStops` and `filterAmenityItems` preserve order). Under
    // it, a later index always carries a distance >= the earlier one, so the nudge
    // can only ever separate equals. These are the near-tied, non-adjacent,
    // fractional cases the previous test (integers 1m apart) did not reach.
    expect(amenityDistanceSort(300.0001, 0)).toBeLessThan(amenityDistanceSort(300.0002, 400));
    expect(amenityDistanceSort(300.5, 10)).toBeLessThan(amenityDistanceSort(300.5, 900));
    expect(amenityDistanceSort(300, 0)).toBeLessThan(amenityDistanceSort(300.0000001, 999));
  });

  it("is non-decreasing across a whole distance-sorted payload, near-ties included", () => {
    const distances = [10, 10, 10.0004, 10.9, 11, 11.0001, 250.5, 250.5, 999.999, 1000];
    const keys = distances.map((d, i) => amenityDistanceSort(d, i));
    for (let i = 1; i < keys.length; i++) expect(keys[i]).toBeGreaterThan(keys[i - 1]);
  });

  it("caps the nudge so a huge payload cannot push a place past the next metre", () => {
    // min(index, 999)/1000 keeps the nudge strictly under 1m for any payload size.
    expect(amenityDistanceSort(300, 5000) - 300).toBeLessThan(1);
    expect(amenityDistanceSort(300, 5000)).toBeLessThan(amenityDistanceSort(301, 0));
  });
});

describe("band visibility rides the DATA path, not a layer filter (task 065)", () => {
  const place = (name: string, category: "groceries" | "parks", band?: 15 | 30 | 45) => ({
    lat: 44.4,
    lng: 26.1,
    name,
    category,
    ...(band === undefined ? {} : { band }),
  });
  const items = [
    place("Inner Shop", "groceries", 15),
    place("Mid Shop", "groceries", 30),
    place("Outer Shop", "groceries", 45),
    place("Inner Park", "parks", 15),
    place("Outer Park", "parks", 45),
  ];

  it("returns only places in the visible bands, cumulatively", () => {
    const names = (bands: (15 | 30 | 45)[]) =>
      filterAmenityItems(items, ["groceries", "parks"], "", bands).map((i) => i.name);
    // Filter 15 → inner only.
    expect(names([15])).toEqual(["Inner Shop", "Inner Park"]);
    // Filter 30 shades 15+30, so the inner places STAY (the cumulative rule).
    expect(names([15, 30])).toEqual(["Inner Shop", "Mid Shop", "Inner Park"]);
    // All bands → everything.
    expect(names([15, 30, 45])).toHaveLength(5);
  });

  it("composes band ∩ category ∩ text query in one pass", () => {
    expect(
      filterAmenityItems(items, ["groceries"], "shop", [15, 30]).map((i) => i.name),
    ).toEqual(["Inner Shop", "Mid Shop"]);
    // A hidden category is still hidden regardless of band.
    expect(filterAmenityItems(items, ["parks"], "", [30]).map((i) => i.name)).toEqual([]);
  });

  it("treats an omitted or empty band list as 'no band restriction'", () => {
    // Keeps the browse list and popup callers working unchanged.
    expect(filterAmenityItems(items, ["groceries", "parks"])).toHaveLength(5);
    expect(filterAmenityItems(items, ["groceries", "parks"], "", [])).toHaveLength(5);
  });

  it("keeps a place with NO band visible rather than hiding it", () => {
    // A malformed payload must not make a populated area look empty; the place is
    // still real, so it renders.
    const withUnbanded = [...items, place("Unknown Band Shop", "groceries")];
    expect(
      filterAmenityItems(withUnbanded, ["groceries"], "", [15]).map((i) => i.name),
    ).toEqual(["Inner Shop", "Unknown Band Shop"]);
  });

  it("scopes the capped-total note to the counts it was given", () => {
    // `counts` reaching the UI is ALREADY band-scoped, so the note can never quote
    // a total for bands the user cannot see.
    const bandScoped = { groceries: 2, pharmacies: 0, parks: 1, schools: 0, transit: 0 };
    expect(cappedAmenityTotal(bandScoped, 3, ["groceries", "parks"])).toBeNull();
    expect(cappedAmenityTotal(bandScoped, 2, ["groceries", "parks"])).toBe(3);
  });
});
