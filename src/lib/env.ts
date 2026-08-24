/**
 * Typed, validated access to server-side environment variables.
 *
 * Required vars are read lazily (at request time, not import/build time) so
 * `next build` succeeds on machines without a database or secrets.
 * Secrets must never be re-exported under NEXT_PUBLIC_*.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import { BUCHAREST_BBOX, DEFAULT_BBOX } from "./bounds";

export interface ServerEnv {
  /** PostgreSQL connection string, e.g. postgresql://user:pass@host:5432/db */
  databaseUrl: string;
  /** Auth.js JWT/session encryption secret — required at runtime, even without OAuth. */
  authSecret: string;
  /** OAuth client credentials — optional; sign-in is hidden when a pair is absent. */
  googleClientId?: string;
  googleClientSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  /** OpenRouteService key (server-side only) — optional until isochrone features land. */
  orsApiKey?: string;
}

export class EnvError extends Error {
  constructor(variable: string, hint: string) {
    super(`Missing or invalid environment variable ${variable}: ${hint}`);
    this.name = "EnvError";
  }
}

/**
 * Plain record instead of NodeJS.ProcessEnv: Next's typed-env augmentation
 * makes ProcessEnv strict (NODE_ENV required) depending on build state, which
 * would make callers/tests type-check differently before vs after a build.
 */
export type EnvSource = Record<string, string | undefined>;

function required(source: EnvSource, name: string, hint: string): string {
  const value = source[name]?.trim();
  if (!value) throw new EnvError(name, hint);
  return value;
}

/**
 * Exported so build-time-safe callers (e.g. configuredProviders) share the
 * exact same present/absent semantics as parseServerEnv — a whitespace-only
 * var must never count as configured in one place and absent in another.
 */
export function optionalEnv(source: EnvSource, name: string): string | undefined {
  const value = source[name]?.trim();
  return value ? value : undefined;
}

const optional = optionalEnv;

export function parseServerEnv(source: EnvSource = process.env): ServerEnv {
  const databaseUrl = required(
    source,
    "DATABASE_URL",
    'expected a PostgreSQL connection string like "postgresql://user:pass@host:5432/db"',
  );
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new EnvError(
      "DATABASE_URL",
      `must start with postgresql:// or postgres:// (got "${databaseUrl.slice(0, 12)}…")`,
    );
  }
  return {
    databaseUrl,
    authSecret: required(
      source,
      "AUTH_SECRET",
      "generate one with `npx auth secret` or `openssl rand -base64 32`",
    ),
    googleClientId: optional(source, "AUTH_GOOGLE_ID"),
    googleClientSecret: optional(source, "AUTH_GOOGLE_SECRET"),
    githubClientId: optional(source, "AUTH_GITHUB_ID"),
    githubClientSecret: optional(source, "AUTH_GITHUB_SECRET"),
    orsApiKey: optional(source, "ORS_API_KEY"),
  };
}

let cached: ServerEnv | undefined;

/** Lazy, memoized accessor — call inside handlers, never at module top level. */
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv();
  return cached;
}

// ─────────────────────────────────────────────────────────────────────────────
// Region / self-host configuration (Phase 1 config lift, task 007).
//
// Every remote-provider host and the tile path is lifted here as an OPTIONAL env
// var, each DEFAULTING to today's public value — so an unset environment is
// byte-for-byte identical to the pre-lift build, and pointing at a self-hosted
// instance (or a different Romanian city) becomes an `.env` edit rather than a
// code change. Read via `providerConfig()` — deliberately NON-memoized and
// SEPARATE from `serverEnv()` so provider clients never gain a dependency on the
// required DATABASE_URL / AUTH_SECRET (they only need these optional knobs).
//
// Fail-closed (mirrors `required()`): an ABSENT var falls back to the default; a
// var that is SET but invalid (unparseable/non-http(s) URL, empty endpoint pool)
// throws EnvError — a typo becomes a startup error, never a silent bad fetch.
// ─────────────────────────────────────────────────────────────────────────────

