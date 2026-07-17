import { NextResponse } from "next/server";

import { errorResponse, jsonError, outOfAreaGuard, parseLatLng } from "@/lib/api-util";
import { reverseGeocode } from "@/features/search/server/nominatim";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const parsed = parseLatLng(new URL(request.url));
  if (parsed instanceof NextResponse) return parsed;
  const outside = outOfAreaGuard(parsed.lat, parsed.lng);
  if (outside) return outside;
  try {
    const point = await reverseGeocode(parsed.lat, parsed.lng);
    if (!point) return jsonError(404, "No address at this location");
    return NextResponse.json(point);
  } catch (err) {
    return errorResponse(err, "reverse");
  }
}
