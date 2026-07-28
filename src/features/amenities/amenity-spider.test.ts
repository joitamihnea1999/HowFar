import { describe, expect, it } from "vitest";

import { clusterFootprintRadius } from "./amenity-cluster";
import {
  leavesAreCoincident,
  SPIDER_LEAF_GAP_PX,
  SPIDER_LEAF_RADIUS_PX,
  SPIDER_MAX_LEAVES,
  SPIDER_MAX_SPAN_M,
  spiderLegs,
  spiderOverlaps,
} from "./amenity-spider";

/**
 * The fan exists to make coincident places individually readable, so a fan whose
 * own leaves overlap would be self-defeating. These tests are the proof of that,
 * across every count the UI can actually produce and every hub size a donut can
 * present — not a spot check at one count.
 */
describe("spiderLegs", () => {
  const hubRadius = clusterFootprintRadius(3);

  it("produces exactly one leg per member", () => {
    for (let n = 1; n <= SPIDER_MAX_LEAVES; n++) {
      expect(spiderLegs(n, { hubRadius })).toHaveLength(n);
    }
  });

  it("keeps every pair of leaves non-overlapping, at every count the ladder allows", () => {
    for (let n = 2; n <= SPIDER_MAX_LEAVES; n++) {
      const legs = spiderLegs(n, { hubRadius });
      expect(spiderOverlaps(legs)).toEqual([]);
    }
  });

  it("holds the full gap, not merely tangency, between neighbours", () => {
    // Tangent leaves are legible but cramped; the fan reserves a real gap because
    // it also has to fit a name label under each leaf.
    const sep = 2 * SPIDER_LEAF_RADIUS_PX + SPIDER_LEAF_GAP_PX;
    for (let n = 2; n <= SPIDER_MAX_LEAVES; n++) {
      const legs = spiderLegs(n, { hubRadius });
      for (let i = 0; i < legs.length; i++) {
        for (let j = i + 1; j < legs.length; j++) {
          const d = Math.hypot(legs[i].dx - legs[j].dx, legs[i].dy - legs[j].dy);
          expect(d).toBeGreaterThanOrEqual(sep - 1e-6);
        }
      }
    }
  });

  it("clears the hub's own footprint so the count stays readable under the fan", () => {
    for (const total of [2, 3, 10, 150, 750]) {
      const r = clusterFootprintRadius(total);
      for (const leg of spiderLegs(SPIDER_MAX_LEAVES, { hubRadius: r })) {
        const d = Math.hypot(leg.dx, leg.dy);
        expect(d).toBeGreaterThanOrEqual(r + SPIDER_LEAF_RADIUS_PX + SPIDER_LEAF_GAP_PX - 1e-6);
      }
    }
  });

  it("stays non-overlapping for a hub far larger than any real donut", () => {
    // A wide hub pushes ring zero out, which RAISES its capacity — the case where a
    // naive "one ring of n" implementation would still be fine but a capacity
    // miscalculation would show up.
    expect(spiderOverlaps(spiderLegs(SPIDER_MAX_LEAVES, { hubRadius: 200 }))).toEqual([]);
  });

  it("uses more than one ring once a single ring cannot hold the members", () => {
    // Not a cosmetic detail: a single ring stretched to hold 12 leaves would either
    // overlap them or fly them far off the place they describe.
    const legs = spiderLegs(SPIDER_MAX_LEAVES, { hubRadius: clusterFootprintRadius(2) });
    const radii = new Set(legs.map((l) => Math.hypot(l.dx, l.dy).toFixed(3)));
    expect(radii.size).toBeGreaterThan(1);
  });

  it("puts a single member straight above the hub", () => {
    const [only] = spiderLegs(1, { hubRadius: 10 });
    expect(only.dx).toBeCloseTo(0, 6);
    expect(only.dy).toBeLessThan(0); // screen y grows downward
  });

  it("is deterministic, so a repaint cannot reshuffle the fan", () => {
    expect(spiderLegs(7, { hubRadius })).toEqual(spiderLegs(7, { hubRadius }));
  });

  it("returns nothing for a degenerate count instead of throwing", () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(spiderLegs(bad, { hubRadius })).toEqual([]);
    }
  });

  it("respects custom leaf sizing, so the caller cannot silently break separation", () => {
    const legs = spiderLegs(9, { hubRadius, leafRadius: 20, gap: 4 });
    expect(spiderOverlaps(legs, 20)).toEqual([]);
  });
});

