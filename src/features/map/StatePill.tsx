import type { Mode } from "@/features/map/selection-flow";
import { MODE_LABELS } from "@/features/map/ModeToggle";

/**
 * Collapsed command dock (task 062): a one-line, always-current summary of
 * what is selected — address · travel mode · time budget — that IS the way
 * back into the full dock. Renders only below `md` and only for a resolved
 * selection (shell-state guarantees `label` is present, so the pill can never
 * be blank). The whole pill is one ≥44px button: tapping it re-expands the
 * dock with search, mode, and time-budget controls.
 */

interface StatePillProps {
  /** Resolved origin label (`sel.lastSelection.label` — survives recomputes). */
  label: string;
  mode: Mode;
  /** The selected preset minute (walk 10/20, transit 20/40, car 10/25). */
  selectedMin: number;
  /** A recompute is in flight — show it, the pill stays interactive. */
  loading: boolean;
  onExpand: () => void;
}

export default function StatePill({ label, mode, selectedMin, loading, onExpand }: StatePillProps) {
  const budget = `${selectedMin} min`;
  return (
    <button
      type="button"
      data-testid="state-pill"
      aria-expanded={false}
      aria-label={`Selected: ${label}, by ${MODE_LABELS[mode].toLowerCase()}, ${budget}. Change address, travel mode, or time budget`}
      onClick={onExpand}
      className="hf-state-pill pointer-events-auto flex min-h-11 w-full items-center gap-2 rounded-full border border-white/[.11] bg-[#0d110e]/92 px-4 py-2 text-left shadow-[0_24px_70px_rgba(0,0,0,.38)] backdrop-blur-2xl transition-colors hover:border-white/[.22]"
    >
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${loading ? "animate-pulse bg-[#c7f36b]" : "bg-[#2dd4bf]"}`} />
      <span className="min-w-0 flex-1 truncate text-[0.8rem] font-semibold text-[#edf2ed]">{label}</span>
      <span className="shrink-0 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-[#9ca9a0]">
        {MODE_LABELS[mode]} · {budget}
      </span>
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5 shrink-0 text-[#78857b]" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="m6 8 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