/** Built-in defaults == today's public providers. Exported so tests assert the
 *  default path against the exact literals (byte-identity is the whole task). */
export const PROVIDER_DEFAULTS = {
  nominatimBase: "https://nominatim.openstreetmap.org",
  photonBase: "https://photon.komoot.io/api",
  orsBase: "https://api.openrouteservice.org",
  transitBase: "https://api.transitous.org",
  // Interactive Overpass race pool (route/stop queries) — ordered by observed
  // reliability; racing means a dead host costs nothing.
  overpassEndpoints: [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ],
  // Bulk importer pool (heavy whole-bbox query) — the two hosts that tolerate it.
  bulkOverpassEndpoints: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ],
} as const;

/** Default tile archive location, relative to cwd, joined server-side. */
export const TILES_PATH_DEFAULT_SEGMENTS = ["data", "tiles", "bucharest.pmtiles"] as const;

export interface ProviderConfig {
  /** Base URL (no trailing slash); the client appends provider-version paths. */
  nominatimBase: string;
  photonBase: string;
  orsBase: string;
  /** One host feeds both MOTIS endpoints (one-to-all + plan). */
  transitBase: string;
  overpassEndpoints: string[];
  bulkOverpassEndpoints: string[];
}

/** Validate a single base URL: trailing slash stripped, must parse as an
 *  absolute http(s) URL. Used for both single bases and each pool member. */
function validateBaseUrl(name: string, raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new EnvError(name, `must be a valid absolute URL (got "${raw.slice(0, 40)}")`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EnvError(name, `must use http:// or https:// (got "${url.protocol}")`);
  }
  // A base URL is path-concatenated by clients (`${base}/v2/…`), so a query or
  // fragment would land in the wrong place (`https://h?x=1` + `/v2` → path `/`,
  // query `x=1/v2`). Reject them; a path prefix (`https://h/osm`) is fine.
  if (url.search || url.hash) {
    throw new EnvError(name, `must not include a query string or fragment (got "${raw.slice(0, 40)}")`);
  }
  return trimmed;
}

/** Absent → default; present → validated (fail-closed). */
function baseUrl(source: EnvSource, name: string, fallback: string): string {
  const raw = optionalEnv(source, name);
  return raw === undefined ? fallback : validateBaseUrl(name, raw);
}

/** A comma/space-separated endpoint pool. Absent → default; present → split,
 *  drop empties, validate each, and reject an empty result (fail-closed). */
function endpointPool(source: EnvSource, name: string, fallback: readonly string[]): string[] {
  const raw = optionalEnv(source, name);
  if (raw === undefined) return [...fallback];
  const parts = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new EnvError(name, "must list at least one endpoint URL");
  return parts.map((p) => validateBaseUrl(name, p));
}

/** Parse provider config from a source. Pure (no process.env), so tests inject. */
export function parseProviderConfig(source: EnvSource = process.env): ProviderConfig {
  return {
    nominatimBase: baseUrl(source, "NOMINATIM_BASE_URL", PROVIDER_DEFAULTS.nominatimBase),
    photonBase: baseUrl(source, "PHOTON_BASE_URL", PROVIDER_DEFAULTS.photonBase),
    orsBase: baseUrl(source, "ORS_BASE_URL", PROVIDER_DEFAULTS.orsBase),
    transitBase: baseUrl(source, "TRANSIT_BASE_URL", PROVIDER_DEFAULTS.transitBase),
    overpassEndpoints: endpointPool(source, "OVERPASS_ENDPOINTS", PROVIDER_DEFAULTS.overpassEndpoints),
    bulkOverpassEndpoints: endpointPool(
      source,
      "OVERPASS_BULK_ENDPOINTS",
      PROVIDER_DEFAULTS.bulkOverpassEndpoints,
    ),
  };
}

