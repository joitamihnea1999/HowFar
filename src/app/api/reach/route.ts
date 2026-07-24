import { NextResponse } from "next/server";

import { planTrip } from "@/features/isochrones/server/transit-plan";
import { representativeDeparture } from "@/features/isochrones/server/transit";
import { departureFields, parseTimeContext } from "@/features/isochrones/time-context";
import { errorResponse, jsonError, outOfAreaGuard } from "@/lib/api-util";

/**
 * Right-click "how do I get there?" (task 052 D). Plans the best public-transport
 * trip from the selected origin (`fromLat`/`fromLng`) to a clicked point
 * (`toLat`/`toLng`) at the selection's departure, via the free MOTIS engine, and
 * returns the trimmed itinerary for the popup. Walk-mode reach is answered on the
 * CLIENT (point-in-ring on the already-drawn rings) — this route is transit-only.
 *
 * Both coordinate pairs are parsed and area-guarded BEFORE any provider call, so
 * an out-of-area or malformed request costs zero upstream traffic (plan-panel P9).
 * The client passes the selection's resolved `departure` ISO so the planned trip
 * matches the timetable the painted rings were computed for (P5); absent/invalid,
 * we derive it from the same preset/day+time contract the isochrone uses.
 */

export const dynamic = "force-dynamic";

/** Parse + validate a lat/lng pair under custom query keys (parseLatLng is fixed
 * to lat/lng; /api/reach carries two points). Returns the point or a 400. */
function parsePoint(url: URL, latKey: string, lngKey: string): { lat: number; lng: number } | NextResponse {
  const latRaw = url.searchParams.get(latKey);
  const lngRaw = url.searchParams.get(lngKey);
  if (latRaw === null || lngRaw === null || latRaw.trim() === "" || lngRaw.trim() === "") {
    return jsonError(400, `${latKey} and ${lngKey} are required`);
  }
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return jsonError(400, `${latKey}/${lngKey} must be valid numbers`);
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return jsonError(400, `${latKey}/${lngKey} out of range`);
  }
  return { lat, lng };
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  const from = parsePoint(url, "fromLat", "fromLng");
  if (from instanceof NextResponse) return from;
  const to = parsePoint(url, "toLat", "toLng");
  if (to instanceof NextResponse) return to;

  // Area-guard BOTH points before touching the provider (P9): an off-area origin
  // OR destination is rejected with zero upstream traffic.
  const fromOutside = outOfAreaGuard(from.lat, from.lng);
  if (fromOutside) return fromOutside;
  const toOutside = outOfAreaGuard(to.lat, to.lng);
  if (toOutside) return toOutside;

  // Prefer the selection's resolved departure ISO (exact match to the rings the
  // user is looking at); otherwise derive it from the time-context params, the
  // same way /api/transit does.
  const departureRaw = url.searchParams.get("departure");
  let departureIso: string;
  const parsedDeparture = departureRaw ? Date.parse(departureRaw) : NaN;
  // Bound a client-supplied departure before it enters the cache key / provider
  // call (impl T6): reject anything more than ~60 days off "now" and round to the
  // minute, so crafted millisecond-precision departures can't spam distinct MOTIS
  // calls / cache rows on the shared Transitous host bucket.
  const HORIZON_MS = 60 * 24 * 60 * 60 * 1000;
  if (Number.isFinite(parsedDeparture) && Math.abs(parsedDeparture - Date.now()) <= HORIZON_MS) {
    departureIso = new Date(Math.round(parsedDeparture / 60000) * 60000).toISOString();
  } else {
    const timeContext = parseTimeContext({
      preset: url.searchParams.get("preset"),
      weekday: url.searchParams.get("weekday"),
      time: url.searchParams.get("time"),
    });
    if (timeContext === null) return jsonError(400, "Invalid departure time");
    departureIso = representativeDeparture(new Date(), departureFields(timeContext));
  }

  // The clicked reach band (minutes) so the planner prefers a trip within the
  // painted "~N-min reach" (task 057). Bounded; ignored if absent/invalid.
  const maxRaw = url.searchParams.get("maxMinutes");
  const maxNum = maxRaw === null ? NaN : Number(maxRaw);
  const maxMinutes = Number.isFinite(maxNum) && maxNum > 0 && maxNum <= 120 ? maxNum : undefined;

  try {
    const plan = await planTrip(from, to, departureIso, maxMinutes);
    return NextResponse.json(plan);
  } catch (err) {
    return errorResponse(err, "reach");
  }
}
