import { NextResponse } from "next/server";

import {
  CatalogueUnavailableError,
  nearbyAmenities,
} from "@/features/amenities/server/catalogue";
import { parsePaceStrict } from "@/features/isochrones/pace";
import { parseTimeContext } from "@/features/isochrones/time-context";
import { parseModeStrict } from "@/features/map/selection-flow";
import { errorResponse, jsonError, outOfAreaGuard, parseLatLng } from "@/lib/api-util";

/**
 * Amenities inside the reach area of a travel mode (task 065).
 *
 * `mode` is REQUIRED and fail-loud: the clip follows the mode, so silently
 * defaulting a missing mode to walk would serve a 15-minute-walk marker set over
 * transit or car shading — the exact defect this task removes — with nothing
 * reporting it. `preset` selects the departure/traffic context that the transit and
 * car rings are computed at, so the markers match the polygon the user sees; it is
 * parsed by the SAME `parseTimeContext` the /api/transit and /api/car routes use,
 * and rejects retired `weekday`/`time` params (task 059).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = parseLatLng(url);
  if (parsed instanceof NextResponse) return parsed;
  const outside = outOfAreaGuard(parsed.lat, parsed.lng);
  if (outside) return outside;
  const pace = parsePaceStrict(url.searchParams.get("pace"));
  if (pace === null) return jsonError(400, "Invalid pace");
  const mode = parseModeStrict(url.searchParams.get("mode"));
  if (mode === null) return jsonError(400, "Invalid mode");
  const timeContext = parseTimeContext({
    preset: url.searchParams.get("preset"),
    weekday: url.searchParams.get("weekday"),
    time: url.searchParams.get("time"),
  });
  if (timeContext === null) return jsonError(400, "Invalid departure time");
  try {
    const result = await nearbyAmenities(parsed.lat, parsed.lng, pace, mode, timeContext);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof CatalogueUnavailableError) {
      console.error(`[api:amenities] ${err.name}: ${err.message}`);
      return jsonError(503, "Amenity catalogue unavailable");
    }
    return errorResponse(err, "amenities");
  }
}
