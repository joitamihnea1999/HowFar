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
    <div
      role="group"
      aria-label="Travel mode"
      className="pointer-events-auto flex gap-1 rounded-full border border-white/15 bg-black/50 p-1 backdrop-blur"
    >
      {(["walk", "transit"] as Mode[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onSwitch(m)}
          aria-pressed={mode === m}
          className={`rounded-full px-5 py-1.5 text-sm font-medium transition-colors ${
            mode === m
              ? m === "walk"
                ? "bg-teal-400/90 text-zinc-950"
                : "bg-violet-400/90 text-zinc-950"
              : "text-zinc-300 hover:text-zinc-100"
          }`}
        >
          {m === "walk" ? "Walk" : "Transit"}
        </button>
      ))}
    </div>
  );
}
