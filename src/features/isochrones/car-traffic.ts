/**
 * Car-mode traffic realism (task 058) — PURE, shared by the `/api/car` route and
 * the client copy. Bucharest driving is heavily congested (public TomTom Traffic
 * Index 2025: 62.5% congestion, 18.5 km/h average), so free-flow ORS driving
 * times over-claim reach 1.5–2.2× at peak. We do NOT call a live-traffic
 * provider (TomTom's free tier is Evaluation-Use-only per its Portal T&C §2.2,
 * and server-caching / deriving a product from its Results is barred by §11.4 /
 * §11.6.1 — see docs/PROVIDERS.md "Car traffic realism"). Instead the driving
 * isochrone budget is DIVIDED by a per-time-of-day congestion factor: reach in
 * `t` real minutes ≈ ORS free-flow reach in `t / factor` minutes. Factors are
 * grounded in the public Traffic Index + peak/off-peak literature and kept
 * deliberately conservative (they under- rather than over-claim — the product's
 * "how far can I really get" promise must never lie the optimistic way).
 *
 * No `Date.now()` here — the caller passes the wall-clock fields (from the
 * TimeContext), so this stays pure and unit-testable.
 */

import { departureFields, type TimeContext } from "@/features/isochrones/time-context";

/** Bucharest traffic periods. `weekday-*` apply Mon–Fri; `weekend-*` Sat/Sun. */
export type CarSlotId =
  | "night"
  | "shoulder"
  | "am-peak"
  | "midday"
  | "pm-peak"
  | "evening-late"
  | "weekend-day"
  | "weekend-off";

export interface CarTrafficSlot {
  slotId: CarSlotId;
  /** Human label for the honesty copy, e.g. "weekday morning rush". */
  label: string;
  /** Congestion multiplier (>=1): real drive time ≈ free-flow × factor. */
  factor: number;
  /** The wall-clock bucket this slot resolved from (documentation + tests). */
  canonical: { weekday: number; hour: number; minute: number };
}

/**
 * Factor-table revision. BUMP THIS whenever the numbers below change — it is
 * embedded in the car isochrone cache keys (ors.ts), so a recalibration can
 * never silently serve rings computed with the old factors (panel fable-4/
 * terra-4). `c1` = initial public-Index-grounded table (2026-07-24, task 058).
 */
export const CAR_FACTOR_REVISION = "c1";

/** Clamp bounds: a factor below 1 would over-claim (free-flow already is the
 * ceiling); above 4 would make a 10-min ring < 2.5 free-flow min (degenerate). */
const MIN_FACTOR = 1.0;
const MAX_FACTOR = 4.0;

interface SlotDef {
  slotId: CarSlotId;
  label: string;
  factor: number;
}

// v0 table (frev c1): public TomTom Traffic Index 2025 (Bucharest) + peak/off-
// peak congestion literature. Weekday peaks are the heaviest; weekends lighter.
const WEEKDAY_AM_PEAK: SlotDef = { slotId: "am-peak", label: "weekday morning rush", factor: 2.1 };
const WEEKDAY_MIDDAY: SlotDef = { slotId: "midday", label: "weekday midday", factor: 1.5 };
const WEEKDAY_PM_PEAK: SlotDef = { slotId: "pm-peak", label: "weekday evening rush", factor: 2.2 };
const WEEKDAY_EVENING: SlotDef = { slotId: "evening-late", label: "weekday evening", factor: 1.25 };
const WEEKDAY_NIGHT: SlotDef = { slotId: "night", label: "overnight", factor: 1.05 };
const WEEKDAY_SHOULDER: SlotDef = { slotId: "shoulder", label: "early morning", factor: 1.4 };
const WEEKEND_DAY: SlotDef = { slotId: "weekend-day", label: "weekend daytime", factor: 1.3 };
const WEEKEND_OFF: SlotDef = { slotId: "weekend-off", label: "weekend off-peak", factor: 1.1 };

function isWeekend(weekday: number): boolean {
  const wd = ((weekday % 7) + 7) % 7;
  return wd === 0 || wd === 6; // 0=Sun, 6=Sat
}

/** Resolve a wall-clock (weekday 0–6, hour 0–23) to its Bucharest traffic slot.
 * Boundaries are half-open on the lower edge: 07:00 is am-peak, 10:00 is midday. */
export function carTrafficSlot(weekday: number, hour: number, minute = 0): CarTrafficSlot {
  const h = Math.min(23, Math.max(0, Math.trunc(hour)));
  const m = Math.min(59, Math.max(0, Math.trunc(minute)));
  const wd = ((Math.trunc(weekday) % 7) + 7) % 7;

  let def: SlotDef;
  if (isWeekend(wd)) {
    // Weekend daytime runs 10–22h: extended past 20:00 (panel sonnet-1) so
    // weekend-evening dinner/nightlife traffic isn't under-scaled to the 1.1
    // off-peak factor (which would OVER-claim reach — the unsafe direction).
    def = h >= 10 && h < 22 ? WEEKEND_DAY : WEEKEND_OFF;
  } else if (h >= 23 || h < 6) {
    def = WEEKDAY_NIGHT;
  } else if (h < 7) {
    def = WEEKDAY_SHOULDER;
  } else if (h < 10) {
    def = WEEKDAY_AM_PEAK;
  } else if (h < 16) {
    def = WEEKDAY_MIDDAY;
  } else if (h < 20) {
    def = WEEKDAY_PM_PEAK;
  } else {
    def = WEEKDAY_EVENING;
  }

  const factor = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, def.factor));
  return { slotId: def.slotId, label: def.label, factor, canonical: { weekday: wd, hour: h, minute: m } };
}

/** Resolve a TimeContext to its car traffic slot (the route's entry point). */
export function carTrafficSlotFor(tc: TimeContext): CarTrafficSlot {
  const f = departureFields(tc);
  return carTrafficSlot(f.weekday, f.hour, f.minute);
}

/**
 * Scale nominal free-flow driving ranges (seconds) by a slot factor. Each range
 * is divided by the factor (heavier traffic ⇒ smaller reach). Guarantees the
 * result is strictly ascending, distinct, and ≥60s so the three rings never
 * collapse or reorder (ors.ts's normalize bijection depends on it).
 */
export function scaledCarRangesS(nominalRangesS: readonly number[], factor: number): number[] {
  const f = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, factor));
  const scaled = nominalRangesS.map((s) => Math.max(60, Math.round(s / f)));
  // Nominal ranges are strictly ascending and the factor is a single positive
  // divisor, so scaled values stay ascending; the 60s floor only bites when a
  // nominal range is already tiny (never the case for 600/1200/1800), but guard
  // anyway so a future range set can't produce a non-ascending triple.
  for (let i = 1; i < scaled.length; i++) {
    if (scaled[i]! <= scaled[i - 1]!) scaled[i] = scaled[i - 1]! + 1;
  }
  return scaled;
}
