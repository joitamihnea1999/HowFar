import { describe, expect, it } from "vitest";

import { AMENITY_CATEGORIES, MAX_PER_CATEGORY_PER_BAND } from "@/features/amenities/amenities";
import { LEGEND_BANDS } from "@/features/isochrones/bands";
import { MAP_MAX_ZOOM } from "@/features/amenities/amenity-cluster";

import {
  CLUSTER_LEAF_PAGE,
  collectClusterLeaves,
  decideClusterAction,
  decideMarkAction,
  dedupeAmenities,
  leavesToAmenities,
  MAX_CLUSTER_LEAVES,
  type LeafFeature,
} from "./cluster-expand";
import { SPIDER_MAX_LEAVES } from "@/features/amenities/amenity-spider";

describe("decideClusterAction", () => {
  it("zooms when the cluster can actually split at a reachable zoom", () => {
    expect(decideClusterAction(15, MAP_MAX_ZOOM)).toEqual({ kind: "zoom", zoom: 15 });
    expect(decideClusterAction(MAP_MAX_ZOOM, MAP_MAX_ZOOM)).toEqual({ kind: "zoom", zoom: MAP_MAX_ZOOM });
  });

  it("lists instead of zooming when the split zoom is beyond the map maximum", () => {
    // The case the whole floor exists for: genuinely coincident places report an
    // expansion zoom ABOVE the map's max, so zooming would silently do nothing
    // and the user would be stuck clicking a donut that never opens.
    expect(decideClusterAction(MAP_MAX_ZOOM + 1, MAP_MAX_ZOOM)).toEqual({ kind: "list" });
    expect(decideClusterAction(99, MAP_MAX_ZOOM)).toEqual({ kind: "list" });
  });

  it("falls back to the always-correct list branch for a non-finite expansion zoom", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(decideClusterAction(bad, MAP_MAX_ZOOM)).toEqual({ kind: "list" });
    }
  });
});

describe("leavesToAmenities", () => {
  const leaf = (props: Record<string, unknown>, coords: unknown = [26.1, 44.4]): LeafFeature => ({
    properties: props,
    geometry: { type: "Point", coordinates: coords },
  });

  it("maps properties and coordinates onto Amenity records", () => {
    const out = leavesToAmenities([
      leaf({ name: "Mega Image", category: "groceries", osmType: "node", osmId: 5, distanceMeters: 210 }),
    ]);
    expect(out).toEqual([
      {
        lat: 44.4,
        lng: 26.1,
        name: "Mega Image",
        category: "groceries",
        osmType: "node",
        osmId: 5,
        distanceMeters: 210,
      },
    ]);
  });

  it("sorts nearest-first so the list matches label priority and the browser order", () => {
    const out = leavesToAmenities([
      leaf({ name: "Far", category: "parks", distanceMeters: 900 }),
      leaf({ name: "Near", category: "parks", distanceMeters: 100 }),
      leaf({ name: "Mid", category: "parks", distanceMeters: 400 }),
    ]);
    expect(out.map((a) => a.name)).toEqual(["Near", "Mid", "Far"]);
  });

  it("puts distance-less leaves last and breaks ties by name (deterministic order)", () => {
    const out = leavesToAmenities([
      leaf({ name: "Zeta", category: "parks" }),
      leaf({ name: "Alpha", category: "parks" }),
      leaf({ name: "Measured", category: "parks", distanceMeters: 500 }),
    ]);
    expect(out.map((a) => a.name)).toEqual(["Measured", "Alpha", "Zeta"]);
  });

  it("drops leaves with unusable coordinates rather than placing them at (0,0)", () => {
    // A row that flies the camera into the Gulf of Guinea is worse than no row.
    const out = leavesToAmenities([
      leaf({ name: "ok", category: "parks" }),
      leaf({ name: "no coords", category: "parks" }, null),
      leaf({ name: "short", category: "parks" }, [26.1]),
      leaf({ name: "nan", category: "parks" }, ["x", "y"]),
      { properties: { name: "no geometry", category: "parks" }, geometry: null },
    ]);
    expect(out.map((a) => a.name)).toEqual(["ok"]);
  });

  it("drops leaves with no category, since category drives colour and icon", () => {
    expect(leavesToAmenities([leaf({ name: "orphan" })])).toEqual([]);
    expect(leavesToAmenities([leaf({ name: "orphan", category: 7 })])).toEqual([]);
  });

  it("omits an invalid osmId and a negative distance instead of passing them through", () => {
    const [a] = leavesToAmenities([
      leaf({ name: "x", category: "transit", osmId: 0, distanceMeters: -3 }),
    ]);
    expect(a.osmId).toBeUndefined();
    expect(a.distanceMeters).toBeUndefined();
  });

  it("passes `members` through untouched in either wire form", () => {
    // MapLibre flattens feature properties, so a WebGL leaf carries the merged
    // 047 members as a JSON STRING while a synthetic one carries the array;
    // parseAmenityMembers downstream accepts both, so neither is transformed here.
    const asString = JSON.stringify([{ osmType: "node", osmId: 1, name: "A", lat: 1, lng: 2 }]);
    const [fromString] = leavesToAmenities([leaf({ name: "s", category: "transit", members: asString })]);
    expect((fromString as { members?: unknown }).members).toBe(asString);

    const asArray = [{ osmType: "node", osmId: 1, name: "A", lat: 1, lng: 2 }];
    const [fromArray] = leavesToAmenities([leaf({ name: "a", category: "transit", members: asArray })]);
    expect((fromArray as { members?: unknown }).members).toBe(asArray);
  });

  it("handles an empty leaf set and null properties without throwing", () => {
    expect(leavesToAmenities([])).toEqual([]);
    expect(leavesToAmenities([{ properties: null, geometry: null }])).toEqual([]);
  });

  it("bounds the requested leaf count above the server's OWN ceiling, not a guessed number", () => {
    // Was `> 150`, which a cap of 151 would satisfy while a real cluster can hold
    // MAX_PER_CATEGORY_PER_BAND x every category x every band = 1500 (task 065; review: the absorbed-pin paging fix was
    // protected by an assertion that could not fail). Tied to the two constants
    // that actually decide the ceiling, so raising either fails here instead of
    // silently truncating a list.
    expect(MAX_CLUSTER_LEAVES).toBeGreaterThanOrEqual(
      MAX_PER_CATEGORY_PER_BAND * AMENITY_CATEGORIES.length * LEGEND_BANDS.length,
    );
  });
});

