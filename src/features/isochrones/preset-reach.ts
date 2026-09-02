/**
 * Phone-first PRESET reach model — the calibrated preset minutes + the pure
 * range GENERATOR that turns a preset into the ORS ranges / transit thresholds to
 * request. PURE module (no server imports), like `pace.ts` and `bands.ts`, so both
 * the server provider clients and the client view can read it.
 *
 * SCOPE: this module lands the calibrated NUMBERS and the generator only. It is
 * deliberately NOT yet wired into the provider clients, routes, cache keys or
 * `bands.ts` — that is serving-path work for a later change. Nothing in the shipped
 * request path imports this yet; the calibration harness + the unit tests exercise
 * it, and the serving path will consume it.
 *
 * CALIBRATION PROVENANCE (do not edit a number without re-running the campaign):
 *   - WALK ranges are ORS foot-walking `range` seconds AT THE 80 m/min CALIBRATION
 *     ANCHOR (a measurement ruler, NOT a pace — see `pace.ts`), fitted + validated
 *     2026-09-02 against the MOTIS street-distance ruler at 3 origins on a held-out
 *     set, to the ESTABLISHED metric (median within ±10% AND over-claim >T+5min ≤
 *     the shipped 15/30/45 baseline of 0–6%). Receipt:
 *     `scripts/calibrate/receipts/walk-2026-09-02.json`. Each pace rescales the
 *     anchor range by `speed / 80` exactly as `pace.ts` does for 15/30/45 (distance
 *     calibration is pace-independent).
 *   - CAR minutes are NOMINAL free-flow (`minutes × 60`); ORS driving-car is
 *     accurate-to-conservative vs OSRM at 10/25 (task 056 straddle-1.0; re-checked
 *     2026-09-02). The per-time-of-day congestion factor (`car-traffic.ts`) applies
 *     on top, unchanged.
 *   - TRANSIT minutes are contour thresholds of the transit field; 20/40 are
 *     interior to the shipped 15/45 envelope (`transit-grid.ts`). The field's
 *     conservatism was measured directly at the served 15/30/45 contours
 *     (`scripts/calibrate/receipts/transit-2026-09-02.json`); 20/40 are argued to
 *     inherit it as interior levels, but NOT yet measured directly — that is a
 *     blocking precondition for the change that parameterises the thresholds and
 *     serves 20/40 (see docs/PROVIDERS.md). A PRE-EXISTING peripheral over-claim in
 *     the field is tracked separately, not introduced here. So do not treat
 *     `TRANSIT_PRESET_MIN` as directly-validated data until that measurement lands.
 */

import { CALIBRATION_SPEED_M_PER_MIN, PACE_MODEL, type Pace } from "@/features/isochrones/pace";

/** ORS foot-walking `range` seconds at the 80 m/min anchor for each walk preset
 *  minute (10/20 = presets; 40 is required by the transit street-walk union). */
export const WALK_PRESET_RANGES_S_AT_80: Readonly<Record<number, number>> = {
  10: 524,
  20: 1090,
  40: 2073,
};

/** Selectable walk preset minutes (the top-bar chips). 40 is a union helper, not a chip. */
export const WALK_PRESET_MIN = [10, 20] as const;
/** Selectable car preset minutes. */
export const CAR_PRESET_MIN = [10, 25] as const;
/** Selectable transit preset minutes (also the transit field contour thresholds). */
export const TRANSIT_PRESET_MIN = [20, 40] as const;

export type Mode = "walk" | "transit" | "car";

/** ORS `RANGE_TOLERANCE_S` in `ors.ts`; the min separation a range set must keep so
 *  the normalize bijection can never mislabel two contours (2 × tolerance). */
export const MIN_RANGE_SEPARATION_S = 2;

/**
 * The nested contour minutes for a selected preset, inner → outer. The OUTER edge
 * is the calibrated metric claim; the LARGER preset additionally exposes the nested
 * SMALLER calibrated preset as an honest interior contour (walk 20 → [10, 20];
 * transit 40 → [20, 40]; car 25 → [10, 25]). The smaller preset has no calibrated
 * interior below it, so it is a single contour (the gradient below it is rendered
 * qualitatively by the renderer, not a per-minute claim).
 */
export function presetContourMinutes(mode: Mode, selectedMin: number): number[] {
  const presets: readonly number[] =
    mode === "walk" ? WALK_PRESET_MIN : mode === "car" ? CAR_PRESET_MIN : TRANSIT_PRESET_MIN;
  // `selectedMin` MUST be an exact selectable preset — anything else (an
  // uncalibrated Custom minute, or the walk-40 union helper which is not a chip)
  // would otherwise silently return a WRONG contour set (e.g. walk 37 → [10,20],
  // a 20-min reach mislabelled). Fail loud instead, mirroring `walkPresetRangeS`.
  if (!presets.includes(selectedMin)) {
    throw new Error(`${mode} minute ${selectedMin} is not a selectable preset (have ${presets.join("/")})`);
  }
  // The nested calibrated contours: every preset up to and including the selection.
  return presets.filter((m) => m <= selectedMin).sort((a, b) => a - b);
}

/**
 * The ORS foot-walking `range` seconds for a walk preset minute at a pace — the
 * anchor range rescaled by `speed / CALIBRATION_SPEED` (integer-rounded, matching
 * `pace.ts`). Throws on an uncalibrated minute (only 10/20/40 are calibrated —
 * arbitrary Custom minutes need the deferred continuous curve).
 */
export function walkPresetRangeS(minuteAt80: number, pace: Pace): number {
  const base = WALK_PRESET_RANGES_S_AT_80[minuteAt80];
  if (base === undefined) {
    throw new Error(`walk minute ${minuteAt80} is not calibrated (have ${Object.keys(WALK_PRESET_RANGES_S_AT_80).join("/")})`);
  }
  return Math.round((base * PACE_MODEL[pace].speedMPerMin) / CALIBRATION_SPEED_M_PER_MIN);
}

/** Nominal free-flow driving `range` seconds for a car preset minute (minutes×60);
 *  the congestion factor is applied downstream by `car-traffic.ts`, unchanged. */
export function carPresetRangeS(minute: number): number {
  return minute * 60;
}

/**
 * The ascending ORS `range` set to request for a selected WALK preset (nested
 * contours), at a pace. Asserts strict ascent + min separation so a future edit
 * cannot produce a set the `ors.ts` normalize bijection would mislabel.
 */
export function walkPresetRangeSetS(selectedMin: number, pace: Pace): number[] {
  const ranges = presetContourMinutes("walk", selectedMin).map((m) => walkPresetRangeS(m, pace));
  assertSeparated(ranges);
  return ranges;
}

/** The ascending nominal driving `range` set for a selected CAR preset. */
export function carPresetRangeSetS(selectedMin: number): number[] {
  const ranges = presetContourMinutes("car", selectedMin).map(carPresetRangeS);
  assertSeparated(ranges);
  return ranges;
}

/** Strictly ascending and separated by ≥ MIN_RANGE_SEPARATION_S so the ORS
 *  normalize bijection can never mislabel two contours. */
export function assertSeparated(ranges: readonly number[]): void {
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]! - ranges[i - 1]! < MIN_RANGE_SEPARATION_S) {
      throw new Error(`range set not separated by ≥${MIN_RANGE_SEPARATION_S}s: [${ranges.join(", ")}]`);
    }
  }
}
