import { bandMinutes, RING_FILTER_OPTIONS, type RingFilter } from "@/features/isochrones/isochrone-view";
import type { Mode } from "@/features/map/selection-flow";

/**
 * Time-band selector (task 024): which of the fetched ring bands the map
 * displays. Pure presentation — the layer-visibility application lives in
 * AppMap; the option list and default in isochrone-view. The band ids are fixed
 * (15/30/45) but the LABEL is per-mode (car reads 10/20/30, task 053), so the
 * label comes from `bandMinutes(mode, band)`, not the band id.
 */

interface RingSelectorProps {
  value: RingFilter;
  mode: Mode;
  onSelect: (next: RingFilter) => void;
}

function optionLabel(mode: Mode, option: RingFilter): string {
  return option === "all" ? "All" : `${bandMinutes(mode, option)} min`;
}

export default function RingSelector({ value, mode, onSelect }: RingSelectorProps) {
  return (
    <div className="min-w-0">
      <span className="mb-1.5 block px-1 text-[0.58rem] font-semibold uppercase tracking-[0.14em] text-[#78857b]">
        Time budget
      </span>
      <div
        role="group"
        aria-label="Travel time"
        className="grid grid-cols-4 rounded-xl border border-white/[.09] bg-[#080b09]/65 p-1"
      >
        {RING_FILTER_OPTIONS.map((option) => (
          <button
            key={String(option)}
            type="button"
            onClick={() => onSelect(option)}
            aria-pressed={value === option}
            className={`min-h-11 rounded-[0.65rem] px-1 text-[0.65rem] font-semibold tracking-[-0.01em] transition-[background-color,color,box-shadow] sm:text-[0.7rem] ${
              value === option
                ? "bg-[#edf2ed] text-[#111713] shadow-[0_5px_16px_rgba(0,0,0,.2)]"
                : "text-[#8b978e] hover:bg-white/[.055] hover:text-[#edf2ed]"
            }`}
          >
            {optionLabel(mode, option)}
          </button>
        ))}
      </div>
    </div>
  );
}
