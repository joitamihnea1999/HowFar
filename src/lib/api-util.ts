import { NextResponse } from "next/server";

import { inBucharest } from "@/lib/bounds";
import { ProviderError } from "@/lib/providers/http";

/** JSON error body with a status code. */
export function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

/** Parse + validate lat/lng query params. Returns the point or a 400 response. */
export function parseLatLng(url: URL): { lat: number; lng: number } | NextResponse {
  const latRaw = url.searchParams.get("lat");
  const lngRaw = url.searchParams.get("lng");
  // Number(null) and Number("") are both 0 — reject absent/blank params explicitly.
  if (latRaw === null || lngRaw === null || latRaw.trim() === "" || lngRaw.trim() === "") {
    return jsonError(400, "lat and lng are required");
  }
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return jsonError(400, "lat and lng must be valid numbers");
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return jsonError(400, "lat/lng out of range");
  }
  return { lat, lng };
}

/** 422 if the point is outside the Bucharest/Ilfov launch area, else null. */
export function outOfAreaGuard(lat: number, lng: number): NextResponse | null {
  return inBucharest(lat, lng) ? null : jsonError(422, "Outside the Bucharest launch area");
}

/**
 * Map a thrown provider/unknown error to a response (502 vs 500), logging the
 * cause first — the response bodies are deliberately generic, so without this
 * line a production failure leaves no trace of which upstream broke. Logs
 * name + message only (never stacks or upstream payloads); ProviderError
 * messages carry the provider name + status by construction.
 */
export function errorResponse(err: unknown, route: string): NextResponse {
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[api:${route}] ${name}: ${message}`);
  if (err instanceof ProviderError) return jsonError(502, "Upstream provider error");
  return jsonError(500, "Internal error");
}
