/**
 * Launch scope is a SINGLE city (Bucharest today), config-driven since task 007.
 * The extent is lifted into `NEXT_PUBLIC_MAP_BBOX` = "minLng,minLat,maxLng,maxLat"
 * (build-time inlined, so it is available in both server and client bundles);
 * when unset it defaults to today's Bucharest+Ilfov box, keeping the current
 * deployment byte-identical. The tile extract `--bbox` in scripts/fetch-tiles.sh
 * and MapLibre's `maxBounds` read the SAME box — keep the three in sync via the
 * one env var.
 *
 * Isomorphic (no server-only deps): the server uses `inLaunchArea` to geofence
 * provider results; the client uses `LAUNCH_MAX_BOUNDS` for `maxBounds`.
 *
 * Names are region-neutral (`LAUNCH_*`) since task 013: the launch area is one
 * city today but the VALUE is config-driven, so `BUCHAREST_*` was renamed to stop
 * implying a hardcoded city. The extent is a SINGLE city on
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

/** Today's Bucharest+Ilfov box — the byte-identical default when the extent env
 *  is unset. Exported so the cache-tag can tell "default extent" from "another
 *  city" off the RESOLVED box (not a raw env string). */
export const DEFAULT_BBOX: Bbox = {
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
  const tokens = raw.split(",").map((s) => s.trim());
  // Reject empty tokens BEFORE Number() — `Number("")` is 0, so "-1,,1,1" would
  // otherwise slip through as [-1,0,1,1].
  if (tokens.length !== 4 || tokens.some((t) => t === "")) return null;
  const parts = tokens.map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const [minLng, minLat, maxLng, maxLat] = parts as [number, number, number, number];
  if (minLng >= maxLng || minLat >= maxLat) return null;
  if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) return null;
  if (maxLng - minLng > MAX_BBOX_SPAN_DEG || maxLat - minLat > MAX_BBOX_SPAN_DEG) return null;
  return { minLng, minLat, maxLng, maxLat };
}

function resolveBbox(): Bbox {
  const rawEnv = process.env.NEXT_PUBLIC_MAP_BBOX;
  if (rawEnv === undefined) return DEFAULT_BBOX; // absent → today's Bucharest box (byte-identical)
  const raw = rawEnv.trim();
  if (raw === "") {
    // Present-but-blank is a mistake, not "use the default" — fail closed so a
    // stray NEXT_PUBLIC_MAP_BBOX= doesn't silently ship the wrong (default) city.
    throw new Error("NEXT_PUBLIC_MAP_BBOX is set but blank — unset it entirely to use the default extent.");
  }
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

export const LAUNCH_BBOX: Bbox = resolveBbox();

export function inLaunchArea(lat: number, lng: number): boolean {
  return (
    lat >= LAUNCH_BBOX.minLat &&
    lat <= LAUNCH_BBOX.maxLat &&
    lng >= LAUNCH_BBOX.minLng &&
    lng <= LAUNCH_BBOX.maxLng
  );
}

/** MapLibre `maxBounds` shape: [[west, south], [east, north]]. */
export const LAUNCH_MAX_BOUNDS: [[number, number], [number, number]] = [
  [LAUNCH_BBOX.minLng, LAUNCH_BBOX.minLat],
  [LAUNCH_BBOX.maxLng, LAUNCH_BBOX.maxLat],
];

/**
 * Coerce an unknown value (e.g. a Bbox read back from a Prisma `Json` column)
 * into a Bbox, or null if it is not one. Unlike `parseBbox` this takes an OBJECT
 * (not a comma string) and does NOT enforce ordering or the single-city span cap —
 * it validates a STORED box for shape/finiteness only, leaving "is this the right
 * region" to `bboxesEqual`. Pure, never throws.
 */
export function coerceBbox(value: unknown): Bbox | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const { minLng, minLat, maxLng, maxLat } = v;
  if (
    !Number.isFinite(minLng) ||
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLng) ||
    !Number.isFinite(maxLat)
  ) {
    return null;
  }
  return {
    minLng: minLng as number,
    minLat: minLat as number,
    maxLng: maxLng as number,
    maxLat: maxLat as number,
  };
}

/**
 * Exact equality of two boxes (null/undefined ⇒ not equal). Used to decide whether
 * an active amenity dataset's recorded import bbox matches the resolved runtime
 * extent (task 013).
 *
 * Exact — not epsilon — comparison is correct here and was verified empirically:
 * the recorded bbox originates from the same `DEFAULT_BBOX` literal / same
 * `NEXT_PUBLIC_MAP_BBOX` env as `LAUNCH_BBOX`, and probing local PostGIS showed the
 * four default values (25.8 / 44.2 / 26.4 / 44.7) round-trip through the JSONB
 * `Json` column byte-exact (text stays "25.8", `::float8` equals the literal). A
 * genuine region change differs by whole degrees, never by float noise.
 */
export function bboxesEqual(a: Bbox | null | undefined, b: Bbox | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.minLng === b.minLng &&
    a.minLat === b.minLat &&
    a.maxLng === b.maxLng &&
    a.maxLat === b.maxLat
  );
}
