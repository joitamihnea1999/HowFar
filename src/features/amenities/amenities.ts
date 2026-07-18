/**
 * Amenities domain model — the single source of truth for the five fixed POI
 * categories the brief mandates (§5: groceries, pharmacies, parks/green space,
 * schools, transit stops). The OSM tag predicates drive BOTH the Overpass query
 * (`buildOverpassQuery`) and the result classifier (`categoryForTags`), so the
 * query and the parser can never drift apart. Isomorphic (no server-only deps):
 * the provider builds/classifies server-side; the client reads label + color for
 * the legend and `buildAmenityFeatures` for the map layer.
 *
 * Colors are the Okabe-Ito colorblind-safe categorical palette: it clears the
 * normal-vision separation floor on every pair, and its residual CVD proximity
 * (worst pair ≈ ΔE 7.6) is covered by the always-visible legend + a white marker
 * ring (secondary encoding). Markers are figure, not receding fills, so they run
 * brighter than a chart-fill lightness band would allow — deliberate, for pop on
 * the dark basemap. (Per-category icon differentiation is a future polish item.)
 */

export type AmenityCategoryKey = "groceries" | "pharmacies" | "parks" | "schools" | "transit";

/** An OSM tag key + the set of values that qualify for a category. */
export interface AmenityPredicate {
  tag: string;
  values: string[];
}

export interface AmenityCategory {
  key: AmenityCategoryKey;
  label: string;
  color: string;
  predicates: AmenityPredicate[];
}

/** Ordered (legend + draw order). Predicates are the query/classify contract. */
export const AMENITY_CATEGORIES: AmenityCategory[] = [
  {
    key: "groceries",
    label: "Groceries",
    color: "#e69f00",
    predicates: [{ tag: "shop", values: ["supermarket", "convenience", "greengrocer"] }],
  },
  {
    key: "pharmacies",
    label: "Pharmacies",
    color: "#d55e00",
    predicates: [{ tag: "amenity", values: ["pharmacy"] }],
  },
  {
    key: "parks",
    label: "Parks & green",
    color: "#009e73",
    predicates: [{ tag: "leisure", values: ["park", "garden"] }],
  },
  {
    key: "schools",
    label: "Schools",
    color: "#cc79a7",
    predicates: [{ tag: "amenity", values: ["school", "kindergarten", "university"] }],
  },
  {
    key: "transit",
    label: "Transit stops",
    // Deliberately NOT railway=subway_entrance: one metro station has several
    // entrances, which would multiply its count. station=subway + railway=station
    // count the station once (deduped by OSM id upstream).
    color: "#56b4e9",
    predicates: [
      { tag: "highway", values: ["bus_stop"] },
      { tag: "railway", values: ["station", "tram_stop"] },
      { tag: "station", values: ["subway"] },
    ],
  },
];

/** Overpass search radius. A generous envelope: correctness comes from the
 * server-side clip to the real walk isochrone, NOT from this radius (crow-flies
 * ≥ street-routed reach, and the ORS walk speed isn't ours to assume). */
export const AMENITY_ENVELOPE_M = 1500;

/** Amenity counts/markers are clipped to this walking-isochrone ring (brief §5). */
export const WALK_CLIP_MINUTES = 15;

/** Defensive per-category cap on the RENDERED markers so one dense category
 * (e.g. gardens tagged as parks in central Bucharest) can't flood the map.
 * Applied to the nearest-first, clipped set so the kept markers are the closest.
 * Counts shown to the user are the true clipped totals (derived pre-cap), so a
 * category exceeding the cap still reports its real count. */
export const MAX_PER_CATEGORY = 150;

/** A single resolved POI — the canonical flat shape the route returns and the
 * client renders/counts. `osmType`/`osmId` carry the OSM identity so a transit
 * stop can be looked up for its serving lines (task 021); optional because a
 * malformed element without an id still renders as a plain marker. */
export interface Amenity {
  lat: number;
  lng: number;
  name: string;
  category: AmenityCategoryKey;
  osmType?: string;
  osmId?: number;
}

export type AmenityCounts = Record<AmenityCategoryKey, number>;

const COLOR_BY_KEY = Object.fromEntries(
  AMENITY_CATEGORIES.map((c) => [c.key, c.color]),
) as Record<AmenityCategoryKey, string>;

