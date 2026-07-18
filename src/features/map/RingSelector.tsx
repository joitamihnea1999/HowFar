import { RING_FILTER_OPTIONS, type RingFilter } from "@/features/isochrones/isochrone-view";

/**
 * Time-band selector (task 024): which of the fetched 15/30/45 rings the map
 * displays. Pure presentation — the layer-visibility application lives in
 * AppMap; the option list and default in isochrone-view.
 */

interface RingSelectorProps {
  value: RingFilter;
  onSelect: (next: RingFilter) => void;
}

const OPTION_LABEL: Record<string, string> = {
  "15": "15 min",
  "30": "30 min",
  "45": "45 min",
  all: "All",
};

export default function RingSelector({ value, onSelect }: RingSelectorProps) {
  return (
    <div
      role="group"
      aria-label="Travel time"
      className="pointer-events-auto flex gap-1 rounded-full border border-white/15 bg-black/50 p-1 backdrop-blur"
    >
      {RING_FILTER_OPTIONS.map((option) => (
        <button
          key={String(option)}
          type="button"
          onClick={() => onSelect(option)}
          aria-pressed={value === option}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            value === option ? "bg-zinc-100/90 text-zinc-950" : "text-zinc-300 hover:text-zinc-100"
          }`}
        >
          {OPTION_LABEL[String(option)]}
        </button>
      ))}
    </div>
  );
}
