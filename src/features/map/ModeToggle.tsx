import type { Mode } from "@/features/map/selection-flow";

/**
 * Travel-mode toggle: recomputes the current point in the chosen mode.
 * Pure presentation — the recompute/abort semantics live in AppMap's
 * switchMode.
 */

interface ModeToggleProps {
  mode: Mode;
  onSwitch: (next: Mode) => void;
}

export default function ModeToggle({ mode, onSwitch }: ModeToggleProps) {
  return (
    <div className="min-w-0">
      <span className="mb-1.5 block px-1 text-[0.58rem] font-semibold uppercase tracking-[0.14em] text-[#78857b]">
        Travel by
      </span>
      <div
        role="group"
        aria-label="Travel mode"
        className="grid grid-cols-2 rounded-xl border border-white/[.09] bg-[#080b09]/65 p-1"
      >
        {(["walk", "transit"] as Mode[]).map((m) => {
          const active = mode === m;
          const walk = m === "walk";
          return (
            <button
              key={m}
              type="button"
              onClick={() => onSwitch(m)}
              aria-pressed={active}
              className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[0.65rem] px-2 text-xs font-semibold transition-[background-color,color,box-shadow] sm:text-[0.8rem] ${
                active
                  ? walk
                    ? "bg-[#2dd4bf] text-[#07221d] shadow-[0_5px_16px_rgba(45,212,191,.16)]"
                    : "bg-[#a78bfa] text-[#1d1238] shadow-[0_5px_16px_rgba(167,139,250,.18)]"
                  : "text-[#9ca9a0] hover:bg-white/[.055] hover:text-[#edf2ed]"
              }`}
            >
              {walk ? (
                <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <circle cx="11.5" cy="3.5" r="1.5" />
                  <path d="m9.5 7 2.8 2.2 2.5.3M11.5 9l-2 3-3.2 1.2M9.4 12.1l2.3 4M9.5 7 7.8 9.6 5.5 9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <rect x="4" y="3" width="12" height="11" rx="3" />
                  <path d="M7 14l-1.2 2M13 14l1.2 2M7 7h6M7 10h.1M13 10h.1" strokeLinecap="round" />
                </svg>
              )}
              {walk ? "Walk" : "Transit"}
            </button>
          );
        })}
      </div>
    </div>
  );
}
