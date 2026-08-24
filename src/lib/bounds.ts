/**
 * Launch scope is a SINGLE city (Bucharest today), config-driven since task 007.
 * The extent is lifted into `NEXT_PUBLIC_MAP_BBOX` = "minLng,minLat,maxLng,maxLat"
 * (build-time inlined, so it is available in both server and client bundles);
 * when unset it defaults to today's Bucharest+Ilfov box, keeping the current
 * deployment byte-identical. The tile extract `--bbox` in scripts/fetch-tiles.sh
 * and MapLibre's `maxBounds` read the SAME box — keep the three in sync via the
 * one env var.
 *
 * Isomorphic (no server-only deps): the server uses `inBucharest` to geofence
 * provider results; the client uses `BUCHAREST_MAX_BOUNDS` for `maxBounds`.
 *
 * Names stay `BUCHAREST_*` in Phase 1 (value is config-driven; a region-neutral
 * rename is deferred to the multi-city phase). The extent is a SINGLE city on
 * purpose: the transit grid allocates memory proportional to the bbox span
 * (transit-grid.ts), so an all-country box would OOM — hence the per-axis span
 * cap below.
 */

// A `type` (not `interface`) on purpose: an interface is not assignable to a
// string index signature, but this shape is stored in a Prisma JSON column
// (catalogue-import CatalogueValidation.source.bbox → InputJsonObject).
export type Bbox = {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
};

/** Widest span (degrees) allowed on either axis — a single-city guard. Bucharest
 *  is ~0.6°×0.5°; 2° leaves generous metro headroom while blocking an
 *  all-Romania (~7°×4°) box that would OOM the transit grid. */
export const MAX_BBOX_SPAN_DEG = 2;

const DEFAULT_BBOX: Bbox = {
  minLng: 25.8,
  minLat: 44.2,
  maxLng: 26.4,
  maxLat: 44.7,
};

/**
 * Parse "minLng,minLat,maxLng,maxLat" into a valid Bbox, or return null if it is
 * malformed: wrong arity, non-finite, mis-ordered (min ≥ max), outside world
 * range, or a span beyond the single-city cap. Pure — no env, never throws — so
 * it is directly unit-testable.
 */
export function parseBbox(raw: string | undefined | null): Bbox | null {
  if (raw == null) return null;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLng, minLat, maxLng, maxLat] = parts as [number, number, number, number];
  if (minLng >= maxLng || minLat >= maxLat) return null;
  if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) return null;
  if (maxLng - minLng > MAX_BBOX_SPAN_DEG || maxLat - minLat > MAX_BBOX_SPAN_DEG) return null;
  return { minLng, minLat, maxLng, maxLat };
}

function resolveBbox(): Bbox {
  const raw = process.env.NEXT_PUBLIC_MAP_BBOX?.trim();
  if (!raw) return DEFAULT_BBOX; // absent → today's Bucharest box (byte-identical)
  const parsed = parseBbox(raw);
  if (!parsed) {
    // Fail-closed: a SET-but-invalid extent must NOT silently fall back to
    // Bucharest (a Cluj deploy would then map the wrong city). NEXT_PUBLIC_* is
    // build-time inlined, so this surfaces at build, before any deploy.
    throw new Error(
      `Invalid NEXT_PUBLIC_MAP_BBOX "${raw}": expected "minLng,minLat,maxLng,maxLat", ` +
        `ordered min<max, within world range, span ≤ ${MAX_BBOX_SPAN_DEG}° per axis (single-city).`,
    );
  }
  return parsed;
}

export const BUCHAREST_BBOX: Bbox = resolveBbox();

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
