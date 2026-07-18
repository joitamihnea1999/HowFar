import { area } from "@turf/area";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { difference } from "@turf/difference";
import type { Feature, MultiPolygon } from "geojson";
import { describe, expect, it, vi } from "vitest";

import fc from "fast-check";

import {
  buildRings,
  EGRESS_M_PER_MIN,
  STREET_DETOUR,
  THRESHOLDS,
  unionRings,
  WALK_SPEED_M_PER_MIN,
  type Ring,
  type WalkRing,
} from "./transit-grid";

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
    // Explicit per-test timeout: the dense payload + full vertex-bounds sweep can
    // brush the 5s vitest default under coverage instrumentation. Headroom only —
    // the real perf ceiling above (ms < 2000) is the actual regression guard.
  }, 20_000);

  it("uses the documented walk speed and measured detour constants", () => {
    expect(WALK_SPEED_M_PER_MIN).toBe(80);
    expect(STREET_DETOUR).toBe(1.402); // measured 2026-07-17, see module comment
    expect(EGRESS_M_PER_MIN).toBeCloseTo(80 / 1.402, 10);
  });

  it("stampOrigin:false leaves the origin unstamped (empty rings with no stops)", () => {
    // transit.ts uses this when the street-routed walk rings get unioned in —
    // the radial origin disc must NOT contribute area in that mode.
    const rings = buildRings(ORIGIN, [], { stampOrigin: false });
    for (const r of rings) expect(r.geometry.coordinates).toEqual([]);
    // ...while stops still stamp normally in the same mode.
    const withStop = buildRings(ORIGIN, [{ lat: 44.44, lng: 26.12, dur: 5 }], { stampOrigin: false });
    expect(withStop[2].geometry.coordinates.length).toBeGreaterThan(0);
  });

  it("egress radius honours the detour deflation: a point ~14 crow-minutes out is NOT 15-reachable", () => {
    // A stop with dur=0 at the origin: at the OLD 80 m/min crow-fly stamp a cell
    // 1120 m away (14 "crow minutes") sat inside the 15-ring; with the measured
    // 1.402 detour its street time is ~19.6 min, so it must now fall OUTSIDE.
    const stop = { lat: ORIGIN.lat, lng: ORIGIN.lng, dur: 0 };
    const [r15] = buildRings({ lat: 50, lng: 30 }, [stop], { stampOrigin: false });
    const lat1120 = ORIGIN.lat + 1120 / 110540;
    expect(booleanPointInPolygon(pt(ORIGIN.lng, lat1120), asFeature(r15))).toBe(false);
    // ...but a point ~700 m out (12.3 street-minutes at the calibrated speed) IS inside.
    const lat700 = ORIGIN.lat + 700 / 110540;
    expect(booleanPointInPolygon(pt(ORIGIN.lng, lat700), asFeature(r15))).toBe(true);
  });

  it("stays under the perf ceiling on a full-scale (~2,500-stop) payload at the finer grid", () => {
    // Deterministic synthetic payload matching the real Unirii one-to-all scale
    // (2,508 stops); complexity depends only on stop count x stamp radii, so
    // this is perf-equivalent to the recorded payload without a binary fixture.
    const stops: { lat: number; lng: number; dur: number }[] = [];
    for (let i = 0; i < 2500; i++) {
      stops.push({
        lat: 44.34 + (i % 50) * 0.004,
        lng: 25.97 + Math.floor(i / 50) * 0.005,
        dur: 3 + (i % 43),
      });
    }
    const t0 = performance.now();
    const rings = buildRings(ORIGIN, stops);
    const ms = performance.now() - t0;
    expect(rings.map((r) => r.minutes)).toEqual([15, 30, 45]);
    // Real measured time ~120-250 ms locally; the generous ceiling absorbs
    // CI coverage-instrumentation inflation (same rationale as the 500-stop test).
    expect(ms).toBeLessThan(2000);
  }, 20_000); // per-test timeout headroom under coverage (ms < 2000 is the real guard)

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

// --- unionRings -------------------------------------------------------------

/** Axis-aligned square as a Polygon ring (closed, CCW). */
function square(clat: number, clng: number, halfDeg: number): number[][][] {
  return [[
    [clng - halfDeg, clat - halfDeg],
    [clng + halfDeg, clat - halfDeg],
    [clng + halfDeg, clat + halfDeg],
    [clng - halfDeg, clat + halfDeg],
    [clng - halfDeg, clat - halfDeg],
  ]];
}
function mpRing(minutes: number, coords: number[][][][]): Ring {
  return { minutes, geometry: { type: "MultiPolygon", coordinates: coords } };
}
function walkRing(minutes: number, clat: number, clng: number, halfDeg: number): WalkRing {
  return { minutes, geometry: { type: "Polygon", coordinates: square(clat, clng, halfDeg) } };
}

