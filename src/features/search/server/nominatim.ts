import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { BUCHAREST_BBOX } from "@/lib/bounds";
import { providerConfig, taggedCacheKey } from "@/lib/env";
import { providerFetch, ProviderError, roundCoord, sha256Hex, USER_AGENT } from "@/lib/provider-http";

// Nominatim viewbox is x1,y1,x2,y2 (two opposite corners); with bounded=1 it
// restricts results to the box — biasing forward geocode to Bucharest so a
// same-name hit elsewhere in Romania can't win and cause a false out-of-area.
const VIEWBOX = `${BUCHAREST_BBOX.minLng},${BUCHAREST_BBOX.maxLat},${BUCHAREST_BBOX.maxLng},${BUCHAREST_BBOX.minLat}`;

/**
 * Nominatim geocoding (server-side, cached). ToS: identifying User-Agent + ≤1
 * req/s (enforced by the rate limiter in http.ts) + mandatory caching. Results
 * are cached under a hashed key; negative results are cached too (via a sentinel
 * wrapper) so a bad/repeated query can't hammer the 1 req/s budget.
 */

// Host/base are config-driven (task 007) — default = today's public Nominatim.
// Read inside the request functions (never at module top level) so an override
// takes effect; the rate-limit host is derived from the configured base.
const MIN_INTERVAL_MS = 1100; // ToS ≤1 req/s, with margin
const TIMEOUT_MS = 8_000;
const TTL_OK_MS = 30 * 24 * 60 * 60 * 1000;
const TTL_EMPTY_MS = 24 * 60 * 60 * 1000;

export interface GeoPoint {
  lat: number;
  lng: number;
  label: string;
}

// Nominatim jsonv2 returns lat/lon as STRINGS — must be coerced to numbers.
interface NominatimRow {
  lat?: string;
  lon?: string;
  display_name?: string;
}

function normalize(row: NominatimRow | undefined): GeoPoint | null {
  if (!row || row.lat == null || row.lon == null) return null;
  const lat = Number(row.lat);
  const lng = Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, label: row.display_name ?? "" };
}

async function cachedLookup(key: string, url: string, host: string): Promise<GeoPoint | null> {
  // Sentinel wrapper: a cached `{ result: null }` is a real "known empty",
  // distinct from a cache miss (getCached returning null).
  const hit = await getCachedSafe<{ result: GeoPoint | null }>(key);
  if (hit) return hit.result;

  // A stalled/unreachable/garbled upstream is a provider error (→ 502), not a 500.
  let data: NominatimRow[] | NominatimRow;
  try {
    const res = await providerFetch(url, {
      rateHost: host,
      minIntervalMs: MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      init: { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
    });
    if (!res.ok) throw new ProviderError(`nominatim responded ${res.status}`);
    data = (await res.json()) as NominatimRow[] | NominatimRow;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`nominatim request failed: ${(err as Error).message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  const result = normalize(row);

  await setCachedSafe(key, { result }, new Date(Date.now() + (result ? TTL_OK_MS : TTL_EMPTY_MS)));
  return result;
}

/** Forward geocode a free-text address (restricted to Romania; top match). */
export function geocode(query: string): Promise<GeoPoint | null> {
  const { nominatimBase } = providerConfig();
  const normalized = query.trim().toLowerCase();
  const key = taggedCacheKey(`geo:fwd:${sha256Hex(normalized)}`);
  const url = `${nominatimBase}/search?format=jsonv2&countrycodes=ro&viewbox=${VIEWBOX}&bounded=1&limit=1&q=${encodeURIComponent(query.trim())}`;
  return cachedLookup(key, url, new URL(nominatimBase).host);
}

/** Reverse geocode a point to a human-readable address. */
export function reverseGeocode(lat: number, lng: number): Promise<GeoPoint | null> {
  const { nominatimBase } = providerConfig();
  const key = taggedCacheKey(`geo:rev:${roundCoord(lat)},${roundCoord(lng)}`);
  const url = `${nominatimBase}/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
  return cachedLookup(key, url, new URL(nominatimBase).host);
}
