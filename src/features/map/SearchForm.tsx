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
    <form onSubmit={onSubmit} role="search" className="flex w-full gap-2">
      <div className="relative min-w-0 flex-1">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="pointer-events-none absolute left-3.5 top-1/2 size-[1.05rem] -translate-y-1/2 text-[#78857b]"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" strokeLinecap="round" />
        </svg>
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          onFocus={onFocus}
          placeholder="Search a Bucharest address"
          aria-label="Search a Bucharest address"
          role="combobox"
          aria-expanded={open}
          aria-controls="suggest-list"
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `suggest-opt-${activeIndex}` : undefined}
          aria-busy={loading}
          autoComplete="off"
          className="h-12 w-full rounded-[0.95rem] border border-white/[.12] bg-[#080b09]/82 pl-10 pr-3 text-[0.82rem] font-medium text-[#f4f7f2] shadow-inner shadow-black/20 transition-[border-color,background-color,box-shadow] placeholder:text-[#657168] hover:border-white/[.2] focus:border-[#c7f36b]/55 focus:bg-[#0b0f0c] sm:text-sm"
        />
      </div>
      <button
        type="submit"
        disabled={loading}
        aria-label={loading ? "Searching" : "Go"}
        aria-busy={loading}
        className="inline-flex size-12 shrink-0 items-center justify-center gap-1.5 rounded-[0.95rem] border border-[#d8ff87]/30 bg-[#c7f36b] text-sm font-bold text-[#172008] shadow-[0_8px_22px_rgba(199,243,107,.16)] transition-[background-color,transform,box-shadow] hover:-translate-y-0.5 hover:bg-[#d8ff87] hover:shadow-[0_10px_26px_rgba(199,243,107,.24)] disabled:translate-y-0 disabled:cursor-wait disabled:opacity-65"
      >
        {loading ? (
          "…"
        ) : (
          <>
            <span>Go</span>
            <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 10h11M11 6l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </>
        )}
      </button>
    </form>
  );
}
