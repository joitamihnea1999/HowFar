/**
 * Amenities domain model — single source of truth for the five fixed POI
 * categories (brief §5: groceries, pharmacies, parks/green space, schools,
 * transit stops).
 *
 * Runtime discovery is local PostGIS (`queryCatalogueSummaryInRing`): the walk
 * 15‑min ring comes from ORS, then one catalogue CTE returns pre-cap counts +
 * nearest markers. Predicates here still drive the **weekly bulk import**
 * (`buildBulkOverpassQuery` + `categoryForTags` during normalize). Client code
 * uses labels/colors + `buildAmenityFeatures` for the map layer only.
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

/** Amenity counts/markers are clipped to this walking-isochrone ring (brief §5). */
export const WALK_CLIP_MINUTES = 15;

/** Per-category cap on rendered markers (SQL ROW_NUMBER in catalogue-query).
 * Counts shown to the user are true in-ring totals (pre-cap). */
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
  /** Transit-mode set derived from OSM tags (task 047), e.g. `["bus","tram"]`.
   * Server-only merge input; not part of the client contract. */
  modes?: string[];
  /** When this marker is the merge of several coincident transit stops (task
   * 047), the absorbed stops' identities+coords so the popup can union their
   * serving lines. Present only on a merged marker (length ≥ 2). */
  members?: TransitStopMember[];
  /** `members.length` — present only on a merged marker (≥ 2). */
  mergedCount?: number;
}

/** One transit stop absorbed into a merged marker (task 047). Carries the OSM
 * identity for the per-stop line lookup and in-area coords for its `/api/stop-lines`
 * out-of-area guard. */
export interface TransitStopMember {
  osmType: string;
  osmId: number;
  name: string;
  lat: number;
  lng: number;
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

/** Classify an element's tags into the FIRST matching category, or null. The
 * first-match rule keeps each element in exactly one category (no double count).
 * Used by the weekly import normalizer (not the interactive runtime path). */
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

/** OSM tags → the set of transit modes a stop belongs to (task 047). Modelled as
 * a SET (not a single mode) so a dual-tagged platform — e.g. a `highway=bus_stop`
 * that also carries `tram=yes` — is correctly seen as serving both, which the
 * coincident-stop merge uses to tell an interchange (different modes) from two
 * same-mode platforms (opposite directions). Order-independent by construction. */
export function deriveTransitModes(tags: Record<string, string> | null | undefined): string[] {
  if (!tags) return [];
  const modes: string[] = [];
  if (tags.highway === "bus_stop" || tags.bus === "yes" || tags.trolleybus === "yes") modes.push("bus");
  if (tags.railway === "tram_stop" || tags.tram === "yes") modes.push("tram");
  if (tags.station === "subway" || tags.subway === "yes") modes.push("metro");
  if ((tags.railway === "station" && tags.station !== "subway") || tags.train === "yes") modes.push("rail");
  return modes;
}

/** Parse the popup `members` value (task 047): the keyboard `inspectAmenity` path
 * passes the raw array, while MapLibre flattens feature properties to primitives
 * so a WebGL-marker click delivers a JSON string. Returns only members with a
 * usable OSM identity + finite coords; `[]` when absent or garbled. */
export function parseAmenityMembers(raw: unknown): TransitStopMember[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: TransitStopMember[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const osmType = typeof rec.osmType === "string" ? rec.osmType : "";
    const osmId = Number(rec.osmId);
    const lat = Number(rec.lat);
    const lng = Number(rec.lng);
    const name = typeof rec.name === "string" ? rec.name : "";
    if (!osmType || !Number.isInteger(osmId) || osmId <= 0) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({ osmType, osmId, name, lat, lng });
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
    // Merged transit marker (task 047): stringify members so the flat-prop
    // contract holds; the popup unions their lines. Omitted for single stops.
    if (a.members && a.members.length > 1) {
      properties.members = JSON.stringify(a.members);
      properties.mergedCount = a.members.length;
    }
    return {
      type: "Feature",
      properties,
      geometry: { type: "Point", coordinates: [a.lng, a.lat] },
    };
  });
}
