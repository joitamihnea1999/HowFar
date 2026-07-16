import { contours } from "d3-contour";

import { BUCHAREST_BBOX } from "@/lib/bounds";

/**
 * Transit-isochrone geometry construction — pure and deterministic so it can be
 * unit-tested without any network or cache. No transit provider returns transit
 * isochrones, so we build them ourselves from the reachable stops Transitous
 * MOTIS reports (provider details: docs/PROVIDERS.md, Transitous section).
 *
 * Approach: rasterize a reachability field over the launch bounding box, then
 * extract 15/30/45-minute contours with marching squares (`d3-contour`).
 *   field(cell) = min( walk-minutes from origin,
 *                      min over stops s of ( transit-minutes(s) + walk-minutes(s→cell) ) )
 * The three rings are contours of ONE monotonic field, so nesting
 * (15 ⊆ 30 ⊆ 45) is guaranteed by construction — no polygon union, no cap.
 *
 * Why not buffer-and-union the reachable stops? On a real 2,509-stop payload
 * that took ~65 s (turf `union` of hundreds of overlapping discs on the request
 * event loop). This grid pass is ~40 ms for the same input. The origin's
 * walk-access is a straight-line radial (not street-routed like the ORS walk
 * isochrone); the contour smoothing blends it into the field so it reads as an
 * organic reachable area rather than a hard circle.
 */

/** Pedestrian speed for access/egress walking (~4.8 km/h; ORS foot default ~5 km/h). */
export const WALK_SPEED_M_PER_MIN = 80;
/** Reachability thresholds in minutes (ascending). */
export const THRESHOLDS = [15, 30, 45] as const;

const MAX_MIN = THRESHOLDS[THRESHOLDS.length - 1];
const CELL_M = 175; // grid resolution; smaller = smoother contours, more cells
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
 */
export function buildRings(origin: { lat: number; lng: number }, stops: TransitStop[]): Ring[] {
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
    const maxR = remaining * WALK_SPEED_M_PER_MIN; // metres of egress walk left
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
        const val = baseMin + Math.hypot(dx, dy) / WALK_SPEED_M_PER_MIN;
        if (val > MAX_MIN) continue;
        const k = j * width + i;
        if (val < grid[k]) grid[k] = val;
      }
    }
  };

  stamp(origin.lat, origin.lng, 0);
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
