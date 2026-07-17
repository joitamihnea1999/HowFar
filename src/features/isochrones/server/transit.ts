import { walkingIsochrone } from "@/features/isochrones/server/ors";
import {
  buildRings,
  THRESHOLDS,
  unionRings,
  type TransitStop,
  type WalkRing,
} from "@/features/isochrones/server/transit-grid";
import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { BUCHAREST_BBOX } from "@/lib/bounds";
import { providerFetch, ProviderError, roundCoord, USER_AGENT } from "@/lib/provider-http";
import { withTimeout } from "@/lib/timeout";

/**
 * Transitous MOTIS transit isochrones (server-side, cached). Transitous has no
 * isochrone endpoint, so we call `one-to-all` (every stop reachable from the
 * origin, with per-stop minutes) and construct the polygons ourselves in
 * `transit-grid.ts`. Non-commercial, keyless; ToS requires an identifying
 * User-Agent + attribution (link rendered client-side to transitous.org/sources
 * + OSM). Returns the same `{origin, rings}` shape as ors.ts's walking
 * isochrone so the map renders both modes through one path.
 */

const URL = "https://api.transitous.org/api/v6/one-to-all";
const HOST = "api.transitous.org";
const MIN_INTERVAL_MS = 1500; // community-run; be a good citizen
const TIMEOUT_MS = 20_000; // one-to-all is heavy (~1.5–3 s live)
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TRAVEL_MIN = THRESHOLDS[THRESHOLDS.length - 1]; // 45
// Pin MOTIS's access-walk speed to the product's 80 m/min (= 1.333 m/s) so the
// per-stop durations share one speed model with the egress stamps and the walk
// rings; routed transfers cost nothing extra and reach ~4% more stops
// (probed live 2026-07-17: 2508→2607 stops, same latency).
const PEDESTRIAN_SPEED_M_S = "1.333";
// Ceiling on how long the transit response waits for the walking rings: past
// this, ship with the radial origin fallback instead of inheriting ORS's
// rate-limit queue or a stalled body. The unfinished ORS call keeps running
// and lands in the 7-day cache — a prefetch, deliberately not cancelled.
const WALK_RINGS_TIMEOUT_MS = 8_000;

const BUCHAREST_TZ = "Europe/Bucharest";
const REPRESENTATIVE_WEEKDAY = 3; // Wednesday
const REPRESENTATIVE_HOUR = 8;
const REPRESENTATIVE_MINUTE = 30;

export interface TransitIsochroneResult {
  /** The rounded origin actually sent to Transitous (== marker origin == cache key). */
  origin: { lat: number; lng: number };
  /** Reachability rings, ascending by minutes (15, 30, 45). */
  rings: { minutes: number; geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown } }[];
  /** The pinned representative departure (ISO instant) the reachability models
   * — upcoming Wednesday 08:30 Europe/Bucharest, NOT "now". Surfaced so the UI
   * can qualify the claim (a weekend/night visitor sees weekday-morning reach). */
  departure: string;
}

interface OneToAllStop {
  place?: { lat?: number; lon?: number };
  duration?: number;
}
interface OneToAllBody {
  all?: OneToAllStop[];
}

/** Minutes Europe/Bucharest is ahead of UTC at `date` (DST-correct via Intl). */
function bucharestOffsetMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUCHAREST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour === "24" ? "0" : p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * A stable, representative departure so transit reach doesn't swing with the
 * time of day the user happens to visit (a night-time "now" would show near-
 * empty rings). Pins the coming Wednesday 08:30 Europe/Bucharest — stable for
 * ~6 days (good cache reuse), rolls forward weekly. Exported for tests.
 */
export function representativeDeparture(now: Date = new Date()): string {
  const off = bucharestOffsetMinutes(now);
  // Shift into Bucharest wall time so getUTC* read local calendar fields.
  const wall = new Date(now.getTime() + off * 60000);
  const dow = wall.getUTCDay();
  let add = (REPRESENTATIVE_WEEKDAY - dow + 7) % 7;
  if (add === 0) add = 7; // strictly upcoming, never "today"
  // Wall-clock target as if UTC, then convert back to the real UTC instant.
  const wallTarget = Date.UTC(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate() + add,
    REPRESENTATIVE_HOUR,
    REPRESENTATIVE_MINUTE,
    0,
  );
  const offAtTarget = bucharestOffsetMinutes(new Date(wallTarget - off * 60000));
  return new Date(wallTarget - offAtTarget * 60000).toISOString();
}

// Keep stops a little beyond the launch box: a stop just outside it can still
// have egress-walk minutes that reach area INSIDE the box. The grid itself only
// spans the box (and clamps stamping to it), so out-of-area cells never render.
const STOP_MARGIN_DEG = 0.05; // ~4–5.5 km — comfortably ≥ max egress walk (45 min · 57 m/min ≈ 2.6 km)

