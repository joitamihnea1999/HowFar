import {
  AMENITY_CATEGORIES,
  amenityCategoryLabel,
  type Amenity,
  type AmenityCategoryKey,
  type AmenityCounts,
} from "@/features/amenities/amenities";
import type { Band } from "@/features/isochrones/bands";

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
 * The TRUE in-area total when the server capped the markers it returned, else null.
 *
 * The server sends pre-cap per-category counts but at most
 * `MAX_PER_CATEGORY_PER_BAND` markers per category per ring band, so in a dense area
 * the map holds strictly fewer places than the chips report. The `counts` passed in
 * are already scoped to the SHADED bands (task 065), so this note can never quote a
 * total for an area the user cannot see. Once cluster donuts display counts (task 061), summing
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

/**
 * The visible subset: selected categories ∩ visible ring bands ∩ text query.
 *
 * **This is the single chokepoint for band visibility (task 065), and it has to be
 * the DATA path rather than a MapLibre layer filter.** A cluster's `point_count` and
 * `clusterProperties` are frozen when the source is indexed, so hiding a band with
 * `setFilter` would remove its markers from the map while leaving them counted inside
 * every donut total — the aggregate would lie. Task 061 reversed task 042's
 * `setFilter` optimisation for exactly this reason on categories; bands ride the same
 * mechanism, and the tests treat a layer-filter-only implementation as a hard fail.
 *
 * `bands` omitted (or empty) means "no band restriction", which keeps every existing
 * caller — the browse list and the popup — working unchanged when the ring filter is
 * not relevant to them.
 */
export function filterAmenityItems(
  items: readonly Amenity[],
  selected: readonly AmenityCategoryKey[],
  query = "",
  bands?: readonly Band[],
): Amenity[] {
  const visible = new Set(selected);
  const visibleBands = bands && bands.length > 0 ? new Set<number>(bands) : null;
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (!visible.has(item.category)) return false;
    // A row with no band stays VISIBLE here. This is now DEFENSIVE ONLY: the controller
    // rejects a payload containing an unbanded row on arrival (a marker with no band would
    // otherwise show under every filter, including outside the shading). Keeping the pure
    // function total means a direct caller with partial data still gets a sensible answer
    // rather than a silently empty list.
    if (visibleBands && item.band !== undefined && !visibleBands.has(item.band)) return false;
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
