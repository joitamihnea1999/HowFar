import { NextResponse } from "next/server";

import { drivingIsochrone } from "@/features/isochrones/server/ors";
import { errorResponse, outOfAreaGuard, parseLatLng } from "@/lib/api-util";

/**
 * Driving-car isochrone (task 053). Mirrors /api/isochrone but for the car
 * mode: fixed ORS driving-car profile, nominal 10/20/30-min ranges. Car has NO
 * pace and NO departure-time controls (those are walk/transit concepts), so —
 * unlike /api/isochrone and /api/transit — this route parses NO pace/preset/
 * weekday/time params and any such query is simply ignored. Origin is
 * area-guarded before any provider call, so an out-of-area request costs zero
 * upstream traffic.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = parseLatLng(url);
  if (parsed instanceof NextResponse) return parsed;
  const outside = outOfAreaGuard(parsed.lat, parsed.lng);
  if (outside) return outside;
  try {
    const result = await drivingIsochrone(parsed.lat, parsed.lng);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, "car");
  }
}