const LABEL_BY_KEY = Object.fromEntries(AMENITY_CATEGORIES.map((c) => [c.key, c.label])) as Record<
  AmenityCategoryKey,
  string
>;

/** Human label for a category key ("groceries" → "Groceries"); unknown keys get
 * a generic fallback — used as popup title/subtitle for unnamed POIs (task 024). */
export function amenityCategoryLabel(key: string): string {
  return (LABEL_BY_KEY as Record<string, string>)[key] ?? "Place";
}

/** Build the merged Overpass QL for all five categories around a point.
 * `out center;` (body verbosity) returns tags + node coords + way/relation
 * centers — `out tags;` would omit coordinates and drop every node. */
export function buildOverpassQuery(lat: number, lng: number): string {
  const clauses = AMENITY_CATEGORIES.flatMap((c) =>
    c.predicates.map(
      (p) => `nwr(around:${AMENITY_ENVELOPE_M},${lat},${lng})[${p.tag}~"^(${p.values.join("|")})$"];`,
    ),
  ).join("");
  return `[out:json][timeout:25];(${clauses});out center;`;
}

/** Classify an element's tags into the FIRST matching category, or null. The
 * first-match rule keeps each element in exactly one category (no double count). */
export function categoryForTags(tags: Record<string, string> | undefined): AmenityCategoryKey | null {
  if (!tags) return null;
  for (const c of AMENITY_CATEGORIES) {
    for (const p of c.predicates) {
      const value = tags[p.tag];
      if (value !== undefined && p.values.includes(value)) return c.key;
    }
  }
  return null;
}

/** Squared planar distance (deg², longitude scaled by latitude) — accurate
 * enough for ORDERING POIs by nearness at city scale, and cheaper than haversine. */
function distanceSq(a: { lat: number; lng: number }, origin: { lat: number; lng: number }): number {
  const k = Math.cos((origin.lat * Math.PI) / 180);
  const dLat = a.lat - origin.lat;
  const dLng = (a.lng - origin.lng) * k;
  return dLat * dLat + dLng * dLng;
}

/** Amenities sorted nearest-first to the origin (stable copy). So that when a
 * category is later capped, the kept items are the NEAREST — not an arbitrary
 * OSM-id-ordered subset. */
export function sortByDistance(items: Amenity[], origin: { lat: number; lng: number }): Amenity[] {
  return [...items].sort((a, b) => distanceSq(a, origin) - distanceSq(b, origin));
}

/** Keep at most `max` amenities per category, preserving input order. Defensive
 * bound on the RENDERED markers (see MAX_PER_CATEGORY) — pure so it's testable.
 * Counts are derived BEFORE this cap, so the displayed totals stay truthful. */
export function capPerCategory(items: Amenity[], max: number): Amenity[] {
  const perCategory: Partial<Record<AmenityCategoryKey, number>> = {};
  const out: Amenity[] = [];
  for (const a of items) {
    const count = perCategory[a.category] ?? 0;
    if (count >= max) continue;
    perCategory[a.category] = count + 1;
    out.push(a);
  }
  return out;
}

/** Per-category counts over a flat amenity list (all keys present, zero-filled). */
export function countByCategory(items: Amenity[]): AmenityCounts {
  const counts = Object.fromEntries(AMENITY_CATEGORIES.map((c) => [c.key, 0])) as AmenityCounts;
  for (const a of items) counts[a.category] += 1;
  return counts;
}

/** Amenities → GeoJSON points carrying the per-category color so one circle
 * layer paints via `["get","color"]` (the isochrone-layer pattern). `osmType`/
 * `osmId` ride along so a click on a transit marker can look up its lines
 * (task 021); omitted when absent so `feature.properties` never carries
 * `undefined` (MapLibre would stringify it). */
export function buildAmenityFeatures(items: Amenity[]): GeoJSON.Feature[] {
  return items.map((a) => {
    const properties: Record<string, string | number> = {
      category: a.category,
      color: COLOR_BY_KEY[a.category],
      name: a.name,
    };
    if (a.osmType) properties.osmType = a.osmType;
    if (typeof a.osmId === "number") properties.osmId = a.osmId;
    return {
      type: "Feature",
      properties,
      geometry: { type: "Point", coordinates: [a.lng, a.lat] },
    };
  });
}
