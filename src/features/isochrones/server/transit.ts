import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { BUCHAREST_BBOX } from "@/lib/bounds";
import { providerFetch, ProviderError, roundCoord, USER_AGENT } from "@/lib/provider-http";
import { buildRings, THRESHOLDS, type TransitStop } from "@/features/isochrones/server/transit-grid";

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

const BUCHAREST_TZ = "Europe/Bucharest";
const REPRESENTATIVE_WEEKDAY = 3; // Wednesday
const REPRESENTATIVE_HOUR = 8;
const REPRESENTATIVE_MINUTE = 30;

export interface TransitIsochroneResult {
  /** The rounded origin actually sent to Transitous (== marker origin == cache key). */
  origin: { lat: number; lng: number };
  /** Reachability rings, ascending by minutes (15, 30, 45). */
  rings: { minutes: number; geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown } }[];
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
const STOP_MARGIN_DEG = 0.05; // ~4–5.5 km ≈ max egress walk (45 min · 80 m/min)

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

/** Transit isochrone (15/30/45 min) from a point, via Transitous one-to-all. */
export async function transitIsochrone(latRaw: number, lngRaw: number): Promise<TransitIsochroneResult> {
  const lat = Number(roundCoord(latRaw));
  const lng = Number(roundCoord(lngRaw));
  const departure = representativeDeparture();
  const key = `transit:${roundCoord(latRaw)},${roundCoord(lngRaw)}:${departure}`;

  const hit = await getCachedSafe<TransitIsochroneResult>(key);
  if (hit) return hit;

  // A stalled/unreachable/garbled upstream is a provider error (→ 502), not a 500.
  let body: OneToAllBody;
  try {
    const url =
      `${URL}?one=${lat},${lng}&maxTravelTime=${MAX_TRAVEL_MIN}` +
      `&transitModes=TRANSIT&time=${encodeURIComponent(departure)}`;
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

  // Geometry construction is CPU work on caller-supplied shapes — a failure here
  // is a provider-side data problem (→ 502), not an internal 500.
  let rings: TransitIsochroneResult["rings"];
  try {
    rings = buildRings({ lat, lng }, stops);
  } catch (err) {
    throw new ProviderError(`transit isochrone construction failed: ${(err as Error).message}`);
  }
  if (rings.length !== THRESHOLDS.length || rings.some((r) => !r.geometry?.coordinates)) {
    throw new ProviderError("transit isochrone produced unexpected rings");
  }

  const result: TransitIsochroneResult = { origin: { lat, lng }, rings };
  await setCachedSafe(key, result, new Date(Date.now() + TTL_MS));
  return result;
}
