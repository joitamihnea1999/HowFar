/**
 * Walking-pace model — the single source of truth for how fast a pedestrian
 * walks, shared by the walk isochrone (`server/ors.ts`), the transit isochrone
 * (`server/transit.ts` MOTIS access + `server/transit-grid.ts` egress), the
 * amenity walk-ring clip (`amenities/server/catalogue.ts`), and the UI control.
 *
 * PURE module — no server imports — so the client `PaceControl` can read
 * `label`/`emoji`/`hint` while the server reads the speed fields.
 *
 * CONTRACT — ANCHOR + SCALE (task 064). Two numbers that used to be the same
 * number are now deliberately different, and conflating them is the trap this
 * module exists to prevent:
 *
 *   - CALIBRATION_SPEED_M_PER_MIN (80) is a MEASUREMENT RULER, not anybody's
 *     walking speed. The ORS ranges `CALIBRATED_RANGES_S_AT_80` were fitted by
 *     street-distance audit AT that speed (PROVIDERS.md "Calibration").
 *   - `speedMPerMin` on each pace is the PRODUCT speed we promise the user.
 *
 * Every pace's `orsRangesS` is the linear `×speed/CALIBRATION_SPEED` rescale of
 * the anchor triple, because distance calibration is speed-independent —
 * distance is the ruler, pace only rescales minutes⇄distance. If someone
 * "simplifies" `scaledRanges` to divide by `normal.speedMPerMin`, Slow's ranges
 * silently change and Normal's silently become the raw uncalibrated triple.
 *
 * Task 064 (owner order): walking speeds are now Slow = 3 km/h (50 m/min) and
 * Normal = 5 km/h (5000/60 m/min), replacing 4 / 4.8 km/h. This RETIRES the
 * task-051 "normal is byte-identical to the pre-051 constants" invariant — the
 * owner changed the promised speed, so no pace is the anchor any more and every
 * derived value moved (all four provider cache keys were bumped in the same
 * commit: iso:foot:v4, transit:v5, reach:plan:v5, amenity:local:v4).
 *
 * VALIDATED: task 051 G6 bounded the linear scale within ±10% at 66 m/min
 * (−2.1%); task 064 re-audited it at the new Slow (50 m/min) — see PROVIDERS.md
 * "Walking-speed audit at Slow". Slow is still labelled an "estimated reach" in the UI
 * because it is a scaled, not directly measured, pace. If a future audit fails,
 * ESCALATE — do not quietly substitute a measured triple, since that breaks the
 * "every pace is the anchor rescaled" property the tests pin.
 */

export type Pace = "slow" | "normal";

export const PACES: readonly Pace[] = ["slow", "normal"] as const;
export const DEFAULT_PACE: Pace = "normal";

/** The speed the ORS ranges below were MEASURED at — a calibration ruler, NOT a
 *  product walking speed (no pace has equalled it since task 064). Only change
 *  this alongside a fresh street-distance audit. */
export const CALIBRATION_SPEED_M_PER_MIN = 80;
/** Median Bucharest street-network detour vs crow-fly (measured 2026-07-17). */
export const STREET_DETOUR = 1.402;
/** ORS ranges (seconds) fitted by street-distance audit AT
 *  `CALIBRATION_SPEED_M_PER_MIN` — see `ors.ts` history / PROVIDERS.md. Every
 *  pace rescales this triple; nobody requests it verbatim. */
export const CALIBRATED_RANGES_S_AT_80: readonly [number, number, number] = [827, 1674, 2528];

export interface PaceModel {
  id: Pace;
  /** Segment label. */
  label: string;
  /** Leading glyph for the control (client only reads this). */
  emoji: string;
  /** Short per-option description shown UNDER each button (both visible, so a
   *  user can choose without selecting) — the owner's "short description of what
   *  it means" (task 059). */
  blurb: string;
  /** Adaptive one-line "when to use this" hint (client `aria-live`). */
  hint: string;
  /** Pedestrian speed in metres/minute. */
  speedMPerMin: number;
  /** MOTIS `pedestrianSpeed` query value (m/s, 3-dp string derived from
   *  `speedMPerMin` — the request contract wants a short decimal). */
  pedestrianSpeedMs: string;
  /** Radial egress speed = speed / detour (m/min); feeds `transit-grid` stamping. */
  egressMPerMin: number;
  /** Requested ORS ranges (seconds) for the 15/30/45 rings at this pace. */
  orsRangesS: [number, number, number];
}