/** Provider config accessor. NON-memoized on purpose: call it INSIDE request
 *  handlers so an override (or a test's `vi.stubEnv`) always takes effect — a
 *  module-top-level const would freeze at import/build time. Parsing is a few
 *  string ops, dwarfed by the network call it precedes. */
export function providerConfig(source: EnvSource = process.env): ProviderConfig {
  return parseProviderConfig(source);
}

/** Server-side resolved path to the tile archive. Absolute override used as-is;
 *  a relative override (or the default) is joined against cwd. */
export function tilesPmtilesPath(source: EnvSource = process.env): string {
  const override = optionalEnv(source, "TILES_PMTILES_PATH");
  if (override) return path.isAbsolute(override) ? override : path.join(process.cwd(), override);
  return path.join(process.cwd(), ...TILES_PATH_DEFAULT_SEGMENTS);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * A short cache-key namespace that is the EMPTY STRING when the resolved
 * provider/region config equals the built-in defaults (so default keys stay
 * byte-identical and the existing multi-day ApiCache keeps serving) and a stable
 * 8-char hash otherwise. Prepended to every ApiCache provider key so flipping a
 * provider host or the city bbox serves a FRESH namespace instead of answers
 * computed against the old provider/region (keys carry no host/bbox themselves).
 *
 * "Default" means every provider var is unset AND the resolved extent equals
 * the Bucharest default. The bbox component is taken from the RESOLVED
 * `BUCHAREST_BBOX` (imported from bounds.ts), NOT a raw runtime read of
 * `NEXT_PUBLIC_MAP_BBOX`: that var is build-time inlined, so a dynamic
 * `process.env` read would be undefined in a build-ARG container and wrongly
 * yield tag "" for a non-default city — serving city A's cached answers for city
 * B. Reading the resolved box keeps the tag consistent with the geofence.
 *
 * The tag is uniform (one tag for all providers), so any config change colds all
 * provider caches together; config changes are rare deploy events and a cold
 * cache is "slower but correct" — the degradation posture the app already
 * commits to.
 */
export function configCacheTag(source: EnvSource = process.env): string {
  const cfg = parseProviderConfig(source);
  const bboxIsDefault =
    BUCHAREST_BBOX.minLng === DEFAULT_BBOX.minLng &&
    BUCHAREST_BBOX.minLat === DEFAULT_BBOX.minLat &&
    BUCHAREST_BBOX.maxLng === DEFAULT_BBOX.maxLng &&
    BUCHAREST_BBOX.maxLat === DEFAULT_BBOX.maxLat;
  const isDefault =
    cfg.nominatimBase === PROVIDER_DEFAULTS.nominatimBase &&
    cfg.photonBase === PROVIDER_DEFAULTS.photonBase &&
    cfg.orsBase === PROVIDER_DEFAULTS.orsBase &&
    cfg.transitBase === PROVIDER_DEFAULTS.transitBase &&
    sameList(cfg.overpassEndpoints, PROVIDER_DEFAULTS.overpassEndpoints) &&
    sameList(cfg.bulkOverpassEndpoints, PROVIDER_DEFAULTS.bulkOverpassEndpoints) &&
    bboxIsDefault;
  if (isDefault) return "";
  const canonical = JSON.stringify({
    n: cfg.nominatimBase,
    p: cfg.photonBase,
    o: cfg.orsBase,
    t: cfg.transitBase,
    ov: cfg.overpassEndpoints,
    bo: cfg.bulkOverpassEndpoints,
    b: [BUCHAREST_BBOX.minLng, BUCHAREST_BBOX.minLat, BUCHAREST_BBOX.maxLng, BUCHAREST_BBOX.maxLat],
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}

/** Prefix a provider cache key with the config tag (no-op on default config). */
export function taggedCacheKey(baseKey: string, source: EnvSource = process.env): string {
  const tag = configCacheTag(source);
  return tag ? `${tag}:${baseKey}` : baseKey;
}
