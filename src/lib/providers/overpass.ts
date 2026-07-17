import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";

import {
  AMENITY_ENVELOPE_M,
  MAX_PER_CATEGORY,
  WALK_CLIP_MINUTES,
  buildOverpassQuery,
  capPerCategory,
  categoryForTags,
  countByCategory,
  sortByDistance,
  type Amenity,
  type AmenityCounts,
} from "@/lib/amenities";
import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { inBucharest } from "@/lib/bounds";
import { providerFetch, ProviderError, roundCoord, USER_AGENT } from "@/lib/providers/http";
import { walkingIsochrone } from "@/lib/providers/ors";

/**
 * OpenStreetMap amenities via the Overpass API (server-side, cached). One merged
 * QL query returns the five brief categories within a generous radius envelope;
 * `nearbyAmenities` then clips them to the real walking isochrone so the counts
 * are "within the walking isochrone" (brief §5), not "within a circle".
 *
 * Keyless, fair-use (~10k req/day). We POST an identifying User-Agent and fall
 * back to the kumi mirror if the primary endpoint is down/slow/rate-limited.
 */

const PRIMARY_URL = "https://overpass-api.de/api/interpreter";
const PRIMARY_HOST = "overpass-api.de";
const MIRROR_URL = "https://overpass.kumi.systems/api/interpreter";
const MIRROR_HOST = "overpass.kumi.systems";
const MIN_INTERVAL_MS = 1100; // be a good fair-use citizen
const PRIMARY_TIMEOUT_MS = 20_000; // Overpass can be slow under load
const MIRROR_TIMEOUT_MS = 12_000; // bounded so primary+mirror don't stack to ~40s
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // amenities change slowly

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

interface OverpassBody {
  elements?: OverpassElement[];
  remark?: string;
}

export interface NearbyAmenitiesResult {
  /** The rounded origin (== cache key basis). */
  origin: { lat: number; lng: number };
  /** The walk-isochrone ring the amenities are clipped to. */
  walkMinutes: number;
  /** True per-category counts of ALL amenities in the ring (before the marker cap). */
  counts: AmenityCounts;
  /** Nearest-first amenities inside the ring, capped per category for rendering. */
  amenities: Amenity[];
}

/** POST the QL to one host. Throws (raw or ProviderError) on any failure so the
 * caller can fall through to the mirror. A soft failure — HTTP 200 with a
 * timeout/quota `remark` or a non-array `elements` — counts as a failure too. */
async function fetchFromHost(
  url: string,
  host: string,
  timeoutMs: number,
  query: string,
): Promise<OverpassElement[]> {
  const res = await providerFetch(url, {
    rateHost: host,
    minIntervalMs: MIN_INTERVAL_MS,
    timeoutMs,
    init: {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `data=${encodeURIComponent(query)}`,
    },
  });
  if (!res.ok) throw new ProviderError(`overpass ${host} responded ${res.status}`);
  const body = (await res.json()) as OverpassBody;
  if (!Array.isArray(body.elements)) {
    throw new ProviderError(`overpass ${host} returned no element array`);
  }
  // Overpass signals server-side timeout/quota via a 200 + `remark`, often with
  // empty/partial elements — treat that as a failure worth retrying the mirror.
  if (body.remark && /timed out|timeout|quota|error|exceeded/i.test(body.remark)) {
    throw new ProviderError(`overpass ${host} remark: ${body.remark}`);
  }
  return body.elements;
}

/** Try the primary endpoint, then the mirror; ProviderError only if both fail. */
async function fetchOverpassElements(lat: number, lng: number): Promise<OverpassElement[]> {
  const query = buildOverpassQuery(lat, lng);
  try {
    return await fetchFromHost(PRIMARY_URL, PRIMARY_HOST, PRIMARY_TIMEOUT_MS, query);
  } catch (primaryErr) {
    try {
      return await fetchFromHost(MIRROR_URL, MIRROR_HOST, MIRROR_TIMEOUT_MS, query);
    } catch (mirrorErr) {
      throw new ProviderError(
        `overpass unavailable (primary: ${(primaryErr as Error).message}; ` +
          `mirror: ${(mirrorErr as Error).message})`,
      );
    }
  }
}

