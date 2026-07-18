import {
  legendColor,
  MODE_LABEL,
  visibleLegendMinutes,
  type RingFilter,
} from "@/features/isochrones/isochrone-view";
import type { Mode } from "@/features/map/selection-flow";

/**
 * Selected-address card: the resolved label + per-mode ring legend, or the
 * failure message. Pure presentation of the selection machine's state. The
 * legend mirrors the ring filter — it never lists a band the map is hiding.
 */

interface SelectionCardProps {
  label: string | null;
  message: string | null;
  mode: Mode;
  ringFilter: RingFilter;
}

export default function SelectionCard({ label, message, mode, ringFilter }: SelectionCardProps) {
  if (!label && !message) return null;
  return (
    <div className="pointer-events-auto flex max-w-md flex-col items-center gap-1 rounded-2xl border border-white/10 bg-black/50 px-4 py-2 text-center backdrop-blur">
      {message ? (
        <p className="text-sm text-amber-300">{message}</p>
      ) : (
        <>
          <p className="line-clamp-2 text-sm text-zinc-200">{label}</p>
          <div data-testid="ring-legend" className="flex items-center gap-3 text-xs text-zinc-400">
            <span className="font-medium text-zinc-300">{MODE_LABEL[mode]}</span>
            {visibleLegendMinutes(ringFilter).map((m) => (
              <span key={m} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: legendColor(mode, m) }}
                />
                {m} min
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
