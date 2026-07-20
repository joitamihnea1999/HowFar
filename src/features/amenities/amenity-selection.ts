import {
  AMENITY_CATEGORIES,
  amenityCategoryLabel,
  type Amenity,
  type AmenityCategoryKey,
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
