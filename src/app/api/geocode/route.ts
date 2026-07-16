import { NextResponse } from "next/server";

import { errorResponse, jsonError, outOfAreaGuard } from "@/lib/api-util";
import { geocode } from "@/lib/providers/nominatim";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q) return jsonError(400, "q is required");
  try {
    const point = await geocode(q);
    if (!point) return jsonError(404, "No match found");
    const outside = outOfAreaGuard(point.lat, point.lng);
    if (outside) return outside;
    return NextResponse.json(point);
  } catch (err) {
    return errorResponse(err, "geocode");
  }
}
