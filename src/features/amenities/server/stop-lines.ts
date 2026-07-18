import { parseRouteRelations, type StopLine } from "@/features/amenities/stop-lines";
import { raceOverpass } from "@/features/amenities/server/overpass-client";
import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";

/**
 * The transit lines serving one OSM stop (task 021), via OSM public-transport
 * route relations on Overpass (server-side, cached). Uses the shared endpoint
 * race with `treatEmptyAsFailure: false` — a stop that serves no mapped routes
 * legitimately returns `[]` (must NOT become a 502).
 *
 * The query is stop-area-aware (probed live 2026-07-17, task 021): a bus/
 * tram stop node is usually a DIRECT member of its route relations, but a metro/
 * rail STATION node is not — its routes reference the platform/stop_position
 * nodes grouped with it under a `public_transport=stop_area` relation. So we
 * seed the stop, pull its stop_area, union the stop with the stop_area's member
 * nodes/ways, then recurse to the route relations of that whole set. One query
 * covers bus, tram AND metro (verified: returns M2 both ways for Piața Romană
 * metro, and the 6 bus relations for the Piața Romană bus stop — no over-reach).
 */

export type OsmType = "node" | "way" | "relation";

const SEED: Record<OsmType, string> = { node: "node", way: "way", relation: "rel" };
// Backward-recursion filter to find relations CONTAINING the seed (task 021:
// `bn:ID` inline is invalid — recursion consumes a seeded set).
const BACK: Record<OsmType, string> = { node: "bn", way: "bw", relation: "br" };

const TTL_FULL_MS = 30 * 24 * 60 * 60 * 1000; // route topology changes slowly
// A shorter TTL for a NEGATIVE (no-lines) result: with treatEmptyAsFailure=false
// a transiently-degraded mirror could win with a bare []; capping the empty
// cache at a day lets it self-heal instead of pinning "no lines" for a month.
const TTL_EMPTY_MS = 24 * 60 * 60 * 1000;

/** DIRECT route relations the stop itself is a member of. Correct for surface
 * stops (a bus/tram platform node IS a member of its routes) — and, crucially,
 * per-platform ACCURATE: it does NOT pull sibling-platform lines the way a
 * stop_area expansion would (task 021, verified live at Piața Unirii: a bus
 * stop with 1 real route gained 8 unrelated tram routes under the area hop).
 * Pure + exported for tests. `id` is a positive integer (validated at the route). */
export function buildDirectQuery(osmType: OsmType, id: number): string {
  const seed = SEED[osmType];
  const back = BACK[osmType];
  return `[out:json][timeout:25];${seed}(${id});(rel(${back})[type=route];);out tags;`;
}

/** stop_area-EXPANDED route relations — the FALLBACK for a metro/rail station,
 * whose station node is NOT a direct route member (its routes reference the
 * platform/stop_position nodes grouped with it under a `public_transport=
 * stop_area`). Only used when `buildDirectQuery` came back empty, so surface
 * stops never pay the over-reach. Pure + exported for tests. */
export function buildAreaQuery(osmType: OsmType, id: number): string {
  const seed = SEED[osmType];
  const back = BACK[osmType];
  return (
    `[out:json][timeout:25];` +
    `${seed}(${id});` +
    `rel(${back})[public_transport=stop_area]->.sa;` +
    `(node(r.sa);way(r.sa););` +
    `(rel(bn)[type=route];rel(bw)[type=route];);` +
    `out tags;`
  );
}

// In-flight requests keyed by cache key so two concurrent cold clicks on the same
// stop share ONE race (the overpass.ts / ors.ts single-flight pattern).
const inFlight = new Map<string, Promise<StopLine[]>>();

/** The deduped, sorted transit lines serving a stop (empty when it serves none).
 * Cached best-effort; single-flighted. The stop's display NAME is NOT derived
 * here (the caller already knows it) — this returns lines only, so the cache is
 * keyed purely by OSM identity and never poisoned by a client-supplied name. */
export async function stopLines(osmType: OsmType, id: number): Promise<StopLine[]> {
  // v2: StopLine gained relationId (task 024) — the bump keeps v1 hits (parsed
  // before ids existed) from serving rows whose paths could never be drawn.
  const key = `stop-lines:v2:${osmType}/${id}`;
  const hit = await getCachedSafe<StopLine[]>(key);
  if (hit) return hit;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchParseCache(osmType, id, key);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function fetchParseCache(osmType: OsmType, id: number, key: string): Promise<StopLine[]> {
  // Single-stop query: [] is a valid "no mapped routes", not a degraded mirror
  // (raceOverpass prefers a non-empty host and only resolves [] if all are empty).
  // Stage 1 — DIRECT membership (accurate for surface stops).
  const direct = parseRouteRelations(await raceOverpass(buildDirectQuery(osmType, id), { treatEmptyAsFailure: false }), "");
  // Stage 2 — only if the stop is a direct member of NOTHING (a metro/rail
  // station): expand via its stop_area. Surface stops never reach this, so they
  // never inherit sibling-platform lines.
  const lines = direct.lines.length
    ? direct.lines
    : parseRouteRelations(await raceOverpass(buildAreaQuery(osmType, id), { treatEmptyAsFailure: false }), "").lines;
  const ttl = lines.length ? TTL_FULL_MS : TTL_EMPTY_MS;
  await setCachedSafe(key, lines, new Date(Date.now() + ttl));
  return lines;
}
