import { NextResponse } from "next/server";

import { carTrafficSlotFor } from "@/features/isochrones/car-traffic";
import { parseReachModelStrict } from "@/features/isochrones/preset-reach";
import { drivingIsochrone, drivingPresetIsochrone } from "@/features/isochrones/server/ors";
import { parseTimeContext } from "@/features/isochrones/time-context";
import { errorResponse, jsonError, outOfAreaGuard, parseLatLng } from "@/lib/api-util";

/**
 * Driving-car isochrone (tasks 053/058). Mirrors /api/isochrone but for the car
 * mode: fixed ORS driving-car profile, 10/20/30-min labels. Car has NO pace
 * (a walk concept), but task 058 makes it TIME-AWARE: a `preset` or
 * `weekday`+`time` selects a Bucharest traffic slot whose congestion factor
 * shrinks the free-flow ranges so the painted band reflects real drive time.
 * The response carries a `car` block describing the basis (always "estimate" —
 * typical congestion, not live traffic) so the UI can be honest. Origin is
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
  // Absent params → default (Crowded); retired/malformed → 400 (never a silent
  // fallback that would hide a broken client contract).
  const timeContext = parseTimeContext({
    preset: url.searchParams.get("preset"),
    weekday: url.searchParams.get("weekday"),
    time: url.searchParams.get("time"),
  });
  if (timeContext === null) return jsonError(400, "Invalid departure time");
  const model = parseReachModelStrict(url.searchParams.get("model"));
  if (model === null) return jsonError(400, "Invalid model");
  const slot = carTrafficSlotFor(timeContext);
  try {
    const result =
      model === "preset"
        ? await drivingPresetIsochrone(parsed.lat, parsed.lng, slot)
        : await drivingIsochrone(parsed.lat, parsed.lng, slot);
    return NextResponse.json({
      ...result,
      car: { basis: "estimate" as const, slotId: slot.slotId, slotLabel: slot.label, factor: slot.factor },
    });
  } catch (err) {
    return errorResponse(err, "car");
  }
}
