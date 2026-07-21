"use client";

import { useMemo, useRef, useState } from "react";

import {
  AMENITY_CATEGORIES,
  amenityCategoryLabel,
  type Amenity,
  type AmenityCategoryKey,
  type AmenityCounts,
} from "@/features/amenities/amenities";
import {
  ALL_AMENITY_CATEGORY_KEYS,
  filterAmenityItems,
  toggleAmenityCategory,
} from "@/features/amenities/amenity-selection";

const CATEGORY_COLOR = Object.fromEntries(
  AMENITY_CATEGORIES.map((category) => [category.key, category.color]),
) as Record<AmenityCategoryKey, string>;

interface AmenityPanelProps {
  status: "idle" | "loading" | "ready" | "error";
  counts: AmenityCounts | null;
  items: Amenity[];
  selectedCategories: AmenityCategoryKey[];
  onSelectedCategoriesChange: (categories: AmenityCategoryKey[]) => void;
  onRetry: () => void;
  onInspect: (item: Amenity) => void;
}

function CategoryIcon({ category, className = "size-4" }: { category: AmenityCategoryKey; className?: string }) {
  const common = { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 };
  if (category === "groceries")
    return (
      <svg {...common} aria-hidden="true">
        <path d="M4 5h2l1.6 9h9.8l1.5-6H7M10 18.5h.1M16.5 18.5h.1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (category === "pharmacies")
    return (
      <svg {...common} aria-hidden="true">
        <path d="M9 4h6v5h5v6h-5v5H9v-5H4V9h5V4Z" strokeLinejoin="round" />
      </svg>
    );
  if (category === "parks")
    return (
      <svg {...common} aria-hidden="true">
        <path d="M12 21v-7M8.5 17.5 12 14l3.5 3.5M12 3c-4 2.2-6 5.1-6 8a6 6 0 0 0 12 0c0-2.9-2-5.8-6-8Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (category === "schools")
    return (
      <svg {...common} aria-hidden="true">
        <path d="m3 9 9-5 9 5-9 5-9-5Z" strokeLinejoin="round" />
        <path d="M7 12v4.5c3 2 7 2 10 0V12M21 9v6" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg {...common} aria-hidden="true">
      <rect x="5" y="3" width="14" height="14" rx="3" />
      <path d="M8 17l-1.5 3M16 17l1.5 3M8 8h8M9 13h.1M15 13h.1" strokeLinecap="round" />
    </svg>
  );
}

export default function AmenityPanel({
  status,
  counts,
  items,
  selectedCategories,
  onSelectedCategoriesChange,
  onRetry,
  onInspect,
}: AmenityPanelProps) {
  const [browserOpen, setBrowserOpen] = useState(false);
  const [query, setQuery] = useState("");
  const browseButtonRef = useRef<HTMLButtonElement | null>(null);

  const filteredItems = useMemo(
    () => filterAmenityItems(items, selectedCategories, query),
    [items, query, selectedCategories],
  );

  if (status === "idle") return null;

  const closeBrowser = (returnFocus = true) => {
    setBrowserOpen(false);
    if (returnFocus) requestAnimationFrame(() => browseButtonRef.current?.focus());
  };

  return (
    <section aria-labelledby="nearby-title" aria-live="polite" aria-busy={status === "loading"} className="mt-2">
      <div className="flex items-start justify-between gap-3 px-1 pb-2.5 pt-1">
        <div>
          <h2 id="nearby-title" className="text-sm font-semibold tracking-[-0.02em] text-[#f4f7f2]">
            Nearby essentials
          </h2>
          <p className="mt-0.5 text-[0.68rem] text-[#78857b]">Within a 15-min walk</p>
        </div>
        {status === "ready" && items.length > 0 ? (
          <button
            ref={browseButtonRef}
            data-testid="amenity-browser-trigger"
            type="button"
            aria-expanded={browserOpen}
            aria-controls="nearby-place-browser"
            onClick={() => setBrowserOpen((open) => !open)}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-white/[.1] bg-white/[.045] px-3 text-[0.7rem] font-semibold text-[#cbd4cc] transition-colors hover:border-white/[.2] hover:bg-white/[.075]"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M4 5h12M4 10h12M4 15h12" strokeLinecap="round" />
            </svg>
            Browse places
          </button>
        ) : null}
      </div>

      {status === "loading" ? (
        <div role="status" className="grid grid-cols-2 gap-2 px-1 pb-1">
          {[0, 1, 2, 3].map((value) => (
            <span key={value} className="h-12 animate-pulse rounded-xl bg-white/[.045]" />
          ))}
          <span className="sr-only">Finding nearby amenities…</span>
        </div>
      ) : status === "error" ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-[#f6c86b]/16 bg-[#f6c86b]/[.07] px-3 py-2.5">
          <span className="text-xs leading-5 text-[#e5c989]">Amenities unavailable right now</span>
          <button
            type="button"
            onClick={onRetry}
            className="min-h-11 shrink-0 rounded-xl border border-[#f6c86b]/30 px-3 text-xs font-semibold text-[#f6d990] transition-colors hover:bg-[#f6c86b]/10"
          >
            Retry
          </button>
        </div>
      ) : counts ? (
        <div className="px-1 pb-1">
          <div className="mb-1.5 flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={selectedCategories.length === ALL_AMENITY_CATEGORY_KEYS.length}
              onClick={() => onSelectedCategoriesChange(ALL_AMENITY_CATEGORY_KEYS)}
              className="min-h-11 rounded-xl px-2.5 text-[0.65rem] font-semibold text-[#aeb9b0] transition-colors hover:bg-white/[.06] disabled:cursor-default disabled:opacity-40"
            >
              Show all
            </button>
            <button
              type="button"
              disabled={selectedCategories.length === 0}
              onClick={() => onSelectedCategoriesChange([])}
              className="min-h-11 rounded-xl px-2.5 text-[0.65rem] font-semibold text-[#aeb9b0] transition-colors hover:bg-white/[.06] disabled:cursor-default disabled:opacity-40"
            >
              Hide all
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {AMENITY_CATEGORIES.map((category) => {
              const selected = selectedCategories.includes(category.key);
              return (
                <button
                  key={category.key}
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${category.label}: ${counts[category.key]} places`}
                  onClick={() =>
                    onSelectedCategoriesChange(toggleAmenityCategory(selectedCategories, category.key))
                  }
                  className={`flex min-h-12 items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c7f36b] ${
                    selected
                      ? "border-white/[.14] bg-white/[.07]"
                      : "border-white/[.05] bg-transparent opacity-55 hover:opacity-80"
                  }`}
                >
                  <span
                    className="grid size-7 shrink-0 place-items-center rounded-lg text-[#08100d] ring-1 ring-white/20"
                    style={{ background: category.color }}
                  >
                    <CategoryIcon category={category.key} className="size-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold tabular-nums leading-none text-[#f4f7f2]">
                      {counts[category.key]}
                    </span>
                    <span className="mt-1 block truncate text-[0.62rem] leading-none text-[#849087]">
                      {category.label}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {browserOpen ? (
        <div
          id="nearby-place-browser"
          data-testid="amenity-browser"
          role="region"
          aria-label="Nearby places"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeBrowser();
            }
          }}
          className="hf-surface-in mt-2 rounded-[1rem] border border-white/[.1] bg-[#080b09]/84 p-2"
        >
          <div className="flex items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Filter nearby places</span>
              <svg aria-hidden="true" viewBox="0 0 20 20" className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[#78857b]" fill="none" stroke="currentColor" strokeWidth="1.7">
                <circle cx="9" cy="9" r="5" />
                <path d="m13 13 3 3" strokeLinecap="round" />
              </svg>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoFocus
                placeholder="Filter places"
                className="h-11 w-full rounded-xl border border-white/[.1] bg-white/[.045] pl-9 pr-3 text-xs text-[#edf2ed] placeholder:text-[#667269]"
              />
            </label>
            <button
              type="button"
              onClick={() => closeBrowser()}
              aria-label="Close nearby places"
              className="grid size-11 shrink-0 place-items-center rounded-xl border border-white/[.1] text-[#9ca9a0] transition-colors hover:bg-white/[.06] hover:text-[#f4f7f2]"
            >
              ×
            </button>
          </div>
          <p className="px-1 pb-1 pt-2 text-[0.62rem] font-medium text-[#667269]">
            {filteredItems.length} of {items.length} {items.length === 1 ? "place" : "places"} shown
          </p>
          <ul className="max-h-52 space-y-1 overflow-y-auto overscroll-contain pr-1">
            {filteredItems.map((item, index) => (
              <li key={`${item.category}-${item.osmType ?? "poi"}-${item.osmId ?? `${item.lat}-${item.lng}`}-${index}`}>
                <button
                  type="button"
                  onClick={() => {
                    onInspect(item);
                    closeBrowser(false);
                  }}
                  className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/[.055]"
                >
                  <span
                    className="grid size-7 shrink-0 place-items-center rounded-lg text-[#08100d]"
                    style={{ background: CATEGORY_COLOR[item.category] }}
                  >
                    <CategoryIcon category={item.category} className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-[#e8ede8]">
                      {item.name || amenityCategoryLabel(item.category)}
                    </span>
                    <span className="mt-0.5 block text-[0.62rem] text-[#78857b]">
                      {amenityCategoryLabel(item.category)}
                    </span>
                  </span>
                  <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5 shrink-0 text-[#667269]" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M5 10h9M11 7l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </li>
            ))}
            {filteredItems.length === 0 ? (
              <li className="rounded-xl px-3 py-4 text-center text-xs text-[#849087]">
                {selectedCategories.length === 0
                  ? "No amenity categories selected."
                  : "No places match this filter."}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