describe("spiderOverlaps", () => {
  it("names the offending pair when two leaves do collide", () => {
    const legs = [
      { dx: 0, dy: 0 },
      { dx: 4, dy: 0 },
      { dx: 100, dy: 100 },
    ];
    expect(spiderOverlaps(legs)).toEqual([[0, 1]]);
  });

  it("treats exactly-tangent leaves as legal", () => {
    const legs = [
      { dx: 0, dy: 0 },
      { dx: 2 * SPIDER_LEAF_RADIUS_PX, dy: 0 },
    ];
    expect(spiderOverlaps(legs)).toEqual([]);
  });
});

describe("leavesAreCoincident", () => {
  // The gate that keeps a fan from LYING about geography (found in review).
  // A fan draws its members at decorative offsets around one hub, so it is only
  // truthful for places genuinely at the same spot; `agglomerateClusters` merges marks
  // that merely collide in SCREEN space, whose leaves keep different real coordinates.
  const at = (lat: number, lng: number) => ({ lat, lng });
  const BASE = at(44.4268, 26.1025);

  it("accepts places at an identical coordinate — the case the fan exists for", () => {
    expect(leavesAreCoincident([BASE, { ...BASE }, { ...BASE }])).toBe(true);
  });

  it("accepts the metre-scale spread a non-splittable cluster actually holds", () => {
    // A cluster that cannot split at the map maximum groups within CLUSTER_RADIUS_PX
    // at z22, which is on the order of one metre.
    expect(leavesAreCoincident([BASE, at(BASE.lat + 0.00001, BASE.lng + 0.00001)])).toBe(true);
  });

  it("rejects places a user would recognise as different addresses", () => {
    // ~80m apart: fanning these would draw both pins tens of metres from where they
    // are, and clicking one would fly the camera away from the leaf just clicked.
    expect(leavesAreCoincident([BASE, at(BASE.lat + 0.0007, BASE.lng)])).toBe(false);
  });

  it("measures EVERY pair, so a chain cannot creep past the span", () => {
    // Each step is inside the limit but the ends are far apart — a centroid test would
    // wave this through.
    const step = 0.00006; // ~6.6m per step
    const chain = [0, 1, 2, 3, 4].map((i) => at(BASE.lat + i * step, BASE.lng));
    expect(leavesAreCoincident(chain)).toBe(false);
  });

  it("is honest about the boundary in both directions", () => {
    const justInside = at(BASE.lat + (SPIDER_MAX_SPAN_M * 0.8) / 110_574, BASE.lng);
    const justOutside = at(BASE.lat + (SPIDER_MAX_SPAN_M * 1.5) / 110_574, BASE.lng);
    expect(leavesAreCoincident([BASE, justInside])).toBe(true);
    expect(leavesAreCoincident([BASE, justOutside])).toBe(false);
  });

  it("treats a single place (or none) as trivially coincident", () => {
    expect(leavesAreCoincident([BASE])).toBe(true);
    expect(leavesAreCoincident([])).toBe(true);
  });

  it("accounts for longitude convergence at Bucharest's latitude", () => {
    // A degree of longitude is ~0.71 of a degree of latitude here, so an east-west
    // pair must be judged with that factor, not as if the earth were a square grid.
    const eastWest = at(BASE.lat, BASE.lng + 0.00009); // ~7.2m
    expect(leavesAreCoincident([BASE, eastWest])).toBe(true);
    expect(leavesAreCoincident([BASE, at(BASE.lat, BASE.lng + 0.0002)])).toBe(false);
  });
});
