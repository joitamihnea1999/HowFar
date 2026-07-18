import { NextResponse } from "next/server";

import { errorResponse, jsonError, outOfAreaGuard, parseLatLng } from "@/lib/api-util";
import { routePath } from "@/features/amenities/server/route-path";

/**
 * The drawable path (track segments + named stops) of one OSM transit route
 * relation (task 024). GET `?rel=<posint>&lat=&lng=`.
 *
 * `outOfAreaGuard` on lat/lng (the clicked stop's location) mirrors the
 * stop-lines posture: it keeps casual off-area traffic off the community
 * Overpass servers with ZERO provider calls, while the real fair-use bound
 * stays the per-host rate limiter + single-flight + TTL cache. The relation id
 * is client-supplied, so the provider layer verifies the fetched relation IS a
 * transit route and bounds the parsed payload — a non-route id yields 404 here.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);

  const parsed = parseLatLng(url);
  if (parsed instanceof NextResponse) return parsed;
  const outside = outOfAreaGuard(parsed.lat, parsed.lng);
  if (outside) return outside;

  const relRaw = url.searchParams.get("rel");
  const rel = Number(relRaw);
  if (relRaw === null || relRaw.trim() === "" || !Number.isInteger(rel) || rel <= 0) {
    return jsonError(400, "rel must be a positive integer");
  }

  try {
    const path = await routePath(rel);
    if (!path) return jsonError(404, "No drawable transit route for that relation");
    return NextResponse.json(path);
  } catch (err) {
    return errorResponse(err, "route-path");
  }
}
