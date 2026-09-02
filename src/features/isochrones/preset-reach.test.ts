import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CALIBRATION_SPEED_M_PER_MIN, PACE_MODEL } from "@/features/isochrones/pace";
import {
  assertSeparated,
  carPresetRangeS,
  carPresetRangeSetS,
  MIN_RANGE_SEPARATION_S,
  presetContourMinutes,
  walkPresetRangeS,
  walkPresetRangeSetS,
  WALK_PRESET_RANGES_S_AT_80,
} from "@/features/isochrones/preset-reach";

describe("preset-reach — calibration provenance", () => {
  it("pins WALK_PRESET_RANGES_S_AT_80 to the committed calibration receipt", () => {
    // The strongest pin (rule 13): the shipped constant MUST equal the validated
    // receipt, so editing a number without re-running the campaign fails here.
    type Rate = { overRate: number; maxOverMin: number };
    const receipt = JSON.parse(
      readFileSync(join(process.cwd(), "scripts/calibrate/receipts/walk-2026-09-02.json"), "utf8"),
    ) as {
      finalCandidateRangeS: Record<string, number>;
      allPass: boolean;
      anyOriginOverBar: boolean;
      acceptance: { perTarget: Record<string, { perOrigin: Record<string, Rate> }> };
    };
    expect(receipt.allPass).toBe(true);
    for (const [minute, range] of Object.entries(receipt.finalCandidateRangeS)) {
      expect(WALK_PRESET_RANGES_S_AT_80[Number(minute)]).toBe(range);
    }
    // And no undocumented extra minutes crept into the constant.
    expect(Object.keys(WALK_PRESET_RANGES_S_AT_80).sort()).toEqual(
      Object.keys(receipt.finalCandidateRangeS).sort(),
    );
    // Pin the DISCLOSED per-origin state so a future re-run that worsens a tail or
    // adds an over-claiming origin fails loudly (review found the pooled pass hid
    // per-origin barrier tails). Known: walk-20 clean everywhere; walk-10 over only
    // at Grozăvești; walk-40 over only at Berceni; magnitudes bounded.
    expect(receipt.anyOriginOverBar).toBe(true); // documented, not hidden
    const BAR = 0.06;
    const over: Record<string, { origin: string; maxOverCeil: number }> = {
      "10": { origin: "Grozavesti", maxOverCeil: 9 },
      "40": { origin: "Berceni", maxOverCeil: 14 },
    };
    for (const t of ["10", "20", "40"]) {
      for (const [origin, r] of Object.entries(receipt.acceptance.perTarget[t]!.perOrigin)) {
        const allowedOver = over[t]?.origin === origin;
        if (!allowedOver) expect(r.overRate).toBeLessThanOrEqual(BAR); // no NEW over-origin
        if (allowedOver) expect(r.maxOverMin).toBeLessThanOrEqual(over[t]!.maxOverCeil); // tail not worse
      }
    }
  });
});

describe("preset-reach — per-pace rescale (distance-calibrated, pace-independent)", () => {
  it("rescales the anchor range by speed / CALIBRATION_SPEED, matching pace.ts", () => {
    const normal = PACE_MODEL.normal.speedMPerMin;
    const slow = PACE_MODEL.slow.speedMPerMin;
    // walk 20 at Normal: round(1090 * (5000/60) / 80) = 1135.
    expect(walkPresetRangeS(20, "normal")).toBe(Math.round((1090 * normal) / CALIBRATION_SPEED_M_PER_MIN));
    expect(walkPresetRangeS(20, "normal")).toBe(1135);
    // walk 10 at Slow: round(524 * 50 / 80) = 328.
    expect(walkPresetRangeS(10, "slow")).toBe(Math.round((524 * slow) / CALIBRATION_SPEED_M_PER_MIN));
    expect(walkPresetRangeS(10, "slow")).toBe(328);
  });

  it("throws on an uncalibrated walk minute (Custom needs the deferred curve)", () => {
    expect(() => walkPresetRangeS(37, "normal")).toThrow(/not calibrated/);
  });
});

describe("preset-reach — nested contour minutes", () => {
  it("the larger preset exposes the nested smaller calibrated preset", () => {
    expect(presetContourMinutes("walk", 20)).toEqual([10, 20]);
    expect(presetContourMinutes("walk", 10)).toEqual([10]);
    expect(presetContourMinutes("car", 25)).toEqual([10, 25]);
    expect(presetContourMinutes("car", 10)).toEqual([10]);
    expect(presetContourMinutes("transit", 40)).toEqual([20, 40]);
    expect(presetContourMinutes("transit", 20)).toEqual([20]);
  });

  it("throws (never silently mis-nests) for a non-selectable minute", () => {
    expect(() => presetContourMinutes("walk", 37)).toThrow(/not a selectable preset/); // above
    expect(() => presetContourMinutes("walk", 15)).toThrow(/not a selectable preset/); // between
    expect(() => presetContourMinutes("walk", 5)).toThrow(/not a selectable preset/); // below
    expect(() => presetContourMinutes("walk", 40)).toThrow(/not a selectable preset/); // union helper, not a chip
    expect(() => presetContourMinutes("car", 20)).toThrow(/not a selectable preset/);
    expect(() => presetContourMinutes("transit", 30)).toThrow(/not a selectable preset/);
  });

  it("the range-set generators reject a non-preset minute too", () => {
    expect(() => walkPresetRangeSetS(37, "normal")).toThrow(/not a selectable preset/);
    expect(() => carPresetRangeSetS(5)).toThrow(/not a selectable preset/);
    expect(() => carPresetRangeSetS(30)).toThrow(/not a selectable preset/);
  });
});

describe("preset-reach — separation invariant", () => {
  it("every emitted range set is strictly ascending and separated", () => {
    for (const pace of ["slow", "normal"] as const) {
      for (const sel of [10, 20]) assertSeparated(walkPresetRangeSetS(sel, pace));
    }
    for (const sel of [10, 25]) assertSeparated(carPresetRangeSetS(sel));
    // Concrete shapes.
    expect(walkPresetRangeSetS(20, "normal")).toEqual([walkPresetRangeS(10, "normal"), 1135]);
    expect(carPresetRangeSetS(25)).toEqual([600, 1500]);
  });

  it("assertSeparated rejects ranges closer than the tolerance", () => {
    expect(() => assertSeparated([600, 600 + MIN_RANGE_SEPARATION_S - 1])).toThrow(/separated/);
    expect(() => assertSeparated([600, 601])).toThrow(/separated/);
    expect(() => assertSeparated([600, 700])).not.toThrow();
  });

  it("car nominal ranges are minutes×60", () => {
    expect(carPresetRangeS(10)).toBe(600);
    expect(carPresetRangeS(25)).toBe(1500);
  });
});
