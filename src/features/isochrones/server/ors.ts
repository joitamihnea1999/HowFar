import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { serverEnv } from "@/lib/env";
import { providerFetch, ProviderError, roundCoord } from "@/lib/provider-http";

/**
 * OpenRouteService foot-walking isochrones (server-side, cached). One request
 * returns three nested reachability polygons (15/30/45 min). The API key is the
 * app's only secret provider key and must never reach the client.
 */

const URL = "https://api.openrouteservice.org/v2/isochrones/foot-walking";
const HOST = "api.openrouteservice.org";
const MIN_INTERVAL_MS = 1500; // free tier ~40 isochrone req/min (PROVIDERS.md) ⇒ ≥1.5s spacing
const TIMEOUT_MS = 12_000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
// The requested ranges are CALIBRATED, not nominal. ORS foot-walking boundaries
// are systematically generous versus real street walking: auditing ring
// boundaries with street-routed distances (MOTIS one-to-many, withDistance) at
// three diverse origins (Unirii / Grozăvești / Berceni, 2026-07-17) put the
// nominal 900/1800/2700 s boundaries at 1.265/1.164/1.123 × their labels at
// 80 m/min. Two-pass fit (initial scale, then one measured iteration because
// the factor grows as ranges shrink) landed the values below; re-audited
// boundaries sit at ≈ the nominal minutes (15-ring median 15.0, residuals
// within ±10%). So the polygon LABELED "15/30/45 min" truly takes ≈ that many
// street-walking minutes. Methodology + re-run: docs/PROVIDERS.md "Calibration".
const CALIBRATED_RANGES_S = [827, 1674, 2528];
const NOMINAL_MINUTES = [15, 30, 45];
const RANGE_TOLERANCE_S = 1; // ORS echoes the requested range in properties.value

// Loose GeoJSON typing to avoid pulling in @types/geojson; the client passes
// these straight into a MapLibre GeoJSON source.
interface Ring {
  minutes: number;
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
}

export interface IsochroneResult {
  /** The rounded origin actually sent to ORS (== marker origin == cache key). */
  origin: { lat: number; lng: number };
  /** Reachability rings, sorted ascending by minutes (15, 30, 45). */
  rings: Ring[];
}

interface OrsFeature {
  properties?: { value?: number };
  geometry?: { type?: string; coordinates?: unknown };
}

/** Strict bijection from response features to nominal rings: exactly one
 * feature per requested calibrated range, matched on the RAW echoed value and
 * only then relabeled to 15/30/45. A dropped, duplicated, reordered-but-wrong
 * or unscaled feature must 502 here — silently mislabeling would lie on the
 * map AND corrupt the amenities clip (it uses the "15-min" ring). */
function normalize(features: OrsFeature[]): Ring[] {
  if (features.length !== CALIBRATED_RANGES_S.length) {
    throw new ProviderError(
      `openrouteservice returned ${features.length} rings (expected ${CALIBRATED_RANGES_S.length})`,
    );
  }
  const sorted = [...features].sort(
    (a, b) => (a?.properties?.value ?? Number.NaN) - (b?.properties?.value ?? Number.NaN),
  );
  return sorted.map((f, i) => {
    const value = f?.properties?.value;
    if (typeof value !== "number" || Math.abs(value - CALIBRATED_RANGES_S[i]!) > RANGE_TOLERANCE_S) {
      throw new ProviderError(
        `openrouteservice ring values [${sorted.map((s) => s?.properties?.value).join(", ")}] ` +
          `do not match the calibrated ranges [${CALIBRATED_RANGES_S.join(", ")}]`,
      );
    }
    const geometry = f?.geometry;
    if (
      !geometry ||
      (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") ||
      // A right-typed feature can still carry null/empty/garbage coordinates
      // — that must fail here (→ 502), not inside MapLibre on the client.
      // One nesting level is checked (each member a non-empty array); full
      // GeoJSON-tree validation is out of scope for a trusted provider.
      !Array.isArray(geometry.coordinates) ||
      geometry.coordinates.length === 0 ||
      !(geometry.coordinates as unknown[]).every((c) => Array.isArray(c) && c.length > 0)
    ) {
      throw new ProviderError("openrouteservice returned a ring with invalid geometry");
    }
    return { minutes: NOMINAL_MINUTES[i]!, geometry: geometry as Ring["geometry"] };
  });
}

// In-flight requests, keyed by cache key, so two concurrent cold callers for the
// same origin (e.g. the client's /api/isochrone and the amenities route, which
// also needs the walk ring) share ONE ORS request instead of each burning a
// rate-limited/quota-capped POST. Cleared on settle.
const inFlight = new Map<string, Promise<IsochroneResult>>();

/** Walking isochrone (15/30/45 min) from a point. Coord is rounded ONCE and
 *  reused for the cache key, the ORS request, and the returned origin. */
export async function walkingIsochrone(latRaw: number, lngRaw: number): Promise<IsochroneResult> {
  // v2: calibrated ranges (see CALIBRATED_RANGES_S) — the version bump makes
  // sure no pre-calibration (over-generous) cached ring is ever served again.
  const key = `iso:foot:v2:${roundCoord(latRaw)},${roundCoord(lngRaw)}`;

  const hit = await getCachedSafe<IsochroneResult>(key);
  if (hit) return hit;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchAndCache(latRaw, lngRaw, key);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function fetchAndCache(latRaw: number, lngRaw: number, key: string): Promise<IsochroneResult> {
  const lat = Number(roundCoord(latRaw));
  const lng = Number(roundCoord(lngRaw));

  const apiKey = serverEnv().orsApiKey;
  if (!apiKey) throw new ProviderError("ORS_API_KEY is not configured");

  // A stalled/unreachable/garbled upstream is a provider error (→ 502), not a 500.
  let body: { features?: OrsFeature[] };
  try {
    const res = await providerFetch(URL, {
      rateHost: HOST,
      minIntervalMs: MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      init: {
        method: "POST",
        // ORS isochrones serves application/geo+json; do NOT send Accept: application/json (→ 406).
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        // ORS expects [lng, lat] order.
        body: JSON.stringify({ locations: [[lng, lat]], range: CALIBRATED_RANGES_S }),
      },
    });
    if (!res.ok) throw new ProviderError(`openrouteservice responded ${res.status}`);
    body = (await res.json()) as { features?: OrsFeature[] };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`openrouteservice request failed: ${(err as Error).message}`);
  }

  // A 200 whose body is null/non-object, or whose features is present but not
  // an array, is a garbled response — it must become a 502, not a TypeError-500.
  if (body === null || typeof body !== "object") {
    throw new ProviderError("openrouteservice returned a malformed response (non-object body)");
  }
  if (body.features !== undefined && !Array.isArray(body.features)) {
    throw new ProviderError("openrouteservice returned a malformed response (features not an array)");
  }
  // normalize enforces the full contract (count, calibrated values, geometry)
  // and throws ProviderError itself — rings come back ascending 15/30/45.
  const rings = normalize(body.features ?? []);

  const result: IsochroneResult = { origin: { lat, lng }, rings };
  await setCachedSafe(key, result, new Date(Date.now() + TTL_MS));
  return result;
}
