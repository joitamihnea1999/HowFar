import { area } from "@turf/area";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { union } from "@turf/union";
import { contours } from "d3-contour";
import type { Feature, MultiPolygon, Polygon } from "geojson";

import { PACE_MODEL, STREET_DETOUR as PACE_STREET_DETOUR } from "@/features/isochrones/pace";
import { LAUNCH_BBOX } from "@/lib/bounds";

/**
 * Transit-isochrone geometry construction — pure and deterministic so it can be
 * unit-tested without any network or cache. No transit provider returns transit
 * isochrones, so we build them ourselves from the reachable stops Transitous
 * MOTIS reports (provider details: docs/PROVIDERS.md, Transitous section).
 *
 * Approach: rasterize a reachability field over the launch bounding box, then
 * extract 15/30/45-minute contours with marching squares (`d3-contour`).
 *   field(cell) = min over stops s of ( transit-minutes(s) + egress-minutes(s→cell) )
 *   (+ the origin's own radial walk access, ONLY when the caller has no
 *    street-routed walking isochrone to union in — see stampOrigin below)
 * The three rings are contours of ONE monotonic field, so nesting
 * (15 ⊆ 30 ⊆ 45) is guaranteed by construction for buildRings itself (no cap,
 * no union inside the field pass); the ONLY union is the separate unionRings
 * step below, whose all-or-nothing + superset guards keep the invariant.
 *
 * REALISM (calibrated 2026-07-17): egress from a stop is stamped radially, but
 * at a DETOUR-DEFLATED speed — crow-fly distance understates real street
 * distance by a measured median 1.402× in Bucharest, so stamping crow-fly
 * metres at the nominal walk speed painted ~2× too much area. This is a
 * calibrated approximation, not street routing: anisotropy (rivers, rail) is
 * documented in docs/PROVIDERS.md "Calibration", not modeled. The ORIGIN's
 * walk component is street-routed (boundary-calibrated ORS rings): transit.ts
 * unions them into the result and skips the radial origin stamp entirely.
 *
 * Why not buffer-and-union the reachable stops? On a real 2,509-stop payload
 * that took ~65 s (turf `union` of hundreds of overlapping discs on the request
 * event loop). This grid pass stays well under 300 ms for the same input.
 */

/** Pedestrian speed of the Normal pace (5 km/h) — the speed the ring LABELS
 * promise. DERIVED from `pace.ts`, never re-declared: until task 064 this
 * module carried its own `80` and `1.402` literals, a second speed model that
 * would have silently kept the pre-064 speed when the owner changed it. */
export const WALK_SPEED_M_PER_MIN = PACE_MODEL.normal.speedMPerMin;
/** Median street-network detour vs crow-fly in Bucharest — measured 2026-07-17
 * from 143 routed-vs-straight distance pairs at 6 diverse origins (MOTIS
 * one-to-many, withDistance): p25 1.29, median 1.402, p75 1.54, p90 1.82.
 * Re-exported from `pace.ts` so there is exactly one definition. */
export const STREET_DETOUR = PACE_STREET_DETOUR;
/** Effective radial egress speed at the NORMAL pace: r crow-fly metres ≈
 * r·STREET_DETOUR street metres, so stamping at speed/detour keeps the stamped
 * minutes honest. Not a default — `buildRings` requires an explicit
 * `egressMPerMin`; this is the named Normal-pace value for callers/tests. */
export const EGRESS_M_PER_MIN = PACE_MODEL.normal.egressMPerMin;
/** Reachability thresholds in minutes (ascending). */
export const THRESHOLDS = [15, 30, 45] as const;

const MAX_MIN = THRESHOLDS[THRESHOLDS.length - 1];
const CELL_M = 120; // grid resolution; smaller = smoother contours, more cells (perf-checked in tests)
const M_PER_DEG_LAT = 110540;
// Offset so `d3-contour` region {value ≥ BIG − T} maps to {reach-minutes ≤ T}.
const BIG = 1000;

export interface TransitStop {
  lat: number;
  lng: number;
  /** Minutes from the pinned departure to this stop (access walk + transit). */
  dur: number;
}

export interface Ring {
  minutes: number;
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
}

/**
 * Build the 15/30/45-minute transit reachability rings from an origin and the
 * set of reachable stops. Always returns exactly `THRESHOLDS.length` rings,
 * ascending; a threshold with no reachable area yields an empty MultiPolygon.
 *
 * `stampOrigin` (default true): radially stamp the origin's own walk access at
 * the calibrated egress speed. Pass false when the caller unions the
 * street-routed walking rings instead (transit.ts's normal path) — the radial
 * disc would only ADD over-claimed area the union cannot remove.
 *
 * `egressMPerMin` is REQUIRED: the radial egress/origin-walk speed. Task 051
 * threads the active pace here so stop egress (and the radial-fallback origin
 * stamp) scale with Slow/Normal in lockstep with the MOTIS access speed and the
 * unioned ORS ring — otherwise a paced request would show internally
 * inconsistent rings. It has NO default on purpose (task 064): a defaulted
 * Normal speed would let a future call site silently stamp Normal-pace egress
 * on a Slow request, which is exactly the drift class this module stopped
 * carrying when its duplicate speed constants were removed.
 */
