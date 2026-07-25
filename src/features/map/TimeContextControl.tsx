import { carTrafficSlotFor } from "@/features/isochrones/car-traffic";
import {
  TIME_PRESET_IDS,
  TIME_PRESETS,
  timeContextHint,
  type TimeContext,
  type TimePresetId,
} from "@/features/isochrones/time-context";

/**
 * Departure/time selector (tasks 051/058; cut to two in 059): two one-tap
 * options — **Crowded** (weekday rush) / **Not crowded** (off-peak midday). The
 * four old presets and the free-form Custom day/time editor are gone (owner:
 * least-necessary UI). Rendered in transit AND car mode (car reach is
 * time-aware for traffic realism); the `mode` prop only changes the labels/hint
 * (transit = departure service; car = the traffic the drive estimate assumes).
 * PaceControl stays a SEPARATE walk-only control.
 */

interface TimeContextControlProps {
  value: TimeContext;
  onSelect: (next: TimeContext) => void;
  /** Which time-aware mode this instance serves — drives labels + hint only. */
  mode: "transit" | "car";
}

export default function TimeContextControl({ value, onSelect, mode }: TimeContextControlProps) {
  const heading = mode === "car" ? "When you drive" : "When you travel";
  const groupLabel = mode === "car" ? "Driving time" : "Public transport departure time";
  // Car hint names the traffic the estimate assumes; transit keeps the
  // service-frequency hint. Both are honest about what the time selection means.
  const hint = mode === "car" ? `Typical ${carTrafficSlotFor(value).label} traffic.` : timeContextHint(value);

  function selectPreset(preset: TimePresetId) {
    onSelect({ kind: "preset", preset });
  }

  const chipClass = (active: boolean) =>
    `inline-flex min-h-11 flex-1 items-center justify-center rounded-[0.65rem] px-2.5 text-[0.7rem] font-semibold transition-[background-color,color,box-shadow] sm:text-xs ${
      active
        ? "bg-[#a78bfa] text-[#1d1238] shadow-[0_5px_16px_rgba(167,139,250,.18)]"
        : "text-[#9ca9a0] hover:bg-white/[.055] hover:text-[#edf2ed]"
    }`;

  return (
    <div className="min-w-0">
      <span className="mb-1.5 block px-1 text-[0.58rem] font-semibold uppercase tracking-[0.14em] text-[#78857b]">
        {heading}
      </span>
      <div role="group" aria-label={groupLabel} className="flex gap-1 rounded-xl border border-white/[.09] bg-[#080b09]/65 p-1">
        {TIME_PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => selectPreset(id)}
            aria-pressed={value.preset === id}
            className={chipClass(value.preset === id)}
          >
            {TIME_PRESETS[id].label}
          </button>
        ))}
      </div>

      <p aria-live="polite" className="mt-1.5 px-1 text-[0.68rem] leading-4 text-[#78857b]">
        {hint}
      </p>
    </div>
  );
}