describe("collectClusterLeaves", () => {
  const page = (n: number, tag: string): LeafFeature[] =>
    Array.from({ length: n }, (_, i) => ({
      properties: { category: "groceries", name: `${tag}-${i}` },
      geometry: { type: "Point", coordinates: [26, 44] },
    }));

  it("walks offsets until a short page ends the cluster", async () => {
    const calls: [number, number, number][] = [];
    const out = await collectClusterLeaves(
      [7],
      async (id, limit, offset) => {
        calls.push([id, limit, offset]);
        return offset === 0 ? page(CLUSTER_LEAF_PAGE, "a") : page(30, "b");
      },
      () => true,
    );
    expect(calls).toEqual([
      [7, CLUSTER_LEAF_PAGE, 0],
      [7, CLUSTER_LEAF_PAGE, CLUSTER_LEAF_PAGE],
    ]);
    expect(out).toHaveLength(CLUSTER_LEAF_PAGE + 30);
  });

  it("reaches every leaf of a cluster at the server's real ceiling", async () => {
    // 750 coincident places is legal (150 per category x 5). Before paging, leaf
    // 251 onward was unreachable while the popup still implied it was listed.
    const TOTAL = MAX_PER_CATEGORY_PER_BAND * AMENITY_CATEGORIES.length * LEGEND_BANDS.length;
    const out = await collectClusterLeaves(
      [1],
      async (_id, limit, offset) => page(Math.max(0, Math.min(limit, TOTAL - offset)), `p${offset}`),
      () => true,
    );
    expect(out).toHaveLength(TOTAL);
  });

  it("unions the pages of every cluster in a merged mark", async () => {
    const out = await collectClusterLeaves(
      [1, 2, 3],
      async () => page(2, "x"),
      () => true,
    );
    expect(out).toHaveLength(6);
  });

  it("abandons as null the moment the caller's generation is superseded", async () => {
    let live = true;
    const out = await collectClusterLeaves(
      [1, 2],
      async () => {
        const p = page(CLUSTER_LEAF_PAGE, "y");
        live = false; // e.g. an Escape or a recluster landed during the await
        return p;
      },
      () => live,
    );
    // null, NOT [] — "superseded" must stay distinguishable from "no leaves", or
    // the caller would paint an empty list over cleared state.
    expect(out).toBeNull();
  });

  it("never exceeds the runaway guard even if the source keeps returning full pages", async () => {
    let calls = 0;
    const out = await collectClusterLeaves(
      [1],
      async () => {
        calls += 1;
        return page(CLUSTER_LEAF_PAGE, "z");
      },
      () => true,
    );
    expect(calls).toBe(Math.ceil(MAX_CLUSTER_LEAVES / CLUSTER_LEAF_PAGE));
    expect(out).toHaveLength(calls * CLUSTER_LEAF_PAGE);
  });
});

