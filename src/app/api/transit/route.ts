import { NextResponse } from "next/server";

import { parsePaceStrict } from "@/features/isochrones/pace";
import { transitIsochrone } from "@/features/isochrones/server/transit";
import { parseTimeContext } from "@/features/isochrones/time-context";
import { errorResponse, jsonError, outOfAreaGuard, parseLatLng } from "@/lib/api-util";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = parseLatLng(url);
  if (parsed instanceof NextResponse) return parsed;
  const outside = outOfAreaGuard(parsed.lat, parsed.lng);
  if (outside) return outside;
  const pace = parsePaceStrict(url.searchParams.get("pace"));
  if (pace === null) return jsonError(400, "Invalid pace");
  const timeContext = parseTimeContext({
    preset: url.searchParams.get("preset"),
    weekday: url.searchParams.get("weekday"),
    time: url.searchParams.get("time"),
  });
  if (timeContext === null) return jsonError(400, "Invalid departure time");
  try {
    const result = await transitIsochrone(parsed.lat, parsed.lng, pace, timeContext);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, "transit");
  }
}
