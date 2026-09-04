import { useEffect, useRef, useState } from "react";

import { MODE_LABEL } from "@/features/isochrones/isochrone-view";
import { presetLegendRamp } from "@/features/isochrones/preset-view";
import type { Mode } from "@/features/map/selection-flow";

/**
 * Slim legend pill (phone-first design): a collapsed pill — mode
 * gradient dot + selected time — that expands to the full labeled ramp on tap and
 * auto-collapses (a timer + outside interactions). It must NEVER permanently
 * cover the map, so the default is the compact pill; the ramp is a transient
 * disclosure.
 *
 * The ramp is LABELED (0′ → selected edge, with the calibrated midpoint marked)
 * so distance-in-time is legible without relying on hue (colour-impaired
 * safe). Stops + minutes come from `presetLegendRamp`, so the legend can never
 * disagree with the painted reach contours.
 */

interface LegendPillProps {
  mode: Mode;
  /** The selected preset minute (the reach edge). */
  selectedMin: number;
}

const AUTO_COLLAPSE_MS = 4200;

export default function LegendPill({ mode, selectedMin }: LegendPillProps) {
  const [expanded, setExpanded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ramp = presetLegendRamp(mode, selectedMin);

  // Auto-collapse so the ramp never lingers over the map. Re-armed each
  // time it opens; cleared on unmount and on manual collapse.
  useEffect(() => {
    if (!expanded) return;
    timerRef.current = setTimeout(() => setExpanded(false), AUTO_COLLAPSE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [expanded]);

  const gradient = `linear-gradient(90deg, ${ramp.origin}, ${ramp.mid}, ${ramp.edge})`;

  if (!expanded) {
    return (
      <button
        type="button"
        data-testid="legend-pill"
        data-legend-state="collapsed"
        aria-label={`Reach legend: ${MODE_LABEL[mode].toLowerCase()}, up to ${selectedMin} minutes. Expand`}
        onClick={() => setExpanded(true)}
        className="pointer-events-auto flex min-h-9 items-center gap-2 rounded-full border border-white/[.12] bg-[#0d110e]/92 px-3 py-1.5 text-[0.68rem] font-semibold text-[#c9d3cc] shadow-[0_10px_30px_rgba(0,0,0,.35)] backdrop-blur-xl transition-colors hover:border-white/[.22]"
      >
        <span
          aria-hidden="true"
          className="size-3 shrink-0 rounded-full ring-1 ring-white/20"
          style={{ background: gradient }}
        />
        <span className="tabular-nums">≤ {selectedMin} min</span>
      </button>
    );
  }

  return (
    <div
      data-testid="legend-ramp"
      data-legend-state="expanded"
      role="group"
      aria-label={`Reach legend for ${MODE_LABEL[mode].toLowerCase()}`}
      className="pointer-events-auto w-[13.5rem] rounded-2xl border border-white/[.12] bg-[#0d110e]/94 p-3 shadow-[0_16px_40px_rgba(0,0,0,.4)] backdrop-blur-xl"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-[#78857b]">
          {MODE_LABEL[mode]} reach
        </span>
        <button
          type="button"
          aria-label="Collapse legend"
          onClick={() => setExpanded(false)}
          className="grid size-6 place-items-center rounded-md text-[#78857b] transition-colors hover:bg-white/[.06] hover:text-[#edf2ed]"
        >
          <svg viewBox="0 0 20 20" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="m6 6 8 8M14 6l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {/* The shading is DECORATIVE (a radial texture, not a per-minute time field —
          the two calibrated contours can't back a colour→minute scale), so the ramp
          carries a QUALITATIVE "Sooner → Later" label and NO minute numbers. The
          minutes live only on the calibrated contour-LINE swatches below — the honest
          world-claims (impl review). */}
      <div className="mt-2 h-2.5 rounded-full ring-1 ring-white/10" style={{ background: gradient }} />
      <div className="mt-1.5 flex items-center justify-between text-[0.62rem] font-medium text-[#9ca9a0]">
        <span>Sooner</span>
        <span>Later</span>
      </div>
      <div data-testid="legend-lines" className="mt-2.5 grid gap-1.5 border-t border-white/[.07] pt-2.5 text-[0.64rem] tabular-nums text-[#c9d3cc]">
        {ramp.midMinutes.map((m) => (
          <span key={m} className="flex items-center gap-2">
            <span aria-hidden="true" className="inline-block h-0 w-6 shrink-0 border-t-2 border-dashed" style={{ borderColor: ramp.line }} />
            <span>~{m} min (interior line)</span>
          </span>
        ))}
        <span className="flex items-center gap-2 font-semibold text-[#edf2ed]">
          <span aria-hidden="true" className="inline-block h-0 w-6 shrink-0 border-t-2" style={{ borderColor: ramp.line }} />
          <span>~{ramp.edgeMinutes} min (your reach)</span>
        </span>
      </div>
      <p className="mt-2 text-[0.6rem] leading-4 text-[#6f7d73]">The lines mark the calibrated reach; the shading is a guide.</p>
    </div>
  );
}
