import { describe, expect, it } from "vitest";

import type { ReachLeg } from "@/features/isochrones/server/transit-plan";

import { hasTransitLeg, NON_TRANSIT_MODES } from "./transit-classify";

function leg(mode: string, minutes: number): ReachLeg {
  return { mode, fromName: "A", toName: "B", minutes };
}

describe("hasTransitLeg", () => {
  it("is false for walk/bike/car-only legs and true once any transit mode appears", () => {
    expect(hasTransitLeg([leg("WALK", 10), leg("BIKE", 5)])).toBe(false);
    expect(hasTransitLeg([leg("WALK", 10), leg("BUS", 5)])).toBe(true);
  });

  it("treats an unknown mode as transit (never hides a genuine new vehicle type)", () => {
    expect(hasTransitLeg([leg("FUNICULAR", 6)])).toBe(true);
  });

  it("is case-insensitive against the non-transit set", () => {
    expect(hasTransitLeg([leg("walk", 10)])).toBe(false);
    expect(NON_TRANSIT_MODES.has("WALK")).toBe(true);
  });

  it("does NOT count the UNKNOWN placeholder (absent/garbled mode) as transit", () => {
    // A leg that told us nothing must not draw + long-cache as public
    // transport; a real unfamiliar mode arrives under its own name (below).
    expect(hasTransitLeg([leg("UNKNOWN", 20)])).toBe(false);
  });

  it("counts a short vehicle hop between long walks as transit — no walk-share heuristic (review reversal)", () => {
    // The route-ranking calibration capture's owner-approved best trip is a
    // 3-min tram between 27 min of walking; any share/minutes threshold
    // misclassifies it as "no route", so the classifier must stay leg-based.
    expect(hasTransitLeg([leg("WALK", 12), leg("TRAM", 3), leg("WALK", 15)])).toBe(true);
  });
});
