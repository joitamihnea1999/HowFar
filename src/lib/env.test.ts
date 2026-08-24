import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EnvError,
  PROVIDER_DEFAULTS,
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
    expect(cfg.photonBase).toBe("https://photon.komoot.io/api");
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

  it("treats an empty/whitespace override as absent (falls back to default)", () => {
    expect(parseProviderConfig({ ORS_BASE_URL: "   " }).orsBase).toBe(PROVIDER_DEFAULTS.orsBase);
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

  it("FAILS CLOSED on an endpoint pool whose members are all empty", () => {
    expect(() => parseProviderConfig({ OVERPASS_ENDPOINTS: " , , " })).toThrowError(
      /at least one endpoint/,
    );
  });

  it("FAILS CLOSED when one endpoint in a pool is invalid", () => {
    expect(() =>
      parseProviderConfig({ OVERPASS_ENDPOINTS: "https://ok.example/api, nope" }),
    ).toThrowError(EnvError);
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

  it("re-namespaces when the bbox changes", () => {
    expect(configCacheTag({ NEXT_PUBLIC_MAP_BBOX: "23.4,46.6,23.7,46.9" })).not.toBe("");
  });

  it("gives different configs different tags (no collision)", () => {
    expect(configCacheTag({ ORS_BASE_URL: "https://a.example" })).not.toBe(
      configCacheTag({ ORS_BASE_URL: "https://b.example" }),
    );
  });
});
