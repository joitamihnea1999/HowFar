import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BBOX, parseBbox } from "./bounds";
import {
  EnvError,
  PROVIDER_DEFAULTS,
  PROVIDER_INTERVAL_DEFAULTS,
  TILES_PATH_DEFAULT_SEGMENTS,
  configCacheTag,
  parseProviderConfig,
  parseServerEnv,
  taggedCacheKey,
  tilesPmtilesPath,
} from "./env";

const valid = {
  DATABASE_URL: "postgresql://user:pass@localhost:5433/howfar",
  AUTH_SECRET: "s3cret",
};

describe("parseServerEnv", () => {
  it("parses a minimal valid environment", () => {
    const env = parseServerEnv(valid);
    expect(env.databaseUrl).toBe(valid.DATABASE_URL);
    expect(env.authSecret).toBe("s3cret");
    expect(env.googleClientId).toBeUndefined();
    expect(env.orsApiKey).toBeUndefined();
  });

  it("throws EnvError when DATABASE_URL is missing", () => {
    expect(() => parseServerEnv({ AUTH_SECRET: "x" })).toThrowError(EnvError);
    expect(() => parseServerEnv({ AUTH_SECRET: "x" })).toThrowError(/DATABASE_URL/);
  });

  it("accepts PostgreSQL's postgresql:// and postgres:// URL schemes", () => {
    expect(parseServerEnv({ ...valid, DATABASE_URL: "postgres://user:pass@localhost/howfar" }).databaseUrl).toBe(
      "postgres://user:pass@localhost/howfar",
    );
  });

  it("rejects non-PostgreSQL connection strings", () => {
    expect(() => parseServerEnv({ ...valid, DATABASE_URL: "mysql://nope" })).toThrowError(
      /must start with postgresql:\/\//,
    );
  });

  it("throws EnvError when AUTH_SECRET is missing (required even without OAuth)", () => {
    expect(() => parseServerEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrowError(/AUTH_SECRET/);
  });

  it("treats empty/whitespace values as absent", () => {
    expect(() => parseServerEnv({ ...valid, AUTH_SECRET: "   " })).toThrowError(/AUTH_SECRET/);
    const env = parseServerEnv({ ...valid, AUTH_GOOGLE_ID: "  " });
    expect(env.googleClientId).toBeUndefined();
  });

  it("picks up optional OAuth pairs and ORS key when present", () => {
    const env = parseServerEnv({
      ...valid,
      AUTH_GITHUB_ID: "gh-id",
      AUTH_GITHUB_SECRET: "gh-secret",
      ORS_API_KEY: "ors-key",
    });
    expect(env.githubClientId).toBe("gh-id");
    expect(env.githubClientSecret).toBe("gh-secret");
    expect(env.orsApiKey).toBe("ors-key");
  });
});

describe("serverEnv (memoized process.env accessor)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("parses once and keeps returning the first result (per-process cache)", async () => {
    vi.resetModules(); // fresh module instance → empty memo
    vi.stubEnv("DATABASE_URL", valid.DATABASE_URL);
    vi.stubEnv("AUTH_SECRET", "first-value");
    const { serverEnv } = await import("./env");
    const first = serverEnv();
    vi.stubEnv("AUTH_SECRET", "changed-later");
    const second = serverEnv();
    expect(second).toBe(first); // same object — env is not re-read per call
    expect(second.authSecret).toBe("first-value");
  });
});

