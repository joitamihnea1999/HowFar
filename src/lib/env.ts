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
  // Host base only (the client appends Photon's `/api` search path), so all four
  // *_BASE_URL vars share one contract: a bare host, paths live in code.
  photonBase: "https://photon.komoot.io",
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

/**
 * Per-provider rate-limit spacing (min ms between upstream calls to the same
 * provider bucket), lifted out of the client modules (task 009) so a self-host
 * operator — who owns the box and has no public ToS — can retune or disable
 * throttling per provider. Each default is the client's original value and the
 * rationale that used to sit next to it:
 *   - nominatim 1100 → OSM ToS ≤1 req/s, with margin
 *   - photon    300  → komoot public; gentle spacing
 *   - ors       1500 → free tier ~40 isochrone req/min ⇒ ≥1.5 s (PROVIDERS.md)
 *   - transit   1500 → community-run MOTIS; be a good citizen (one-to-all + plan share it)
 *   - overpass  1100 → fair-use per host (interactive pool)
 * `0` disables the throttle entirely (see `withRateLimit`: it bypasses the
 * serialize-chain at ≤0). Unset ⇒ these exact defaults ⇒ byte-identical to pre-lift.
 */
export const PROVIDER_INTERVAL_DEFAULTS = {
  nominatim: 1100,
  photon: 300,
  ors: 1500,
  transit: 1500,
  overpass: 1100,
} as const;

export interface ProviderConfig {
  /** Base URL (no trailing slash); the client appends provider-version paths. */
  nominatimBase: string;
  photonBase: string;
  orsBase: string;
  /** One host feeds both MOTIS endpoints (one-to-all + plan). */
  transitBase: string;
  overpassEndpoints: string[];
  bulkOverpassEndpoints: string[];
  /** Per-provider rate-limit spacing in ms (0 = no throttle). Timing only —
   *  deliberately NOT part of `configCacheTag` (it never changes response content). */
  intervals: {
    nominatim: number;
    photon: number;
    ors: number;
    transit: number;
    overpass: number;
  };
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

/** ABSENT (key unset) → default; PRESENT-but-blank → EnvError; else validated.
 *  A blank value is a mistake, not "use the default": for the commercial
 *  self-host boundary a stray `ORS_BASE_URL=` must not silently fall back to a
 *  public provider — fail closed and make the operator unset it deliberately. */
function baseUrl(source: EnvSource, name: string, fallback: string): string {
  const raw = source[name];
  if (raw === undefined) return fallback;
  if (raw.trim() === "") {
    throw new EnvError(name, "is set but blank — unset it entirely to use the default");
  }
  return validateBaseUrl(name, raw);
}

/** A comma/space-separated endpoint pool. ABSENT → default; PRESENT-but-empty
 *  (blank or only separators) → EnvError; else split, validate each. */
function endpointPool(source: EnvSource, name: string, fallback: readonly string[]): string[] {
  const raw = source[name];
  if (raw === undefined) return [...fallback];
  const parts = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new EnvError(name, "is set but lists no endpoint URL — unset it entirely to use the default");
  }
  return parts.map((p) => validateBaseUrl(name, p));
}

/** A non-negative integer count of milliseconds. ABSENT → default;
 *  PRESENT-but-blank → EnvError; non-integer or negative → EnvError; `0` is
 *  allowed and means "no throttle" (a self-host with no ToS limit). Fail-closed
 *  like `baseUrl` — a typo becomes a startup error, never a silent bad interval. */
function intervalMs(source: EnvSource, name: string, fallback: number): number {
  const raw = source[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new EnvError(name, "is set but blank — unset it entirely to use the default");
  }
  const n = Number(trimmed);
  // Upper bound = Node's max setTimeout delay (2^31−1 ms). A larger value would
  // be silently CLAMPED to 1 ms by setTimeout (defeating the throttle), so reject
  // it loudly instead (task 009). ~24.8 days is already absurd for
  // a rate-limit interval, so the ceiling costs no real config range.
  const MAX_TIMER_MS = 2_147_483_647;
  if (!Number.isInteger(n) || n < 0 || n > MAX_TIMER_MS) {
    throw new EnvError(
      name,
      `must be an integer between 0 and ${MAX_TIMER_MS} milliseconds (got "${raw.slice(0, 40)}")`,
    );
  }
  return n;
}

