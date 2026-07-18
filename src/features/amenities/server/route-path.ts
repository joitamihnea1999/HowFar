import { parseRoutePath, type RoutePath } from "@/features/amenities/route-path";
import { TRANSIT_ROUTE_VALUES } from "@/features/amenities/stop-lines";
import { raceOverpass } from "@/features/amenities/server/overpass-client";
import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";

/**
 * The drawable path (track + named stops) of one OSM transit route relation
 * (task 024), via Overpass `out geom` (server-side, cached). Uses the shared
 * endpoint race with `treatEmptyAsFailure: false` — a nonexistent or deleted
 * relation id legitimately returns an empty envelope, which must resolve to a
 * cached negative (404), never an uncacheable 502.
 *
 * The compound query is SET-SAFE (probed live, task 024): the relation is
 * pinned to `.r` because each `node(r.r:...)` statement overwrites the default
 * set — a plain chain would recurse from the previous statement's nodes.
 * The second half fetches the passenger nodes' tags (names); `out geom` alone
 * inlines member coords but never member tags.
 *
 * A relation that exists but is NOT a transit route (the id is client-
 * supplied) parses to `invalid` and is cached briefly — the route maps it to
 * a 404, and the response stays bounded by the parser's caps either way.
 */

const TTL_FULL_MS = 30 * 24 * 60 * 60 * 1000; // route geometry changes slowly
// A shorter TTL for negative results (not-a-transit-route / degenerate parse):
// they should self-heal quickly if the relation gets fixed in OSM, and a
// briefly-cached negative still blunts id-cycling against the shared servers.
const TTL_INVALID_MS = 24 * 60 * 60 * 1000;

/** Cache envelope: distinguishes a cached negative from a cache miss. */
interface CachedRoutePath {
  path: RoutePath | null;
}

const TRANSIT_SET = new Set<string>(TRANSIT_ROUTE_VALUES);

/** Passenger roles whose member nodes the second statement fetches for names
 * (stop* preferred by the parser; platform* feeds its fallback). */
const PASSENGER_ROLES = [
  "stop",
  "stop_entry_only",
  "stop_exit_only",
  "platform",
  "platform_entry_only",
  "platform_exit_only",
] as const;

/** Set-safe compound QL: relation geometry + its passenger nodes' tags. Pure +
 * exported for tests. `relationId` is a positive integer (validated at the route). */
export function buildRoutePathQuery(relationId: number): string {
  const nodeStatements = PASSENGER_ROLES.map((role) => `node(r.r:"${role}");`).join("");
  return `[out:json][timeout:25];rel(${relationId})->.r;.r out geom;(${nodeStatements});out body;`;
}

// In-flight requests keyed by cache key so two concurrent cold clicks on the
// same line share ONE race (the stop-lines / ors.ts single-flight pattern).
const inFlight = new Map<string, Promise<RoutePath | null>>();

/**
 * The drawable path for a route relation, or null when the relation is not a
 * transit route (→ 404 at the route). Cached best-effort; single-flighted.
 */
export async function routePath(relationId: number): Promise<RoutePath | null> {
  const key = `route-path:v1:${relationId}`;
  const hit = await getCachedSafe<CachedRoutePath>(key);
  if (hit) return hit.path;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchParseCache(relationId, key);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function fetchParseCache(relationId: number, key: string): Promise<RoutePath | null> {
  // Tolerate an empty envelope: a NONEXISTENT/deleted relation id legitimately
  // returns [] from every healthy host, and must become a cached negative
  // (→ 404), not an uncacheable 502 that re-races the pool on every click —
  // that would defeat the id-cycling blunting entirely.
  const elements = await raceOverpass(buildRoutePathQuery(relationId), { treatEmptyAsFailure: false });

  // Payload hygiene: the id is client-supplied, so confirm what came back IS
  // the requested transit route before doing any geometry work — this endpoint
  // must not become a generic OSM-geometry proxy.
  const relation = elements.find((el) => el?.type === "relation" && el.id === relationId);
  const tags = relation?.tags ?? {};
  const isTransitRoute = tags.type === "route" && TRANSIT_SET.has(tags.route ?? "");

  // A transit route with no drawable track is as unusable as a non-route —
  // cache both as negatives (short TTL) rather than serving an empty map layer.
  const parsed = isTransitRoute ? parseRoutePath(elements) : null;
  const path = parsed && parsed.segments.length > 0 ? parsed : null;

  await setCachedSafe(key, { path }, new Date(Date.now() + (path ? TTL_FULL_MS : TTL_INVALID_MS)));
  return path;
}
