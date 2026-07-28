import { describe, expect, it } from "vitest";

import { AMENITY_CATEGORIES, type AmenityCategoryKey } from "@/features/amenities/amenities";

import {
  agglomerateClusters,
  AMENITY_SOURCE_MAX_ZOOM,
  assertMarkSeparationInvariant,
  CLUSTER_MAX_RADIUS_PX,
  CLUSTER_MAX_ZOOM,
  CLUSTER_MIN_RADIUS_PX,
  CLUSTER_RADIUS_PX,
  clusterCategoryCounts,
  clusterFootprintRadius,
  clusterRadiusForCount,
  donutArcs,
  MAP_MAX_ZOOM,
  MAX_PIN_RADIUS_PX,
  MAX_MARK_FOOTPRINT_PX,
  MAX_PIN_FOOTPRINT_PX,
  pinFootprintRadius,
  pickClusterGeneration,
  resolveGenerations,
  tilesOverlap,
  markBounds,
  marksOverlap,
  overlappingPairs,
  PIN_RADIUS_STOPS,
  pinRadiusForZoom,
  pinRadiusZoomExpression,
  totalFromCounts,
} from "./amenity-cluster";

const KEYS = AMENITY_CATEGORIES.map((c) => c.key);

describe("the mark-separation invariant", () => {
  // This is the design's central claim, and review's most important
  // finding was that centre separation alone does not establish it. These tests
  // are what make "always legible" a checked property rather than an intention.
  it("holds for the shipped constants", () => {
    expect(() => assertMarkSeparationInvariant()).not.toThrow();
  });

  it("FIRES on every envelope violation, so the guard is proven not to be a no-op", () => {
    // Asserting only that the real constants pass cannot tell a working guard from one a
    // refactor has quietly emptied (found in review). Each case below breaks
    // exactly one relationship.
    const cases: [string, Parameters<typeof assertMarkSeparationInvariant>[0]][] = [
      ["a hovered pin wider than the clustering radius", { maxPinFootprint: 40, clusterRadius: 46 }],
      ["a donut budget wider than the clustering radius", { maxMarkFootprint: 60, clusterRadius: 46 }],
      ["a donut drawn wider than its own budget", { donutFootprint: 99, maxMarkFootprint: 34 }],
      ["a source maxzoom that stops clustering early", { sourceMaxZoom: 22, clusterMaxZoom: 22 }],
    ];
    for (const [what, overrides] of cases) {
      expect(() => assertMarkSeparationInvariant(overrides), what).toThrow(
        /mark separation invariant violated/,
      );
    }
  });

  it("names every simultaneous violation rather than only the first", () => {
    try {
      assertMarkSeparationInvariant({ maxPinFootprint: 40, maxMarkFootprint: 60, clusterRadius: 46 });
      throw new Error("expected a throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("hovered pin footprint");
      expect(message).toContain("MAX_MARK_FOOTPRINT_PX");
    }
  });

  it("keeps every mark a pin or a donut can present inside the clustering radius", () => {
    // The envelope, judged on the WORST case of each kind: a hovered pin at max
    // zoom (what collision reserves) and a donut at its size cap.
    expect(2 * MAX_PIN_FOOTPRINT_PX).toBeLessThanOrEqual(CLUSTER_RADIUS_PX);
    expect(MAX_MARK_FOOTPRINT_PX).toBeLessThanOrEqual(CLUSTER_RADIUS_PX);
    expect(2 * CLUSTER_MAX_RADIUS_PX).toBeLessThanOrEqual(MAX_MARK_FOOTPRINT_PX);
    // The resting pin is the smaller case, so it must fit too.
    expect(2 * (MAX_PIN_RADIUS_PX + 1.75)).toBeLessThanOrEqual(CLUSTER_RADIUS_PX);
  });

  it("keeps the source maxzoom strictly above clusterMaxZoom so clustering never stops early", () => {
    // MapLibre warns (and stops clustering) when source maxzoom <= clusterMaxZoom.
    // The source default is 18 and the map default is 22, so both are explicit.
    expect(AMENITY_SOURCE_MAX_ZOOM).toBeGreaterThan(CLUSTER_MAX_ZOOM);
    expect(CLUSTER_MAX_ZOOM).toBe(MAP_MAX_ZOOM);
  });
});

describe("pinRadiusForZoom", () => {
  it("clamps below the first and above the last stop", () => {
    expect(pinRadiusForZoom(0)).toBe(PIN_RADIUS_STOPS[0][1]);
    expect(pinRadiusForZoom(PIN_RADIUS_STOPS[0][0] - 3)).toBe(PIN_RADIUS_STOPS[0][1]);
    expect(pinRadiusForZoom(30)).toBe(MAX_PIN_RADIUS_PX);
  });

  it("returns each stop's exact radius at that stop", () => {
    for (const [zoom, radius] of PIN_RADIUS_STOPS) {
      expect(pinRadiusForZoom(zoom)).toBeCloseTo(radius, 6);
    }
  });

  it("grows monotonically with zoom and never exceeds the invariant's cap", () => {
    let previous = -Infinity;
    for (let z = 0; z <= 24; z += 0.25) {
      const r = pinRadiusForZoom(z);
      expect(r).toBeGreaterThanOrEqual(previous);
      expect(r).toBeLessThanOrEqual(MAX_PIN_RADIUS_PX);
      expect(Number.isFinite(r)).toBe(true);
      previous = r;
    }
  });

  it("interpolates linearly between stops", () => {
    const [z0, r0] = PIN_RADIUS_STOPS[0];
    const [z1, r1] = PIN_RADIUS_STOPS[1];
    expect(pinRadiusForZoom((z0 + z1) / 2)).toBeCloseTo((r0 + r1) / 2, 6);
  });

  it("emits a MapLibre interpolate expression built from the same stops", () => {
    // One source of truth: if the expression and the pure function could drift,
    // the pure separation tests would stop describing what is actually rendered.
    expect(pinRadiusZoomExpression()).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      ...PIN_RADIUS_STOPS.flatMap(([z, r]) => [z, r]),
    ]);
  });
});