/** Linear rescale of the CALIBRATION-ANCHOR ranges by speed ratio,
 * integer-rounded (ORS echoes and `normalize()` biject on integers,
 * RANGE_TOLERANCE_S=1). The divisor is the anchor speed, never a pace's own
 * speed — see the module contract. */
function scaledRanges(speedMPerMin: number): [number, number, number] {
  const f = speedMPerMin / CALIBRATION_SPEED_M_PER_MIN;
  return CALIBRATED_RANGES_S_AT_80.map((s) => Math.round(s * f)) as unknown as [
    number,
    number,
    number,
  ];
}

// Product speeds (task 064, owner-set). Kept as `km/h × 1000 / 60` expressions
// rather than rounded literals so the promised km/h stays exact. Named
// *_PACE_SPEED_* so neither can be mistaken for the calibration anchor above —
// the pre-064 `NORMAL_SPEED_M_PER_MIN` meant the anchor, and reviving that
// spelling for a pace speed is precisely the conflation this module forbids.
/** Slow = 3 km/h. */
const SLOW_PACE_SPEED_M_PER_MIN = 3000 / 60;
/** Normal = 5 km/h. */
const NORMAL_PACE_SPEED_M_PER_MIN = 5000 / 60;

/** MOTIS `pedestrianSpeed` (m/s) DERIVED from the pace speed, 3 dp — the
 * request contract wants a short decimal string, but hand-typing it would make
 * it the one speed field that can silently go stale when a speed is edited
 * (the consistency test only bounds it to ±0.005 m/s). */
function pedestrianSpeedMsOf(speedMPerMin: number): string {
  return (speedMPerMin / 60).toFixed(3);
}

export const PACE_MODEL: Record<Pace, PaceModel> = {
  // 3 km/h — 37.5% below the calibration anchor, i.e. further from it than any
  // pace task 051 validated, which is why task 064 re-ran the G6 distance-ruler
  // audit here. Labelled an "estimated reach" (non-anchor) in the control.
  slow: {
    id: "slow",
    label: "Slow",
    emoji: "🚶",
    blurb: "leisurely, ~3 km/h",
    hint: "an easy stroll — with kids, a stroller, or in no hurry",
    speedMPerMin: SLOW_PACE_SPEED_M_PER_MIN,
    // 50/60 = 0.8333… m/s -> "0.833" (probed live in task 064).
    pedestrianSpeedMs: pedestrianSpeedMsOf(SLOW_PACE_SPEED_M_PER_MIN),
    egressMPerMin: SLOW_PACE_SPEED_M_PER_MIN / STREET_DETOUR,
    orsRangesS: scaledRanges(SLOW_PACE_SPEED_M_PER_MIN),
  },
  normal: {
    id: "normal",
    label: "Normal",
    emoji: "🚶‍♂️",
    blurb: "average adult, ~5 km/h",
    hint: "average adult, about 5 km/h",
    speedMPerMin: NORMAL_PACE_SPEED_M_PER_MIN,
    // (5000/60)/60 = 1.3888… m/s -> "1.389" (probed live in task 064).
    pedestrianSpeedMs: pedestrianSpeedMsOf(NORMAL_PACE_SPEED_M_PER_MIN),
    egressMPerMin: NORMAL_PACE_SPEED_M_PER_MIN / STREET_DETOUR,
    orsRangesS: scaledRanges(NORMAL_PACE_SPEED_M_PER_MIN),
  },
};

/** Narrow an untrusted string (query param) to a `Pace` for API validation: null
 * when the value is present but invalid (so a route can 400 on junk incl. the
 * retired `relaxed`/`brisk` ids — fail-loud, no silent alias) vs undefined/empty
 * → default. Every route uses this strict form (the pre-059 lenient `parsePace`
 * that silently defaulted junk was removed as dead + policy-contradicting). */
export function parsePaceStrict(raw: string | null | undefined): Pace | null {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_PACE;
  return (PACES as readonly string[]).includes(raw) ? (raw as Pace) : null;
}
