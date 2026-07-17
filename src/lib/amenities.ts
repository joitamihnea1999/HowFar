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

/** Defensive per-category cap so one dense category (e.g. bus stops) can't
 * dominate the map. Applied AFTER the isochrone clip (not on the raw envelope):
 * Overpass returns elements in type/id order, not by distance, so capping the
 * envelope could drop a NEAR item in favour of a far one. Capping the clipped,
 * in-isochrone set is both fair and — at a 15-min walk — effectively never hit. */
export const MAX_PER_CATEGORY = 150;

/** A single resolved POI — the canonical flat shape the route returns and the
 * client renders/counts. */
export interface Amenity {
  lat: number;
  lng: number;
  name: string;
  category: AmenityCategoryKey;
}

export type AmenityCounts = Record<AmenityCategoryKey, number>;

const COLOR_BY_KEY = Object.fromEntries(
  AMENITY_CATEGORIES.map((c) => [c.key, c.color]),
) as Record<AmenityCategoryKey, string>;

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

/** Keep at most `max` amenities per category, preserving input order. Defensive
 * bound on the displayed set (see MAX_PER_CATEGORY) — pure so it's testable. */
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
 * layer paints via `["get","color"]` (the isochrone-layer pattern). */
export function buildAmenityFeatures(items: Amenity[]): GeoJSON.Feature[] {
  return items.map((a) => ({
    type: "Feature",
    properties: { category: a.category, color: COLOR_BY_KEY[a.category], name: a.name },
    geometry: { type: "Point", coordinates: [a.lng, a.lat] },
  }));
}
