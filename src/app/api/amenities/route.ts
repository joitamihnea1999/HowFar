import { NextResponse } from "next/server";

import {
  CatalogueUnavailableError,
  nearbyAmenities,
} from "@/features/amenities/server/catalogue";
import { parsePaceStrict } from "@/features/isochrones/pace";
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
    const result = await nearbyAmenities(parsed.lat, parsed.lng, pace);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof CatalogueUnavailableError) {
      console.error(`[api:amenities] ${err.name}: ${err.message}`);
      return jsonError(503, "Amenity catalogue unavailable");
    }
    return errorResponse(err, "amenities");
  }
}
