import type { FormEvent, KeyboardEvent } from "react";

/**
 * Address search form (input + submit). Pure presentation: every state
 * transition lives in AppMap's combobox wiring; this only renders the
 * combobox's current query/open/activeIndex and forwards DOM events.
 */

interface SearchFormProps {
  query: string;
  open: boolean;
  activeIndex: number;
  /** True while a selection is resolving — disables the submit button. */
  loading: boolean;
  onSubmit: (e: FormEvent) => void;
  onQueryChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onFocus: () => void;
  onBlur: () => void;
}

export default function SearchForm({
  query,
  open,
  activeIndex,
  loading,
  onSubmit,
  onQueryChange,
  onKeyDown,
  onFocus,
  onBlur,
}: SearchFormProps) {
  return (
    <form onSubmit={onSubmit} className="pointer-events-auto flex w-full max-w-md gap-2">
      <input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onFocus={onFocus}
        placeholder="Search a Bucharest address — or click the map"
        aria-label="Search a Bucharest address"
        role="combobox"
        aria-expanded={open}
        aria-controls="suggest-list"
        aria-activedescendant={activeIndex >= 0 ? `suggest-opt-${activeIndex}` : undefined}
        autoComplete="off"
        className="w-full rounded-full border border-white/15 bg-black/50 px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 backdrop-blur focus:border-teal-300/60 focus:outline-none"
      />
      <button
        type="submit"
        disabled={loading}
        className="rounded-full bg-teal-400/90 px-4 py-2.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-teal-300 disabled:opacity-50"
      >
        {loading ? "…" : "Go"}
      </button>
    </form>
  );
}
