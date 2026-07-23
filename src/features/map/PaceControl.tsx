import { PACES, PACE_MODEL, type Pace } from "@/features/isochrones/pace";

/**
 * Walking-pace selector (task 051): Relaxed / Normal / Brisk, with a single
 * adaptive hint line that changes to teach WHEN to use each — no manual, no
 * hover needed. Pure presentation; the recompute/abort semantics live in
 * AppMap's `setPace`. Applies to BOTH modes (it also scales transit access +
 * egress walk and the amenity radius), so it uses the neutral accent rather
 * than a mode colour. Reach at a non-normal pace is an ESTIMATE (labelled).
 */

interface PaceControlProps {
  pace: Pace;
  onSelect: (next: Pace) => void;
}

export default function PaceControl({ pace, onSelect }: PaceControlProps) {
  return (
    <div className="min-w-0">
      <span className="mb-1.5 block px-1 text-[0.58rem] font-semibold uppercase tracking-[0.14em] text-[#78857b]">
        Walking pace
      </span>
      <div
        role="group"
        aria-label="Walking pace"
        className="grid grid-cols-3 rounded-xl border border-white/[.09] bg-[#080b09]/65 p-1"
      >
        {PACES.map((p) => {
          const model = PACE_MODEL[p];
          const active = pace === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => onSelect(p)}
              aria-pressed={active}
              className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[0.65rem] px-2 text-xs font-semibold transition-[background-color,color,box-shadow] sm:text-[0.8rem] ${
                active
                  ? "bg-[#edf2ed] text-[#111713] shadow-[0_5px_16px_rgba(0,0,0,.2)]"
                  : "text-[#9ca9a0] hover:bg-white/[.055] hover:text-[#edf2ed]"
              }`}
            >
              <span aria-hidden="true">{model.emoji}</span>
              {model.label}
            </button>
          );
        })}
      </div>
      {/* Adaptive "why" hint — always visible, announced to screen readers.
          Non-normal paces append an estimate qualifier (both walk + transit),
          since the pace-scaled ring is a calibrated approximation (G6). */}
      <p
        data-testid="pace-hint"
        aria-live="polite"
        className="mt-1.5 px-1 text-[0.68rem] leading-4 text-[#78857b]"
      >
        {PACE_MODEL[pace].hint}
        {pace !== "normal" ? " — estimated reach" : ""}
      </p>
    </div>
  );
}
