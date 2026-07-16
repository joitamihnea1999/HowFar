/**
 * Launch scope is Bucharest (brief §11). We reuse the exact bounding box of the
 * self-hosted tile extract (Bucharest + Ilfov — the `--bbox` in
 * scripts/fetch-tiles.sh; keep the two in sync) so the map, the geocoder
 * geofence, and the isochrone origin all agree on "in area".
 *
 * Isomorphic (no server-only deps): the server uses `inBucharest` to geofence
 * provider results; the client uses `BUCHAREST_MAX_BOUNDS` for `maxBounds`.
 */
export const BUCHAREST_BBOX = {
  minLng: 25.8,
  minLat: 44.2,
  maxLng: 26.4,
  maxLat: 44.7,
} as const;

export function inBucharest(lat: number, lng: number): boolean {
  return (
    lat >= BUCHAREST_BBOX.minLat &&
    lat <= BUCHAREST_BBOX.maxLat &&
    lng >= BUCHAREST_BBOX.minLng &&
    lng <= BUCHAREST_BBOX.maxLng
  );
}

/** MapLibre `maxBounds` shape: [[west, south], [east, north]]. */
export const BUCHAREST_MAX_BOUNDS: [[number, number], [number, number]] = [
  [BUCHAREST_BBOX.minLng, BUCHAREST_BBOX.minLat],
  [BUCHAREST_BBOX.maxLng, BUCHAREST_BBOX.maxLat],
];
