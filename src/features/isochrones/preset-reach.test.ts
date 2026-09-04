import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CALIBRATION_SPEED_M_PER_MIN, PACE_MODEL } from "@/features/isochrones/pace";
import {
  allPresetWalkRangesS,
  ALL_PRESET_WALK_MIN,
  assertSeparated,
  CAR_PRESET_MIN,
  carPresetRangeS,
  carPresetRangeSetS,
  MIN_RANGE_SEPARATION_S,
  presetContourMinutes,
  PRESET_MIN_BY_MODE,
  presetMinFor,
  TRANSIT_PRESET_MIN,
  WALK_PRESET_MIN,
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

describe("preset-reach — allPresetWalkRangesS (the one [10,20,40] walk fetch, sliced per consumer)", () => {
  it("returns ranges at [10,20,40] ascending + separated, so walk serving slices [10,20] and the transit union slices [20,40]", () => {
    expect([...ALL_PRESET_WALK_MIN]).toEqual([10, 20, 40]);
    for (const pace of ["slow", "normal"] as const) {
      const ranges = allPresetWalkRangesS(pace);
      expect(ranges).toEqual([
        walkPresetRangeS(10, pace),
        walkPresetRangeS(20, pace),
        walkPresetRangeS(40, pace),
      ]);
      // strictly ascending + separated (assertSeparated would throw otherwise)
      expect(ranges[0]! < ranges[1]! && ranges[1]! < ranges[2]!).toBe(true);
      assertSeparated(ranges);
    }
    // Normal-pace concrete shape (anchor triple rescaled by 5000/60 ÷ 80).
    expect(allPresetWalkRangesS("normal")).toEqual([546, 1135, 2159]);
  });

  it("every TRANSIT_PRESET_MIN is present in ALL_PRESET_WALK_MIN — the preset transit union slices the walk fetch by these labels, so a one-token drift in EITHER constant (likely in task 021) would silently make the union null and fail-close ALL preset transit", () => {
    for (const t of TRANSIT_PRESET_MIN) {
      expect(ALL_PRESET_WALK_MIN as readonly number[]).toContain(t);
    }
    // the sliced walk-ring set the union consumes must have exactly one ring per threshold
    const sliced = (ALL_PRESET_WALK_MIN as readonly number[]).filter((m) =>
      (TRANSIT_PRESET_MIN as readonly number[]).includes(m),
);
    expect(sliced).toEqual([...TRANSIT_PRESET_MIN]);
  });

  it("every WALK_PRESET_MIN chip is present in ALL_PRESET_WALK_MIN — the walk route slices the [10,20,40] fetch down to these chips, so a one-token drift would make the route return an EMPTY ring set (the route guards this, but the constants must agree)", () => {
    for (const chip of WALK_PRESET_MIN) {
      expect(ALL_PRESET_WALK_MIN as readonly number[]).toContain(chip);
    }
    const sliced = (ALL_PRESET_WALK_MIN as readonly number[]).filter((m) =>
      (WALK_PRESET_MIN as readonly number[]).includes(m),
    );
    expect(sliced).toEqual([...WALK_PRESET_MIN]);
  });
});

describe("PRESET_MIN_BY_MODE + presetMinFor (phone-first chip index → selected minute)", () => {
  it("maps each mode to its two selectable chips smaller→larger, tied to the per-mode constants (one home)", () => {
    expect(PRESET_MIN_BY_MODE.walk).toEqual([...WALK_PRESET_MIN]);
    expect(PRESET_MIN_BY_MODE.transit).toEqual([...TRANSIT_PRESET_MIN]);
    expect(PRESET_MIN_BY_MODE.car).toEqual([...CAR_PRESET_MIN]);
  });

  it("index 0 is the DESIGN default (walk 10 / transit 20 / car 10); index 1 is the larger chip", () => {
    expect(presetMinFor("walk", 0)).toBe(10);
    expect(presetMinFor("walk", 1)).toBe(20);
    expect(presetMinFor("transit", 0)).toBe(20);
    expect(presetMinFor("transit", 1)).toBe(40);
    expect(presetMinFor("car", 0)).toBe(10);
    expect(presetMinFor("car", 1)).toBe(25);
  });

  it("every selected minute is an exact selectable preset — presetContourMinutes accepts it (never throws)", () => {
    for (const mode of ["walk", "transit", "car"] as const) {
      for (const index of [0, 1] as const) {
        expect(() => presetContourMinutes(mode, presetMinFor(mode, index))).not.toThrow();
      }
    }
  });

  it("clamps a stray index into range rather than reading undefined", () => {
    expect(presetMinFor("walk", -1)).toBe(10);
    expect(presetMinFor("walk", 5)).toBe(20);
  });
});
