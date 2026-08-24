import {
  CAR_FACTOR_REVISION,
  scaledCarRangesS,
  type CarTrafficSlot,
} from "@/features/isochrones/car-traffic";
import { DEFAULT_PACE, PACE_MODEL, type Pace } from "@/features/isochrones/pace";
import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { providerConfig, serverEnv, taggedCacheKey } from "@/lib/env";
import { providerFetch, ProviderError, roundCoord } from "@/lib/provider-http";

/**
 * OpenRouteService isochrones (server-side, cached). One request returns three
 * nested reachability polygons. Two profiles are used:
 *   - foot-walking (walk mode): calibrated + pace-scaled 15/30/45-min ranges.
 *   - driving-car  (car mode, task 053): nominal 10/20/30-min ranges.
 * The API key is the app's only secret provider key and must never reach the
 * client. The two profiles share the normalize contract, rate limiter, cache,
 * and single-flight machinery — they differ only in URL, ranges, labels, and
 * cache prefix.
 */

// Host/base are config-driven (task 007) — default = today's public ORS. Read
// inside the fetch function; the rate-limit host derives from the base.
/** ORS isochrone endpoint for a routing profile (foot-walking | driving-car). */
const isoUrl = (base: string, profile: string) => `${base}/v2/isochrones/${profile}`;
const MIN_INTERVAL_MS = 1500; // free tier ~40 isochrone req/min (PROVIDERS.md) ⇒ ≥1.5s spacing
const TIMEOUT_MS = 12_000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
// The requested WALK ranges are CALIBRATED, not nominal, and now PACE-SCALED.
// ORS foot-walking boundaries are systematically generous versus real street
// walking: auditing ring boundaries with street-routed distances (MOTIS
// one-to-many, withDistance) at three diverse origins (Unirii / Grozăvești /
// Berceni, 2026-07-17) put the nominal 900/1800/2700 s boundaries at
// 1.265/1.164/1.123 × their labels at the 80 m/min CALIBRATION ANCHOR. Two-pass
// fit landed the anchor triple [827,1674,2528] (now `pace.ts`
// CALIBRATED_RANGES_S_AT_80). Since task 064 NO pace walks at the anchor speed —
// every pace's triple is that baseline scaled by speed/CALIBRATION_SPEED (task
// 051, distance is speed-independent); `PACE_MODEL[pace].orsRangesS` is the
// requested triple. So the polygon LABELED
// "15/30/45 min" takes ≈ that many street-walking minutes at the chosen pace.
// Methodology + re-run: docs/PROVIDERS.md "Calibration".
const NOMINAL_MINUTES = [15, 30, 45];
// Car (task 053): owner-picked 10/20/30-min bands (600/1200/1800 s) so the
// driving reach fits the Bucharest map extent — a 45-min drive is ~3.5× the
// tiled area (measured). These are NOMINAL FREE-FLOW seconds.
//
// TASK 058 — traffic realism: the task-056 re-audit ("ranges already accurate,
// no calibration factor") was FREE-FLOW-ONLY — it validated the ORS free-flow
// number against free-flow rulers (public OSRM + ORS-Matrix), and is silent on
// CONGESTION. Bucharest is heavily congested (public TomTom Traffic Index 2025:
// 62.5% congestion, 18.5 km/h avg), so free-flow reach over-claims 1.5–2.2× at
// peak. Car reach is now TIME-AWARE: `drivingIsochrone` divides these nominal
// seconds by a per-time-of-day congestion factor (features/isochrones/
// car-traffic.ts) so the painted band reflects real drive time. We do NOT call
// a live-traffic provider — TomTom's free tier is Evaluation-Use-only (Portal
// T&C §2.2) and its Results can't be cached-to-scale (§11.4) or turned into a
// derived product (§11.6.1); Mapbox/HERE are disqualified/parked. See
// docs/PROVIDERS.md "Car traffic realism". Payloads stay ≤~34 KB / ~1050 coords
// — within the ApiCache row budget, so no size cap is needed.
const CAR_RANGES_S = [600, 1200, 1800];
const CAR_MINUTES = [10, 20, 30];
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
  /** Reachability rings, sorted ascending by minutes (walk 15/30/45; car 10/20/30). */
  rings: Ring[];
}

interface OrsFeature {
  properties?: { value?: number };
  geometry?: { type?: string; coordinates?: unknown };
}

/** Strict bijection from response features to labelled rings: exactly one
 * feature per requested range, matched on the RAW echoed value and only then
 * relabeled to `labels` (walk 15/30/45; car 10/20/30). A dropped, duplicated,
 * reordered-but-wrong or unscaled feature must 502 here — silently mislabeling
 * would lie on the map AND corrupt the amenities clip (it uses the smallest
 * walk ring). `expectedRangesS` and `labels` are positional-parallel, both
 * ascending, so index i pairs the i-th requested range with its label. */
