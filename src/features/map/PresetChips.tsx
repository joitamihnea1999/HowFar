import { PRESET_MIN_BY_MODE, type Mode, type PresetIndex } from "@/features/isochrones/preset-reach";

/**
 * Phone-first preset chip row (phone-first design): the active mode's TWO
 * calibrated presets — walk 10/20, transit 20/40, car 10/25 — as a compact
 * segmented control. Custom stays HIDDEN (owner-deferred: an arbitrary minute has
 * no fitted calibration point), so there is no `[Custom…]` chip and no `?minute=`
 * param. The chip is pure client-side visibility: the route returned BOTH
 * contours, so selecting a chip repaints locally with no refetch.
 *
 * Labels come from `PRESET_MIN_BY_MODE` (the one home for the calibrated minutes),
 * so a chip can never disagree with the served/calibrated reach — the band-identity
 * requirement (labels off the served minutes, not fixed positions).
 */

interface PresetChipsProps {
  mode: Mode;
  value: PresetIndex;
  onSelect: (next: PresetIndex) => void;
}

export default function PresetChips({ mode, value, onSelect }: PresetChipsProps) {
  const minutes = PRESET_MIN_BY_MODE[mode];
  return (
    <div
      role="group"
      aria-label="Reach time"
      data-testid="preset-chips"
      className="flex shrink-0 items-center gap-1 rounded-full border border-white/[.09] bg-[#080b09]/65 p-0.5"
    >
      {minutes.map((min, i) => {
        const index = i as PresetIndex;
        const active = value === index;
        return (
          <button
            key={min}
            type="button"
            data-testid={`preset-chip-${min}`}
            data-preset-min={min}
            aria-pressed={active}
            onClick={() => onSelect(index)}
            className={`min-h-9 rounded-full px-3 text-[0.72rem] font-semibold tabular-nums tracking-[-0.01em] transition-[background-color,color,box-shadow] ${
              active
                ? "bg-[#edf2ed] text-[#111713] shadow-[0_4px_12px_rgba(0,0,0,.2)]"
                : "text-[#8b978e] hover:bg-white/[.06] hover:text-[#edf2ed]"
            }`}
          >
            {min} min
          </button>
        );
      })}
    </div>
  );
}
