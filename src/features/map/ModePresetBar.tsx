import { type PresetIndex } from "@/features/isochrones/preset-reach";
import { MODE_ACTIVE_CLASS, MODE_ICONS, MODE_LABELS } from "@/features/map/ModeToggle";
import PresetChips from "@/features/map/PresetChips";
import { MODES, type Mode } from "@/features/map/selection-flow";

/**
 * The one compact ~48px top bar (phone-first design): the three mode icons
 * (active tinted in the mode hue) on the left, the active mode's two calibrated
 * preset chips on the right — a single row so the map keeps ≥65% of the screen.
 * Icon-only mode buttons sized to the 44px touch-target minimum within the 48px
 * bar (44px button + 2px bar padding = 48px, so the accessible tap area meets the
 * minimum without a taller bar eating map space); the accessible name carries the
 * full mode label. A failed mode is flagged on its icon (the degraded state) via
 * `failedMode`.
 *
 * Custom is HIDDEN (owner-deferred) — the chip row is the two presets only.
 */

interface ModePresetBarProps {
  mode: Mode;
  presetIndex: PresetIndex;
  onSwitchMode: (next: Mode) => void;
  onSelectPreset: (next: PresetIndex) => void;
  /** A mode whose reach failed to load, flagged on its icon (never a takeover). */
  failedMode?: Mode | null;
}

export default function ModePresetBar({
  mode,
  presetIndex,
  onSwitchMode,
  onSelectPreset,
  failedMode,
}: ModePresetBarProps) {
  return (
    <div
      data-testid="mode-preset-bar"
      className="pointer-events-auto flex items-center justify-between gap-2 rounded-full border border-white/[.11] bg-[#0d110e]/92 p-0.5 shadow-[0_16px_44px_rgba(0,0,0,.34)] backdrop-blur-2xl"
    >
      <div role="group" aria-label="Travel mode" className="flex shrink-0 items-center gap-0.5">
        {MODES.map((m) => {
          const active = mode === m;
          const failed = failedMode === m;
          return (
            <button
              key={m}
              type="button"
              data-testid={`mode-icon-${m}`}
              data-mode-active={active ? "true" : "false"}
              aria-pressed={active}
              aria-label={`${MODE_LABELS[m]}${failed ? " (unavailable)" : ""}`}
              onClick={() => onSwitchMode(m)}
              className={`relative grid size-11 place-items-center rounded-full transition-[background-color,color,box-shadow] ${
                active ? MODE_ACTIVE_CLASS[m] : "text-[#9ca9a0] hover:bg-white/[.06] hover:text-[#edf2ed]"
              }`}
            >
              {MODE_ICONS[m]}
              {failed ? (
                <span
                  aria-hidden="true"
                  className="absolute -right-0 -top-0 grid size-3.5 place-items-center rounded-full bg-[#fb927f] text-[0.5rem] font-bold text-[#2a0f0a] ring-2 ring-[#0d110e]"
                >
                  !
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <PresetChips mode={mode} value={presetIndex} onSelect={onSelectPreset} />
    </div>
  );
}
