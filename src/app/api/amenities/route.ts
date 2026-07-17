import { NextResponse } from "next/server";

import { errorResponse, outOfAreaGuard, parseLatLng } from "@/lib/api-util";
import { nearbyAmenities } from "@/lib/providers/overpass";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const parsed = parseLatLng(new URL(request.url));
  if (parsed instanceof NextResponse) return parsed;
  const outside = outOfAreaGuard(parsed.lat, parsed.lng);
  if (outside) return outside;
  try {
    const result = await nearbyAmenities(parsed.lat, parsed.lng);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, "amenities");
  }
}
