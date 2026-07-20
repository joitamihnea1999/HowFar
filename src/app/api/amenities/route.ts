import { NextResponse } from "next/server";

import {
  CatalogueUnavailableError,
  nearbyAmenities,
} from "@/features/amenities/server/catalogue";
import { errorResponse, jsonError, outOfAreaGuard, parseLatLng } from "@/lib/api-util";

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
    if (err instanceof CatalogueUnavailableError) {
      console.error(`[api:amenities] ${err.name}: ${err.message}`);
      return jsonError(503, "Amenity catalogue unavailable");
    }
    return errorResponse(err, "amenities");
  }
}