/** Host in the canonical form used for public-provider detection: lowercased,
 *  with a single trailing DNS root dot stripped. `EXAMPLE.org`, `example.org`,
 *  and `example.org.` all resolve to the same service but WHATWG `URL.host`
 *  keeps them distinct — canonicalize so a case/trailing-dot variant can neither
 *  evade public-host detection nor split a rate-limit bucket (task 009). */
export function canonicalHost(rawUrl: string): string {
  return new URL(rawUrl).host.toLowerCase().replace(/\.$/, "");
}

/** True when `base` resolves to the same host as `defaultBase` — i.e. it still
 *  points at the public provider (case-, port-, and trailing-dot-insensitive). */
function isPublicHost(base: string, defaultBase: string): boolean {
  return canonicalHost(base) === canonicalHost(defaultBase);
}

/**
 * Fail closed when a single-base provider still points at a PUBLIC host but over
 * cleartext `http:` (task 009). For ORS this would transmit the secret key in
 * the clear; for all four it is a misconfiguration that otherwise degrades
 * silently (keyless/blocked request → runtime 502 while `/api/ready` stays
 * green). Rejecting at parse turns it into a loud healthcheck failure. A
 * self-hosted host (not a public default) may use http on a trusted network.
 */
function assertNoHttpOnPublicHost(cfg: ProviderConfig): void {
  const singleBases: Array<[string, string, string]> = [
    ["NOMINATIM_BASE_URL", cfg.nominatimBase, PROVIDER_DEFAULTS.nominatimBase],
    ["PHOTON_BASE_URL", cfg.photonBase, PROVIDER_DEFAULTS.photonBase],
    ["ORS_BASE_URL", cfg.orsBase, PROVIDER_DEFAULTS.orsBase],
    ["TRANSIT_BASE_URL", cfg.transitBase, PROVIDER_DEFAULTS.transitBase],
  ];
  for (const [name, base, dflt] of singleBases) {
    if (canonicalHost(base) === canonicalHost(dflt) && new URL(base).protocol !== "https:") {
      throw new EnvError(name, "must use https:// for the public provider host (http would send/expose over cleartext)");
    }
  }
  // Same rule for the Overpass pools (sibling-path class): an http endpoint whose
  // canonical host is a known public Overpass host must also fail closed.
  const publicOverpassHosts = new Set(
    [...PROVIDER_DEFAULTS.overpassEndpoints, ...PROVIDER_DEFAULTS.bulkOverpassEndpoints].map(canonicalHost),
  );
  for (const [name, pool] of [
    ["OVERPASS_ENDPOINTS", cfg.overpassEndpoints],
    ["OVERPASS_BULK_ENDPOINTS", cfg.bulkOverpassEndpoints],
  ] as const) {
    for (const ep of pool) {
      if (publicOverpassHosts.has(canonicalHost(ep)) && new URL(ep).protocol !== "https:") {
        throw new EnvError(name, `must use https:// for the public Overpass host "${canonicalHost(ep)}" (http would expose traffic over cleartext)`);
      }
    }
  }
}

/**
 * Safety guard (task 009): you may only RELAX a provider's rate
 * limit below its ToS-safe default when you actually self-host that provider.
 * Setting e.g. `NOMINATIM_MIN_INTERVAL_MS=0` while `NOMINATIM_BASE_URL` is still
 * the public default would let the LIVE deployment exceed OSM's ≤1 req/s and get
 * the product's IP blocked — with no other warning. Fail closed: throw so the
 * operator must ALSO point the base at their own instance. Raising the interval
 * (more throttle) is always allowed; overpass keys off its interactive pool.
 */