function parseStops(all: OneToAllStop[]): TransitStop[] {
  const stops: TransitStop[] = [];
  for (const entry of all) {
    // `entry` (and `entry.place`) may be null/garbled — never let a bad element
    // throw here (this runs outside the ProviderError try/catch → would be a 500).
    const lat = Number(entry?.place?.lat);
    const lng = Number(entry?.place?.lon);
    const dur = Number(entry?.duration);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(dur)) continue;
    if (dur <= 0 || dur > MAX_TRAVEL_MIN) continue;
    // Drop bogus coords (e.g. 0,0) and stops well outside the launch area.
    if (
      lat < BUCHAREST_BBOX.minLat - STOP_MARGIN_DEG ||
      lat > BUCHAREST_BBOX.maxLat + STOP_MARGIN_DEG ||
      lng < BUCHAREST_BBOX.minLng - STOP_MARGIN_DEG ||
      lng > BUCHAREST_BBOX.maxLng + STOP_MARGIN_DEG
    ) {
      continue;
    }
    stops.push({ lat, lng, dur });
  }
  return stops;
}

// In-flight requests keyed by cache key: two concurrent cold callers for the
// same origin+departure share ONE heavy one-to-all request (the ors.ts T3
// pattern — fair use under bursts). Cleared on settle.
const inFlight = new Map<string, Promise<TransitIsochroneResult>>();

/** Transit isochrone (15/30/45 min) from a point, via Transitous one-to-all. */
export async function transitIsochrone(latRaw: number, lngRaw: number): Promise<TransitIsochroneResult> {
  const departure = representativeDeparture();
  // v2: calibrated egress + pinned pedestrian speed + routed transfers + union
  // (the version bump keeps pre-calibration cached rings from ever serving).
  const key = `transit:v2:${roundCoord(latRaw)},${roundCoord(lngRaw)}:${departure}`;

  const hit = await getCachedSafe<TransitIsochroneResult>(key);
  if (hit) return hit;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchAndBuild(latRaw, lngRaw, departure, key);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function fetchAndBuild(
  latRaw: number,
  lngRaw: number,
  departure: string,
  key: string,
): Promise<TransitIsochroneResult> {
  const lat = Number(roundCoord(latRaw));
  const lng = Number(roundCoord(lngRaw));

  // Street-routed origin walk, fetched IN PARALLEL with one-to-all (coalesced
  // with /api/isochrone + amenities via ors.ts's single-flight + 7d cache, so
  // a fresh transit selection costs ≤1 marginal ORS call). Failure is non-fatal
  // — the radial origin stamp takes over and the response still ships.
  const walkPromise: Promise<WalkRing[] | null> = walkingIsochrone(latRaw, lngRaw)
    .then((r) => r.rings as WalkRing[])
    .catch((err: Error) => {
      console.error(`[transit] walking rings unavailable, radial origin fallback: ${err.message}`);
      return null;
    });

  // A stalled/unreachable/garbled upstream is a provider error (→ 502), not a 500.
  let body: OneToAllBody;
  try {
    const url =
      `${URL}?one=${lat},${lng}&maxTravelTime=${MAX_TRAVEL_MIN}` +
      `&transitModes=TRANSIT&time=${encodeURIComponent(departure)}` +
      `&pedestrianSpeed=${PEDESTRIAN_SPEED_M_S}&useRoutedTransfers=true`;
    const res = await providerFetch(url, {
      rateHost: HOST,
      minIntervalMs: MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      init: { headers: { "User-Agent": USER_AGENT } },
    });
    if (!res.ok) throw new ProviderError(`transitous responded ${res.status}`);
    body = (await res.json()) as OneToAllBody;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`transitous request failed: ${(err as Error).message}`);
  }

  // Distinguish a garbled response (no stop array) from a valid zero-stop result
  // (an origin with no transit nearby → walk-only rings, which is legitimate).
  if (!Array.isArray(body?.all)) {
    throw new ProviderError("transitous returned a malformed response (no stop array)");
  }

  const stops = parseStops(body.all);
  // Bounded wait: a stalled ORS body or a deep rate-limit queue must not hold
  // the transit response hostage (the walk ring is polish, not a dependency).
  const timedWalk = await withTimeout(walkPromise, WALK_RINGS_TIMEOUT_MS);
  if (!timedWalk.ok) {
    console.error("[transit] walking rings timed out; radial origin fallback (ORS call continues into cache)");
  }
  const walkRings = timedWalk.ok ? timedWalk.value : null;

  // Geometry construction is CPU work on caller-supplied shapes — a failure here
  // is a provider-side data problem (→ 502), not an internal 500.
  let rings: TransitIsochroneResult["rings"];
  try {
    // With street-routed walk rings in hand, skip the radial origin stamp and
    // union the walk geometry in per threshold. unionRings is all-or-nothing:
    // any per-ring failure returns null and the WHOLE family is rebuilt with
    // the radial origin stamp — a mixed family could exclude the origin from
    // one of its own rings and break nesting (then sit in cache for 7 days).
    const built = buildRings({ lat, lng }, stops, { stampOrigin: !walkRings });
    rings = walkRings
      ? (unionRings(built, walkRings) ?? buildRings({ lat, lng }, stops, { stampOrigin: true }))
      : built;
  } catch (err) {
    throw new ProviderError(`transit isochrone construction failed: ${(err as Error).message}`);
  }
  if (rings.length !== THRESHOLDS.length || rings.some((r) => !r.geometry?.coordinates)) {
    throw new ProviderError("transit isochrone produced unexpected rings");
  }

  const result: TransitIsochroneResult = { origin: { lat, lng }, rings, departure };
  await setCachedSafe(key, result, new Date(Date.now() + TTL_MS));
  return result;
}
