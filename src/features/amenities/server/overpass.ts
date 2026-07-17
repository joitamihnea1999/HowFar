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
} from "@/features/amenities/amenities";
import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { inBucharest } from "@/lib/bounds";
import { providerFetch, ProviderError, roundCoord, USER_AGENT } from "@/lib/provider-http";
import { walkingIsochrone } from "@/features/isochrones/server/ors";

/**
 * OpenStreetMap amenities via the Overpass API (server-side, cached). One merged
 * QL query returns the five brief categories within a generous radius envelope;
 * `nearbyAmenities` then clips them to the real walking isochrone so the counts
 * are "within the walking isochrone" (brief §5), not "within a circle".
 *
 * Keyless, fair-use (~10k req/day). We POST an identifying User-Agent and RACE
 * a small pool of public instances (Promise.any): the first healthy responder
 * wins and the losers are aborted. Public Overpass instances are individually
 * flaky — any one can be overloaded/down at any moment (a sequential
 * primary→mirror fallback fails hard whenever the mirror is the one that's
 * down) — so racing a few of them turns "all must be up in order" into "any one
 * must be up". This is cold-path only (30d cache), a small pool, with an
 * identifying UA and abort-on-win, which keeps us a good fair-use citizen.
 */

// Ordered by observed reliability (probed 2026-07-17): maps.mail.ru answered the
// live query every round (~2s); overpass-api.de is variable (fast, or 504 under
// load); kumi is kept as a third hedge (was fully down when probed, may recover).
// Racing means a currently-dead host costs nothing — it simply never wins.
const ENDPOINTS: { url: string; host: string }[] = [
  { url: "https://maps.mail.ru/osm/tools/overpass/api/interpreter", host: "maps.mail.ru" },
  { url: "https://overpass-api.de/api/interpreter", host: "overpass-api.de" },
  { url: "https://overpass.kumi.systems/api/interpreter", host: "overpass.kumi.systems" },
];
const MIN_INTERVAL_MS = 1100; // be a good fair-use citizen (per host)
const ENDPOINT_TIMEOUT_MS = 18_000; // per-host abort; the race isn't sequential so this is the whole budget
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

/** POST the QL to one host. Throws (raw or ProviderError) on any failure so a
 * losing host can't sink the race. A soft failure — HTTP 200 with a
 * timeout/quota `remark` or a non-array `elements` — counts as a failure too.
 * `signal` cancels this request when a sibling host wins the race. */
async function fetchFromHost(
  endpoint: { url: string; host: string },
  query: string,
  raceSignal: AbortSignal,
): Promise<OverpassElement[]> {
  // A per-attempt deadline that stays armed THROUGH body parsing. providerFetch's
  // internal timeout only guards until response headers arrive — a host that
  // sends 200 headers then stalls the body would otherwise keep the race pending
  // forever if the siblings have already failed. Merge it with the race signal
  // (which aborts this attempt the moment a sibling wins).
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ENDPOINT_TIMEOUT_MS);
  try {
    const res = await providerFetch(endpoint.url, {
      rateHost: endpoint.host,
      minIntervalMs: MIN_INTERVAL_MS,
      timeoutMs: ENDPOINT_TIMEOUT_MS,
      signal: AbortSignal.any([deadline.signal, raceSignal]),
      init: {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `data=${encodeURIComponent(query)}`,
      },
    });
    if (!res.ok) throw new ProviderError(`overpass ${endpoint.host} responded ${res.status}`);
    const body = (await res.json()) as OverpassBody;
    if (!Array.isArray(body.elements)) {
      throw new ProviderError(`overpass ${endpoint.host} returned no element array`);
    }
    // Overpass signals server-side timeout/quota via a 200 + `remark`, often with
    // empty/partial elements — treat that as a failure so another host can win.
    if (body.remark && /timed out|timeout|quota|error|exceeded/i.test(body.remark)) {
      throw new ProviderError(`overpass ${endpoint.host} remark: ${body.remark}`);
    }
    // A truly empty envelope is never legitimate for a guarded Bucharest-bbox
    // origin (5 broad categories within 1500m — there's always at least a bus
    // stop). A mirror returning [] without a remark is degraded; treat it as a
    // loss so a healthy host wins, and so we never cache an empty set for 30 days.
    if (body.elements.length === 0) {
      throw new ProviderError(`overpass ${endpoint.host} returned an empty envelope`);
    }
    return body.elements;
  } finally {
    clearTimeout(timer);
  }
}

/** Race the endpoint pool: the first host to return a valid response wins and
 * the rest are aborted; ProviderError only if EVERY host fails. */
async function fetchOverpassElements(lat: number, lng: number): Promise<OverpassElement[]> {
  const query = buildOverpassQuery(lat, lng);
  const controller = new AbortController();
  const attempts = ENDPOINTS.map((ep) => fetchFromHost(ep, query, controller.signal));
  try {
    return await Promise.any(attempts);
  } catch (err) {
    const reasons =
      err instanceof AggregateError
        ? err.errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")
        : String(err);
    throw new ProviderError(`overpass unavailable (all endpoints failed: ${reasons})`);
  } finally {
    controller.abort(); // cancel the losers (no-op once they've settled)
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

// In-flight envelopes, keyed by cache key, so two concurrent cold callers for
// the same origin share ONE 3-endpoint race instead of each fanning out to all
// three public instances (which would triple the load on keyless community
// servers). Mirrors the single-flight in ors.ts. Cleared on settle.
const inFlight = new Map<string, Promise<Amenity[]>>();

/** Fetch + parse the raw (unclipped) envelope of amenities around a point,
 * cached (best-effort) and single-flighted. Mode-independent, so it's shared
 * across walk/transit views. Exported for tests (the clip is applied by
 * `nearbyAmenities`). */
export async function fetchOverpassAmenities(lat: number, lng: number): Promise<Amenity[]> {
  const key = `amenities:v1:${AMENITY_ENVELOPE_M}:${roundCoord(lat)},${roundCoord(lng)}`;
  const hit = await getCachedSafe<Amenity[]>(key);
  if (hit) return hit;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchParseCache(lat, lng, key);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function fetchParseCache(lat: number, lng: number, key: string): Promise<Amenity[]> {
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
