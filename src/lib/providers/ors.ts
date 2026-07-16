import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { serverEnv } from "@/lib/env";
import { providerFetch, ProviderError, roundCoord } from "@/lib/providers/http";

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
const RANGES_SECONDS = [900, 1800, 2700]; // 15 / 30 / 45 minutes
const EXPECTED_MINUTES = [15, 30, 45];

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

function normalize(features: OrsFeature[]): Ring[] {
  return features
    .map((f) => ({
      minutes: Math.round((f.properties?.value ?? 0) / 60),
      geometry: f.geometry,
    }))
    .filter(
      (r): r is Ring =>
        !!r.geometry &&
        (r.geometry.type === "Polygon" || r.geometry.type === "MultiPolygon") &&
        // A right-typed feature can still carry null/empty coordinates — that
        // must fail here (→ 502), not inside MapLibre on the client.
        Array.isArray(r.geometry.coordinates) &&
        r.geometry.coordinates.length > 0 &&
        r.minutes > 0,
    )
    .sort((a, b) => a.minutes - b.minutes);
}

/** Walking isochrone (15/30/45 min) from a point. Coord is rounded ONCE and
 *  reused for the cache key, the ORS request, and the returned origin. */
export async function walkingIsochrone(latRaw: number, lngRaw: number): Promise<IsochroneResult> {
  const lat = Number(roundCoord(latRaw));
  const lng = Number(roundCoord(lngRaw));
  const key = `iso:foot:${roundCoord(latRaw)},${roundCoord(lngRaw)}`;

  const hit = await getCachedSafe<IsochroneResult>(key);
  if (hit) return hit;

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
        body: JSON.stringify({ locations: [[lng, lat]], range: RANGES_SECONDS }),
      },
    });
    if (!res.ok) throw new ProviderError(`openrouteservice responded ${res.status}`);
    body = (await res.json()) as { features?: OrsFeature[] };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`openrouteservice request failed: ${(err as Error).message}`);
  }

  const rings = normalize(body.features ?? []);
  // Contract: exactly one valid ring per requested range (15/30/45), ascending.
  const gotExpected =
    rings.length === EXPECTED_MINUTES.length &&
    EXPECTED_MINUTES.every((m, i) => rings[i]?.minutes === m);
  if (!gotExpected) {
    throw new ProviderError(
      `openrouteservice returned unexpected rings: [${rings.map((r) => r.minutes).join(", ")}]`,
    );
  }

  const result: IsochroneResult = { origin: { lat, lng }, rings };
  await setCachedSafe(key, result, new Date(Date.now() + TTL_MS));
  return result;
}