describe("clusterRadiusForCount", () => {
  it("uses the minimum radius for degenerate and tiny counts", () => {
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0, 1]) {
      expect(clusterRadiusForCount(n)).toBe(CLUSTER_MIN_RADIUS_PX);
    }
  });

  it("grows with count but is hard-capped, so a huge cluster is no wider than a small one", () => {
    // The cap is the whole point (found in review): extra members grow the centre
    // NUMBER, never the ring, because an uncapped radius would let two legally
    // separated centres overlap visually.
    let previous = -Infinity;
    for (let n = 1; n <= 800; n++) {
      const r = clusterRadiusForCount(n);
      expect(r).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(r).toBeGreaterThanOrEqual(CLUSTER_MIN_RADIUS_PX);
      expect(r).toBeLessThanOrEqual(CLUSTER_MAX_RADIUS_PX);
      expect(Number.isFinite(r)).toBe(true);
      previous = r;
    }
    expect(clusterRadiusForCount(750)).toBe(CLUSTER_MAX_RADIUS_PX);
  });
});

describe("clusterCategoryCounts", () => {
  it("drops zero and absent categories and keeps legend order", () => {
    const counts = clusterCategoryCounts({ transit: 3, groceries: 2, parks: 0, schools: undefined });
    expect(counts).toEqual([
      { category: "groceries", count: 2 },
      { category: "transit", count: 3 },
    ]);
  });

  it("follows AMENITY_CATEGORIES order for every subset, so a mix always draws the same picture", () => {
    const props = Object.fromEntries(KEYS.map((k) => [k, 1]));
    expect(clusterCategoryCounts(props).map((c) => c.category)).toEqual(KEYS);
  });

  it("ignores non-numeric and negative property values", () => {
    expect(clusterCategoryCounts({ groceries: "x", transit: -2, parks: null })).toEqual([]);
  });

  it("rounds fractional accumulator values", () => {
    expect(clusterCategoryCounts({ groceries: 2.4 })).toEqual([{ category: "groceries", count: 2 }]);
  });

  it("returns an empty list for properties with no category data", () => {
    expect(clusterCategoryCounts({ point_count: 5, cluster_id: 7 })).toEqual([]);
  });
});

