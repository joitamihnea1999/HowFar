import { DEFAULT_PACE, PACE_MODEL, type Pace } from "@/features/isochrones/pace";
import { walkingIsochrone } from "@/features/isochrones/server/ors";
import {
  buildRings,
  dropSmallComponents,
  THRESHOLDS,
  unionRings,
  type Ring,
  type TransitStop,
  type WalkRing,
} from "@/features/isochrones/server/transit-grid";
import {
  DEFAULT_TIME_CONTEXT,
  departureFields,
  type DepartureFields,
  type TimeContext,
} from "@/features/isochrones/time-context";
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
// MOTIS access-walk speed, egress stamping, and the unioned ORS ring all read
// ONE speed model — `PACE_MODEL[pace]` (task 051). Normal pace == the pre-051
// pinned "1.333" m/s so an unchanged request stays byte-identical; routed
// transfers cost nothing extra and reach ~4% more stops (probed 2026-07-17).
// Ceiling on how long the transit response waits for the walking rings: past
// this, ship with the radial origin fallback instead of inheriting ORS's
// rate-limit queue or a stalled body. The unfinished ORS call keeps running
// and lands in the 7-day cache — a prefetch, deliberately not cancelled.
const WALK_RINGS_TIMEOUT_MS = 8_000;

const BUCHAREST_TZ = "Europe/Bucharest";

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
 * moment the user happens to visit (a night-time "now" would show near-empty
 * rings). Resolves `fields` (weekday/hour/minute + allowToday) to the nearest
 * UPCOMING Europe/Bucharest instant, DST-correct. Default (no `fields`) ==
 * upcoming Wednesday 08:30, never-today — the pre-051 behaviour, byte-identical.
 *
 * `allowToday=false` (presets): strictly-future, never today → ~6-day cache
 * reuse, rolls forward weekly. `allowToday=true` (custom): same-day if the
 * chosen slot is still ahead of now, else next week. Exported for tests.
 *
 * DST: the offset is recomputed AT the target instant (`offAtTarget`), so
 * spring-forward/fall-back are handled; a wall time in a fold resolves to the
 * offset Intl reports for that instant (deterministic, single occurrence).
 */
export function representativeDeparture(
  now: Date = new Date(),
  fields: DepartureFields = departureFields(DEFAULT_TIME_CONTEXT),
): string {
  const { weekday, hour, minute, allowToday } = fields;
  const off = bucharestOffsetMinutes(now);
  // Shift into Bucharest wall time so getUTC* read local calendar fields.
  const wall = new Date(now.getTime() + off * 60000);
  const dow = wall.getUTCDay();
  let add = (weekday - dow + 7) % 7;
  if (add === 0 && !allowToday) add = 7; // presets: strictly upcoming, never "today"
  // Wall-clock target as if UTC, then convert back to the real UTC instant.
  const buildWall = (daysAhead: number) =>
    Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + daysAhead, hour, minute, 0);
  let wallTarget = buildWall(add);
  // Same-day custom whose slot already passed today → roll a full week forward.
  if (add === 0 && allowToday && wallTarget <= wall.getTime()) {
    wallTarget = buildWall(7);
  }
  // Convert the wall target to a real UTC instant, iterating the offset to a
  // FIXPOINT. A single `off`-based estimate is wrong when a DST transition falls
  // between `now` and the target (the offset there differs): the estimated
  // instant reads the wrong offset and lands ~1h off. Two–three iterations
  // converge for normal + fall-back (fold) cases; a spring-forward GAP slot
  // (a wall time that doesn't exist) settles just past the gap — a valid future
  // instant. Presets (top of the hour / :30 well clear of transitions) are
  // unaffected either way.
  let offAtTarget = off;
  for (let i = 0; i < 3; i++) {
    const next = bucharestOffsetMinutes(new Date(wallTarget - offAtTarget * 60000));
    if (next === offAtTarget) break;
    offAtTarget = next;
  }
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

/** Transit isochrone (15/30/45 min) from a point, via Transitous one-to-all, at
 * a walking `pace` and departure `timeContext`. Defaults reproduce the pre-051
 * request exactly (normal pace, weekday-morning preset). */
export async function transitIsochrone(
  latRaw: number,
  lngRaw: number,
  pace: Pace = DEFAULT_PACE,
  timeContext: TimeContext = DEFAULT_TIME_CONTEXT,
): Promise<TransitIsochroneResult> {
  const departure = representativeDeparture(new Date(), departureFields(timeContext));
  // v4 (task 052): cache key includes pace + departure so paced/time-shifted
  // rings never serve a Normal/other-time result (and different-pace/time
  // concurrent callers don't share one flight). Bumped v3→v4 because the cached
  // ring geometry now has the speck filter applied (task 052 C) — the bump
  // retires all pre-052 (v3) entries so no stale unfiltered rings serve.
  const key = `transit:v4:${pace}:${roundCoord(latRaw)},${roundCoord(lngRaw)}:${departure}`;

  const hit = await getCachedSafe<TransitIsochroneResult>(key);
  if (hit) return hit;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchAndBuild(latRaw, lngRaw, pace, departure, key);
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
  pace: Pace,
  departure: string,
  key: string,
): Promise<TransitIsochroneResult> {
  const lat = Number(roundCoord(latRaw));
  const lng = Number(roundCoord(lngRaw));
  const paceModel = PACE_MODEL[pace];

  // Street-routed origin walk AT THE ACTIVE PACE, fetched IN PARALLEL with
  // one-to-all (coalesced with /api/isochrone + amenities via ors.ts's
  // single-flight + 7d cache, so a fresh transit selection costs ≤1 marginal ORS
  // call). Failure is non-fatal — the radial origin stamp takes over.
  const walkPromise: Promise<WalkRing[] | null> = walkingIsochrone(latRaw, lngRaw, pace)
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
      `&pedestrianSpeed=${paceModel.pedestrianSpeedMs}&useRoutedTransfers=true`;
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
  let rings: Ring[];
  try {
    // With street-routed walk rings in hand, skip the radial origin stamp and
    // union the walk geometry in per threshold. unionRings is all-or-nothing:
    // any per-ring failure returns null and the WHOLE family is rebuilt with
    // the radial origin stamp — a mixed family could exclude the origin from
    // one of its own rings and break nesting (then sit in cache for 7 days).
    const egressMPerMin = paceModel.egressMPerMin;
    const built = buildRings({ lat, lng }, stops, { stampOrigin: !walkRings, egressMPerMin });
    rings = walkRings
      ? (unionRings(built, walkRings) ??
        buildRings({ lat, lng }, stops, { stampOrigin: true, egressMPerMin }))
      : built;
  } catch (err) {
    throw new ProviderError(`transit isochrone construction failed: ${(err as Error).message}`);
  }
  if (rings.length !== THRESHOLDS.length || rings.some((r) => !r.geometry?.coordinates)) {
    throw new ProviderError("transit isochrone produced unexpected rings");
  }

  // Drop tiny disconnected specks from the FINAL rings — after the whole
  // union/radial-fallback resolution above (task 052 C, plan-panel P11), so the
  // fallback path is filtered too — while always keeping the origin's component.
  // The nesting invariant survives (see dropSmallComponents).
  rings = dropSmallComponents(rings, { lat, lng });

  const result: TransitIsochroneResult = { origin: { lat, lng }, rings, departure };
  await setCachedSafe(key, result, new Date(Date.now() + TTL_MS));
  return result;
}
