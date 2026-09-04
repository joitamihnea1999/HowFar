import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { describe, expect, it } from "vitest";

import {
  buildPresetContourFeatures,
  buildPresetShellFeatures,
  PRESET_GRADIENT_STOPS,
  PRESET_SHELL_STEPS,
  presetInteriorLineMinutes,
  presetLegendRamp,
  presetRampColor,
  presetReachCaveat,
  presetReachExplainer,
  scaleGeometryTowardOrigin,
  selectPresetRings,
} from "./preset-view";
import type { Mode } from "@/features/isochrones/preset-reach";
import type { Origin, Ring } from "@/features/map/selection-flow";

const ORIGIN: Origin = { lat: 44.43, lng: 26.1 };

/** A square polygon of half-size `d` (degrees) centred on the origin — a stand-in for a
 * nested isochrone contour. Larger `d` = a longer-time (outer) ring. */
function square(d: number): GeoJSON.Polygon {
  const { lat, lng } = ORIGIN;
  return {
    type: "Polygon",
    coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]],
  };
}
// Walk preset serves BOTH contours [10,20]; car [10,25]; transit [20,40].
const WALK_RINGS: Ring[] = [
  { minutes: 10, geometry: square(0.01) },
  { minutes: 20, geometry: square(0.02) },
];
const CAR_RINGS: Ring[] = [
  { minutes: 10, geometry: square(0.015) },
  { minutes: 25, geometry: square(0.05) },
];
const TRANSIT_RINGS: Ring[] = [
  { minutes: 20, geometry: square(0.03) },
  { minutes: 40, geometry: square(0.07) },
];

describe("presetRampColor", () => {
  it("anchors the ends at the origin (light) and edge (dark) stops per mode", () => {
    expect(presetRampColor("walk", 0)).toBe(PRESET_GRADIENT_STOPS.walk.origin);
    expect(presetRampColor("walk", 1)).toBe(PRESET_GRADIENT_STOPS.walk.edge);
    expect(presetRampColor("transit", 0)).toBe(PRESET_GRADIENT_STOPS.transit.origin);
    expect(presetRampColor("car", 1)).toBe(PRESET_GRADIENT_STOPS.car.edge);
  });

  it("passes through the mid stop at f=0.5", () => {
    expect(presetRampColor("walk", 0.5)).toBe(PRESET_GRADIENT_STOPS.walk.mid);
  });

  it("darkens MONOTONICALLY light→dark (green channel falls as f rises) — the ramp reads without hue", () => {
    const g = (hex: string) => parseInt(hex.slice(3, 5), 16);
    let prev = Infinity;
    for (let f = 0; f <= 1.0001; f += 0.1) {
      const cur = g(presetRampColor("walk", f));
      expect(cur).toBeLessThanOrEqual(prev + 1); // non-increasing (allow rounding jitter)
      prev = cur;
    }
  });

  it("clamps a stray fraction onto the ramp", () => {
    expect(presetRampColor("walk", -1)).toBe(PRESET_GRADIENT_STOPS.walk.origin);
    expect(presetRampColor("walk", 2)).toBe(PRESET_GRADIENT_STOPS.walk.edge);
  });
});

describe("scaleGeometryTowardOrigin", () => {
  it("t=1 is identity (edge shell keeps the served polygon)", () => {
    expect(scaleGeometryTowardOrigin(square(0.02), ORIGIN, 1)).toEqual(square(0.02));
  });

  it("t<1 shrinks every vertex toward the origin (nested shell)", () => {
    const half = scaleGeometryTowardOrigin(square(0.02), ORIGIN, 0.5) as GeoJSON.Polygon;
    const [lng, lat] = half.coordinates[0]![0]!;
    expect(lng).toBeCloseTo(ORIGIN.lng - 0.01, 9);
    expect(lat).toBeCloseTo(ORIGIN.lat - 0.01, 9);
  });

  it("does not mutate the input geometry", () => {
    const g = square(0.02);
    const snapshot = JSON.parse(JSON.stringify(g));
    scaleGeometryTowardOrigin(g, ORIGIN, 0.3);
    expect(g).toEqual(snapshot);
  });

  it("handles MultiPolygon and passes non-polygonal geometry through unchanged", () => {
    const mp: GeoJSON.MultiPolygon = { type: "MultiPolygon", coordinates: [square(0.02).coordinates] };
    const scaled = scaleGeometryTowardOrigin(mp, ORIGIN, 0.5) as GeoJSON.MultiPolygon;
    expect(scaled.type).toBe("MultiPolygon");
    const [lng, lat] = scaled.coordinates[0]![0]![0]!;
    expect(lng).toBeCloseTo(ORIGIN.lng - 0.01, 9);
    expect(lat).toBeCloseTo(ORIGIN.lat - 0.01, 9);
    const pt: GeoJSON.Point = { type: "Point", coordinates: [1, 2] };
    expect(scaleGeometryTowardOrigin(pt, ORIGIN, 0.5)).toEqual(pt);
  });
});