export function buildRings(
  origin: { lat: number; lng: number },
  stops: TransitStop[],
  opts: { stampOrigin?: boolean; egressMPerMin: number },
): Ring[] {
  const egressMPerMin = opts.egressMPerMin;
  const mPerDegLng = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  const spanLng = LAUNCH_BBOX.maxLng - LAUNCH_BBOX.minLng;
  const spanLat = LAUNCH_BBOX.maxLat - LAUNCH_BBOX.minLat;
  const width = Math.max(2, Math.ceil((spanLng * mPerDegLng) / CELL_M));
  const height = Math.max(2, Math.ceil((spanLat * M_PER_DEG_LAT) / CELL_M));
  const dLng = spanLng / width;
  const dLat = spanLat / height;

  const grid = new Float64Array(width * height).fill(Infinity);

  // Stamp a walk source (a stop, or the origin at base 0) into every cell within
  // its remaining-walk radius, keeping the minimum reach-minutes per cell.
  const stamp = (lat: number, lng: number, baseMin: number) => {
    const remaining = MAX_MIN - baseMin;
    if (remaining <= 0) return;
    const maxR = remaining * egressMPerMin; // crow-fly metres of egress budget left
    const di = Math.ceil(maxR / (dLng * mPerDegLng));
    const dj = Math.ceil(maxR / (dLat * M_PER_DEG_LAT));
    const ci = Math.round((lng - LAUNCH_BBOX.minLng) / dLng - 0.5);
    const cj = Math.round((lat - LAUNCH_BBOX.minLat) / dLat - 0.5);
    const jLo = Math.max(0, cj - dj);
    const jHi = Math.min(height - 1, cj + dj);
    const iLo = Math.max(0, ci - di);
    const iHi = Math.min(width - 1, ci + di);
    for (let j = jLo; j <= jHi; j++) {
      const cellLat = LAUNCH_BBOX.minLat + (j + 0.5) * dLat;
      const dy = (cellLat - lat) * M_PER_DEG_LAT;
      for (let i = iLo; i <= iHi; i++) {
        const cellLng = LAUNCH_BBOX.minLng + (i + 0.5) * dLng;
        const dx = (cellLng - lng) * mPerDegLng;
        const val = baseMin + Math.hypot(dx, dy) / egressMPerMin;
        if (val > MAX_MIN) continue;
        const k = j * width + i;
        if (val < grid[k]) grid[k] = val;
      }
    }
  };

  if (opts?.stampOrigin !== false) stamp(origin.lat, origin.lng, 0);
  for (const s of stops) stamp(s.lat, s.lng, s.dur);

  // Invert so higher = closer, letting d3-contour's "≥ threshold" region be the
  // reachable area; unreachable cells sink to -Infinity (always outside).
  const field = Array.from(grid, (r) => (Number.isFinite(r) ? BIG - r : -Infinity));
  const contourSet = contours()
    .size([width, height])
    .thresholds(THRESHOLDS.map((t) => BIG - t))(field);

  // Clamp to the launch box so no vertex can escape the rendered tile extent
  // (matters only for an origin near the box edge; central origins never reach it).
  const clampLng = (v: number) => Math.min(LAUNCH_BBOX.maxLng, Math.max(LAUNCH_BBOX.minLng, v));
  const clampLat = (v: number) => Math.min(LAUNCH_BBOX.maxLat, Math.max(LAUNCH_BBOX.minLat, v));
  const toGeo = (multipoly: number[][][][]): number[][][][] =>
    multipoly.map((poly) =>
      poly.map((ring) =>
        // d3-contour vertices are in grid-index space; +0.5 puts them at cell centres.
        ring.map(([x, y]) => [
          clampLng(LAUNCH_BBOX.minLng + (x + 0.5) * dLng),
          clampLat(LAUNCH_BBOX.minLat + (y + 0.5) * dLat),
        ]),
      ),
    );

  const byMinutes = new Map<number, Ring>();
  for (const c of contourSet) {
    const minutes = Math.round(BIG - c.value);
    byMinutes.set(minutes, {
      minutes,
      geometry: { type: "MultiPolygon", coordinates: toGeo(c.coordinates) },
    });
  }

  return THRESHOLDS.map(
    (t): Ring =>
      byMinutes.get(t) ?? { minutes: t, geometry: { type: "MultiPolygon", coordinates: [] } },
  ).sort((a, b) => a.minutes - b.minutes);
}

/**
 * Minimum area (m²) a disconnected ring component must have to survive the
 * speck filter (task 052 C). Below this, a component is a visual artifact — a
 * scatter of tiny polygons around far stops reads as "the map is broken" on a
 * livability map, even though it is genuinely (barely) reachable. The right-click
 * "how do I get there?" popup (task 052 D) is what surfaces the real far pockets
 * that ARE substantial. Calibrated on real Bucharest addresses (see the task's C
 * checkpoint): specks measured well under this; the far-metro pockets (e.g. the
 * northern M2 area reachable from Berceni) measure far above it.
 */
