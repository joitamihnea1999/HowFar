import { NextResponse } from "next/server";

import { parsePaceStrict } from "@/features/isochrones/pace";
import { walkingIsochrone } from "@/features/isochrones/server/ors";
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
  try {
    const result = await walkingIsochrone(parsed.lat, parsed.lng, pace);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, "isochrone");
  }
}
