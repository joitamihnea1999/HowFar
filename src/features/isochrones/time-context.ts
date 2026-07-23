/**
 * Transit departure "time context" — the single source of truth for WHEN the
 * transit reachability is computed, shared by the UI `TimeContextControl`
 * (labels + hints + presets), the `/api/transit` route (param parsing), and
 * `server/transit.ts` (resolution to a pinned ISO instant).
 *
 * PURE module — no server imports — so the client control can read presets and
 * the server can resolve them from the same table.
 *
 * Transit-only (walking has no schedule). The default preset reproduces the
 * pre-051 behaviour exactly (upcoming Wednesday 08:30 Europe/Bucharest,
 * strictly-future / never-today), so an unchanged request is byte-identical.
 *
 * Custom is deliberately NOT exact-minute trip planning (task 051 scope): the
 * minute is quantised to :00/:30 slots so cache keys stay bounded, and the
 * resolver rolls forward to the nearest UPCOMING occurrence of the chosen
 * weekday+slot (same-day if still in the future — unlike the presets).
 */

// JS `Date.getUTCDay()` convention: 0=Sun … 3=Wed … 6=Sat.
export type TimePresetId = "weekday-morning" | "midday" | "evening" | "weekend";

export interface TimePreset {
  id: TimePresetId;
  label: string;
  /** Adaptive "why" hint, mirroring the pace control. */
  hint: string;
  weekday: number;
  hour: number;
  minute: number;
}

export const TIME_PRESETS: Record<TimePresetId, TimePreset> = {
  "weekday-morning": {
    id: "weekday-morning",
    label: "Weekday morning",
    hint: "typical weekday morning peak",
    weekday: 3,
    hour: 8,
    minute: 30,
  },
  midday: {
    id: "midday",
    label: "Midday",
    hint: "quieter off-peak weekday service",
    weekday: 3,
    hour: 12,
    minute: 30,
  },
  evening: {
    id: "evening",
    label: "Evening",
    hint: "evening rush-hour service",
    weekday: 3,
    hour: 18,
    minute: 0,
  },
  weekend: {
    id: "weekend",
    label: "Weekend",
    hint: "thinner weekend timetable",
    weekday: 6,
    hour: 12,
    minute: 0,
  },
};

export const TIME_PRESET_IDS = Object.keys(TIME_PRESETS) as TimePresetId[];
export const DEFAULT_TIME_PRESET: TimePresetId = "weekday-morning";

export type TimeContext =
  | { kind: "preset"; preset: TimePresetId }
  | { kind: "custom"; weekday: number; hour: number; minute: number };

export const DEFAULT_TIME_CONTEXT: TimeContext = { kind: "preset", preset: DEFAULT_TIME_PRESET };

/** Quantise a raw minute to the nearest :00/:30 slot (bounds cache keys; the
 * picker only offers those two anyway). Rounds to 30 only within the same hour
 * — 30..59 → 30, else 0 — so no hour carry is needed. */
export function quantizeMinute(minute: number): 0 | 30 {
  return minute >= 30 ? 30 : 0;
}

/** Resolved wall-clock fields + whether "today" is allowed (presets are
 * strictly-future/never-today for cache stability; custom may be today). */
export interface DepartureFields {
  weekday: number;
  hour: number;
  minute: number;
  allowToday: boolean;
}

export function departureFields(tc: TimeContext): DepartureFields {
  if (tc.kind === "custom") {
    return {
      weekday: ((tc.weekday % 7) + 7) % 7,
      hour: Math.min(23, Math.max(0, Math.trunc(tc.hour))),
      minute: quantizeMinute(tc.minute),
      allowToday: true,
    };
  }
  const p = TIME_PRESETS[tc.preset];
  return { weekday: p.weekday, hour: p.hour, minute: p.minute, allowToday: false };
}

/** Short human summary for the UI honesty copy ("Scheduled public transport for …"). */
export function timeContextSummary(tc: TimeContext): string {
  if (tc.kind === "preset") return TIME_PRESETS[tc.preset].label;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const f = departureFields(tc);
  const hh = String(f.hour).padStart(2, "0");
  const mm = String(f.minute).padStart(2, "0");
  return `${days[f.weekday]} ${hh}:${mm}`;
}

/** Adaptive hint for the active context (mirrors pace's `hint`). */
export function timeContextHint(tc: TimeContext): string {
  return tc.kind === "preset" ? TIME_PRESETS[tc.preset].hint : "your chosen day and time";
}

/**
 * Parse untrusted query params into a `TimeContext`. Returns `null` on invalid
 * input (route → 400) and `DEFAULT_TIME_CONTEXT` when nothing is supplied (so
 * pre-051 URLs keep working). Custom (weekday+time) takes precedence; both are
 * required together. `time` is `HH:MM` 24h; the minute is slot-quantised later.
 */
export function parseTimeContext(params: {
  preset?: string | null;
  weekday?: string | null;
  time?: string | null;
}): TimeContext | null {
  const preset = params.preset ?? "";
  const weekday = params.weekday ?? "";
  const time = params.time ?? "";

  if (weekday !== "" || time !== "") {
    if (weekday === "" || time === "") return null; // custom needs BOTH
    const wd = Number(weekday);
    const m = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6 || !m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { kind: "custom", weekday: wd, hour, minute };
  }
  if (preset !== "") {
    if (!(TIME_PRESET_IDS as string[]).includes(preset)) return null;
    return { kind: "preset", preset: preset as TimePresetId };
  }
  return DEFAULT_TIME_CONTEXT;
}