function normalize(
  features: OrsFeature[],
  expectedRangesS: readonly number[],
  labels: readonly number[],
): Ring[] {
  if (features.length !== expectedRangesS.length) {
    throw new ProviderError(
      `openrouteservice returned ${features.length} rings (expected ${expectedRangesS.length})`,
    );
  }
  const sorted = [...features].sort(
    (a, b) => (a?.properties?.value ?? Number.NaN) - (b?.properties?.value ?? Number.NaN),
  );
  return sorted.map((f, i) => {
    const value = f?.properties?.value;
    if (typeof value !== "number" || Math.abs(value - expectedRangesS[i]!) > RANGE_TOLERANCE_S) {
      throw new ProviderError(
        `openrouteservice ring values [${sorted.map((s) => s?.properties?.value).join(", ")}] ` +
          `do not match the requested ranges [${expectedRangesS.join(", ")}]`,
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
    return { minutes: labels[i]!, geometry: geometry as Ring["geometry"] };
  });
}

// In-flight requests, keyed by cache key, so two concurrent cold callers for the
// same origin (e.g. the client's /api/isochrone and the amenities route, which
// also needs the walk ring) share ONE ORS request instead of each burning a
// rate-limited/quota-capped POST. Cleared on settle. Shared across profiles —
// the key prefix (iso:foot / iso:car) keeps walk and car requests distinct.
const inFlight = new Map<string, Promise<IsochroneResult>>();

/** Cached + single-flight core over an ORS `profile`. The caller owns the cache
 *  key (prefix decides walk vs car) and the labels the rings are relabelled to. */
async function orsIsochrone(
  profile: string,
  latRaw: number,
  lngRaw: number,
  ranges: readonly number[],
  labels: readonly number[],
  key: string,
): Promise<IsochroneResult> {
  const hit = await getCachedSafe<IsochroneResult>(key);
  if (hit) return hit;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchAndCache(profile, latRaw, lngRaw, ranges, labels, key);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/** Walking isochrone (15/30/45 min) from a point at a walking `pace`. Coord is
 *  rounded ONCE and reused for the cache key, the ORS request, and the returned
 *  origin. `pace` selects the requested (calibrated, speed-scaled) ranges. */
export async function walkingIsochrone(
  latRaw: number,
  lngRaw: number,
  pace: Pace = DEFAULT_PACE,
): Promise<IsochroneResult> {
  // The cache key includes pace so a Slow request never serves the Normal ring
  // (and concurrent different-pace callers don't share one flight).
  // v3 (task 051): pace added to the key. v4 (task 064): the walking speeds
  // changed to 3/5 km/h, so every cached ring's GEOMETRY is different at the
  // same coordinates — v3 entries must never serve (7-day TTL).
  const key = taggedCacheKey(`iso:foot:v4:${pace}:${roundCoord(latRaw)},${roundCoord(lngRaw)}`);
  return orsIsochrone("foot-walking", latRaw, lngRaw, PACE_MODEL[pace].orsRangesS, NOMINAL_MINUTES, key);
}

/** Driving-car isochrone (10/20/30-min labels, tasks 053/058). Time-aware: the
 *  nominal free-flow ranges are DIVIDED by the traffic slot's congestion factor,
 *  so the painted band reflects real Bucharest drive time at that time of day.
 *  No pace (a walk concept). Cache `iso:car:v2:{frev}:est:{slotId}:{coords}` —
 *  the factor-table revision (`frev`) is IN THE KEY so a recalibration can never
 *  serve rings computed with the old factors; `slotId`
 *  keeps the eight traffic periods distinct. `v2` retires all free-flow `v1`
 *  entries. `basis` on the payload is always "estimate" (typical-congestion
 *  adjustment, not live traffic) — surfaced honestly in the UI. */
export async function drivingIsochrone(
  latRaw: number,
  lngRaw: number,
  slot: CarTrafficSlot,
): Promise<IsochroneResult> {
  const ranges = scaledCarRangesS(CAR_RANGES_S, slot.factor);
  const key = taggedCacheKey(
    `iso:car:v2:${CAR_FACTOR_REVISION}:est:${slot.slotId}:${roundCoord(latRaw)},${roundCoord(lngRaw)}`,
  );
  return orsIsochrone("driving-car", latRaw, lngRaw, ranges, CAR_MINUTES, key);
}

async function fetchAndCache(
  profile: string,
  latRaw: number,
  lngRaw: number,
  ranges: readonly number[],
  labels: readonly number[],
  key: string,
): Promise<IsochroneResult> {
  const lat = Number(roundCoord(latRaw));
  const lng = Number(roundCoord(lngRaw));

  const apiKey = serverEnv().orsApiKey;
  if (!apiKey) throw new ProviderError("ORS_API_KEY is not configured");

  const { orsBase } = providerConfig();

  // A stalled/unreachable/garbled upstream is a provider error (→ 502), not a 500.
  let body: { features?: OrsFeature[] };
  try {
    const res = await providerFetch(isoUrl(orsBase, profile), {
      rateHost: new URL(orsBase).host,
      minIntervalMs: MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      init: {
        method: "POST",
        // ORS isochrones serves application/geo+json; do NOT send Accept: application/json (→ 406).
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        // ORS expects [lng, lat] order.
        body: JSON.stringify({ locations: [[lng, lat]], range: ranges }),
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
  // normalize enforces the full contract (count, requested-range bijection,
  // geometry) and throws ProviderError itself — rings ascending by label.
  const rings = normalize(body.features ?? [], ranges, labels);

  const result: IsochroneResult = { origin: { lat, lng }, rings };
  await setCachedSafe(key, result, new Date(Date.now() + TTL_MS));
  return result;
}
