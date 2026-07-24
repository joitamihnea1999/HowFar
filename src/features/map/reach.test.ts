import { describe, expect, it } from "vitest";

import type { ReachLeg, ReachPlan } from "@/features/isochrones/server/transit-plan";
import { buildReachSteps, carReachText, decideReach, hasTransitLeg, isWalkOnly, journeyLegs, journeyStops, reachBand, reachSummary, transitModeLabel, walkReachText } from "@/features/map/reach";

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
  it("car yields a car answer (band-only, NO transit fetch) for both a band and a null band (task 053)", () => {
    // Car must be matched BEFORE the non-transit → walk fallthrough — a regression
    // to `{kind:"walk"}` here would ship the wrong copy and (via handleReach)
    // risk a transit fetch. This is the tripwire for plan-panel C-A/F3.
    expect(decideReach("car", 20)).toEqual({ kind: "car", band: 20 });
    expect(decideReach("car", null)).toEqual({ kind: "car", band: null });
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
    expect(steps[1]).toEqual({ primary: "Bus 243 → Bd. Lacul Tei", secondary: "Board Emil Racovita → alight Soseaua Colentina · 50 min" });
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
    expect(steps[0].secondary).toBe("Board your start → alight Market · 4 min");
    expect(steps[1].secondary).toBe("to your destination");
  });
});

describe("hasTransitLeg (gates the visual draw)", () => {
  it("is true when any leg is a public-transport mode", () => {
    expect(hasTransitLeg([{ mode: "WALK", fromName: "A", toName: "B", minutes: 3 }, { mode: "BUS", fromName: "B", toName: "C", minutes: 8 }])).toBe(true);
    expect(hasTransitLeg([{ mode: "SUBWAY", fromName: "A", toName: "B", minutes: 8 }])).toBe(true);
  });
  it("is false for walk-only AND for a bike/car direct fallback (never draws those)", () => {
    expect(hasTransitLeg([{ mode: "WALK", fromName: "A", toName: "B", minutes: 12 }])).toBe(false);
    expect(hasTransitLeg([{ mode: "BIKE", fromName: "A", toName: "B", minutes: 9 }])).toBe(false);
    expect(hasTransitLeg([{ mode: "CAR", fromName: "A", toName: "B", minutes: 6 }])).toBe(false);
  });
  it("treats an unknown non-{walk,bike,car} mode as transit (so a genuine transit mode still draws)", () => {
    expect(hasTransitLeg([{ mode: "FUNICULAR", fromName: "A", toName: "B", minutes: 4 }])).toBe(true);
  });
});

describe("journeyStops (drawable board/transfer/alight model)", () => {
  const P = (lat: number, lng: number) => ({ lat, lng });

  it("a single transit leg yields exactly board + alight (walk legs contribute no stops)", () => {
    const legs: ReachLeg[] = [
      { mode: "WALK", fromName: "START", toName: "Board", minutes: 9, from: P(44.42, 26.1), to: P(44.43, 26.1) },
      { mode: "BUS", line: "243", fromName: "Board", toName: "Alight", minutes: 50, from: P(44.43, 26.1), to: P(44.45, 26.09) },
      { mode: "WALK", fromName: "Alight", toName: "END", minutes: 5, from: P(44.45, 26.09), to: P(44.45, 26.087) },
    ];
    const stops = journeyStops(legs);
    expect(stops.map((s) => [s.name, s.kind])).toEqual([
      ["Board", "board"],
      ["Alight", "alight"],
    ]);
  });

  it("a same-stop (platform) transfer collapses to one transfer node → transfers+2 stops", () => {
    const legs: ReachLeg[] = [
      { mode: "BUS", fromName: "A", toName: "X", minutes: 10, from: P(44.4, 26.1), to: P(44.42, 26.1) },
      { mode: "TRAM", fromName: "X", toName: "B", minutes: 10, from: P(44.42, 26.1), to: P(44.44, 26.1) },
    ];
    const stops = journeyStops(legs);
    expect(stops.map((s) => s.kind)).toEqual(["board", "transfer", "alight"]);
    expect(stops.map((s) => s.name)).toEqual(["A", "X", "B"]);
  });

  it("a walk-transfer between DISTINCT stops keeps both → 2·transfers+2 stops (not transfers+2)", () => {
    const legs: ReachLeg[] = [
      { mode: "BUS", fromName: "A", toName: "X1", minutes: 10, from: P(44.4, 26.1), to: P(44.42, 26.1) },
      { mode: "WALK", fromName: "X1", toName: "X2", minutes: 3, from: P(44.42, 26.1), to: P(44.421, 26.101) },
      { mode: "TRAM", fromName: "X2", toName: "B", minutes: 10, from: P(44.421, 26.101), to: P(44.44, 26.1) },
    ];
    const stops = journeyStops(legs);
    // transfers = 1, but the distinct alight/board yields 4 dots.
    expect(stops.map((s) => s.kind)).toEqual(["board", "transfer", "transfer", "alight"]);
    expect(stops.map((s) => s.name)).toEqual(["A", "X1", "X2", "B"]);
  });

  it("prefers a real stop name over START/END when merging a coincident pair", () => {
    const legs: ReachLeg[] = [
      { mode: "BUS", fromName: "A", toName: "END", minutes: 10, from: P(44.4, 26.1), to: P(44.42, 26.1) },
      { mode: "TRAM", fromName: "Real Interchange", toName: "B", minutes: 10, from: P(44.42, 26.1), to: P(44.44, 26.1) },
    ];
    expect(journeyStops(legs)[1].name).toBe("Real Interchange");
  });

  it("returns [] for a walk-only itinerary (no vehicle legs)", () => {
    expect(journeyStops([{ mode: "WALK", fromName: "START", toName: "END", minutes: 8, from: P(44.4, 26.1), to: P(44.41, 26.1) }])).toEqual([]);
  });
});

describe("journeyLegs (drawable leg lines)", () => {
  const P = (lat: number, lng: number) => ({ lat, lng });

  it("uses the decoded path when present, else a straight from→to fallback, and drops coordinateless legs", () => {
    const legs: ReachLeg[] = [
      { mode: "WALK", fromName: "START", toName: "Board", minutes: 9, from: P(44.42, 26.1), to: P(44.43, 26.1) },
      { mode: "BUS", fromName: "Board", toName: "Alight", minutes: 50, from: P(44.43, 26.1), to: P(44.45, 26.09), path: [[26.1, 44.43], [26.095, 44.44], [26.09, 44.45]] },
      { mode: "WALK", fromName: "Alight", toName: "END", minutes: 5 }, // no coords → dropped
    ];
    const drawn = journeyLegs(legs);
    expect(drawn.map((l) => l.index)).toEqual([0, 1]); // leg 2 dropped, indices preserved
    expect(drawn[0]).toEqual({ index: 0, isWalk: true, coords: [[26.1, 44.42], [26.1, 44.43]] });
    expect(drawn[1].isWalk).toBe(false);
    expect(drawn[1].coords).toHaveLength(3); // real path, not the 2-point fallback
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

  it("car copy reflects the drive band with the estimate caveat, or 'beyond' (task 053, C-F)", () => {
    expect(carReachText(20).title).toBe("By car");
    expect(carReachText(20).detail).toContain("20");
    // The no-live-traffic honesty caveat must be in the popup copy itself.
    expect(carReachText(20).detail).toMatch(/estimate/i);
    expect(carReachText(20).detail).toMatch(/traffic/i);
    expect(carReachText(null).title).toBe("Beyond your driving reach");
  });
});
