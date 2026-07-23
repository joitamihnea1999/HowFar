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
  loading: boolean;
  /** Transit only: the resolved representative departure + summary, so we can
   * honestly qualify the reach (schedule-based, no live traffic — task 051). */
  departure?: { iso: string; summary: string } | null;
}

export default function SelectionCard({ label, message, mode, ringFilter, loading, departure }: SelectionCardProps) {
  if (!label && !message && !loading) return null;
  const modeColor = mode === "walk" ? "var(--hf-walk)" : "var(--hf-transit)";
  return (
    <div
      aria-live="polite"
      aria-busy={loading}
      className="rounded-[1.1rem] border border-white/[.08] bg-white/[.035] p-3.5 md:p-4"
    >
      {loading ? (
        <div className="flex min-h-14 items-center gap-3">
          <span className="hf-spinner size-5 shrink-0 rounded-full border-2 border-[#c7f36b]/25 border-t-[#c7f36b]" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-[#f4f7f2]">Mapping your everyday reach…</p>
            <p className="mt-1 text-xs text-[#78857b]">Calculating routes and nearby essentials</p>
          </div>
        </div>
      ) : message ? (
        <div role="alert" className="flex min-h-14 items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-[#f6c86b]/10 text-[#f6c86b] ring-1 ring-[#f6c86b]/20" aria-hidden="true">
            !
          </span>
          <div>
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-[#f6c86b]">Couldn’t finish</p>
            <p className="mt-1 text-sm leading-5 text-[#eadfc7]">{message}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <span
              className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-white/[.05] ring-1 ring-white/[.08]"
              style={{ color: modeColor }}
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24" className="size-[1.1rem]" fill="none" stroke="currentColor" strokeWidth="1.9">
                <path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z" />
                <circle cx="12" cy="10" r="2" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-[#78857b]">Your selected place</p>
              <p className="mt-1 line-clamp-2 text-sm font-medium leading-5 text-[#edf2ed]">{label}</p>
            </div>
          </div>
          <div
            data-testid="ring-legend"
            className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/[.07] pt-3 text-[0.7rem] text-[#9ca9a0]"
          >
            <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: modeColor }}>
              <span className="size-1.5 rounded-full bg-current" />
              {MODE_LABEL[mode]}
            </span>
            {visibleLegendMinutes(ringFilter).map((m) => (
              <span key={m} className="flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-full ring-1 ring-white/20" style={{ background: legendColor(mode, m) }} />
                {m} min
              </span>
            ))}
            <span className="ml-auto text-[#667269]">shown on map</span>
          </div>
          {mode === "transit" && departure ? (
            <p data-testid="transit-departure-note" className="mt-2 text-[0.68rem] leading-4 text-[#667269]">
              Scheduled public transport for <span className="text-[#9ca9a0]">{departure.summary}</span> — an estimate
              from published timetables; live delays and road traffic aren’t included.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
