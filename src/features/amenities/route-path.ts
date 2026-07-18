/**
 * Route-path domain model (task 024): turn one OSM route relation (fetched
 * with `out geom` + a second statement for stop-node tags) into the drawable
 * shape of a transit line — its track segments and its ordered, named stops —
 * so a rider can see everything a line reaches from a stop.
 *
 * Pure + isomorphic: the server parses (and caches) this; the client only
 * paints. Total on arbitrary junk — malformed members are skipped, never
 * thrown on (this runs outside the ProviderError try/catch).
 *
 * Structure ground-truth (live probes, task 024 E1 — bus 301, tram 41, M2):
 * the line geometry is the relation's EMPTY-role way members ONLY. Platform-
 * role WAY members also carry geometry (tram 41: 7 of 20) and must be
 * excluded or platforms draw as track stubs. Passenger positions are the
 * `stop*`-role node members (stop / stop_entry_only / stop_exit_only);
 * `platform*`-role NODE members are the fallback when a relation has no
 * stop-role nodes at all (some PTv2 mappings). Stop names come from the
 * response's standalone node elements, joined by member ref.
 */

export interface RouteStop {
  lat: number;
  lng: number;
  /** From the stop node's `name` tag; omitted when unnamed (never invented). */
  name?: string;
}

export interface RoutePath {
  /** Track segments as [lng, lat] point lists (GeoJSON coordinate order),
   * one per empty-role way member, in relation order. */
  segments: [number, number][][];
  /** Passenger stops in relation order, deduped by node identity. */
  stops: RouteStop[];
}

/** Defensive caps on a parsed path (a relation is client-named by id, so the
 * response must stay bounded no matter what the id points at). Generous: the
 * longest Bucharest routes probe at ~226 members / ~25-50 stops / ~1000 track
 * points. The POINT budget is the real payload bound — segment count alone
 * would let a few ultra-dense ways balloon the cached response. */
export const MAX_ROUTE_STOPS = 200;
export const MAX_ROUTE_SEGMENTS = 600;
export const MAX_ROUTE_POINTS = 20_000;

/** Way roles that ARE the line's track: PTv2 uses the empty role; older but
 * valid mappings use forward/backward. Platform- and stop-role ways are never
 * track (their geometry would draw as stubs). */
const TRACK_WAY_ROLES = new Set(["", "forward", "backward"]);

interface MemberShape {
  type?: string;
  ref?: number;
  role?: string;
  lat?: number;
  lon?: number;
  geometry?: { lat?: number; lon?: number }[];
}

interface ElementShape {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  members?: MemberShape[];
}

function finitePair(lat: unknown, lon: unknown): lat is number {
  return Number.isFinite(lat) && Number.isFinite(lon);
}

/** Way-member geometry → a [lng, lat] segment; null when unusable (<2 points). */
function toSegment(geometry: MemberShape["geometry"]): [number, number][] | null {
  if (!Array.isArray(geometry)) return null;
  const points: [number, number][] = [];
  for (const p of geometry) {
    if (!p || typeof p !== "object" || !finitePair(p.lat, p.lon)) continue;
    points.push([p.lon as number, p.lat as number]);
  }
  return points.length >= 2 ? points : null;
}

/**
 * Parse the compound Overpass response (relation with `out geom` + stop nodes
 * with `out body`) into the route's drawable path. The FIRST relation element
 * is the route (the query seeds exactly one id); everything else is ignored
 * except standalone nodes, which contribute names.
 */
export function parseRoutePath(elements: unknown): RoutePath {
  const list = Array.isArray(elements) ? (elements as ElementShape[]) : [];
  const relation = list.find(
    (el) => el && typeof el === "object" && el.type === "relation" && Array.isArray(el.members),
  );

  // Stop names live on the standalone node elements the second query
  // statement returns; members themselves carry coords but no tags.
  const nameByNodeId = new Map<number, string>();
  for (const el of list) {
    if (!el || typeof el !== "object" || el.type !== "node") continue;
    if (typeof el.id !== "number") continue;
    const name = el.tags?.name;
    if (typeof name === "string" && name.trim()) nameByNodeId.set(el.id, name.trim());
  }

  const segments: [number, number][][] = [];
  const stops: RouteStop[] = [];
  const platformFallback: RouteStop[] = [];
  const seenStopRefs = new Set<number | string>();
  const seenPlatformRefs = new Set<number | string>();
  let pointBudget = MAX_ROUTE_POINTS;

  for (const m of relation?.members ?? []) {
    if (!m || typeof m !== "object") continue;
    const role = typeof m.role === "string" ? m.role : "";

    if (m.type === "way" && TRACK_WAY_ROLES.has(role) && segments.length < MAX_ROUTE_SEGMENTS) {
      const segment = toSegment(m.geometry);
      if (segment && segment.length <= pointBudget) {
        pointBudget -= segment.length;
        segments.push(segment);
      }
      continue;
    }

    if (m.type !== "node" || !finitePair(m.lat, m.lon)) continue;
    const stop: RouteStop = { lat: m.lat as number, lng: m.lon as number };
    const name = typeof m.ref === "number" ? nameByNodeId.get(m.ref) : undefined;
    if (name) stop.name = name;
    // Dedup by node identity: a circular route revisits its terminus; one row
    // per place. Coordinate key when the ref is malformed.
    const key = typeof m.ref === "number" ? m.ref : `${stop.lat},${stop.lng}`;

    if (role.startsWith("stop")) {
      if (seenStopRefs.has(key) || stops.length >= MAX_ROUTE_STOPS) continue;
      seenStopRefs.add(key);
      stops.push(stop);
    } else if (role.startsWith("platform")) {
      if (seenPlatformRefs.has(key) || platformFallback.length >= MAX_ROUTE_STOPS) continue;
      seenPlatformRefs.add(key);
      platformFallback.push(stop);
    }
  }

  // Some PTv2 mappings have only platform nodes — better honest platform dots
  // than a bare line. Never mixed: stop-role positions win when present.
  return { segments, stops: stops.length ? stops : platformFallback };
}

/** RoutePath → GeoJSON features for one source: LineStrings (track) + Points
 * (stops, carrying `name` for a hover/inspect affordance). The layers split
 * them by `["geometry-type"]` (the isochrone per-layer pattern). */
export function buildRoutePathFeatures(path: RoutePath): GeoJSON.Feature[] {
  const lines: GeoJSON.Feature[] = path.segments.map((coordinates) => ({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates },
  }));
  const stops: GeoJSON.Feature[] = path.stops.map((s) => ({
    type: "Feature",
    properties: s.name ? { name: s.name } : {},
    geometry: { type: "Point", coordinates: [s.lng, s.lat] },
  }));
  return [...lines, ...stops];
}

/** Bounding box of everything drawable ([[minLng,minLat],[maxLng,maxLat]]),
 * or null for a degenerate path — the caller skips fitBounds rather than
 * flying to a broken box. */
export function routePathBounds(path: RoutePath): [[number, number], [number, number]] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const extend = (lng: number, lat: number) => {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  };
  for (const segment of path.segments) for (const [lng, lat] of segment) extend(lng, lat);
  for (const s of path.stops) extend(s.lng, s.lat);
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}
