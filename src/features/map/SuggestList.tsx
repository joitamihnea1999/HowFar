import { MIN_SUGGEST_LEN, type ComboboxState, type Suggestion } from "@/features/search/combobox";

/**
 * Autocomplete dropdown. Pure presentation of the combobox state — the
 * open/short-query gate mirrors the reducer's fetch gate so the list never
 * shows for a query the wiring would not have fetched for.
 */

interface SuggestListProps {
  combo: ComboboxState;
  onPick: (s: Suggestion) => void;
  onHover: (index: number) => void;
}

export default function SuggestList({ combo, onPick, onHover }: SuggestListProps) {
  if (!combo.open || combo.query.trim().length < MIN_SUGGEST_LEN) return null;
  return (
    <ul
      id="suggest-list"
      role="listbox"
      className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-black/70 backdrop-blur"
    >
      {combo.status === "loading" ? (
        <li className="px-4 py-2.5 text-sm text-zinc-500">Searching…</li>
      ) : combo.status === "error" ? (
        <li className="px-4 py-2.5 text-sm text-amber-300">Couldn’t load suggestions. Try again.</li>
      ) : combo.suggestions.length === 0 ? (
        <li className="px-4 py-2.5 text-sm text-zinc-500">No matches in Bucharest</li>
      ) : (
        combo.suggestions.map((s, i) => (
          <li
            key={`${s.lat},${s.lng},${i}`}
            id={`suggest-opt-${i}`}
            role="option"
            aria-selected={i === combo.activeIndex}
            onPointerDown={(e) => {
              e.preventDefault(); // keep focus so the pick runs before blur (mouse + touch)
              onPick(s);
            }}
            onMouseEnter={() => onHover(i)}
            className={`cursor-pointer px-4 py-2.5 text-sm ${
              i === combo.activeIndex ? "bg-teal-400/20 text-zinc-50" : "text-zinc-200"
            }`}
          >
            {s.label}
          </li>
        ))
      )}
    </ul>
  );
}