describe("unionRings", () => {
  const C = { lat: 44.4268, lng: 26.1025 };

  it("merges the walk ring into each threshold: walk-only area becomes part of the result", () => {
    // Transit square NE of the origin; walk square AT the origin, disjoint from it.
    const transit = THRESHOLDS.map((m, i) => mpRing(m, [square(44.47, 26.16, 0.01 + i * 0.005)]));
    const walk = THRESHOLDS.map((m, i) => walkRing(m, C.lat, C.lng, 0.008 + i * 0.004));
    const out = unionRings(transit, walk)!;
    expect(out).not.toBeNull();
    for (const [i, r] of out.entries()) {
      expect(r.minutes).toBe(THRESHOLDS[i]);
      // origin (walk-only) AND the transit square both inside
      expect(booleanPointInPolygon(pt(C.lng, C.lat), asFeature(r))).toBe(true);
      expect(booleanPointInPolygon(pt(26.16, 44.47), asFeature(r))).toBe(true);
    }
  });

  it("an empty transit ring takes the walk geometry outright (as MultiPolygon)", () => {
    const transit = THRESHOLDS.map((m) => mpRing(m, []));
    const walk = THRESHOLDS.map((m) => walkRing(m, C.lat, C.lng, 0.01));
    const out = unionRings(transit, walk)!;
    expect(out).not.toBeNull();
    for (const r of out) {
      expect(r.geometry.type).toBe("MultiPolygon");
      expect(r.geometry.coordinates.length).toBe(1);
      expect(booleanPointInPolygon(pt(C.lng, C.lat), asFeature(r))).toBe(true);
    }
  });

  it("returns null (family fallback) when a walk ring is missing, empty, or threshold-mismatched", () => {
    // ALL-OR-NOTHING: the caller skipped the origin stamp, so a partial merge
    // could ship a ring without any origin-walk area — signal a full rebuild.
    const transit = THRESHOLDS.map((m) => mpRing(m, [square(44.44, 26.12, 0.01)]));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(unionRings(transit, [])).toBeNull();
      const empties = THRESHOLDS.map((m) => ({ minutes: m, geometry: { type: "Polygon" as const, coordinates: [] } }));
      expect(unionRings(transit, empties)).toBeNull();
      const mismatched = [walkRing(99, C.lat, C.lng, 0.01), walkRing(98, C.lat, C.lng, 0.02), walkRing(97, C.lat, C.lng, 0.03)];
      expect(unionRings(transit, mismatched)).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("returns null when turf union fails on degenerate input — never throws, never partial", () => {
    const transit = THRESHOLDS.map((m) => mpRing(m, [square(44.44, 26.12, 0.01)]));
    const garbage = THRESHOLDS.map((m) => ({
      minutes: m,
      geometry: { type: "Polygon" as const, coordinates: [[["x"]]] as unknown },
    }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(unionRings(transit, garbage)).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a SINGLE bad ring poisons the whole family (the mixed case that breaks nesting)", () => {
    // Good walk rings at 15 and 45 but garbage at 30: a per-ring fallback would
    // ship a 30-ring without origin-walk area while 15/45 have it — the exact
    // nesting/origin-exclusion bug the all-or-nothing contract prevents.
    const transit = THRESHOLDS.map((m, i) => mpRing(m, [square(44.44, 26.12, 0.01 + i * 0.005)]));
    const walk = [
      walkRing(15, C.lat, C.lng, 0.008),
      { minutes: 30, geometry: { type: "Polygon" as const, coordinates: [[["x"]]] as unknown } },
      walkRing(45, C.lat, C.lng, 0.016),
    ];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(unionRings(transit, walk)).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("property: outputs nest (15 ⊆ 30 ⊆ 45) for arbitrary concentric families", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 44.35, max: 44.5, noNaN: true }),
        fc.double({ min: 26.0, max: 26.2, noNaN: true }),
        fc.double({ min: 0.002, max: 0.02, noNaN: true }),
        fc.double({ min: 0.002, max: 0.02, noNaN: true }),
        fc.double({ min: 0, max: 0.05, noNaN: true }),
        (tlat, tlng, tHalf, wHalf, offset) => {
          // Both inputs nest by construction (concentric squares, growing half-size).
          const transit = THRESHOLDS.map((m, i) => mpRing(m, [square(tlat, tlng, tHalf * (i + 1))]));
          const walk = THRESHOLDS.map((m, i) => walkRing(m, tlat + offset, tlng - offset, wHalf * (i + 1)));
          const out = unionRings(transit, walk);
          if (out === null) return false; // clean inputs must never trigger fallback
          for (const [small, large] of [[out[0], out[1]], [out[1], out[2]]] as const) {
            const diff = difference({
              type: "FeatureCollection",
              features: [asFeature(small!), asFeature(large!)],
            });
            if ((diff ? area(diff) : 0) >= 1) return false; // leak ≥ 1 m² = nesting broken
          }
          return true;
        },
      ),
      { numRuns: 40 },
    );
  });
});