function assertPublicThrottleFloor(cfg: ProviderConfig): void {
  // Overpass shares ONE interval across a POOL: the floor must apply if the pool
  // contains ANY public host (pinning/reordering/subsetting the default mirrors
  // must NOT bypass it), so key off per-endpoint membership, not whole-list
  // equality — matching one surviving public host is enough to hit fair-use.
  // Membership is tested over the INTERACTIVE `overpassEndpoints` only — the
  // interval governs just that client; the weekly bulk importer uses raw fetch
  // (no bucket/interval), so a public `bulkOverpassEndpoints` is intentionally
  // irrelevant to this floor (the http-on-public guard above still covers bulk).
  const defaultOverpassHosts = new Set(
    [...PROVIDER_DEFAULTS.overpassEndpoints, ...PROVIDER_DEFAULTS.bulkOverpassEndpoints].map(canonicalHost),
  );
  const overpassTouchesPublic = cfg.overpassEndpoints.some((u) =>
    defaultOverpassHosts.has(canonicalHost(u)),
  );
  const checks: Array<[string, boolean, number, number]> = [
    ["NOMINATIM_MIN_INTERVAL_MS", isPublicHost(cfg.nominatimBase, PROVIDER_DEFAULTS.nominatimBase), cfg.intervals.nominatim, PROVIDER_INTERVAL_DEFAULTS.nominatim],
    ["PHOTON_MIN_INTERVAL_MS", isPublicHost(cfg.photonBase, PROVIDER_DEFAULTS.photonBase), cfg.intervals.photon, PROVIDER_INTERVAL_DEFAULTS.photon],
    ["ORS_MIN_INTERVAL_MS", isPublicHost(cfg.orsBase, PROVIDER_DEFAULTS.orsBase), cfg.intervals.ors, PROVIDER_INTERVAL_DEFAULTS.ors],
    ["TRANSIT_MIN_INTERVAL_MS", isPublicHost(cfg.transitBase, PROVIDER_DEFAULTS.transitBase), cfg.intervals.transit, PROVIDER_INTERVAL_DEFAULTS.transit],
    ["OVERPASS_MIN_INTERVAL_MS", overpassTouchesPublic, cfg.intervals.overpass, PROVIDER_INTERVAL_DEFAULTS.overpass],
  ];
  for (const [name, onPublic, interval, floor] of checks) {
    if (onPublic && interval < floor) {
      throw new EnvError(
        name,
        `${interval} is below the public provider's fair-use floor of ${floor} ms — ` +
          `point the matching *_BASE_URL / pool at a self-hosted instance before relaxing it`,
      );
    }
  }
}

/** Parse provider config from a source. Pure (no process.env), so tests inject. */
export function parseProviderConfig(source: EnvSource = process.env): ProviderConfig {
  const cfg: ProviderConfig = {
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
    intervals: {
      nominatim: intervalMs(source, "NOMINATIM_MIN_INTERVAL_MS", PROVIDER_INTERVAL_DEFAULTS.nominatim),
      photon: intervalMs(source, "PHOTON_MIN_INTERVAL_MS", PROVIDER_INTERVAL_DEFAULTS.photon),
      ors: intervalMs(source, "ORS_MIN_INTERVAL_MS", PROVIDER_INTERVAL_DEFAULTS.ors),
      transit: intervalMs(source, "TRANSIT_MIN_INTERVAL_MS", PROVIDER_INTERVAL_DEFAULTS.transit),
      overpass: intervalMs(source, "OVERPASS_MIN_INTERVAL_MS", PROVIDER_INTERVAL_DEFAULTS.overpass),
    },
  };
  assertNoHttpOnPublicHost(cfg);
  assertPublicThrottleFloor(cfg);
  return cfg;
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
 *
 * `PROVIDER_DATA_REVISION` (task 009) is an OPTIONAL free-form token (e.g. an
 * OSM-extract date) folded into the tag — mirroring `CAR_FACTOR_REVISION` one
 * level up. Self-hosted ORS/MOTIS keep byte-identical URLs after a graph rebuild
 * from a newer extract, so nothing else in the tag would change and stale rings
 * would be served until each key's TTL; bump this token on a rebuild to cold the
 * namespace. NOTE the blast radius is UNIFORM: a bump colds EVERY provider cache
 * (geocode/suggest/stop-lines/route-path/catalogue too), not only routing rings.
 * NOTE also that the previous generation's rows are not deleted — there is no
 * expiry sweep (see api-cache.ts) — so a bump leaves them resident until a
 * manual `DELETE FROM "ApiCache"`.
 */
export function configCacheTag(source: EnvSource = process.env): string {
  const cfg = parseProviderConfig(source);
  const dataRevision = optionalEnv(source, "PROVIDER_DATA_REVISION");
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
    !dataRevision &&
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
    r: dataRevision ?? "",
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}

/** Prefix a provider cache key with the config tag (no-op on default config). */
export function taggedCacheKey(baseKey: string, source: EnvSource = process.env): string {
  const tag = configCacheTag(source);
  return tag ? `${tag}:${baseKey}` : baseKey;
}
