import { shouldShowSuggestList, type ComboboxState, type Suggestion } from "@/features/search/combobox";

/**
 * Autocomplete dropdown. Pure presentation of the combobox state — the
 * show/hide decision lives with the reducer (`shouldShowSuggestList`) so it
 * stays measured and can't drift from the fetch gate.
 */

interface SuggestListProps {
  combo: ComboboxState;
  onPick: (s: Suggestion) => void;
  onHover: (index: number) => void;
}

export default function SuggestList({ combo, onPick, onHover }: SuggestListProps) {
  if (!shouldShowSuggestList(combo)) return null;
  return (
    <ul
      id="suggest-list"
      role="listbox"
      aria-label="Address suggestions"
      aria-live="polite"
      className="pointer-events-auto hf-surface-in absolute left-0 right-14 top-[calc(100%+.5rem)] z-50 max-h-[min(19rem,45dvh)] overflow-y-auto overscroll-contain rounded-[1rem] border border-white/[.13] bg-[#0c100d]/98 p-1.5 shadow-[0_20px_50px_rgba(0,0,0,.48)] backdrop-blur-2xl"
    >
      {combo.status === "loading" ? (
        <li className="flex min-h-11 items-center gap-2.5 px-3 text-sm text-[#9ca9a0]">
          <span className="hf-spinner size-3.5 rounded-full border border-[#c7f36b]/25 border-t-[#c7f36b]" />
          Searching…
        </li>
      ) : combo.status === "error" ? (
        <li role="status" className="flex min-h-11 items-center px-3 text-sm text-[#f6c86b]">
          Couldn’t load suggestions. Try again.
        </li>
      ) : combo.suggestions.length === 0 ? (
        <li role="status" className="flex min-h-11 items-center px-3 text-sm text-[#9ca9a0]">
          No matches in Bucharest
        </li>
      ) : (
        combo.suggestions.map((s, i) => (
          <li
            key={`${s.lat},${s.lng},${i}`}
            id={`suggest-opt-${i}`}
            role="option"
            aria-selected={i === combo.activeIndex}
            // Mouse down is cancelled only to preserve combobox focus until
            // click. Selection itself happens on click, so a touch gesture that
            // begins on an option can scroll the list without choosing it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(s)}
            onMouseEnter={() => onHover(i)}
            className={`flex min-h-11 touch-pan-y cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-[0.8rem] leading-5 transition-colors sm:text-sm ${
              i === combo.activeIndex ? "bg-[#c7f36b]/12 text-[#f4f7f2]" : "text-[#c9d1ca] hover:bg-white/[.05]"
            }`}
          >
            <span
              aria-hidden="true"
              className={`grid size-7 shrink-0 place-items-center rounded-lg ${
                i === combo.activeIndex ? "bg-[#c7f36b]/14 text-[#d8ff87]" : "bg-white/[.05] text-[#78857b]"
              }`}
            >
              <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M10 17s4.7-4.2 4.7-8.5a4.7 4.7 0 1 0-9.4 0C5.3 12.8 10 17 10 17Z" />
                <circle cx="10" cy="8.5" r="1.5" />
              </svg>
            </span>
            <span className="line-clamp-2">{s.label}</span>
          </li>
        ))
      )}
    </ul>
  );
}
