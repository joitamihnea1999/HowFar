import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { decodePolyline } from "@/features/isochrones/polyline";
import { providerFetch, ProviderError, roundCoord, USER_AGENT } from "@/lib/provider-http";

/**
 * Transitous MOTIS journey planning (server-side, cached) for the right-click
 * "how do I get there?" popup (task 052 D). Unlike the reachability isochrone
 * (one-to-all → polygons), this asks the SAME free/keyless engine for the actual
 * best trip from the selected origin to a clicked point, so the popup can give
 * specific, actionable directions — walk to a named stop, board a named line
 * (e.g. "243", "M2") in a stated direction, transfer, then walk to the
 * destination — rather than a nearest-stop approximation. ToS: identifying
 * User-Agent + attribution to transitous.org/sources (rendered client-side).
 */

const URL = "https://api.transitous.org/api/v1/plan";
const HOST = "api.transitous.org";
const MIN_INTERVAL_MS = 1500; // community-run; be a good citizen (shared with one-to-all's host)
const TIMEOUT_MS = 15_000; // /plan is lighter than one-to-all (~0.6s server), but stay generous
// Schedules are stable within a day and the departure is in the cache key, so a
// few hours of reuse is safe and keeps repeat right-clicks instant.
const TTL_MS = 6 * 60 * 60 * 1000;
/** Legs-per-itinerary cap (payload bound). Bucharest trips run ~3–9 legs; a
 * value well above that drops only degenerate/hostile responses (task 054). */
const MAX_REACH_LEGS = 24;

/** A leg endpoint's coordinates ([lng, lat] carried as named fields). Optional:
 * a malformed leg without finite coords still lists its step, it just can't be
 * drawn (task 054). */
export interface ReachPoint {
  lat: number;
  lng: number;
}

export interface ReachLeg {
  /** MOTIS mode: WALK | BUS | TRAM | SUBWAY | RAIL | COACH | … */
  mode: string;
  /** The line's public short name (e.g. "243", "M2") — transit legs only. */
  line?: string;
  /** The line's destination sign (direction) — transit legs only. */
  headsign?: string;
  /** Board/alight place names ("START"/"END" for the trip endpoints). */
  fromName: string;
  toName: string;
  minutes: number;
  /** Board/alight coordinates, surfaced so the client can highlight the stops
   * the rider actually uses (task 054). Absent when the leg lacks finite coords. */
  from?: ReachPoint;
  to?: ReachPoint;
  /** The leg's drawn track as [lng, lat] points, decoded from MOTIS
   * `legGeometry` (Google-encoded polyline, precision 7). Empty/absent when the
   * leg carried no geometry or it decoded to nothing — the client then falls back
   * to a straight from→to line so a transfer/alight is never silently omitted. */
  path?: [number, number][];
}

export type ReachPlan =
  | { reachable: true; totalMinutes: number; transfers: number; legs: ReachLeg[] }
  | { reachable: false };

interface MotisPlace {
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
}
interface MotisLegGeometry {
  points?: unknown;
  precision?: unknown;
}
interface MotisLeg {
  mode?: unknown;
  duration?: unknown;
  from?: MotisPlace | null;
  to?: MotisPlace | null;
  routeShortName?: unknown;
  headsign?: unknown;
  legGeometry?: MotisLegGeometry | null;
}
interface MotisItinerary {
  duration?: unknown;
  transfers?: unknown;
  legs?: MotisLeg[];
}
interface MotisPlanBody {
  itineraries?: MotisItinerary[];
  /** Non-transit (walk/bike) options MOTIS returns separately — used as a
   * fallback so a very-close destination gets a walking answer instead of a
   * false "no public-transport route" (impl-panel T4). */
  direct?: MotisItinerary[];
}

function placeName(p: MotisPlace | null | undefined): string {
  return typeof p?.name === "string" ? p.name : "";
}
/** A leg endpoint's coords, or undefined when either is missing / non-numeric /
 * out of range — a leg without drawable coords still lists as a step. Requires
 * an ACTUAL number (not a coercible null/""): `Number(null)` is 0, which would
 * otherwise plant a false (0,0) stop off West Africa (review). */
function placePoint(p: MotisPlace | null | undefined): ReachPoint | undefined {
  const lat = p?.lat;
  const lng = p?.lon;
  if (typeof lat !== "number" || typeof lng !== "number") return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  return { lat, lng };
}
/** Transitous encodes `legGeometry` at precision 7. Default to 7 (NOT the format's
 * usual 5) when the field is missing, so a dropped precision degrades to correct
 * decoding rather than silently pushing every path 100× out of range → empty →
 * straight-line-only draw (review). */