describe("donutArcs", () => {
  const entry = (category: AmenityCategoryKey, count: number) => ({ category, count });

  it("returns nothing for an empty or zero-total input", () => {
    expect(donutArcs([], 16)).toEqual([]);
    expect(donutArcs([entry("groceries", 0)], 16)).toEqual([]);
  });

  it("draws a single-category cluster as a COMPLETE ring via two half-arcs", () => {
    // A naive 0deg->360deg arc has identical endpoints and SVG renders nothing,
    // so a pure-groceries cluster would silently vanish.
    const arcs = donutArcs([entry("groceries", 7)], 16);
    expect(arcs).toHaveLength(1);
    expect(arcs[0].sweepDeg).toBe(360);
    expect(arcs[0].d.match(/A /g) ?? []).toHaveLength(2);
    expect(arcs[0].color).toBe(AMENITY_CATEGORIES[0].color);
  });

  it("splits a mixed cluster into one arc per category, in legend order", () => {
    const arcs = donutArcs([entry("groceries", 3), entry("transit", 1)], 20);
    expect(arcs.map((a) => a.category)).toEqual(["groceries", "transit"]);
    expect(arcs[0].sweepDeg).toBeCloseTo(270, 6);
    expect(arcs[1].sweepDeg).toBeCloseTo(90, 6);
  });

  it("sweeps sum to exactly 360 for every generated count vector (no hairline gaps)", () => {
    // The last arc closes the remainder exactly, so accumulated rounding can
    // neither leave a visible gap nor overshoot past a full turn.
    for (let n = 1; n <= 200; n++) {
      const counts = KEYS.map((k, i) => entry(k, ((n + i * 7) % 13) + (i === 0 ? 1 : 0))).filter(
        (c) => c.count > 0,
      );
      if (counts.length === 0) continue;
      const arcs = donutArcs(counts, clusterRadiusForCount(totalFromCounts(counts)));
      const sum = arcs.reduce((s, a) => s + a.sweepDeg, 0);
      expect(sum).toBeCloseTo(360, 6);
      expect(arcs).toHaveLength(counts.length);
    }
  });

  it("emits finite coordinates only — never NaN — across radii and counts", () => {
    for (const radius of [1, 2, 8, 16, CLUSTER_MAX_RADIUS_PX, 100]) {
      for (const counts of [
        [entry("groceries", 1)],
        [entry("groceries", 1), entry("pharmacies", 1)],
        KEYS.map((k) => entry(k, 3)),
      ]) {
        for (const a of donutArcs(counts, radius)) {
          expect(a.d).not.toMatch(/NaN|Infinity|undefined/);
          expect(a.sweepDeg).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps the ring inside the requested radius so the footprint maths stay honest", () => {
    const radius = 20;
    const thickness = 6;
    for (const a of donutArcs([entry("groceries", 2), entry("parks", 1)], radius, thickness)) {
      const coords = a.d.match(/-?\d+\.\d+/g)?.map(Number) ?? [];
      for (const value of coords) expect(Math.abs(value)).toBeLessThanOrEqual(radius);
    }
  });

  it("covers every category with a distinct colour, so no two arcs are confusable", () => {
    const arcs = donutArcs(
      KEYS.map((k) => entry(k, 1)),
      CLUSTER_MAX_RADIUS_PX,
    );
    expect(new Set(arcs.map((a) => a.color)).size).toBe(KEYS.length);
  });
});

describe("totalFromCounts", () => {
  it("sums member counts", () => {
    expect(totalFromCounts([{ count: 3 }, { count: 4 }])).toBe(7);
    expect(totalFromCounts([])).toBe(0);
  });
});

describe("footprint overlap detection", () => {
  it("reports bounds inflated by the mark radius", () => {
    expect(markBounds({ x: 10, y: 20, radius: 4 })).toEqual({ minX: 6, minY: 16, maxX: 14, maxY: 24 });
  });

  it("calls intersecting circles overlapping and tangent/disjoint ones not", () => {
    const a = { x: 0, y: 0, radius: 10 };
    expect(marksOverlap(a, { x: 19, y: 0, radius: 10 })).toBe(true);
    expect(marksOverlap(a, { x: 20, y: 0, radius: 10 })).toBe(false); // exactly tangent
    expect(marksOverlap(a, { x: 40, y: 0, radius: 10 })).toBe(false);
  });

  it("catches the case centre-distance testing misses: two large donuts far enough apart by centre", () => {
    // This pair is 45px apart — legal under a 44px clustering radius — yet the
    // rendered rings intersect. Exactly the flaw review identified, and
    // the reason the shipped cap keeps donut diameter <= MAX_MARK_FOOTPRINT_PX.
    const a = { x: 0, y: 0, radius: 30 };
    const b = { x: 45, y: 0, radius: 30 };
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(CLUSTER_RADIUS_PX - 2);
    expect(marksOverlap(a, b)).toBe(true);
  });

  it("finds every overlapping pair and names them", () => {
    const marks = [
      { id: "a", x: 0, y: 0, radius: 10 },
      { id: "b", x: 5, y: 0, radius: 10 },
      { id: "c", x: 100, y: 100, radius: 10 },
    ];
    const pairs = overlappingPairs(marks);
    expect(pairs).toHaveLength(1);
    expect([pairs[0][0].id, pairs[0][1].id].sort()).toEqual(["a", "b"]);
  });

  it("passes a set laid out one full footprint apart, each at the maximum radius", () => {
    // The rendered guarantee: marks a full MAX_MARK_FOOTPRINT_PX apart, each at the
    // maximum permitted radius, must not overlap.
    const marks = [0, 1, 2, 3, 4].map((i) => ({
      x: i * MAX_MARK_FOOTPRINT_PX,
      y: 0,
      radius: CLUSTER_MAX_RADIUS_PX,
    }));
    expect(overlappingPairs(marks)).toEqual([]);
  });
});

describe("agglomerateClusters", () => {
  const cand = (
    id: number,
    x: number,
    y: number,
    counts: { category: AmenityCategoryKey; count: number }[],
  ) => ({
    ids: [id],
    pinIds: [] as number[],
    x,
    y,
    lng: 26 + x / 10000,
    lat: 44 + y / 10000,
    counts,
    total: counts.reduce((s, c) => s + c.count, 0),
  });

  it("leaves well-separated clusters untouched", () => {
    const input = [
      cand(1, 0, 0, [{ category: "groceries", count: 5 }]),
      cand(2, 200, 0, [{ category: "transit", count: 3 }]),
    ];
    const out = agglomerateClusters(input);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.ids.flat()).flat().sort()).toEqual([1, 2]);
  });

  it("merges the exact collision an adversarial fixture found: cluster(15) next to cluster(5)", () => {
    // Supercluster bounds MEMBER distance, not CENTROID distance, so two clusters
    // can settle closer than the radius that formed them. This pair overlapped in a
    // real run at z13 and is why merging exists at all.
    const a = cand(1, 0, 0, [{ category: "groceries", count: 15 }]);
    const b = cand(2, 20, 0, [{ category: "transit", count: 5 }]);
    expect(marksOverlap({ ...a, radius: clusterRadiusForCount(a.total) }, { ...b, radius: clusterRadiusForCount(b.total) })).toBe(true);

    const out = agglomerateClusters([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].total).toBe(20); // counts are SUMMED — never lost or double-counted
    expect(out[0].ids.sort()).toEqual([1, 2]);
    expect(out[0].counts).toEqual([
      { category: "groceries", count: 15 },
      { category: "transit", count: 5 },
    ]);
  });

  it("guarantees an overlap-free result — the invariant, checked on the output", () => {
    // Randomised-but-deterministic dense layouts: whatever goes in, nothing that
    // comes out may overlap. This is the property the whole design claims.
    for (let seed = 0; seed < 40; seed++) {
      const input = Array.from({ length: 25 }, (_, i) => {
        const x = ((seed * 37 + i * 53) % 300) - 150;
        const y = ((seed * 17 + i * 29) % 300) - 150;
        const key = KEYS[(i + seed) % KEYS.length];
        return cand(i, x, y, [{ category: key, count: ((i * 7 + seed) % 40) + 1 }]);
      });
      const out = agglomerateClusters(input);
      const footprints = out.map((c) => ({ x: c.x, y: c.y, radius: clusterRadiusForCount(c.total) }));
      expect(overlappingPairs(footprints), `seed ${seed}`).toEqual([]);
    }
  });

  it("conserves the total member count across any merge", () => {
    for (let seed = 0; seed < 20; seed++) {
      const input = Array.from({ length: 14 }, (_, i) =>
        cand(i, ((seed * 11 + i * 9) % 60) - 30, ((seed * 5 + i * 13) % 60) - 30, [
          { category: KEYS[i % KEYS.length], count: (i % 6) + 1 },
        ]),
      );
      const before = input.reduce((s, c) => s + c.total, 0);
      const out = agglomerateClusters(input);
      expect(out.reduce((s, c) => s + c.total, 0)).toBe(before);
      // Per-category sums must also survive, or a donut would misreport its mix.
      const catTotal = (list: typeof out) => {
        const m = new Map<string, number>();
        for (const c of list) for (const e of c.counts) m.set(e.category, (m.get(e.category) ?? 0) + e.count);
        return [...m.entries()].sort();
      };
      expect(catTotal(out)).toEqual(catTotal(input));
    }
  });

  it("keeps every supercluster id, so a merged mark can still list all its leaves", () => {
    const input = [
      cand(7, 0, 0, [{ category: "groceries", count: 4 }]),
      cand(8, 6, 0, [{ category: "parks", count: 4 }]),
      cand(9, 12, 0, [{ category: "schools", count: 4 }]),
    ];
    const out = agglomerateClusters(input);
    expect(out.flatMap((c) => c.ids).sort()).toEqual([7, 8, 9]);
  });

  it("places a merged mark at the COUNT-WEIGHTED centroid, nearer the denser side", () => {
    const heavy = cand(1, 0, 0, [{ category: "groceries", count: 30 }]);
    const light = cand(2, 20, 0, [{ category: "parks", count: 2 }]);
    const [merged] = agglomerateClusters([heavy, light]);
    expect(merged.x).toBeLessThan(10); // pulled toward the 30-member side
    expect(merged.x).toBeGreaterThan(0);
  });

  it("is stable: identical input yields identical output", () => {
    const build = () => [
      cand(1, 0, 0, [{ category: "groceries", count: 6 }]),
      cand(2, 10, 4, [{ category: "parks", count: 6 }]),
      cand(3, 90, 90, [{ category: "transit", count: 2 }]),
    ];
    expect(agglomerateClusters(build())).toEqual(agglomerateClusters(build()));
  });

  it("handles empty input and a single cluster", () => {
    expect(agglomerateClusters([])).toEqual([]);
    const one = [cand(1, 5, 5, [{ category: "groceries", count: 2 }])];
    expect(agglomerateClusters(one)).toHaveLength(1);
  });

  it("absorbs an unclustered PIN that a drifted centroid collides with (found in review)", () => {
    // Supercluster keeps a pin clear of a cluster's SEED, not of its centroid — and a
    // centroid is a weighted average that can drift toward that pin. Before this, the
    // pass merged donut-vs-donut only, so a donut and a lone pin could overlap heavily
    // while every donut pair was legal.
    const donut = cand(1, 0, 0, [{ category: "groceries", count: 3 }]);
    const pin = { ...cand(0, 14, 0, [{ category: "parks", count: 1 }]), ids: [] as number[], pinIds: [9] };
    const out = agglomerateClusters([donut, pin]);
    expect(out).toHaveLength(1);
    expect(out[0].ids).toEqual([1]);
    expect(out[0].pinIds).toEqual([9]); // carried, so the list can still show it
    expect(out[0].total).toBe(4);
    expect(out[0].counts.map((c) => c.category).sort()).toEqual(["groceries", "parks"]);
  });

  it("leaves a pin that collides with nothing untouched, so it stays a WebGL pin", () => {
    const donut = cand(1, 0, 0, [{ category: "groceries", count: 3 }]);
    const pin = { ...cand(0, 200, 0, [{ category: "parks", count: 1 }]), ids: [] as number[], pinIds: [9] };
    const out = agglomerateClusters([donut, pin]);
    expect(out).toHaveLength(2);
    expect(out.find((m) => m.pinIds.length === 1)?.ids).toEqual([]);
  });

  it("converges overlap-free even with far MORE marks than the old fixed pass bound", () => {
    // The pass limit used to be a hard 64, which quietly made the overlap-free claim
    // conditional once more marks than that were on screen. Termination is now
    // structural: every merge removes one mark.
    const many = Array.from({ length: 160 }, (_, i) =>
      cand(i, (i % 16) * 6, Math.floor(i / 16) * 6, [
        { category: KEYS[i % KEYS.length], count: (i % 9) + 1 },
      ]),
    );
    const out = agglomerateClusters(many);
    expect(out.length).toBeGreaterThan(0);
    expect(
      overlappingPairs(out.map((c) => ({ x: c.x, y: c.y, radius: clusterFootprintRadius(c.total) }))),
    ).toEqual([]);
    // Nothing lost in a long merge chain.
    expect(out.reduce((n, c) => n + c.total, 0)).toBe(many.reduce((n, c) => n + c.total, 0));
  });

  it("does not mutate its input", () => {
    const input = [
      cand(1, 0, 0, [{ category: "groceries", count: 5 }]),
      cand(2, 8, 0, [{ category: "parks", count: 5 }]),
    ];
    const snapshot = JSON.stringify(input);
    agglomerateClusters(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("pinFootprintRadius", () => {
  // One formula for "how big is this pin", shared by the collision pass and the
  // e2e. They disagreed before: collision reserved `r x hover + 2`, the e2e
  // measured a bare `r`, so pairs could visibly overlap by 2-3px and still pass.
  it("includes the outline MapLibre paints outside the radius", () => {
    expect(pinFootprintRadius(15)).toBeCloseTo(pinRadiusForZoom(15) + 1.75, 6);
  });

  it("reserves the grown radius AND the thicker outline when hovered", () => {
    expect(pinFootprintRadius(15, true)).toBeCloseTo(pinRadiusForZoom(15) * 1.4 + 2.5, 6);
    expect(pinFootprintRadius(15, true)).toBeGreaterThan(pinFootprintRadius(15));
  });

  it("peaks at MAX_PIN_FOOTPRINT_PX, which is what the envelope assertion bounds", () => {
    for (const zoom of [11, 13, 15, 17, 19, 22, 30]) {
      expect(pinFootprintRadius(zoom, true)).toBeLessThanOrEqual(MAX_PIN_FOOTPRINT_PX + 1e-9);
    }
    expect(pinFootprintRadius(22, true)).toBeCloseTo(MAX_PIN_FOOTPRINT_PX, 6);
  });
});

describe("resolveGenerations", () => {
  // The double-count fix originally dropped every off-generation candidate, which is
  // right where the generations overlap and WRONG where they do not: a zoom loads tiles
  // progressively, so retained old tiles can be the only coverage for part of the
  // viewport. Dropping those made amenities briefly VANISH there.
  //
  // The second attempt kept off-generation marks by SCREEN PROXIMITY, and four reviewers
  // independently showed why that fails: a coarse parent cluster's centroid is the
  // weighted average of its children, so it can sit far from all of them and be kept
  // ALONGSIDE them — double-counting the very places the partition protects. The decision
  // is therefore made on tile coverage, which is exact.
  const item = (z: number, x: number, y: number, id: number) => ({ tile: { z, x, y }, id });

  it("drops an off-generation mark whose area the chosen generation has loaded", () => {
    // z13 tile (4,5) is the parent of z14 tile (8,10) — same ground, so the stale one goes.
    const items = [item(14, 8, 10, 1), item(13, 4, 5, 2)];
    expect(resolveGenerations(items, 14).map((i) => i.id)).toEqual([1]);
  });

  it("KEEPS an off-generation mark covering ground the chosen generation has not loaded", () => {
    const items = [item(14, 8, 10, 1), item(13, 40, 50, 2)];
    expect(resolveGenerations(items, 14).map((i) => i.id).sort()).toEqual([1, 2]);
  });

  it("drops a coarse PARENT even when it is nowhere near its children on screen", () => {
    // The case that killed the proximity heuristic: one z13 parent, two z14 children in
    // the same tile area. Proximity kept all three; coverage keeps only the children.
    const items = [item(14, 8, 10, 1), item(14, 8, 10, 2), item(13, 4, 5, 3)];
    expect(resolveGenerations(items, 14).map((i) => i.id).sort()).toEqual([1, 2]);
  });

  it("keeps only ONE stale tile where several cover the same uncovered ground", () => {
    // Two stale generations (z12 and z13) over the same area, none of it covered by the
    // chosen z14 tile. Keeping both would re-inflate the count in that region — but the
    // choice is per TILE, so all features of whichever tile wins are kept.
    const items = [item(14, 8, 10, 1), item(13, 40, 50, 2), item(12, 20, 25, 3)];
    const out = resolveGenerations(items, 14).map((i) => i.id);
    expect(out).toContain(1);
    expect(out.filter((id) => id !== 1)).toHaveLength(1);
  });

  it("keeps EVERY feature of a retained stale tile, not just the first", () => {
    // The data-loss bug: retention was decided per feature, and a tile always overlaps
    // itself, so the "already represented" test dropped every feature after the first
    // from the same uncovered tile — deleting amenities from the very region the
    // retention exists to preserve.
    const items = [
      item(14, 8, 10, 1),
      item(13, 40, 50, 2),
      item(13, 40, 50, 3),
      item(13, 40, 50, 4),
    ];
    expect(resolveGenerations(items, 14).map((i) => i.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it("keeps every feature of SEVERAL retained tiles", () => {
    const items = [
      item(14, 8, 10, 1),
      item(13, 40, 50, 2),
      item(13, 40, 50, 3),
      item(13, 41, 50, 4),
      item(13, 41, 50, 5),
    ];
    expect(resolveGenerations(items, 14).map((i) => i.id).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("still drops every feature of a tile the chosen generation covers", () => {
    const items = [item(14, 8, 10, 1), item(13, 4, 5, 2), item(13, 4, 5, 3)];
    expect(resolveGenerations(items, 14).map((i) => i.id)).toEqual([1]);
  });

  it("falls back to keeping everything when tile provenance is unknown", () => {
    const items = [{ tile: null, id: 1 }, item(14, 8, 10, 2)];
    expect(resolveGenerations(items, 14)).toHaveLength(2);
  });
});

describe("tilesOverlap", () => {
  it("recognises a tile as covering itself", () => {
    expect(tilesOverlap({ z: 14, x: 8, y: 10 }, { z: 14, x: 8, y: 10 })).toBe(true);
  });

  it("recognises parent/child containment in both argument orders", () => {
    const parent = { z: 13, x: 4, y: 5 };
    const child = { z: 14, x: 8, y: 10 };
    expect(tilesOverlap(child, parent)).toBe(true);
    expect(tilesOverlap(parent, child)).toBe(true);
  });

  it("separates siblings and unrelated areas", () => {
    expect(tilesOverlap({ z: 14, x: 8, y: 10 }, { z: 14, x: 9, y: 10 })).toBe(false);
    // x=9 IS a child of x=4 (9>>1 === 4), so pick a tile that genuinely is not.
    expect(tilesOverlap({ z: 14, x: 10, y: 10 }, { z: 13, x: 4, y: 5 })).toBe(false);
  });

  it("holds across a multi-level gap", () => {
    // z12 (2,3) contains z15 (16..23, 24..31).
    expect(tilesOverlap({ z: 15, x: 17, y: 25 }, { z: 12, x: 2, y: 3 })).toBe(true);
    expect(tilesOverlap({ z: 15, x: 33, y: 25 }, { z: 12, x: 2, y: 3 })).toBe(false);
  });
});

describe("pickClusterGeneration", () => {
  // Mid-zoom the source holds two tilings at once, and their clusters cover the
  // same places under different ids — merging across them paints a donut with
  // roughly DOUBLE the real count (found in review).
  const gen = (tileZ: number | null, id: number) => ({ tileZ, id });

  it("keeps only the generation matching the map's current tiling", () => {
    const items = [gen(13, 1), gen(14, 2), gen(13, 3), gen(14, 4)];
    expect(pickClusterGeneration(items, 14).map((i) => i.id)).toEqual([2, 4]);
    expect(pickClusterGeneration(items, 13).map((i) => i.id)).toEqual([1, 3]);
  });

  it("falls back to the nearest available generation when the target is absent", () => {
    const items = [gen(11, 1), gen(15, 2)];
    expect(pickClusterGeneration(items, 12).map((i) => i.id)).toEqual([1]);
    expect(pickClusterGeneration(items, 14).map((i) => i.id)).toEqual([2]);
  });

  it("breaks an exact tie toward the finer zoom the map is heading to", () => {
    const items = [gen(12, 1), gen(14, 2)];
    expect(pickClusterGeneration(items, 13).map((i) => i.id)).toEqual([2]);
  });

  it("keeps everything when any tile zoom is unknown, so a MapLibre change degrades to the old behaviour", () => {
    const items = [gen(13, 1), gen(null, 2), gen(14, 3)];
    expect(pickClusterGeneration(items, 14)).toHaveLength(3);
  });

  it("halves a mixed-generation double count in the shape the review described", () => {
    // Same 20 places reported twice: once as two z13 clusters, once as four z14
    // clusters. Whichever generation wins, the total must be 20 and not 40.
    const items = [
      { tileZ: 13, total: 12 },
      { tileZ: 13, total: 8 },
      { tileZ: 14, total: 6 },
      { tileZ: 14, total: 6 },
      { tileZ: 14, total: 4 },
      { tileZ: 14, total: 4 },
    ];
    const kept = pickClusterGeneration(items, 14);
    expect(kept.reduce((n, i) => n + i.total, 0)).toBe(20);
    expect(items.reduce((n, i) => n + i.total, 0)).toBe(40);
  });

  it("returns an empty set unchanged", () => {
    expect(pickClusterGeneration([], 14)).toEqual([]);
  });
});

describe("what the envelope implies about absorption (review, measured)", () => {
  // Two rounds of review asked for an e2e fixture that reproduces the absorbed-pin case — a lone pin
  // absorbed into a donut. Trying to build one turned up the reason no fixture ever
  // did: the constants bound how close an UNCLUSTERED mark can get.
  //
  // Supercluster groups anything within CLUSTER_RADIUS_PX at the tile zoom, and the
  // map's tile zoom is floor(zoom), so on screen two unclustered features are at
  // least CLUSTER_RADIUS_PX apart (more at fractional zooms). These tests pin the
  // consequences, so the absorption pass is documented as the DEFENSIVE guard it is
  // rather than as a routinely-exercised path — and so that raising a pin radius or
  // lowering the clustering radius fails here instead of silently making a real
  // overlap possible again.
  it("makes a pin-vs-pin overlap arithmetically impossible", () => {
    // Even at max zoom AND hovered — the largest a pin ever gets — two of them cannot
    // reach each other across the smallest gap clustering can leave.
    expect(2 * MAX_PIN_FOOTPRINT_PX).toBeLessThan(CLUSTER_RADIUS_PX);
  });

  it("leaves donut-vs-pin possible ONLY through centroid drift, and says how much", () => {
    // A cluster centroid is a weighted average, so it can sit closer to a lone pin
    // than the seed that formed the cluster does. That is the only way the two
    // footprints can meet — and it takes this much drift.
    const donut = clusterFootprintRadius(Number.MAX_SAFE_INTEGER);
    const reach = donut + MAX_PIN_FOOTPRINT_PX;
    expect(reach).toBeLessThan(CLUSTER_RADIUS_PX);
    const driftNeeded = CLUSTER_RADIUS_PX - reach;
    expect(driftNeeded).toBeGreaterThan(0);
    // Documented, not merely computed: a few px of drift is enough, which is why the
    // guard stays even though no fixture reproduces it.
    expect(driftNeeded).toBeLessThan(CLUSTER_RADIUS_PX / 4);
  });

  it("still absorbs correctly when that drift does occur", () => {
    // The behaviour under test, expressed directly rather than through a fixture that
    // hopes supercluster drifts: a donut and a pin whose footprints intersect merge,
    // and the merged mark reports the sum.
    const donutTotal = 6;
    const donut = {
      ids: [1],
      pinIds: [] as number[],
      x: 0,
      y: 0,
      lng: 26,
      lat: 44,
      counts: [{ category: "groceries" as AmenityCategoryKey, count: donutTotal }],
      total: donutTotal,
    };
    const gap = clusterFootprintRadius(donutTotal) + MAX_PIN_FOOTPRINT_PX - 1; // just touching
    const lonePin = {
      ids: [] as number[],
      pinIds: [77],
      x: gap,
      y: 0,
      lng: 26.001,
      lat: 44,
      counts: [{ category: "schools" as AmenityCategoryKey, count: 1 }],
      total: 1,
    };
    const out = agglomerateClusters([donut, lonePin], (total) =>
      total <= 1 ? MAX_PIN_FOOTPRINT_PX : clusterFootprintRadius(total),
    );
    expect(out).toHaveLength(1);
    expect(out[0].total).toBe(donutTotal + 1);
    expect(out[0].pinIds).toEqual([77]);
  });
});

describe("agglomerateClusters cost at the reachable worst case", () => {
  // The claim gap a review asked to close, and a later one put a number on
  // (~105ms for a 375-candidate chain). MEASURED here instead of argued: the chain
  // geometry needs hundreds of MUTUALLY OVERLAPPING marks, which the clustering radius
  // makes impossible — unclustered pins are always at least CLUSTER_RADIUS_PX apart. So
  // the reachable worst case is "many pins, nothing merges", and what matters is that
  // it stays a single pass. Asserted as an algorithmic property, not a wall-clock
  // number, because a timing assertion on shared CI would be flaky.
  it("performs NO merges on a full payload of legally-separated pins", () => {
    const foot = (total: number) => (total <= 1 ? MAX_PIN_FOOTPRINT_PX : clusterFootprintRadius(total));
    // 750 = MAX_PER_CATEGORY x categories, laid out at the minimum legal separation.
    const pins = Array.from({ length: 750 }, (_, i) => ({
      ids: [] as number[],
      pinIds: [i],
      x: (i % 30) * CLUSTER_RADIUS_PX,
      y: Math.floor(i / 30) * CLUSTER_RADIUS_PX,
      lng: 26,
      lat: 44,
      counts: [{ category: "groceries" as AmenityCategoryKey, count: 1 }],
      total: 1,
    }));
    const out = agglomerateClusters(pins, foot);
    // Nothing merged ⇒ the loop found no overlapping pair ⇒ exactly one pass.
    expect(out).toHaveLength(pins.length);
    expect(overlappingPairs(out.map((c) => ({ x: c.x, y: c.y, radius: foot(c.total) })))).toEqual([]);
  });
});
