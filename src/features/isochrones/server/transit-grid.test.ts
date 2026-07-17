import { area } from "@turf/area";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { difference } from "@turf/difference";
import type { Feature, MultiPolygon } from "geojson";
import { describe, expect, it } from "vitest";

import { buildRings, THRESHOLDS, WALK_SPEED_M_PER_MIN, type Ring } from "./transit-grid";

const ORIGIN = { lat: 44.4268, lng: 26.1025 }; // Piața Unirii

function asFeature(r: Ring): Feature<MultiPolygon> {
  return { type: "Feature", properties: {}, geometry: r.geometry };
}
function pt(lng: number, lat: number): [number, number] {
  return [lng, lat];
}
function ringArea(r: Ring): number {
  return r.geometry.coordinates.length ? area(asFeature(r)) : 0;
}

describe("buildRings", () => {
  it("returns exactly the 3 thresholds, ascending, as MultiPolygons", () => {
    const rings = buildRings(ORIGIN, []);
    expect(rings.map((r) => r.minutes)).toEqual([...THRESHOLDS]);
    for (const r of rings) expect(r.geometry.type).toBe("MultiPolygon");
  });

  it("origin-only (no stops) still yields a non-empty innermost ring containing the origin", () => {
    const rings = buildRings(ORIGIN, []);
    expect(rings[0].geometry.coordinates.length).toBeGreaterThan(0);
    expect(booleanPointInPolygon(pt(ORIGIN.lng, ORIGIN.lat), asFeature(rings[0]))).toBe(true);
  });

  it("rings nest: area(15) ≤ area(30) ≤ area(45) and each is contained in the next (0 leak)", () => {
    const stops = [
      { lat: 44.44, lng: 26.12, dur: 5 },
      { lat: 44.475, lng: 26.16, dur: 20 }, // ~7 km NE — a transit-only reach
      { lat: 44.41, lng: 26.05, dur: 12 },
    ];
    const [r15, r30, r45] = buildRings(ORIGIN, stops);
    expect(ringArea(r15)).toBeLessThanOrEqual(ringArea(r30));
    expect(ringArea(r30)).toBeLessThanOrEqual(ringArea(r45));
    // containment: (smaller − larger) must be empty
    for (const [small, large] of [[r15, r30], [r30, r45]] as const) {
      const diff = difference({ type: "FeatureCollection", features: [asFeature(small), asFeature(large)] });
      const leak = diff ? area(diff) : 0;
      expect(leak).toBeLessThan(5000); // < 5000 m² ≈ float/grid noise
    }
  });

  it("captures transit reach: a far stop is inside the 45-ring though it is far beyond walking distance", () => {
    // ~7 km from origin: a 45-min WALK covers only 45*80 = 3.6 km, so pure walking
    // can never reach it — only transit (dur 20) + egress does.
    const far = { lat: 44.475, lng: 26.16, dur: 20 };
    const rings = buildRings(ORIGIN, [far]);
    const [r15, , r45] = rings;
    const farPt = pt(far.lng, far.lat);
    const walkOnly = buildRings(ORIGIN, []); // no transit
    expect(booleanPointInPolygon(farPt, asFeature(r45))).toBe(true);
    expect(booleanPointInPolygon(farPt, asFeature(walkOnly[2]))).toBe(false); // not reachable on foot
    // and it is NOT in the 15-min ring (stop needs 20 min just to reach)
    expect(booleanPointInPolygon(farPt, asFeature(r15))).toBe(false);
  });

  it("holds nesting, bbox-containment and a perf ceiling on a dense (~500-stop) payload", () => {
    // The 42 ms / 0-leak result was a one-off prototype on the real payload; this
    // locks the invariants in as a CI regression guard against grid/contour tweaks.
    const stops: { lat: number; lng: number; dur: number }[] = [];
    for (let i = 0; i < 500; i++) {
      stops.push({
        lat: 44.30 + (i % 25) * 0.015,
        lng: 25.95 + Math.floor(i / 25) * 0.02,
        dur: 4 + (i % 41),
      });
    }
    const t0 = performance.now();
    const [r15, r30, r45] = buildRings(ORIGIN, stops);
    const ms = performance.now() - t0;

    expect([r15.minutes, r30.minutes, r45.minutes]).toEqual([15, 30, 45]);
    expect(ringArea(r15)).toBeLessThanOrEqual(ringArea(r30));
    expect(ringArea(r30)).toBeLessThanOrEqual(ringArea(r45));
    for (const [small, large] of [[r15, r30], [r30, r45]] as const) {
      const diff = difference({ type: "FeatureCollection", features: [asFeature(small), asFeature(large)] });
      expect(diff ? area(diff) : 0).toBeLessThan(5000);
    }
    // Every output vertex must stay within the launch box (tile extent).
    const BB = { minLng: 25.8, minLat: 44.2, maxLng: 26.4, maxLat: 44.7 };
    for (const r of [r15, r30, r45]) {
      for (const poly of r.geometry.coordinates) {
        for (const ring of poly) {
          for (const [x, y] of ring) {
            expect(x).toBeGreaterThanOrEqual(BB.minLng);
            expect(x).toBeLessThanOrEqual(BB.maxLng);
            expect(y).toBeGreaterThanOrEqual(BB.minLat);
            expect(y).toBeLessThanOrEqual(BB.maxLat);
          }
        }
      }
    }
    // Catch a catastrophic perf cliff (the abandoned union approach was ~65 s);
    // ceiling is generous for CI/coverage variance (real ~40–100 ms).
    expect(ms).toBeLessThan(2000);
  });

  it("uses the documented walk speed constant", () => {
    expect(WALK_SPEED_M_PER_MIN).toBe(80);
  });

  it("yields three EMPTY MultiPolygons (still 3 rings, ascending) when nothing reaches the box", () => {
    // Origin far outside the launch box and no stops: no cell is stamped, every
    // threshold takes the empty-MultiPolygon fallback instead of being dropped.
    const rings = buildRings({ lat: 50, lng: 30 }, []);
    expect(rings.map((r) => r.minutes)).toEqual([...THRESHOLDS]);
    for (const r of rings) expect(r.geometry.coordinates).toEqual([]);
  });

  it("a stop with zero remaining budget (dur = 45) stamps nothing; dur = 20 fills only 30/45", () => {
    const outsideOrigin = { lat: 50, lng: 30 }; // isolates the stop's contribution
    const stop = { lat: 44.4268, lng: 26.1025 };

    const spent = buildRings(outsideOrigin, [{ ...stop, dur: 45 }]);
    for (const r of spent) expect(r.geometry.coordinates).toEqual([]);

    // dur 20: cells within a 10-min walk have reach ≤ 30 (area for the 30-ring)
    // but nothing can be ≤ 15, so the 15-ring stays the empty fallback.
    const [r15, r30, r45] = buildRings(outsideOrigin, [{ ...stop, dur: 20 }]);
    expect(r15.geometry.coordinates).toEqual([]);
    expect(r30.geometry.coordinates.length).toBeGreaterThan(0);
    expect(r45.geometry.coordinates.length).toBeGreaterThan(0);
  });
});