const DEFAULT_LEG_PRECISION = 7;
/** Decode a MOTIS leg's `legGeometry` to a bounded [lng,lat] track. */
function legPath(g: MotisLegGeometry | null | undefined): [number, number][] {
  if (!g || typeof g !== "object") return [];
  const precision = Number(g.precision);
  return decodePolyline(g.points, Number.isFinite(precision) && precision > 0 ? precision : DEFAULT_LEG_PRECISION);
}
function minutesOf(seconds: unknown): number {
  const s = Number(seconds);
  return Number.isFinite(s) && s > 0 ? Math.round(s / 60) : 0;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Trim one MOTIS itinerary to the fields the popup renders. Drops negligible
 * (<1 min) WALK legs — the engine emits 0-minute START/END walk stubs when the
 * origin/destination sits on a stop. An itinerary that trims to no legs is not a
 * usable answer. Pure + exported for tests.
 */
export function parseItinerary(it: MotisItinerary): ReachPlan {
  const rawLegs = Array.isArray(it?.legs) ? it.legs : [];
  const legs: ReachLeg[] = [];
  for (const l of rawLegs) {
    // Bound legs-per-itinerary: with each leg's `path` now up to
    // MAX_POLYLINE_POINTS, a degenerate/hostile MOTIS response could otherwise
    // build a multi-MB ReachPlan that gets cached (6h) and shipped to the client.
    // A real Bucharest trip is well under this (review).
    if (legs.length >= MAX_REACH_LEGS) break;
    if (!l || typeof l !== "object") continue; // tolerate null/garbled leg entries (T2)
    const mode = str(l.mode) ?? "UNKNOWN";
    const minutes = minutesOf(l.duration);
    const isWalk = mode === "WALK";
    if (isWalk && minutes < 1) continue; // drop 0-min START/END walk stubs
    const leg: ReachLeg = {
      mode,
      fromName: placeName(l.from),
      toName: placeName(l.to),
      minutes,
      // Coords + decoded track ride along so the client can DRAW the journey
      // (task 054); from/to are kept even when the path decodes to nothing.
      from: placePoint(l.from),
      to: placePoint(l.to),
      path: legPath(l.legGeometry),
    };
    if (!isWalk) {
      const line = str(l.routeShortName);
      if (line) leg.line = line;
      const headsign = str(l.headsign);
      if (headsign) leg.headsign = headsign;
    }
    legs.push(leg);
  }
  if (legs.length === 0) return { reachable: false };
  const transfers = Number(it.transfers);
  return {
    reachable: true,
    totalMinutes: minutesOf(it.duration),
    transfers: Number.isFinite(transfers) && transfers > 0 ? Math.trunc(transfers) : 0,
    legs,
  };
}

/**
 * Pick the best itinerary (fastest, then fewest transfers) and trim it. MOTIS
 * does NOT return itineraries sorted by duration (observed: 83, 57, 57, 58, 77),
 * so choosing index 0 would show a slower trip than exists. Transit options
 * (`itineraries`) win; if there are none, fall back to `direct` (walk/bike) so a
 * very-close destination still gets an answer (T4). Itineraries without a finite
 * positive duration are dropped, never sorted to the front (T2). Pure + exported.
 */
export function bestPlan(body: MotisPlanBody): ReachPlan {
  const usable = (list: MotisItinerary[] | undefined): MotisItinerary[] =>
    (Array.isArray(list) ? list : []).filter((it) => it && minutesOf(it.duration) > 0);
  const transit = usable(body.itineraries);
  const candidates = transit.length > 0 ? transit : usable(body.direct);
  if (candidates.length === 0) return { reachable: false };
  const best = [...candidates].sort((a, b) => {
    const da = minutesOf(a.duration);
    const db = minutesOf(b.duration);
    if (da !== db) return da - db;
    return (Number(a.transfers) || 0) - (Number(b.transfers) || 0);
  })[0];
  return parseItinerary(best);
}

// In-flight requests keyed by cache key: concurrent cold right-clicks on the
// same trip share ONE /plan request (the ors.ts / transit.ts single-flight).
const inFlight = new Map<string, Promise<ReachPlan>>();

/** Plan the best public-transport trip from `from` to `to` departing at
 * `departureIso` (the selection's resolved departure, so it matches the painted
 * rings' time). Cached + single-flighted. Throws ProviderError on a provider
 * failure (→ 502); a genuine "no route" is a cacheable `{reachable:false}`. */
export async function planTrip(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  departureIso: string,
): Promise<ReachPlan> {
  // v2: the cached ReachPlan now carries per-leg coords + decoded geometry
  // (task 054) — a v1 entry would deserialize without them.
  const key = `reach:plan:v2:${roundCoord(from.lat)},${roundCoord(from.lng)}:${roundCoord(to.lat)},${roundCoord(to.lng)}:${departureIso}`;
  const hit = await getCachedSafe<ReachPlan>(key);
  if (hit) return hit;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = fetchAndParse(from, to, departureIso, key);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function fetchAndParse(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  departureIso: string,
  key: string,
): Promise<ReachPlan> {
  const url =
    `${URL}?fromPlace=${roundCoord(from.lat)},${roundCoord(from.lng)}` +
    `&toPlace=${roundCoord(to.lat)},${roundCoord(to.lng)}` +
    `&time=${encodeURIComponent(departureIso)}&arriveBy=false`;

  let body: MotisPlanBody;
  try {
    const res = await providerFetch(url, {
      rateHost: HOST,
      minIntervalMs: MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      init: { headers: { "User-Agent": USER_AGENT } },
    });
    if (!res.ok) throw new ProviderError(`transitous plan responded ${res.status}`);
    body = (await res.json()) as MotisPlanBody;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`transitous plan request failed: ${(err as Error).message}`);
  }
  if (!Array.isArray(body?.itineraries)) {
    throw new ProviderError("transitous plan returned a malformed response (no itineraries array)");
  }

  const plan = bestPlan(body);
  await setCachedSafe(key, plan, new Date(Date.now() + TTL_MS));
  return plan;
}
