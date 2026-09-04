/**
 * Phone-first PRESET reach model — the calibrated preset minutes + the pure
 * range GENERATOR that turns a preset into the ORS ranges / transit thresholds to
 * request. PURE module (no server imports), like `pace.ts` and `bands.ts`, so both
 * the server provider clients and the client view can read it.
 *
 * SCOPE: this module holds the calibrated NUMBERS and the pure generator. The
 * provider clients + routes now consume it as an ADDITIVE serving path — the
 * isochrone / car / transit routes serve the presets only when called with
 * `?model=preset` (absent ⇒ the legacy 15/30/45 path, byte-identical), via
 * `walkingPresetIsochrone` / `drivingPresetIsochrone` / `transitPresetIsochrone`
 * under distinct `*:preset:v1:` cache keys. It is NOT yet wired into `bands.ts` /
 * the amenity clip (still the legacy 3-ring model) or any client UI — those are the
 * remaining phone-first changes.
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
 *     A per-origin note: walk 10/20 is clean at central + most origins but
 *     OVER-claims at a river/rail barrier (Grozăvești ~+10 min) — the same
 *     street-network anisotropy the shipped 15/30/45 rings show. This is an
 *     accepted, documented limitation (see docs/PROVIDERS.md); the reach UI must
 *     state that times are typical street-walk estimates and can overstate near
 *     barriers. It is NOT within a symmetric ±10% bar at those origins.
 *   - CAR minutes are NOMINAL free-flow (`minutes × 60`); ORS driving-car is
 *     accurate-to-conservative vs OSRM at 10/25 (task 056 straddle-1.0; re-checked
 *     directly on the served free-flow ranges 2026-09-03, 0% over-claim — receipt
 *     `scripts/calibrate/receipts/car-spotcheck-2026-09-03.json`). The per-time-of-day
 *     congestion factor (`car-traffic.ts`) applies on top, shrinking the reach further.
 *   - TRANSIT minutes are contour thresholds of the transit field; 20/40 are
 *     interior to the shipped 15/45 envelope (`transit-grid.ts`) and were measured
 *     DIRECTLY on the served preset code (`transitPresetIsochrone`, thresholds
 *     [20,40], field kept at 45) against MOTIS `/plan` best-journey at 3 origins —
 *     central 0% over-claim, only KNOWN peripheral tails (Berceni SE +33, Militari
 *     west +6) — receipt `scripts/calibrate/receipts/transit-2026-09-03.json`. The transit
 *     union at 40 folds in the walk-40 contour; its walk-union component west of the
 *     CFR/A1 barrier corridor is covered by the accepted-anisotropy limitation, not a
 *     separate direct measurement. The UI must not overstate transit reach at the edges.
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
/** The full walk contour set the serving path FETCHES in one ORS request: the two
 *  walk-preset chips [10,20] plus 40 (the transit street-walk union helper). The
 *  serving path fetches this whole set under one cache key and SLICES per consumer
 *  — the walk route returns [10,20]; the transit union takes [20,40] — so walk and
 *  transit never issue different-range requests under a colliding key (which would
 *  cache-poison the transit union). */
export const ALL_PRESET_WALK_MIN = [10, 20, 40] as const;
/** Selectable car preset minutes. */
export const CAR_PRESET_MIN = [10, 25] as const;
/** Selectable transit preset minutes (also the transit field contour thresholds). */
export const TRANSIT_PRESET_MIN = [20, 40] as const;

export type Mode = "walk" | "transit" | "car";

/**
 * The two selectable preset chips per mode, smaller→larger (the phone-first top
 * bar). ONE home for the mapping, derived from the per-mode constants above so a
 * chip list can never disagree with the served/calibrated minutes. Index 0 is the
 * DEFAULT (walk 10 / transit 20 / car 10). Exhaustive `Record<Mode,…>` so a new
 * mode is a compile error, not a silent inherit.
 */
export const PRESET_MIN_BY_MODE: Record<Mode, readonly number[]> = {
  walk: WALK_PRESET_MIN,
  transit: TRANSIT_PRESET_MIN,
  car: CAR_PRESET_MIN,
};

/** A selectable preset index (0 = smaller/default, 1 = larger). The phone-first
 * chip row is exactly these two, mode-independent, so the index survives a mode
 * switch (index 0 = walk 10 / transit 20 / car 10; index 1 = walk 20 / transit
 * 40 / car 25). */
export type PresetIndex = 0 | 1;
export const DEFAULT_PRESET_INDEX: PresetIndex = 0;

/**
 * The selected preset MINUTE for a mode + chip index. Clamps the index into
 * range (the UI only ever passes 0/1, but a clamp keeps a stray value on the
 * ramp rather than reading `undefined`). This is the single lookup the client
 * render + fetch + chip labels derive the selected minute from, so they can
 * never disagree.
 */
export function presetMinFor(mode: Mode, index: number): number {
  const mins = PRESET_MIN_BY_MODE[mode];
  const i = Math.max(0, Math.min(mins.length - 1, Math.trunc(index)));
  return mins[i]!;
}

/** Which reach model a route serves. `legacy` = the shipped 15/30/45 (walk/transit)
 *  / 10/20/30 (car) bands; `preset` = the phone-first preset contours. */
export type ReachModel = "legacy" | "preset";

/**
 * Strict `?model=` query parser: absent/empty → `legacy` (the
 * byte-identical default the current client relies on), `"preset"` → `preset`,
 * anything else → `null` so the route 400s WITHOUT a provider call. Mirrors
 * `parsePaceStrict` — a junk value is a loud 400, never a silent fall-through to
 * legacy (which would hide a broken client contract). 2a's model space is these
 * two only; there is no per-minute selector until Custom ships (that stays a
 * separate calibration task).
 */
export function parseReachModelStrict(raw: string | null | undefined): ReachModel | null {
  if (raw === null || raw === undefined || raw === "") return "legacy";
  return raw === "preset" ? "preset" : null;
}

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

/**
 * The full ORS foot-walking `range` set the serving path requests in ONE call:
 * ranges at [10, 20, 40] (`ALL_PRESET_WALK_MIN`) for a pace, ascending + separated.
 * The serving path caches this whole set under one key and slices it — the walk
 * route returns the [10,20] contours, the transit union takes the [20,40] ones.
 * `walkPresetRangeS(40, …)` is the reason `WALK_PRESET_RANGES_S_AT_80` carries the
 * 40 range even though 40 is not a selectable walk chip.
 */
export function allPresetWalkRangesS(pace: Pace): number[] {
  const ranges = ALL_PRESET_WALK_MIN.map((m) => walkPresetRangeS(m, pace));
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