describe("parseProviderConfig (region/self-host config lift)", () => {
  it("defaults to today's exact public hosts when nothing is set (byte-identity)", () => {
    const cfg = parseProviderConfig({});
    expect(cfg.nominatimBase).toBe("https://nominatim.openstreetmap.org");
    expect(cfg.photonBase).toBe("https://photon.komoot.io");
    expect(cfg.orsBase).toBe("https://api.openrouteservice.org");
    expect(cfg.transitBase).toBe("https://api.transitous.org");
    expect(cfg.overpassEndpoints).toEqual([
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
    ]);
    expect(cfg.bulkOverpassEndpoints).toEqual([
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
    ]);
  });

  it("the returned default lists are copies, not the frozen PROVIDER_DEFAULTS arrays", () => {
    const cfg = parseProviderConfig({});
    expect(cfg.overpassEndpoints).not.toBe(PROVIDER_DEFAULTS.overpassEndpoints);
    expect(() => cfg.overpassEndpoints.push("x")).not.toThrow();
  });

  it("honors a single-base override and strips a trailing slash", () => {
    const cfg = parseProviderConfig({ NOMINATIM_BASE_URL: "https://nom.example/" });
    expect(cfg.nominatimBase).toBe("https://nom.example");
    expect(cfg.photonBase).toBe(PROVIDER_DEFAULTS.photonBase); // others untouched
  });

  it("splits an endpoint pool on commas and whitespace, dropping empties", () => {
    const cfg = parseProviderConfig({
      OVERPASS_ENDPOINTS: "https://a.example/api ,  https://b.example/api\n",
    });
    expect(cfg.overpassEndpoints).toEqual(["https://a.example/api", "https://b.example/api"]);
  });

  it("uses the default only when the var is ABSENT, not when set-but-blank", () => {
    expect(parseProviderConfig({}).orsBase).toBe(PROVIDER_DEFAULTS.orsBase); // absent → default
  });

  it("FAILS CLOSED on a set-but-blank provider base (a stray `ORS_BASE_URL=` must not silently use public)", () => {
    expect(() => parseProviderConfig({ ORS_BASE_URL: "   " })).toThrowError(/blank/);
    expect(() => parseProviderConfig({ NOMINATIM_BASE_URL: "" })).toThrowError(/blank/);
  });

  it("FAILS CLOSED on a set-but-blank endpoint pool", () => {
    expect(() => parseProviderConfig({ OVERPASS_ENDPOINTS: "" })).toThrowError(/no endpoint URL/);
  });

  it("FAILS CLOSED on a set-but-invalid URL", () => {
    expect(() => parseProviderConfig({ ORS_BASE_URL: "not-a-url" })).toThrowError(EnvError);
    expect(() => parseProviderConfig({ ORS_BASE_URL: "not-a-url" })).toThrowError(/ORS_BASE_URL/);
  });

  it("FAILS CLOSED on a non-http(s) scheme", () => {
    expect(() => parseProviderConfig({ PHOTON_BASE_URL: "ftp://x.example" })).toThrowError(
      /http:\/\/ or https:\/\//,
    );
  });

  it("FAILS CLOSED on a base URL carrying a query string or fragment (path-concat would break)", () => {
    expect(() => parseProviderConfig({ NOMINATIM_BASE_URL: "https://nom.example?x=1" })).toThrowError(
      /query string or fragment/,
    );
    expect(() => parseProviderConfig({ ORS_BASE_URL: "https://ors.example#frag" })).toThrowError(
      /query string or fragment/,
    );
  });

  it("allows a path prefix on the base (self-host under a subpath)", () => {
    expect(parseProviderConfig({ ORS_BASE_URL: "https://osm.internal/ors" }).orsBase).toBe(
      "https://osm.internal/ors",
    );
  });

  it("FAILS CLOSED on an endpoint pool whose members are all empty", () => {
    expect(() => parseProviderConfig({ OVERPASS_ENDPOINTS: " , , " })).toThrowError(
      /no endpoint URL/,
    );
  });

  it("FAILS CLOSED when one endpoint in a pool is invalid", () => {
    expect(() =>
      parseProviderConfig({ OVERPASS_ENDPOINTS: "https://ok.example/api, nope" }),
    ).toThrowError(EnvError);
  });
});