describe("selectPresetRings — chip → visible contour", () => {
  it("selecting the LARGER preset draws it as the edge with the smaller as the calibrated interior (walk 20 → edge 20, interior [10])", () => {
    const sel = selectPresetRings(WALK_RINGS, "walk", 20)!;
    expect(sel.outer.minutes).toBe(20);
    expect(sel.interiorMinutes).toEqual([10]);
    expect(sel.interiorRings.map((r) => r.minutes)).toEqual([10]);
  });

  it("selecting the SMALLER preset draws it alone with NO interior line (walk 10 → edge 10, interior [])", () => {
    const sel = selectPresetRings(WALK_RINGS, "walk", 10)!;
    expect(sel.outer.minutes).toBe(10);
    expect(sel.interiorMinutes).toEqual([]);
    expect(sel.interiorRings).toEqual([]);
  });

  it("transit 40 → edge 40, interior [20]; car 25 → edge 25, interior [10]", () => {
    expect(selectPresetRings(TRANSIT_RINGS, "transit", 40)!.interiorMinutes).toEqual([20]);
    expect(selectPresetRings(CAR_RINGS, "car", 25)!.interiorMinutes).toEqual([10]);
  });

  it("returns null (renders nothing) when the served set lacks the selected contour — a drifted server contract, never a mislabelled reach", () => {
    expect(selectPresetRings([{ minutes: 10, geometry: square(0.01) }], "walk", 20)).toBeNull();
  });

  it("throws on a minute that is not a selectable preset (an uncalibrated Custom minute)", () => {
    expect(() => selectPresetRings(WALK_RINGS, "walk", 15)).toThrow(/not a selectable preset/);
  });
});

describe("buildPresetShellFeatures — the DECORATIVE ramp (clipped, annular)", () => {
  it("emits colour-ramped shells, outermost first, carrying NO minute label", () => {
    const shells = buildPresetShellFeatures(WALK_RINGS, "walk", 20, ORIGIN);
    expect(shells.length).toBeGreaterThan(1);
    expect(shells.length).toBeLessThanOrEqual(PRESET_SHELL_STEPS);
    // Outermost shell = edge colour; innermost = origin colour. No `minutes` on any shell.
    expect(shells[0]!.properties).toMatchObject({ fillColor: PRESET_GRADIENT_STOPS.walk.edge, decorative: true });
    expect(shells[shells.length - 1]!.properties!.fillColor).toBe(PRESET_GRADIENT_STOPS.walk.origin);
    expect(shells.every((f) => !("minutes" in (f.properties ?? {})))).toBe(true);
  });

  it("every shell is CONTAINED in the served outer reach — a shell never paints past the honest edge (containment, impl review)", () => {
    // A deliberately NON-STAR-shaped outer (an L, origin in the notch) — a naive homothety
    // toward the origin would fling scaled copies over the unreachable notch. The clip must
    // keep every painted vertex inside the served outer polygon.
    const { lat, lng } = ORIGIN;
    const L: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [[
        [lng, lat], [lng + 0.06, lat], [lng + 0.06, lat + 0.02], [lng + 0.02, lat + 0.02],
        [lng + 0.02, lat + 0.06], [lng, lat + 0.06], [lng, lat],
      ]],
    };
    const inner: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [[[lng, lat], [lng + 0.02, lat], [lng + 0.02, lat + 0.02], [lng, lat + 0.02], [lng, lat]]],
    };
    const rings: Ring[] = [{ minutes: 10, geometry: inner }, { minutes: 20, geometry: L }];
    const shells = buildPresetShellFeatures(rings, "walk", 20, { lat: lat + 0.005, lng: lng + 0.005 });
    const outer: GeoJSON.Feature<GeoJSON.Polygon> = { type: "Feature", properties: {}, geometry: L };
    for (const shell of shells) {
      for (const poly of shell.geometry.type === "MultiPolygon"
        ? (shell.geometry as GeoJSON.MultiPolygon).coordinates
        : [(shell.geometry as GeoJSON.Polygon).coordinates]) {
        for (const ringCoords of poly) {
          for (const [x, y] of ringCoords) {
            expect(booleanPointInPolygon([x!, y!], outer, { ignoreBoundary: false })).toBe(true);
          }
        }
      }
    }
  });

  it("empty when the served set can't back the selection", () => {
    expect(buildPresetShellFeatures([{ minutes: 10, geometry: square(0.01) }], "walk", 20, ORIGIN)).toEqual([]);
  });
});

