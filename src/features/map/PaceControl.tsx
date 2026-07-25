import { PACES, PACE_MODEL, type Pace } from "@/features/isochrones/pace";

/**
 * Walking-pace selector (task 051; cut to two in 059): Slow / Normal. Each
 * button carries a COMPACT per-option meaning (owner: "a short description of
 * what it means") so the choice is legible without selecting; the aria-live line
 * below only surfaces the honesty qualifier for Slow (a non-normal, estimated
 * reach). Pure presentation; the recompute/abort semantics live in AppMap's
 * `setPace`. Walk-only (task 052 `effectivePace`), neutral accent.
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
        className="grid grid-cols-2 rounded-xl border border-white/[.09] bg-[#080b09]/65 p-1"
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
              className={`flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-[0.65rem] px-2 py-1.5 text-center transition-[background-color,color,box-shadow] ${
                active
                  ? "bg-[#edf2ed] text-[#111713] shadow-[0_5px_16px_rgba(0,0,0,.2)]"
                  : "text-[#9ca9a0] hover:bg-white/[.055] hover:text-[#edf2ed]"
              }`}
            >
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold sm:text-[0.8rem]">
                <span aria-hidden="true">{model.emoji}</span>
                {model.label}
              </span>
              {/* Per-option meaning — visible on BOTH buttons so the user can
                  compare without selecting (owner ask / plan panel E). Dims on
                  the inactive button but stays readable. */}
              <span
                data-testid={`pace-blurb-${p}`}
                className={`text-[0.62rem] leading-3 ${active ? "text-[#4b5650]" : "text-[#6b776e]"}`}
              >
                {model.blurb}
              </span>
            </button>
          );
        })}
      </div>
      {/* Honesty qualifier — Slow is a non-normal, calibrated-approximation reach
          (G6). Announced to screen readers; blank (reserved height) for Normal so
          the layout doesn't jump. */}
      <p
        data-testid="pace-hint"
        aria-live="polite"
        className="mt-1.5 min-h-4 px-1 text-[0.68rem] leading-4 text-[#78857b]"
      >
        {pace === "normal" ? "" : `${PACE_MODEL[pace].hint} — estimated reach`}
      </p>
    </div>
  );
}
