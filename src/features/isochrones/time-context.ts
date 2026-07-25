/**
 * Transit/car departure "time context" — the single source of truth for WHEN
 * reachability is computed, shared by the UI `TimeContextControl` (labels +
 * hints), the `/api/transit` `/api/car` `/api/reach` routes (param parsing), and
 * `server/transit.ts` (resolution to a pinned ISO instant).
 *
 * PURE module — no server imports — so the client control and the server read
 * the same table.
 *
 * Task 059 cut this to the least-necessary set the owner asked for: TWO options,
 * **Crowded** (weekday rush) and **Not crowded** (off-peak midday). The four old
 * presets and the free-form Custom day/time editor are gone. `crowded` reuses the
 * pre-059 default fields exactly (upcoming Wednesday 08:30 Europe/Bucharest,
 * strictly-future / never-today), so a default request stays byte-identical
 * (same resolved departure → same transit cache key; same am-peak car slot).
 *
 * No live users (CLAUDE.md), so removed query params are NOT aliased — they are
 * rejected fail-loud (→ 400) rather than silently defaulting, and the intentional
 * API break is documented in docs/PROVIDERS.md.
 */

// JS `Date.getUTCDay()` convention: 0=Sun … 3=Wed … 6=Sat.
export type TimePresetId = "crowded" | "quiet";

export interface TimePreset {
  id: TimePresetId;
  /** Segment label shown on the chip. */
  label: string;
  /** Adaptive "why" hint, mirroring the pace control. */
  hint: string;
  /** Natural time-phrase for the SelectionCard honesty sentence
   *  ("Scheduled public transport for {phrase}"). */
  phrase: string;
  weekday: number;
  hour: number;
  minute: number;
}

export const TIME_PRESETS: Record<TimePresetId, TimePreset> = {
  // `crowded` == the pre-059 default (Wed 08:30) → byte-identical default rings
  // and the weekday-morning car slot (am-peak ×2.1).
  crowded: {
    id: "crowded",
    label: "Crowded",
    hint: "rush hour — busiest service and heaviest traffic",
    phrase: "a weekday rush hour",
    weekday: 3,
    hour: 8,
    minute: 30,
  },
  quiet: {
    id: "quiet",
    // Owner label "Not crowded". Mapped to weekday MIDDAY (Wed 12:30): the honest
    // "not crowded" for BOTH engines — full daytime transit service + light-but-
    // real traffic (car midday ×1.5). Night/weekend would misread as a thin
    // timetable (worse reach), which is not what "quieter" should imply.
    label: "Not crowded",
    hint: "off-peak midday — quieter service and lighter traffic",
    phrase: "a quieter midday",
    weekday: 3,
    hour: 12,
    minute: 30,
  },
};

export const TIME_PRESET_IDS = Object.keys(TIME_PRESETS) as TimePresetId[];
export const DEFAULT_TIME_PRESET: TimePresetId = "crowded";

/** One option now, but kept as a discriminated shape so `tc.kind`/`tc.preset`
 *  consumers stay unchanged after the Custom variant was removed (task 059). */
export type TimeContext = { kind: "preset"; preset: TimePresetId };

export const DEFAULT_TIME_CONTEXT: TimeContext = { kind: "preset", preset: DEFAULT_TIME_PRESET };

/** Resolved wall-clock fields. Both presets are strictly-future/never-today for
 * cache stability (~6-day reuse, rolls forward weekly). The pre-059 `allowToday`
 * flag existed only for the now-removed Custom mode, so it is gone. */
export interface DepartureFields {
  weekday: number;
  hour: number;
  minute: number;
}

export function departureFields(tc: TimeContext): DepartureFields {
  const p = TIME_PRESETS[tc.preset];
  return { weekday: p.weekday, hour: p.hour, minute: p.minute };
}

/** Natural time-phrase for the UI honesty copy — reads correctly inside
 * "Scheduled public transport for {…}" (never the raw label, which would render
 * "…for Crowded"). */
export function timeContextSummary(tc: TimeContext): string {
  return TIME_PRESETS[tc.preset].phrase;
}

/** Adaptive hint for the active context (mirrors pace's `hint`). */
export function timeContextHint(tc: TimeContext): string {
  return TIME_PRESETS[tc.preset].hint;
}

/**
 * Parse untrusted query params into a `TimeContext`. Preset-only (task 059).
 * Returns `DEFAULT_TIME_CONTEXT` when nothing relevant is supplied, `null` on
 * anything invalid (route → 400). Fail-loud on the RETIRED custom params: any
 * `weekday` or `time` present is rejected (never silently defaulted to Crowded),
 * and an unknown/removed preset id is rejected.
 */
export function parseTimeContext(params: {
  preset?: string | null;
  weekday?: string | null;
  time?: string | null;
}): TimeContext | null {
  const preset = params.preset ?? "";
  const weekday = params.weekday ?? "";
  const time = params.time ?? "";

  // Retired custom mode: reject rather than ignore, so a stale client fails
  // loudly instead of getting a silent Crowded default (plan panel).
  if (weekday !== "" || time !== "") return null;

  if (preset !== "") {
    if (!(TIME_PRESET_IDS as string[]).includes(preset)) return null;
    return { kind: "preset", preset: preset as TimePresetId };
  }
  return DEFAULT_TIME_CONTEXT;
}