describe("parseProviderConfig — per-provider rate-limit intervals (task 009)", () => {
  it("defaults to today's exact per-client spacing when nothing is set (byte-identity)", () => {
    const { intervals } = parseProviderConfig({});
    expect(intervals.nominatim).toBe(1100);
    expect(intervals.photon).toBe(300);
    expect(intervals.ors).toBe(1500);
    expect(intervals.transit).toBe(1500);
    expect(intervals.overpass).toBe(1100);
    // and the exported defaults are those same literals
    expect(intervals).toEqual({ ...PROVIDER_INTERVAL_DEFAULTS });
  });

  it("honors a per-provider override (raising the interval is always allowed)", () => {
    const { intervals } = parseProviderConfig({ NOMINATIM_MIN_INTERVAL_MS: "2500" });
    expect(intervals.nominatim).toBe(2500);
    expect(intervals.photon).toBe(300); // others untouched
  });

  it("allows a sub-default interval (incl. 0 = no throttle) once the matching base is self-hosted", () => {
    const cfg = parseProviderConfig({
      TRANSIT_BASE_URL: "https://motis.internal",
      TRANSIT_MIN_INTERVAL_MS: "0",
    });
    expect(cfg.intervals.transit).toBe(0);
  });

  // IT3 safety guard: relaxing a PUBLIC provider's throttle would risk an IP ban.
  it("FAILS CLOSED on a sub-default interval while the base is still the public default", () => {
    expect(() => parseProviderConfig({ NOMINATIM_MIN_INTERVAL_MS: "0" })).toThrowError(/fair-use floor/);
    expect(() => parseProviderConfig({ PHOTON_MIN_INTERVAL_MS: "100" })).toThrowError(/fair-use floor/);
    expect(() => parseProviderConfig({ ORS_MIN_INTERVAL_MS: "500" })).toThrowError(/fair-use floor/);
    expect(() => parseProviderConfig({ TRANSIT_MIN_INTERVAL_MS: "0" })).toThrowError(/fair-use floor/);
    // overpass keys off its interactive pool being the default
    expect(() => parseProviderConfig({ OVERPASS_MIN_INTERVAL_MS: "100" })).toThrowError(/fair-use floor/);
  });

  it("a case/port variant of the public host still counts as public for the throttle floor", () => {
    expect(() =>
      parseProviderConfig({ ORS_BASE_URL: "https://API.openrouteservice.org:443", ORS_MIN_INTERVAL_MS: "0" }),
    ).toThrowError(/fair-use floor/);
  });

  // The overpass floor keys off per-endpoint membership, not whole-list equality:
  // pinning/reordering/subsetting the public mirrors must NOT bypass it.
  it("overpass floor applies when the pool still contains a public host (subset or reordered)", () => {
    // one public mirror pinned + no throttle → must throw
    expect(() =>
      parseProviderConfig({
        OVERPASS_ENDPOINTS: "https://overpass-api.de/api/interpreter",
        OVERPASS_MIN_INTERVAL_MS: "0",
      }),
    ).toThrowError(/fair-use floor/);
    // reordered default list + sub-default → must throw
    expect(() =>
      parseProviderConfig({
        OVERPASS_ENDPOINTS:
          "https://overpass.kumi.systems/api/interpreter, https://overpass-api.de/api/interpreter, https://maps.mail.ru/osm/tools/overpass/api/interpreter",
        OVERPASS_MIN_INTERVAL_MS: "100",
      }),
    ).toThrowError(/fair-use floor/);
    // a public host mixed with a self-hosted one still counts as public
    expect(() =>
      parseProviderConfig({
        OVERPASS_ENDPOINTS: "https://op.internal/api/interpreter, https://overpass-api.de/api/interpreter",
        OVERPASS_MIN_INTERVAL_MS: "0",
      }),
    ).toThrowError(/fair-use floor/);
  });

  it("overpass floor does NOT apply to an all-self-hosted pool (0 allowed)", () => {
    const cfg = parseProviderConfig({
      OVERPASS_ENDPOINTS: "https://op1.internal/api/interpreter, https://op2.internal/api/interpreter",
      OVERPASS_MIN_INTERVAL_MS: "0",
    });
    expect(cfg.intervals.overpass).toBe(0);
  });

  it("the overpass floor keys off the INTERACTIVE pool only — a public BULK pool doesn't block interval 0", () => {
    // `intervals.overpass` governs only the interactive client; bulk-overpass.ts
    // uses raw fetch with no bucket/interval, so a public bulk pool is irrelevant
    // to the interactive throttle floor (task 009, intentional).
    const cfg = parseProviderConfig({
      OVERPASS_ENDPOINTS: "https://op.internal/api/interpreter", // interactive self-hosted
      OVERPASS_BULK_ENDPOINTS: "https://overpass-api.de/api/interpreter", // bulk still public (https)
      OVERPASS_MIN_INTERVAL_MS: "0",
    });
    expect(cfg.intervals.overpass).toBe(0);
  });

  it("a trailing-dot FQDN of the public host does NOT bypass the floor (canonicalized)", () => {
    expect(() =>
      parseProviderConfig({ NOMINATIM_BASE_URL: "https://nominatim.openstreetmap.org.", NOMINATIM_MIN_INTERVAL_MS: "0" }),
    ).toThrowError(/fair-use floor/);
    // and a trailing-dot public overpass mirror still triggers the pool floor
    expect(() =>
      parseProviderConfig({ OVERPASS_ENDPOINTS: "https://overpass-api.de./api/interpreter", OVERPASS_MIN_INTERVAL_MS: "0" }),
    ).toThrowError(/fair-use floor/);
  });
});

