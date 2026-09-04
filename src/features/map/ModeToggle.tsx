import type { ReactNode } from "react";

import type { Mode } from "@/features/map/selection-flow";

/**
 * Travel-mode toggle: recomputes the current point in the chosen mode. Pure
 * presentation — the recompute/abort semantics live in AppMap's switchMode.
 *
 * Data-driven over `MODES` (not a hardcoded pair) and the grid column count is
 * derived from `MODES.length`, so a third mode (car, task 053) slots in without
 * a layout rewrite. Icon-over-label so a long label ("Public transport") wraps
 * inside the narrow command-dock column instead of overflowing.
 */

interface ModeToggleProps {
  mode: Mode;
  onSwitch: (next: Mode) => void;
}

interface ModeDef {
  id: Mode;
  label: string;
  icon: ReactNode;
  /** Active-state classes (per-mode accent so a toggle reads instantly). */
  active: string;
  /** Grid column weight — "Public transport" needs more width than "Walk"/"Car"
   * in the 388px desktop dock or its second line clips to "anspo" (task 062,
   * found in live inspection). */
  weight: number;
}

const WalkIcon = (
  <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.7">
    <circle cx="11.5" cy="3.5" r="1.5" />
    <path d="m9.5 7 2.8 2.2 2.5.3M11.5 9l-2 3-3.2 1.2M9.4 12.1l2.3 4M9.5 7 7.8 9.6 5.5 9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TransitIcon = (
  <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x="4" y="3" width="12" height="11" rx="3" />
    <path d="M7 14l-1.2 2M13 14l1.2 2M7 7h6M7 10h.1M13 10h.1" strokeLinecap="round" />
  </svg>
);

const CarIcon = (
  <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 12v-2.2L5 6h10l2 3.8V12M3 12h14M3 12v2h1.5M17 12v2h-1.5" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="6" cy="14" r="1.3" />
    <circle cx="14" cy="14" r="1.3" />
  </svg>
);

/** Single source for user-facing mode names (dock toggle + collapsed state pill). */
export const MODE_LABELS: Record<Mode, string> = {
  walk: "Walk",
  transit: "Public transport",
  car: "Car",
};

/** The mode glyphs, shared so the compact phone-first bar (`ModePresetBar`)
 * reuses the exact icons this toggle draws rather than a second, drifting copy. */
export const MODE_ICONS: Record<Mode, ReactNode> = {
  walk: WalkIcon,
  transit: TransitIcon,
  car: CarIcon,
};

/** Per-mode active-state classes (hue tint), shared with the compact bar. */
export const MODE_ACTIVE_CLASS: Record<Mode, string> = {
  walk: "bg-[#2dd4bf] text-[#07221d] shadow-[0_5px_16px_rgba(45,212,191,.16)]",
  transit: "bg-[#a78bfa] text-[#1d1238] shadow-[0_5px_16px_rgba(167,139,250,.18)]",
  car: "bg-[#3b82f6] text-[#0a1633] shadow-[0_5px_16px_rgba(59,130,246,.2)]",
};

const MODES: ModeDef[] = [
  {
    id: "walk",
    label: MODE_LABELS.walk,
    icon: WalkIcon,
    active: "bg-[#2dd4bf] text-[#07221d] shadow-[0_5px_16px_rgba(45,212,191,.16)]",
    weight: 1,
  },
  {
    id: "transit",
    label: MODE_LABELS.transit,
    icon: TransitIcon,
    active: "bg-[#a78bfa] text-[#1d1238] shadow-[0_5px_16px_rgba(167,139,250,.18)]",
    weight: 1.6,
  },
  {
    id: "car",
    label: MODE_LABELS.car,
    icon: CarIcon,
    active: "bg-[#3b82f6] text-[#0a1633] shadow-[0_5px_16px_rgba(59,130,246,.2)]",
    weight: 1,
  },
];

export default function ModeToggle({ mode, onSwitch }: ModeToggleProps) {
  return (
    <div className="min-w-0">
      <span className="mb-1.5 block px-1 text-[0.58rem] font-semibold uppercase tracking-[0.14em] text-[#78857b]">
        Travel by
      </span>
      <div
        role="group"
        aria-label="Travel mode"
        className="grid gap-1 rounded-xl border border-white/[.09] bg-[#080b09]/65 p-1"
        style={{ gridTemplateColumns: MODES.map((m) => `minmax(0, ${m.weight}fr)`).join(" ") }}
      >
        {MODES.map((m) => {
          const isActive = mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onSwitch(m.id)}
              aria-pressed={isActive}
              className={`inline-flex h-11 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-[0.65rem] px-1 text-center text-[0.62rem] font-semibold leading-[1.0] transition-[background-color,color,box-shadow] md:text-[0.6rem] ${
                isActive ? m.active : "text-[#9ca9a0] hover:bg-white/[.055] hover:text-[#edf2ed]"
              }`}
            >
              {m.icon}
              <span className="text-balance">{m.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
