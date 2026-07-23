import { describe, expect, it } from "vitest";

import type { ReachLeg, ReachPlan } from "@/features/isochrones/server/transit-plan";
import { buildReachSteps, decideReach, isWalkOnly, reachBand, reachSummary, transitModeLabel, walkReachText } from "@/features/map/reach";

// A square Polygon centred at (clng, clat), half-width halfDeg, as a ring's geometry.
function square(clat: number, clng: number, halfDeg: number) {
  return {
    type: "MultiPolygon" as const,
    coordinates: [[[
      [clng - halfDeg, clat - halfDeg],
      [clng + halfDeg, clat - halfDeg],
      [clng + halfDeg, clat + halfDeg],
      [clng - halfDeg, clat + halfDeg],
      [clng - halfDeg, clat - halfDeg],
    ]]],
  };
}
const C = { lat: 44.4268, lng: 26.1025 };

describe("reachBand", () => {
  const rings = [
    { minutes: 15, geometry: square(C.lat, C.lng, 0.005) },
    { minutes: 30, geometry: square(C.lat, C.lng, 0.01) },
    { minutes: 45, geometry: square(C.lat, C.lng, 0.02) },
  ];

  it("returns the smallest band containing the point", () => {
    expect(reachBand([C.lng, C.lat], rings)).toBe(15); // at centre → innermost
    expect(reachBand([C.lng + 0.008, C.lat], rings)).toBe(30); // outside 15, inside 30
    expect(reachBand([C.lng + 0.015, C.lat], rings)).toBe(45); // only inside 45
  });

  it("returns null when the point is outside every ring", () => {
    expect(reachBand([C.lng + 0.05, C.lat], rings)).toBeNull();
  });

  it("skips empty/degenerate ring geometry without throwing", () => {
    const withEmpty = [
      { minutes: 15, geometry: { type: "MultiPolygon", coordinates: [] } },
      { minutes: 30, geometry: square(C.lat, C.lng, 0.01) },
    ];
    expect(reachBand([C.lng, C.lat], withEmpty)).toBe(30);
    expect(reachBand([C.lng, C.lat], [{ minutes: 15, geometry: undefined }])).toBeNull();
  });

  it("is order-independent (sorts by minutes first)", () => {
    const shuffled = [rings[2], rings[0], rings[1]];
    expect(reachBand([C.lng, C.lat], shuffled)).toBe(15);
  });
});

describe("decideReach (band → action policy, impl T1)", () => {
  it("walk always yields a walk answer, including a null band (outside walk reach)", () => {
    expect(decideReach("walk", 15)).toEqual({ kind: "walk", band: 15 });
    expect(decideReach("walk", null)).toEqual({ kind: "walk", band: null });
  });
  it("transit OUTSIDE every ring is unreachable — no provider call", () => {
    expect(decideReach("transit", null)).toEqual({ kind: "transit-unreachable" });
  });
  it("transit inside a band plans the trip, carrying the band for honest framing", () => {
    expect(decideReach("transit", 30)).toEqual({ kind: "transit", band: 30 });
  });
});

describe("isWalkOnly", () => {
  it("true only when every leg is a WALK leg", () => {
    expect(isWalkOnly([{ mode: "WALK", fromName: "A", toName: "B", minutes: 5 }])).toBe(true);
    expect(isWalkOnly([{ mode: "WALK", fromName: "A", toName: "B", minutes: 5 }, { mode: "BUS", fromName: "B", toName: "C", minutes: 10 }])).toBe(false);
    expect(isWalkOnly([])).toBe(false);
  });
});

describe("transitModeLabel", () => {
  it("maps known MOTIS modes and title-cases unknown ones", () => {
    expect(transitModeLabel("SUBWAY")).toBe("Metro");
    expect(transitModeLabel("BUS")).toBe("Bus");
    expect(transitModeLabel("TRAM")).toBe("Tram");
    expect(transitModeLabel("RAIL")).toBe("Train");
    expect(transitModeLabel("GONDOLA")).toBe("Gondola");
  });
});

describe("buildReachSteps", () => {
  const legs: ReachLeg[] = [
    { mode: "WALK", fromName: "START", toName: "Emil Racovita", minutes: 9 },
    { mode: "BUS", line: "243", headsign: "Bd. Lacul Tei", fromName: "Emil Racovita", toName: "Soseaua Colentina", minutes: 50 },
    { mode: "WALK", fromName: "Fabrica de Glucoza", toName: "END", minutes: 5 },
  ];

  it("formats walk legs and transit legs into two-line steps", () => {
    const steps = buildReachSteps(legs);
    expect(steps[0]).toEqual({ primary: "Walk 9 min", secondary: "to Emil Racovita" });
    expect(steps[1]).toEqual({ primary: "Bus 243 → Bd. Lacul Tei", secondary: "Board at Emil Racovita · 50 min" });
    // END maps to a human destination label.
    expect(steps[2]).toEqual({ primary: "Walk 5 min", secondary: "to your destination" });
  });

  it("omits an absent line/headsign gracefully", () => {
    const [step] = buildReachSteps([{ mode: "TRAM", fromName: "A", toName: "B", minutes: 3 }]);
    expect(step.primary).toBe("Tram");
  });

  it("labels the trip endpoints (START/END) as human places", () => {
    const steps = buildReachSteps([
      { mode: "BUS", line: "5", fromName: "START", toName: "Market", minutes: 4 },
      { mode: "WALK", fromName: "Market", toName: "END", minutes: 3 },
    ]);
    expect(steps[0].secondary).toBe("Board at your start · 4 min");
    expect(steps[1].secondary).toBe("to your destination");
  });
});

describe("reachSummary + walkReachText", () => {
  it("pluralises transfers", () => {
    const base = { reachable: true as const, totalMinutes: 57, legs: [] };
    expect(reachSummary({ ...base, transfers: 0 })).toBe("~57 min · no transfers");
    expect(reachSummary({ ...base, transfers: 1 })).toBe("~57 min · 1 transfer");
    expect(reachSummary({ ...base, transfers: 2 } as Extract<ReachPlan, { reachable: true }>)).toBe("~57 min · 2 transfers");
  });

  it("walk copy reflects the band or 'outside'", () => {
    expect(walkReachText(15).title).toBe("On foot");
    expect(walkReachText(15).detail).toContain("15");
    expect(walkReachText(null).title).toBe("Outside your walking reach");
  });
});