describe("dedupeAmenities", () => {
  // The mark's leaves and its absorbed-pin snapshot are concatenated, and mid-zoom one
  // POI can be reported in BOTH roles (clustered in the new tiling, unclustered in the
  // retained old one) — so the same place could appear twice in one list
  // (found in review).
  const place = (name: string, osmId?: number, lat = 44, lng = 26) => ({
    name,
    category: "groceries" as const,
    lat,
    lng,
    ...(osmId === undefined ? {} : { osmType: "node", osmId }),
  });

  it("collapses the same OSM feature reported twice", () => {
    const out = dedupeAmenities([place("Mega", 1), place("Mega", 1), place("Profi", 2)]);
    expect(out.map((a) => a.name)).toEqual(["Mega", "Profi"]);
  });

  it("keeps genuinely different places that share an address", () => {
    // Two units in one building: same coordinate, different OSM ids. Collapsing these
    // would hide a place, which is the opposite of the guarantee.
    const out = dedupeAmenities([place("Unit 1", 1), place("Unit 2", 2)]);
    expect(out).toHaveLength(2);
  });

  it("NEVER drops a place it cannot positively identify", () => {
    // OSM identity is optional by contract, so its absence means "cannot prove these are
    // the same", not "assume they are" — two unnamed kiosks at one coordinate are two
    // places, and hiding one is the defect this task exists to remove. Showing a
    // duplicate row is the safer error.
    const out = dedupeAmenities([place("Kiosk"), place("Kiosk"), place("Kiosk", undefined, 44.001)]);
    expect(out).toHaveLength(3);
  });

  it("preserves order, so the nearest-first sort survives", () => {
    const out = dedupeAmenities([place("A", 1), place("B", 2), place("A", 1), place("C", 3)]);
    expect(out.map((a) => a.name)).toEqual(["A", "B", "C"]);
  });

  it("is applied by leavesToAmenities itself", () => {
    const leaf = (osmId: number): LeafFeature => ({
      properties: { category: "groceries", name: `p${osmId}`, osmType: "node", osmId, distanceMeters: 10 },
      geometry: { type: "Point", coordinates: [26, 44] },
    });
    expect(leavesToAmenities([leaf(5), leaf(5), leaf(6)])).toHaveLength(2);
  });
});

describe("decideMarkAction — the whole resolution ladder", () => {
  // Two round-review converged on this from different angles: the composed condition
  // was the last untested decision in the task (its pieces were tested, the composition
  // was not), it lived in a coverage-excluded file, and the e2e that tried to cover it
  // could only measure the fan's DECORATIVE coordinates and passed with zero fans — so
  // removing the coincidence wiring would have left it green. Tested here directly.
  const base = {
    expansionZoom: 30, // above maxZoom ⇒ not splittable
    maxZoom: 22,
    clusterCount: 1,
    pinCount: 0,
    leafCount: 3,
    total: 3,
    coincident: true,
    keyboard: false,
  };

  it("zooms when a lone cluster can still be split", () => {
    expect(decideMarkAction({ ...base, expansionZoom: 16 })).toEqual({ kind: "zoom", zoom: 16 });
  });

  it("never zooms a mark that is itself a collision of several clusters", () => {
    // Zooming cannot "unmerge" a screen-space collision, so the user would be left
    // clicking a mark that never opens.
    expect(decideMarkAction({ ...base, expansionZoom: 16, clusterCount: 2 }).kind).toBe("list");
    expect(decideMarkAction({ ...base, expansionZoom: 16, pinCount: 1 }).kind).toBe("list");
  });

  it("fans a lone, coincident, small, fully-enumerated cluster", () => {
    expect(decideMarkAction(base)).toEqual({ kind: "fan" });
  });

  it("REFUSES to fan places that are not really at the same spot", () => {
    // The round-6 Critical: a merged mark's leaves keep different real coordinates, so a
    // fan would draw pins where no place is and clicking one would fly the camera away.
    expect(decideMarkAction({ ...base, coincident: false }).kind).toBe("list");
  });

  it("refuses to fan a merged mark or one holding absorbed pins", () => {
    expect(decideMarkAction({ ...base, clusterCount: 2 }).kind).toBe("list");
    expect(decideMarkAction({ ...base, pinCount: 2 }).kind).toBe("list");
  });

  it("refuses to fan more legs than a fan can hold", () => {
    expect(decideMarkAction({ ...base, leafCount: SPIDER_MAX_LEAVES, total: SPIDER_MAX_LEAVES }).kind).toBe("fan");
    expect(
      decideMarkAction({ ...base, leafCount: SPIDER_MAX_LEAVES + 1, total: SPIDER_MAX_LEAVES + 1 }).kind,
    ).toBe("list");
  });

  it("refuses to fan what it could not fully enumerate", () => {
    // Fewer legs than the hub counts would be a mark that under-reports — the list says
    // "N of M" instead of quietly showing less.
    expect(decideMarkAction({ ...base, leafCount: 3, total: 5 }).kind).toBe("list");
  });

  it("sends KEYBOARD activations to the list, because the fan has no focusable leaves", () => {
    // Opening a fan removes the donut button the keyboard user was standing on, and the
    // leaves are WebGL geometry — so for them the fan is a dead end.
    expect(decideMarkAction({ ...base, keyboard: true }).kind).toBe("list");
    // …but a keyboard activation on a SPLITTABLE cluster still zooms, which is operable.
    expect(decideMarkAction({ ...base, expansionZoom: 16, keyboard: true }).kind).toBe("zoom");
  });

  it("does not fan a single place (it resolves straight to its detail upstream)", () => {
    expect(decideMarkAction({ ...base, leafCount: 1, total: 1 }).kind).toBe("list");
  });

  it("falls back to the list when the expansion zoom is unusable", () => {
    expect(decideMarkAction({ ...base, expansionZoom: Number.NaN, coincident: false }).kind).toBe("list");
  });
});
