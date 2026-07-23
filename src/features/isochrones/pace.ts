/**
 * Walking-pace model — the single source of truth for how fast a pedestrian
 * walks, shared by the walk isochrone (`server/ors.ts`), the transit isochrone
 * (`server/transit.ts` MOTIS access + `server/transit-grid.ts` egress), the
 * amenity walk-ring clip (`amenities/server/catalogue.ts`), and the UI control.
 *
 * PURE module — no server imports — so the client `PaceControl` can read
 * `label`/`emoji`/`hint` while the server reads the speed fields.
 *
 * INVARIANT (task 051, byte-identity gate): the `normal` pace MUST reproduce
 * the pre-051 constants exactly — ORS ranges `[827,1674,2528]`, MOTIS
 * pedestrian speed `"1.333"`, egress base 80 m/min over the 1.402 detour — so
 * an unchanged (default-pace) request is byte-identical to before this feature.
 *
 * Non-`normal` ORS ranges are the linear `×speed/80` scale of the calibrated
 * normal ranges (distance calibration is speed-independent — PROVIDERS.md
 * "Calibration": distance is the ruler, pace only rescales minutes⇄distance).
 * VALIDATED (task 051 G6, bounded MOTIS distance-ruler at pace extremes): the
 * linear scale holds within ±10% (Relaxed −2.1%, Brisk +9.7% — borderline, so
 * the UI labels non-normal paced reach an "estimated reach"). A multi-origin
 * tightening of Brisk is parked. If a future audit fails, replace the failing
 * pace's `orsRangesS` with a measured triple.
 */

export type Pace = "relaxed" | "normal" | "brisk";

export const PACES: readonly Pace[] = ["relaxed", "normal", "brisk"] as const;
export const DEFAULT_PACE: Pace = "normal";

/** Nominal normal walking speed — the speed the ring LABELS have always promised. */
export const NORMAL_SPEED_M_PER_MIN = 80;
/** Median Bucharest street-network detour vs crow-fly (measured 2026-07-17). */
export const STREET_DETOUR = 1.402;
/** The pre-051 calibrated normal ORS ranges (seconds) — see `ors.ts` history. */
export const NORMAL_ORS_RANGES_S: readonly [number, number, number] = [827, 1674, 2528];

export interface PaceModel {
  id: Pace;
  /** Segment label. */
  label: string;
  /** Leading glyph for the control (client only reads this). */
  emoji: string;
  /** Adaptive one-line "when to use this" hint (client `aria-live`). */
  hint: string;
  /** Pedestrian speed in metres/minute. */
  speedMPerMin: number;
  /** MOTIS `pedestrianSpeed` query value (m/s, string — kept exact for `normal`). */
  pedestrianSpeedMs: string;
  /** Radial egress speed = speed / detour (m/min); feeds `transit-grid` stamping. */
  egressMPerMin: number;
  /** Requested ORS ranges (seconds) for the 15/30/45 rings at this pace. */
  orsRangesS: [number, number, number];
}

/** Linear scale of the normal ranges by speed ratio, integer-rounded (ORS
 * echoes and `normalize()` biject on integers, RANGE_TOLERANCE_S=1). `normal`
 * scales by exactly 1 ⇒ the byte-identical calibrated triple. */
function scaledRanges(speedMPerMin: number): [number, number, number] {
  const f = speedMPerMin / NORMAL_SPEED_M_PER_MIN;
  return NORMAL_ORS_RANGES_S.map((s) => Math.round(s * f)) as unknown as [number, number, number];
}

export const PACE_MODEL: Record<Pace, PaceModel> = {
  relaxed: {
    id: "relaxed",
    label: "Relaxed",
    emoji: "🚶",
    hint: "with kids, a stroller, or taking it easy",
    speedMPerMin: 66,
    pedestrianSpeedMs: "1.100",
    egressMPerMin: 66 / STREET_DETOUR,
    orsRangesS: scaledRanges(66),
  },
  normal: {
    id: "normal",
    label: "Normal",
    emoji: "🚶‍♂️",
    hint: "average adult, about 4.8 km/h",
    speedMPerMin: NORMAL_SPEED_M_PER_MIN,
    // Kept as the pre-051 literal (NOT 80/60="1.3333…") for request byte-identity.
    pedestrianSpeedMs: "1.333",
    egressMPerMin: NORMAL_SPEED_M_PER_MIN / STREET_DETOUR,
    orsRangesS: scaledRanges(NORMAL_SPEED_M_PER_MIN),
  },
  brisk: {
    id: "brisk",
    label: "Brisk",
    emoji: "🏃",
    hint: "fit and walking with purpose",
    speedMPerMin: 92,
    pedestrianSpeedMs: "1.533",
    egressMPerMin: 92 / STREET_DETOUR,
    orsRangesS: scaledRanges(92),
  },
};

/** Narrow an untrusted string (query param) to a `Pace`, defaulting to normal. */
export function parsePace(raw: string | null | undefined): Pace {
  return raw && (PACES as readonly string[]).includes(raw) ? (raw as Pace) : DEFAULT_PACE;
}

/** Strict variant for API validation: null when the value is present but invalid
 * (so a route can 400 on junk) vs undefined/empty → default. */
export function parsePaceStrict(raw: string | null | undefined): Pace | null {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_PACE;
  return (PACES as readonly string[]).includes(raw) ? (raw as Pace) : null;
}