export const MIN_TRANSIT_COMPONENT_AREA_M2 = 200_000; // ~0.2 km²; calibrated (task 052)

/**
 * Drop tiny disconnected components from each transit ring, keeping every
 * component of at least `minAreaM2` AND — always, however small — the component
 * containing the origin (so the user's own neighbourhood is never filtered out).
 *
 * Nesting (15⊆30⊆45) is preserved by a fixed threshold: a pocket's area only
 * grows with the threshold band (15's component ⊆ 30's ⊆ 45's), so if it clears
 * `minAreaM2` in a smaller band it clears it in every larger one; dropping it
 * from a smaller band only SHRINKS that band, never breaking containment. The
 * origin sits inside every band's origin-component, so it is kept in all three.
 * Pure + deterministic (no cache/network) — unit-tested including the geometric
 * nesting invariant.
 */
export function dropSmallComponents(
  rings: Ring[],
  origin: { lat: number; lng: number },
  minAreaM2: number = MIN_TRANSIT_COMPONENT_AREA_M2,
): Ring[] {
  const point: [number, number] = [origin.lng, origin.lat];
  return rings.map((ring) => {
    const polygons = ring.geometry.coordinates;
    if (!Array.isArray(polygons) || polygons.length === 0) return ring;
    const kept = polygons.filter((polygon) => {
      const feature: Feature<Polygon> = {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: polygon },
      };
      if (area(feature) >= minAreaM2) return true;
      // Always keep the origin's own component, however small.
      try {
        return booleanPointInPolygon(point, feature);
      } catch {
        return false;
      }
    });
    return { minutes: ring.minutes, geometry: { type: "MultiPolygon", coordinates: kept } };
  });
}

/** A walking ring as returned by the ORS provider (looser geometry typing). */
export interface WalkRing {
  minutes: number;
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
}

function isEmptyGeometry(coordinates: unknown): boolean {
  return !Array.isArray(coordinates) || coordinates.length === 0;
}

function toMultiPolygon(g: { type: "Polygon" | "MultiPolygon"; coordinates: unknown }): Ring["geometry"] {
  return g.type === "Polygon"
    ? { type: "MultiPolygon", coordinates: [g.coordinates as number[][][]] }
    : { type: "MultiPolygon", coordinates: g.coordinates as number[][][][] };
}

/**
 * Union each transit ring with the street-routed walking ring of the SAME
 * threshold, replacing the radial origin approximation with the walk geometry
 * (a walk of ≤T minutes is always a valid ≤T-minute transit journey, so the
 * union is semantically a superset-merge, and both families nest ⇒ the
 * outputs nest — GUARDED below, not assumed).
 *
 * ALL-OR-NOTHING: returns null if ANY threshold's merge fails (turf throw,
 * missing/mismatched walk ring, degenerate geometry, or a merged result whose
 * area shrank — a union must be a superset). A per-ring fallback would be
 * WRONG here: the caller skipped the radial origin stamp expecting the walk
 * geometry, so one failed ring would ship without any origin-walk area while
 * its neighbours have it — breaking nesting and possibly excluding the origin
 * from its own ring, then caching that for 7 days. On null the caller rebuilds
 * the whole family with the radial origin stamp instead.
 */
export function unionRings(transitRings: Ring[], walkRings: WalkRing[]): Ring[] | null {
  const out: Ring[] = [];
  for (const [i, ring] of transitRings.entries()) {
    const walk = walkRings[i];
    if (!walk || walk.minutes !== ring.minutes || isEmptyGeometry(walk.geometry?.coordinates)) {
      console.error(`[transit-grid] ring-${ring.minutes}: walk ring missing/empty — radial fallback`);
      return null;
    }
    try {
      const walkFeature = {
        type: "Feature",
        properties: {},
        geometry: walk.geometry as unknown,
      } as Feature<Polygon | MultiPolygon>;
      const walkArea = area(walkFeature); // also validates the walk geometry (throws on garbage)
      if (isEmptyGeometry(ring.geometry.coordinates)) {
        // No transit reach at this threshold — the walking area IS the reach.
        out.push({ minutes: ring.minutes, geometry: toMultiPolygon(walk.geometry) });
        continue;
      }
      const transitFeature = {
        type: "Feature",
        properties: {},
        geometry: ring.geometry,
      } as Feature<MultiPolygon>;
      const merged = union({ type: "FeatureCollection", features: [transitFeature, walkFeature] });
      if (!merged?.geometry) return null;
      // Superset guard: turf can fail SILENTLY on near-degenerate input,
      // returning valid-looking but smaller geometry. 1 m² of float slack.
      const mergedArea = area(merged);
      if (mergedArea + 1 < Math.max(area(transitFeature), walkArea)) {
        console.error(`[transit-grid] ring-${ring.minutes}: union shrank — radial fallback`);
        return null;
      }
      out.push({ minutes: ring.minutes, geometry: toMultiPolygon(merged.geometry) });
    } catch (err) {
      console.error(`[transit-grid] ring-${ring.minutes} union failed — radial fallback:`, err);
      return null;
    }
  }
  return out;
}