describe("buildPresetContourFeatures — the ONLY honest world-claim", () => {
  it("draws exactly ONE edge line (selected preset) + ONE interior line at the CALIBRATED midpoint — and nothing between (render-midpoint rule)", () => {
    const lines = buildPresetContourFeatures(WALK_RINGS, "walk", 20);
    const edge = lines.filter((f) => f.properties!.kind === "edge");
    const interior = lines.filter((f) => f.properties!.kind === "interior");
    expect(edge).toHaveLength(1);
    expect(edge[0]!.properties!.minutes).toBe(20);
    expect(interior).toHaveLength(1);
    expect(interior[0]!.properties!.minutes).toBe(10); // the calibrated midpoint, NOT 15 or any per-minute value
    expect(interior[0]!.geometry).toEqual(square(0.01)); // sits on the served 10-min ring
  });

  it("the smaller preset draws an edge line only (no interior line below the smallest calibrated contour)", () => {
    const lines = buildPresetContourFeatures(WALK_RINGS, "walk", 10);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.properties).toMatchObject({ kind: "edge", minutes: 10 });
  });

  it("carries the per-mode contour-line colour", () => {
    expect(buildPresetContourFeatures(TRANSIT_RINGS, "transit", 40)[0]!.properties!.lineColor).toBe(
      PRESET_GRADIENT_STOPS.transit.line,
    );
  });
});

describe("presetInteriorLineMinutes — the render-midpoint read-back stamp", () => {
  it("names the calibrated interior line minutes per mode/selection", () => {
    expect(presetInteriorLineMinutes("walk", 20)).toEqual([10]);
    expect(presetInteriorLineMinutes("walk", 10)).toEqual([]);
    expect(presetInteriorLineMinutes("transit", 40)).toEqual([20]);
    expect(presetInteriorLineMinutes("car", 25)).toEqual([10]);
    expect(presetInteriorLineMinutes("car", 10)).toEqual([]);
  });
});

describe("presetReachExplainer — the honest reach claim (assertive gate)", () => {
  const modes: Mode[] = ["walk", "transit", "car"];

  it("names the SELECTED served minute for every mode/preset — never a minute the map isn't drawing", () => {
    // walk 10/20, transit 20/40, car 10/25 — the exact served contours.
    expect(presetReachExplainer("walk", 10)).toContain("10-minute walk");
    expect(presetReachExplainer("walk", 20)).toContain("20-minute walk");
    expect(presetReachExplainer("transit", 20)).toContain("20 minutes");
    expect(presetReachExplainer("transit", 40)).toContain("40 minutes");
    expect(presetReachExplainer("car", 10)).toContain("10-minute drive");
    expect(presetReachExplainer("car", 25)).toContain("25-minute drive");
  });

  it("hedges with 'about' in every mode — the reach is an estimate, never a guaranteed envelope", () => {
    const pairs: [Mode, number][] = [
      ["walk", 10],
      ["walk", 20],
      ["transit", 20],
      ["transit", 40],
      ["car", 10],
      ["car", 25],
    ];
    for (const [mode, min] of pairs) {
      expect(presetReachExplainer(mode, min).toLowerCase()).toContain("about");
      // Must NOT use "within" at all — even "within about a N-minute walk" reads as
      // the absolute promise the caveat then contradicts (impl review).
      expect(presetReachExplainer(mode, min)).not.toMatch(/\bwithin\b/i);
    }
    expect(modes).toHaveLength(3);
  });

  it("transit copy states walks to/from stops are included (honest scoping)", () => {
    expect(presetReachExplainer("transit", 40).toLowerCase()).toContain("walk to and from stops");
  });
});

describe("presetReachCaveat — the barrier honesty rider (owner honesty requirement)", () => {
  it("walk + transit carry a barrier caveat; car does NOT (0% over-claim, no street-walk)", () => {
    expect(presetReachCaveat("walk")).toBeTruthy();
    expect(presetReachCaveat("transit")).toBeTruthy();
    expect(presetReachCaveat("car")).toBeNull();
  });

  it("names the overstate direction only — the reach can be SHORTER than shown (never longer), and does not over-scare", () => {
    for (const mode of ["walk", "transit"] as const) {
      const c = presetReachCaveat(mode)!.toLowerCase();
      expect(c).toContain("shorter");
      // The honest direction is over-claim near barriers, never under-claim.
      expect(c).not.toContain("longer");
    }
    // Walk names the physical barrier; transit names the city edges.
    expect(presetReachCaveat("walk")!.toLowerCase()).toMatch(/river|rail/);
    expect(presetReachCaveat("transit")!.toLowerCase()).toContain("edge");
  });
});

describe("presetLegendRamp — labeled ramp for the legend pill", () => {
  it("carries the origin→edge stops + the calibrated midpoint label, tied to the selection", () => {
    const walk20 = presetLegendRamp("walk", 20);
    expect(walk20).toMatchObject({
      origin: PRESET_GRADIENT_STOPS.walk.origin,
      edge: PRESET_GRADIENT_STOPS.walk.edge,
      midMinutes: [10],
      edgeMinutes: 20,
    });
    // The smaller preset has no interior midpoint label.
    expect(presetLegendRamp("walk", 10).midMinutes).toEqual([]);
    expect(presetLegendRamp("transit", 40)).toMatchObject({ midMinutes: [20], edgeMinutes: 40 });
  });
});