describe("parseProviderConfig — http on a public provider host fails closed (task 009)", () => {
  it("rejects http:// on the public ORS host (would expose the key over cleartext)", () => {
    expect(() => parseProviderConfig({ ORS_BASE_URL: "http://api.openrouteservice.org" })).toThrowError(
      /https:\/\/ for the public provider host/,
    );
  });
  it("rejects http:// on a public host given as a trailing-dot FQDN too", () => {
    expect(() => parseProviderConfig({ NOMINATIM_BASE_URL: "http://nominatim.openstreetmap.org." })).toThrowError(
      /https:\/\/ for the public provider host/,
    );
  });
  it("rejects http:// on the public Photon and Transit hosts too (all single bases)", () => {
    expect(() => parseProviderConfig({ PHOTON_BASE_URL: "http://photon.komoot.io" })).toThrowError(
      /https:\/\/ for the public provider host/,
    );
    expect(() => parseProviderConfig({ TRANSIT_BASE_URL: "http://api.transitous.org" })).toThrowError(
      /https:\/\/ for the public provider host/,
    );
  });
  it("ALLOWS http:// on a self-hosted host (trusted network)", () => {
    expect(parseProviderConfig({ ORS_BASE_URL: "http://ors.internal" }).orsBase).toBe("http://ors.internal");
  });
  it("rejects http:// on a public Overpass pool member (sibling-path class)", () => {
    expect(() => parseProviderConfig({ OVERPASS_ENDPOINTS: "http://overpass-api.de/api/interpreter" })).toThrowError(
      /https:\/\/ for the public Overpass host/,
    );
    // ...even when mixed with a valid self-hosted https endpoint
    expect(() =>
      parseProviderConfig({ OVERPASS_ENDPOINTS: "https://op.internal/api, http://overpass.kumi.systems/api/interpreter" }),
    ).toThrowError(/https:\/\/ for the public Overpass host/);
  });
  it("ALLOWS http:// on an all-self-hosted Overpass pool", () => {
    expect(parseProviderConfig({ OVERPASS_ENDPOINTS: "http://op.internal/api/interpreter" }).overpassEndpoints).toEqual([
      "http://op.internal/api/interpreter",
    ]);
  });

  it("FAILS CLOSED on a set-but-blank interval", () => {
    expect(() => parseProviderConfig({ ORS_MIN_INTERVAL_MS: "  " })).toThrowError(/blank/);
  });

  it("FAILS CLOSED on a negative or non-integer interval", () => {
    expect(() => parseProviderConfig({ PHOTON_MIN_INTERVAL_MS: "-5" })).toThrowError(
      /between 0 and/,
    );
    expect(() => parseProviderConfig({ PHOTON_MIN_INTERVAL_MS: "1.5" })).toThrowError(
      /between 0 and/,
    );
    expect(() => parseProviderConfig({ OVERPASS_MIN_INTERVAL_MS: "soon" })).toThrowError(EnvError);
  });

  it("accepts Node's max timer delay but REJECTS one above it (would clamp to 1ms, defeating the throttle)", () => {
    // IT2: an interval over 2^31−1 is silently clamped to 1ms by setTimeout.
    expect(parseProviderConfig({ ORS_MIN_INTERVAL_MS: "2147483647" }).intervals.ors).toBe(2147483647);
    expect(() => parseProviderConfig({ ORS_MIN_INTERVAL_MS: "2147483648" })).toThrowError(/between 0 and/);
  });
});

