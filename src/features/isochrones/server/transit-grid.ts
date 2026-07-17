import { area } from "@turf/area";
import { union } from "@turf/union";
import { contours } from "d3-contour";
import type { Feature, MultiPolygon, Polygon } from "geojson";

import { BUCHAREST_BBOX } from "@/lib/bounds";

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

/** Nominal pedestrian speed (~4.8 km/h) — the speed the ring LABELS promise. */
export const WALK_SPEED_M_PER_MIN = 80;
/** Median street-network detour vs crow-fly in Bucharest — measured 2026-07-17
 * from 143 routed-vs-straight distance pairs at 6 diverse origins (MOTIS
 * one-to-many, withDistance): p25 1.29, median 1.402, p75 1.54, p90 1.82. */
export const STREET_DETOUR = 1.402;
/** Effective radial egress speed: r crow-fly metres ≈ r·STREET_DETOUR street
 * metres, so stamping at speed/detour keeps the stamped minutes honest. */
export const EGRESS_M_PER_MIN = WALK_SPEED_M_PER_MIN / STREET_DETOUR;
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
 */
export function buildRings(
  origin: { lat: number; lng: number },
  stops: TransitStop[],
  opts?: { stampOrigin?: boolean },
): Ring[] {
  const mPerDegLng = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  const spanLng = BUCHAREST_BBOX.maxLng - BUCHAREST_BBOX.minLng;
  const spanLat = BUCHAREST_BBOX.maxLat - BUCHAREST_BBOX.minLat;
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
    const maxR = remaining * EGRESS_M_PER_MIN; // crow-fly metres of egress budget left
    const di = Math.ceil(maxR / (dLng * mPerDegLng));
    const dj = Math.ceil(maxR / (dLat * M_PER_DEG_LAT));
    const ci = Math.round((lng - BUCHAREST_BBOX.minLng) / dLng - 0.5);
    const cj = Math.round((lat - BUCHAREST_BBOX.minLat) / dLat - 0.5);
    const jLo = Math.max(0, cj - dj);
    const jHi = Math.min(height - 1, cj + dj);
    const iLo = Math.max(0, ci - di);
    const iHi = Math.min(width - 1, ci + di);
    for (let j = jLo; j <= jHi; j++) {
      const cellLat = BUCHAREST_BBOX.minLat + (j + 0.5) * dLat;
      const dy = (cellLat - lat) * M_PER_DEG_LAT;
      for (let i = iLo; i <= iHi; i++) {
        const cellLng = BUCHAREST_BBOX.minLng + (i + 0.5) * dLng;
        const dx = (cellLng - lng) * mPerDegLng;
        const val = baseMin + Math.hypot(dx, dy) / EGRESS_M_PER_MIN;
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
  const clampLng = (v: number) => Math.min(BUCHAREST_BBOX.maxLng, Math.max(BUCHAREST_BBOX.minLng, v));
  const clampLat = (v: number) => Math.min(BUCHAREST_BBOX.maxLat, Math.max(BUCHAREST_BBOX.minLat, v));
  const toGeo = (multipoly: number[][][][]): number[][][][] =>
    multipoly.map((poly) =>
      poly.map((ring) =>
        // d3-contour vertices are in grid-index space; +0.5 puts them at cell centres.
        ring.map(([x, y]) => [
          clampLng(BUCHAREST_BBOX.minLng + (x + 0.5) * dLng),
          clampLat(BUCHAREST_BBOX.minLat + (y + 0.5) * dLat),
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
