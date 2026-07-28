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

/**
 * Label sort-key fallback for a POI with no server distance: sorts LAST, and
 * keeps the `symbol-sort-key` expression from ever resolving to `undefined`.
 *
 * Lives here, in the dependency-free base module, rather than alongside the other
 * display constants in `amenity-cluster` — that module imports
 * `AMENITY_CATEGORIES` from this one, so importing back would form a cycle whose
 * top-level `AMENITY_CATEGORIES.map(...)` crashes with "Cannot read properties of
 * undefined" whenever `amenities.ts` is the entry module. That is not
 * hypothetical: it was verified with a probe test before this constant was moved.
 */
export const UNKNOWN_DISTANCE_SORT = 1_000_000;

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
  /** Walking distance from the origin, in metres. Already computed server-side
   * (`catalogue-query`: `ST_Distance(display_point, origin)`) and already sent
   * over the wire — this declaration just stops the client from throwing it away.
   * Drives the label `symbol-sort-key` (so collision thinning keeps the NEAREST
   * places' names) and the "350 m" browser rows. Optional because a malformed
   * payload must still render as a plain marker. */
  distanceMeters?: number;
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

/**
 * Walking distance for display ("350 m", "1.2 km").
 *
 * Rounded to 10 m below a kilometre: the underlying figure is a straight-line
 * geography distance from an in-ring display point, so metre precision would
 * imply an accuracy the number does not have. Non-finite input yields an empty
 * string rather than "NaN m", so a malformed payload degrades to no distance
 * instead of visible nonsense.
 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "";
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
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

/**
 * Label-placement sort key for an amenity (task 061).
 *
 * MapLibre gives placement priority to the LOWER `symbol-sort-key`, so returning
 * the walking distance means that when labels must be thinned, the names that
 * survive are the nearest places — the ones a "how far is everything?" product
 * should keep. Two refinements matter:
 *
 * - a missing distance sorts LAST (`UNKNOWN_DISTANCE_SORT`) instead of first, so
 *   an unmeasured POI never outranks a measured one;
 * - near-equal distances are broken deterministically by index, because a raw tie lets
 *   MapLibre thin arbitrarily and the surviving label set could differ between
 *   repaints of identical data.
 *
 * Honest limit on that tie-break: the nudge is up to +0.999 m, so two places whose true
 * distances differ by LESS than a metre can swap label priority. That is deliberate — it
 * buys deterministic thinning — and it only ever affects which of two effectively
 * equidistant names survives, never a visible ordering. An earlier version of this
 * comment claimed it "never reorders genuinely different distances", which overstated it.
 */
export function amenityDistanceSort(distanceMeters: number | undefined, index: number): number {
  const base =
    typeof distanceMeters === "number" && Number.isFinite(distanceMeters) && distanceMeters >= 0
      ? distanceMeters
      : UNKNOWN_DISTANCE_SORT;
  // A sub-metre nudge: it orders effectively-equal distances deterministically. See the
  // note above for the sub-metre reordering this deliberately accepts.
  return base + Math.min(index, 999) / 1000;
}

/** Amenities → GeoJSON points carrying the per-category color so one circle
 * layer paints via `["get","color"]` (the isochrone-layer pattern). `osmType`/
 * `osmId` ride along so a click on a transit marker can look up its lines
 * (task 021); omitted when absent so `feature.properties` never carries
 * `undefined` (MapLibre would stringify it).
 *
 * Each feature carries an **explicit numeric `id`** (its payload index). The
 * source clusters (task 061), and MapLibre's `generateId` is unavailable on a
 * clustered source — but supercluster preserves an author-supplied id, verified
 * stable across tile seams and zoom changes, which is exactly what hover
 * feature-state needs. The index is stable for the lifetime of one payload, and
 * every `setData` is already preceded by `resetAmenityHover`. */
export function buildAmenityFeatures(items: Amenity[]): GeoJSON.Feature[] {
  return items.map((a, index) => {
    const properties: Record<string, string | number> = {
      category: a.category,
      color: COLOR_BY_KEY[a.category],
      name: a.name,
      // Always a finite number so the `symbol-sort-key` expression can never
      // resolve to `undefined` (which would make placement order arbitrary).
      distanceSort: amenityDistanceSort(a.distanceMeters, index),
    };
    if (typeof a.distanceMeters === "number" && Number.isFinite(a.distanceMeters)) {
      properties.distanceMeters = a.distanceMeters;
    }
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
      id: index,
      properties,
      geometry: { type: "Point", coordinates: [a.lng, a.lat] },
    };
  });
}