describe("fetch-tiles.sh default drift guard (task 007)", () => {
  // The build script has its own copy of the extent + archive-path defaults
  // (it can't import TS). Guard that they don't drift from the app's defaults,
  // else an unset deploy would extract a different box/path than the app reads.
  // File-relative (not cwd-relative) so it resolves regardless of the runner cwd.
  const script = readFileSync(new URL("../../scripts/fetch-tiles.sh", import.meta.url), "utf8");

  it("its fallback bbox equals DEFAULT_BBOX", () => {
    // Anchor on the numeric fallback (`:-25.80,…`), not the `:-$(read_env_key…)` line.
    const m = script.match(/NEXT_PUBLIC_MAP_BBOX:-(\d[0-9.,]+)/);
    expect(m, "fallback bbox literal not found in fetch-tiles.sh").not.toBeNull();
    expect(parseBbox(m![1])).toEqual(DEFAULT_BBOX);
  });

  it("its fallback archive path equals the app default", () => {
    const m = script.match(/TILES_PMTILES_PATH:-(data[^}"']+)/);
    expect(m, "fallback path literal not found in fetch-tiles.sh").not.toBeNull();
    expect(m![1].trim()).toBe(TILES_PATH_DEFAULT_SEGMENTS.join("/"));
  });
});

describe("tilesPmtilesPath", () => {
  it("defaults to <cwd>/data/tiles/bucharest.pmtiles", () => {
    expect(tilesPmtilesPath({})).toBe(`${process.cwd()}/data/tiles/bucharest.pmtiles`);
  });
  it("uses an absolute override verbatim", () => {
    expect(tilesPmtilesPath({ TILES_PMTILES_PATH: "/srv/tiles/cluj.pmtiles" })).toBe(
      "/srv/tiles/cluj.pmtiles",
    );
  });
  it("resolves a relative override against cwd", () => {
    expect(tilesPmtilesPath({ TILES_PMTILES_PATH: "data/tiles/cluj.pmtiles" })).toBe(
      `${process.cwd()}/data/tiles/cluj.pmtiles`,
    );
  });
});

describe("configCacheTag + taggedCacheKey", () => {
  it("is the empty string on default config, so keys stay byte-identical", () => {
    expect(configCacheTag({})).toBe("");
    expect(taggedCacheKey("iso:foot:v4:normal:44.4,26.1", {})).toBe("iso:foot:v4:normal:44.4,26.1");
  });

  it("produces a stable non-empty tag once any provider host is overridden", () => {
    const src = { ORS_BASE_URL: "https://ors.internal" };
    const tag = configCacheTag(src);
    expect(tag).not.toBe("");
    expect(tag).toBe(configCacheTag(src)); // stable
    expect(taggedCacheKey("k", src)).toBe(`${tag}:k`);
  });

  it("re-namespaces when the resolved extent changes (via a fresh module load)", async () => {
    // The bbox component comes from the RESOLVED LAUNCH_BBOX (build-consistent),
    // not a raw runtime env read — so exercise it by re-importing with a stubbed
    // extent, which also proves the tag tracks the geofence rather than a var that
    // may be absent at runtime in a build-ARG container.
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_MAP_BBOX", "23.4,46.6,23.7,46.9");
    try {
      const fresh = await import("./env");
      expect(fresh.configCacheTag({})).not.toBe("");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("gives different configs different tags (no collision)", () => {
    expect(configCacheTag({ ORS_BASE_URL: "https://a.example" })).not.toBe(
      configCacheTag({ ORS_BASE_URL: "https://b.example" }),
    );
  });

  // PROVIDER_DATA_REVISION (task 009): bump on a self-hosted graph rebuild to
  // cold the namespace even though every host URL stays byte-identical.
  it("cold-namespaces on PROVIDER_DATA_REVISION alone, even with default hosts", () => {
    expect(configCacheTag({})).toBe(""); // absent → still default
    expect(configCacheTag({ PROVIDER_DATA_REVISION: "2026-09-01" })).not.toBe("");
  });

  it("gives distinct revisions distinct tags", () => {
    expect(configCacheTag({ PROVIDER_DATA_REVISION: "r1" })).not.toBe(
      configCacheTag({ PROVIDER_DATA_REVISION: "r2" }),
    );
  });

  it("composes revision with a host override (both feed the tag)", () => {
    const hostOnly = configCacheTag({ ORS_BASE_URL: "https://ors.internal" });
    const hostPlusRev = configCacheTag({ ORS_BASE_URL: "https://ors.internal", PROVIDER_DATA_REVISION: "r1" });
    expect(hostPlusRev).not.toBe("");
    expect(hostPlusRev).not.toBe(hostOnly); // the revision changed the tag
  });

  it("taggedCacheKey (the shared prefixer) rotates ANY base key on a revision bump", () => {
    // This proves the PREFIXER is uniform — NOT that any given call site uses it.
    // The per-call-site proof that geocode/suggest/rings/catalogue/stop-lines/
    // route-path all flow through taggedCacheKey lives in each client's own
    // "config-namespaces the cache key under an override" test.
    const rev = { PROVIDER_DATA_REVISION: "r1" };
    for (const base of ["geo:fwd:abc", "suggest:abc", "iso:foot:v4:normal:44.4,26.1", "catalogue:x"]) {
      expect(taggedCacheKey(base, rev)).not.toBe(base);
      expect(taggedCacheKey(base, rev)).not.toBe(taggedCacheKey(base, {}));
    }
  });
});
