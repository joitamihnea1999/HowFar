import {
  AMENITY_CATEGORIES,
  amenityCategoryLabel,
  type Amenity,
  type AmenityCategoryKey,
  type AmenityCounts,
} from "@/features/amenities/amenities";

export const AMENITY_PREFERENCE_KEY = "howfar:amenity-categories:v1";
export const ALL_AMENITY_CATEGORY_KEYS = AMENITY_CATEGORIES.map(
  ({ key }) => key,
) as AmenityCategoryKey[];

const VALID_KEYS = new Set<AmenityCategoryKey>(ALL_AMENITY_CATEGORY_KEYS);

export function normalizeAmenitySelection(values: readonly string[]): AmenityCategoryKey[] {
  const selected = new Set(values.filter((value): value is AmenityCategoryKey => VALID_KEYS.has(value as AmenityCategoryKey)));
  return ALL_AMENITY_CATEGORY_KEYS.filter((key) => selected.has(key));
}

export function toggleAmenityCategory(
  selected: readonly AmenityCategoryKey[],
  category: AmenityCategoryKey,
): AmenityCategoryKey[] {
  const next = new Set(selected);
  if (next.has(category)) next.delete(category);
  else next.add(category);
  return ALL_AMENITY_CATEGORY_KEYS.filter((key) => next.has(key));
}

export function serializeAmenitySelection(selected: readonly AmenityCategoryKey[]): string {
  return JSON.stringify({ version: 1, selected: normalizeAmenitySelection(selected) });
}

export function parseAmenitySelection(value: string | null): AmenityCategoryKey[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { version?: unknown; selected?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.selected)) return null;
    if (!parsed.selected.every((item) => typeof item === "string")) return null;
    return normalizeAmenitySelection(parsed.selected);
  } catch {
    return null;
  }
}

/**
 * The TRUE in-ring total when the server capped the markers it returned, else null.
 *
 * The server sends pre-cap per-category counts but at most `MAX_PER_CATEGORY`
 * markers per category, so in a dense area the map holds strictly fewer places
 * than the chips report. Once cluster donuts display counts (task 061), summing
 * them visibly disagrees with the chips — and an unexplained mismatch reads as a
 * bug rather than a documented limit. Returns null when nothing was capped, so
 * the note only appears when it is actually true.
 *
 * Scoped to the SELECTED categories (found in review). Summing every category made the
 * note quote a total the user could not see: with only Groceries shown it still
 * said "the nearest 400 of 900 places", counting schools and parks that were
 * deliberately hidden — an honesty note that is itself misleading is worse than
 * none. `selected` defaults to all categories, which is the all-on default state.
 */
export function cappedAmenityTotal(
  counts: AmenityCounts | null,
  renderedCount: number,
  selected: readonly AmenityCategoryKey[] = ALL_AMENITY_CATEGORY_KEYS,
): number | null {
  if (!counts) return null;
  const visible = new Set(normalizeAmenitySelection([...selected]));
  const total = ALL_AMENITY_CATEGORY_KEYS.reduce(
    (sum, key) => (visible.has(key) ? sum + (counts[key] ?? 0) : sum),
    0,
  );
  return total > renderedCount ? total : null;
}

export function filterAmenityItems(
  items: readonly Amenity[],
  selected: readonly AmenityCategoryKey[],
  query = "",
): Amenity[] {
  const visible = new Set(selected);
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (!visible.has(item.category)) return false;
    if (!needle) return true;
    return `${item.name} ${amenityCategoryLabel(item.category)}`
      .toLocaleLowerCase()
      .includes(needle);
  });
}

/**
 * MapLibre layer filter for amenity circle/glyph layers.
 * - all categories selected → `null` (no filter, every feature paints)
 * - none selected → always-false expression
 * - partial → match on `category` property
 * List/popup code still uses `filterAmenityItems` on the same selection array.
 */
export type AmenityMapCategoryFilter =
  | null
  | readonly ["boolean", false]
  | readonly ["match", readonly ["get", "category"], ...(string | boolean)[]];

export function amenityMapCategoryFilter(
  selected: readonly AmenityCategoryKey[],
): AmenityMapCategoryFilter {
  const normalized = normalizeAmenitySelection([...selected]);
  if (normalized.length === 0) return ["boolean", false] as const;
  if (normalized.length === ALL_AMENITY_CATEGORY_KEYS.length) return null;
  const match: (string | boolean)[] = [];
  for (const key of normalized) {
    match.push(key, true);
  }
  match.push(false);
  return ["match", ["get", "category"], ...match] as AmenityMapCategoryFilter;
}
