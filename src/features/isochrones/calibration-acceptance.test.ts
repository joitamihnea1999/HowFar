import { describe, expect, it } from "vitest";

import {
  campaignExitCode,
  coverageShortfalls,
  perOriginFailures,
  type CoverageCell,
  type OriginTargetRate,
  type PerOriginBar,
} from "@/features/isochrones/calibration-acceptance";

describe("calibration-acceptance — coverage guard (a recorded precondition)", () => {
  const full: CoverageCell[] = [
    { origin: "Unirii", target: 10, n: 6 },
    { origin: "Grozavesti", target: 10, n: 6 },
    { origin: "Berceni", target: 10, n: 6 },
  ];

  it("passes when every cell has the full expected sample count", () => {
    expect(coverageShortfalls(full, 6)).toEqual([]);
  });

  it("FAILS (reports the cell) when any sector was dropped — a missing sector could be the unsafe one", () => {
    const holed = [...full.slice(0, 2), { origin: "Berceni", target: 10, n: 4 }];
    const short = coverageShortfalls(holed, 6);
    expect(short).toHaveLength(1);
    expect(short[0]).toMatch(/Berceni@10min: 4\/6/);
  });
});

describe("calibration-acceptance — per-origin bar (a recorded precondition)", () => {
  const bar: PerOriginBar = { medTolerance: 0.1, overRateBar: 0.06, maxOverMinCeil: 6 };
  const ok: OriginTargetRate = { n: 6, overRate: 0, maxOverMin: 2, medMin: 10.2 };

  it("passes an origin within median, rate, AND magnitude", () => {
    expect(perOriginFailures(10, { Unirii: ok }, bar)).toEqual([]);
  });

  it("fails an origin whose over-claim MAGNITUDE exceeds the ceiling even if the rate is modest", () => {
    // A rate-only bar would pass this (11% just over) but the +13.1min tail is the
    // real harm — the magnitude ceiling catches it (the walk-40 Berceni case).
    const bad: OriginTargetRate = { n: 6, overRate: 0.11, maxOverMin: 13.1, medMin: 10.1 };
    const fails = perOriginFailures(10, { Berceni: bad }, bar);
    expect(fails).toHaveLength(1);
    expect(fails[0]!.reason).toMatch(/over-claim 11% > bar 6%/); // rate breaches first
  });

  it("fails purely on magnitude when the rate is within bar", () => {
    const bad: OriginTargetRate = { n: 6, overRate: 0.05, maxOverMin: 9, medMin: 10.0 };
    expect(perOriginFailures(10, { Berceni: bad }, bar)[0]!.reason).toMatch(/maxOver \+9\.0min > ceiling \+6\.0min/);
  });

  it("fails on median inaccuracy", () => {
    const bad: OriginTargetRate = { n: 6, overRate: 0, maxOverMin: 1, medMin: 12 }; // 20% off
    expect(perOriginFailures(10, { X: bad }, bar)[0]!.reason).toMatch(/median 12.0min off/);
  });

  it("treats a zero-sample origin as a coverage gap, never a silent pass", () => {
    const empty: OriginTargetRate = { n: 0, overRate: 0, maxOverMin: 0, medMin: NaN };
    expect(perOriginFailures(10, { X: empty }, bar)[0]!.reason).toMatch(/no samples/);
  });
});

describe("calibration-acceptance — exit code", () => {
  it("0 only when coverage complete AND no served failures", () => {
    expect(campaignExitCode(true, 0)).toBe(0);
    expect(campaignExitCode(false, 0)).toBe(1); // coverage gap
    expect(campaignExitCode(true, 1)).toBe(1); // a served preset failed
    expect(campaignExitCode(false, 3)).toBe(1);
  });
});
