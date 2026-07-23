import { useState } from "react";

import {
  quantizeMinute,
  TIME_PRESET_IDS,
  TIME_PRESETS,
  timeContextHint,
  type TimeContext,
  type TimePresetId,
} from "@/features/isochrones/time-context";

/**
 * Transit departure selector (task 051): 4 one-tap presets + a "Custom…" toggle
 * that reveals an INLINE day + time (30-min slots) editor. No Apply button and
 * no floating popover (impl-panel findings): presets apply on tap; a custom
 * day/time applies the moment either select changes — direct, minimal-click, and
 * it scrolls naturally inside the result sheet (a floating popover would clip in
 * the sheet's overflow box). Rendered only in transit mode by AppMap.
 */

interface TimeContextControlProps {
  value: TimeContext;
  onSelect: (next: TimeContext) => void;
}

// Monday-first ordering for the picker; values are JS `getUTCDay()` numbers.
const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

// 30-min slots 00:00 … 23:30.
const TIME_SLOTS: string[] = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = i % 2 === 0 ? "00" : "30";
  return `${String(h).padStart(2, "0")}:${m}`;
});

export default function TimeContextControl({ value, onSelect }: TimeContextControlProps) {
  const isCustom = value.kind === "custom";
  const [expanded, setExpanded] = useState(isCustom);

  // The editor's current day/time: the active custom value, else a sensible
  // default (Saturday 12:00). Selecting a slot commits immediately.
  const curWeekday = isCustom ? value.weekday : 6;
  const curTime = isCustom
    ? `${String(value.hour).padStart(2, "0")}:${String(quantizeMinute(value.minute)).padStart(2, "0")}`
    : "12:00";

  function selectPreset(preset: TimePresetId) {
    setExpanded(false);
    onSelect({ kind: "preset", preset });
  }

  function commitCustom(weekday: number, time: string) {
    const [hh, mm] = time.split(":");
    onSelect({ kind: "custom", weekday, hour: Number(hh), minute: Number(mm) });
  }

  const chipClass = (active: boolean) =>
    `inline-flex min-h-11 items-center justify-center rounded-[0.65rem] px-2.5 text-[0.7rem] font-semibold transition-[background-color,color,box-shadow] sm:text-xs ${
      active
        ? "bg-[#a78bfa] text-[#1d1238] shadow-[0_5px_16px_rgba(167,139,250,.18)]"
        : "text-[#9ca9a0] hover:bg-white/[.055] hover:text-[#edf2ed]"
    }`;

  return (
    <div className="min-w-0">
      <span className="mb-1.5 block px-1 text-[0.58rem] font-semibold uppercase tracking-[0.14em] text-[#78857b]">
        When you travel
      </span>
      <div role="group" aria-label="Transit departure time" className="flex flex-wrap gap-1 rounded-xl border border-white/[.09] bg-[#080b09]/65 p-1">
        {TIME_PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => selectPreset(id)}
            aria-pressed={value.kind === "preset" && value.preset === id}
            className={chipClass(value.kind === "preset" && value.preset === id)}
          >
            {TIME_PRESETS[id].label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-pressed={isCustom}
          aria-expanded={expanded}
          className={chipClass(isCustom)}
        >
          Custom…
        </button>
      </div>

      {expanded ? (
        <div className="mt-1.5 grid grid-cols-2 gap-2">
          <label className="text-[0.58rem] font-semibold uppercase tracking-[0.12em] text-[#78857b]">
            Day
            <select
              aria-label="Departure day"
              value={curWeekday}
              onChange={(e) => commitCustom(Number(e.target.value), curTime)}
              className="mt-1 min-h-11 w-full rounded-lg border border-white/[.12] bg-[#080b09] px-2 text-sm font-medium text-[#edf2ed]"
            >
              {WEEKDAY_OPTIONS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[0.58rem] font-semibold uppercase tracking-[0.12em] text-[#78857b]">
            Time
            <select
              aria-label="Departure time"
              value={curTime}
              onChange={(e) => commitCustom(curWeekday, e.target.value)}
              className="mt-1 min-h-11 w-full rounded-lg border border-white/[.12] bg-[#080b09] px-2 text-sm font-medium text-[#edf2ed]"
            >
              {TIME_SLOTS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      <p aria-live="polite" className="mt-1.5 px-1 text-[0.68rem] leading-4 text-[#78857b]">
        {timeContextHint(value)}
      </p>
    </div>
  );
}
