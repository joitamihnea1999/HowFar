import { NextResponse } from "next/server";

import { errorResponse, jsonError, outOfAreaGuard, parseLatLng } from "@/lib/api-util";
import { stopLines, type OsmType } from "@/features/amenities/server/stop-lines";

/**
 * Transit lines serving one OSM stop (task 021). GET
 * `?type=node|way|relation&id=<posint>&lat=&lng=&name=`.
 *
 * `outOfAreaGuard` rejects out-of-Bucharest coordinates with ZERO provider calls
 * — it keeps casual off-area traffic off the community Overpass servers. It does
 * NOT bind the OSM id to the coordinates (both are client-supplied), so it is not
 * a hard anti-abuse boundary (both are client-supplied). The real fair-use bound
 * — the metric that matters for the shared Overpass instances — is the per-host
 * RATE limiter in provider-http (~1 req/1.1s/host) plus single-flight + the
 * TTL'd cache; cache rows expire, so keyspace growth is rate-bounded and
 * self-healing. Signed stop capabilities were considered and rejected as
 * disproportionate for a keyless, non-commercial portfolio. `name` is the
 * client's known stop label, echoed back as the popup title (never enters the QL).
 */

export const dynamic = "force-dynamic";

const OSM_TYPES: readonly string[] = ["node", "way", "relation"];

export async function GET(request: Request) {
  const url = new URL(request.url);

  const parsed = parseLatLng(url);
  if (parsed instanceof NextResponse) return parsed;
  const outside = outOfAreaGuard(parsed.lat, parsed.lng);
  if (outside) return outside;

  const type = url.searchParams.get("type");
  if (!type || !OSM_TYPES.includes(type)) {
    return jsonError(400, "type must be node, way, or relation");
  }
  const idRaw = url.searchParams.get("id");
  const id = Number(idRaw);
  if (idRaw === null || idRaw.trim() === "" || !Number.isInteger(id) || id <= 0) {
    return jsonError(400, "id must be a positive integer");
  }
  const name = url.searchParams.get("name")?.trim() ?? "";

  try {
    const lines = await stopLines(type as OsmType, id);
    return NextResponse.json({ name, lines });
  } catch (err) {
    return errorResponse(err, "stop-lines");
  }
}