/** Classify + clean the raw elements into flat amenities: first-match category,
 * node coords or way/relation `center`, drop non-finite/(0,0)/out-of-area,
 * dedup by OSM `type/id`. No cap here — the per-category cap is applied to the
 * CLIPPED set (see capPerCategory) so it can't drop a near item for a far one. */
function parseElements(elements: OverpassElement[]): Amenity[] {
  const seen = new Set<string>();
  const out: Amenity[] = [];
  for (const el of elements) {
    // A malformed array may contain null/non-object entries — never let one
    // throw here (this runs outside the ProviderError try/catch → would be a 500).
    if (!el || typeof el !== "object") continue;
    const category = categoryForTags(el.tags);
    if (!category) continue;
    const lat = Number(el.lat ?? el.center?.lat);
    const lng = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat === 0 && lng === 0) continue;
    if (!inBucharest(lat, lng)) continue;

    const dedupKey = `${el.type ?? "?"}/${el.id ?? `${lat},${lng}`}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const name = typeof el.tags?.name === "string" ? el.tags.name : "";
    out.push({ lat, lng, name, category });
  }
  return out;
}

/** Keep only amenities whose point falls inside the walk-isochrone ring
 * geometry. This is what makes counts "within the walking isochrone" (§5)
 * rather than "within a radius". A malformed ring yields [] (no throw). Lives
 * server-side (turf) so the client bundle never pulls in the geometry lib. */
export function clipToRing(items: Amenity[], ring: GeoJSON.Geometry | null | undefined): Amenity[] {
  if (!ring) return [];
  return items.filter((a) => {
    try {
      return booleanPointInPolygon([a.lng, a.lat], ring as GeoJSON.Polygon | GeoJSON.MultiPolygon);
    } catch {
      return false;
    }
  });
}

/** Fetch + parse the raw (unclipped) envelope of amenities around a point,
 * cached (best-effort). Mode-independent, so it's shared across walk/transit
 * views. Exported for tests (the clip is applied by `nearbyAmenities`). */
export async function fetchOverpassAmenities(lat: number, lng: number): Promise<Amenity[]> {
  const key = `amenities:v1:${AMENITY_ENVELOPE_M}:${roundCoord(lat)},${roundCoord(lng)}`;
  const hit = await getCachedSafe<Amenity[]>(key);
  if (hit) return hit;

  const elements = await fetchOverpassElements(Number(roundCoord(lat)), Number(roundCoord(lng)));
  const amenities = parseElements(elements);
  await setCachedSafe(key, amenities, new Date(Date.now() + TTL_MS));
  return amenities;
}

/** Amenities within the walking isochrone (brief §5). Fetches the walk isochrone
 * and the Overpass envelope IN PARALLEL, then clips POIs to the 15-min ring. */
export async function nearbyAmenities(latRaw: number, lngRaw: number): Promise<NearbyAmenitiesResult> {
  const lat = Number(roundCoord(latRaw));
  const lng = Number(roundCoord(lngRaw));

  const [iso, all] = await Promise.all([
    walkingIsochrone(latRaw, lngRaw),
    fetchOverpassAmenities(latRaw, lngRaw),
  ]);

  const ring = iso.rings.find((r) => r.minutes === WALK_CLIP_MINUTES);
  if (!ring?.geometry) {
    throw new ProviderError(`walk isochrone missing the ${WALK_CLIP_MINUTES}-min ring for clipping`);
  }
  const clipped = clipToRing(all, ring.geometry as GeoJSON.Geometry);
  // Counts are the TRUE clipped totals (before the cap) so a category exceeding
  // the marker cap still reports its real number; markers are the nearest N.
  const counts = countByCategory(clipped);
  const amenities = capPerCategory(sortByDistance(clipped, { lat, lng }), MAX_PER_CATEGORY);
  return { origin: { lat, lng }, walkMinutes: WALK_CLIP_MINUTES, counts, amenities };
}
