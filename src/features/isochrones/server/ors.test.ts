import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, providerFetch, serverEnv } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  providerFetch: vi.fn(),
  serverEnv: vi.fn(() => ({ orsApiKey: "test-key" }) as { orsApiKey?: string }),
}));

vi.mock("@/lib/api-cache", () => ({
  getCachedSafe: (key: string) => Promise.resolve(store.has(key) ? store.get(key) : null),
  setCachedSafe: (key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  },
}));

vi.mock("@/lib/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provider-http")>()),
  providerFetch,
}));

vi.mock("@/lib/env", () => ({ serverEnv }));

import { drivingIsochrone, walkingIsochrone } from "./ors";

const poly = (value: number) => ({
  properties: { value },
  geometry: { type: "Polygon", coordinates: [[[26, 44], [26.1, 44], [26.1, 44.1], [26, 44]]] },
});

function orsResponse(features: unknown[]) {
  return { ok: true, status: 200, json: () => Promise.resolve({ features }) };
}

beforeEach(() => {
  store.clear();
  providerFetch.mockReset();
  serverEnv.mockReturnValue({ orsApiKey: "test-key" });
});

describe("walkingIsochrone", () => {
  it("normalizes to rings sorted ascending by minutes, regardless of input order", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(2528), poly(827), poly(1674)]));
    const result = await walkingIsochrone(44.4268, 26.1025);
    expect(result.rings.map((r) => r.minutes)).toEqual([15, 30, 45]);
    expect(result.origin).toEqual({ lat: 44.4268, lng: 26.1025 });
  });

  it("sends [lng, lat] order and the CALIBRATED ranges in the request body", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(827), poly(1674), poly(2528)]));
    await walkingIsochrone(44.4268, 26.1025);
    const opts = providerFetch.mock.calls[0][1] as { init: { body: string } };
    expect(JSON.parse(opts.init.body).locations[0]).toEqual([26.1025, 44.4268]);
    // The calibration IS the request: nominal 900/1800/2700 scaled by the
    // measured per-ring boundary factors (see ors.ts CALIBRATED_RANGES_S).
    expect(JSON.parse(opts.init.body).range).toEqual([827, 1674, 2528]);
  });

  it("rejects an UNSCALED (nominal 900/1800/2700) response — the calibration contract is load-bearing", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(900), poly(1800), poly(2700)]));
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/requested ranges/i);
  });

  it("throws ProviderError on a non-ok status", async () => {
    providerFetch.mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({}) });
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/429/);
  });

  it("throws when only one (malformed) feature is returned", async () => {
    // one malformed → 0 valid rings
    providerFetch.mockResolvedValue(
      orsResponse([{ properties: { value: 827 }, geometry: { type: "LineString", coordinates: [] } }]),
    );
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/1 rings/i);
  });

  it("throws when a requested range is missing (only 2 rings)", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(827), poly(1674)]));
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/2 rings/i);
  });

  it("throws when a range is duplicated instead of the full 15/30/45 set", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(827), poly(827), poly(1674)]));
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/requested ranges/i);
  });

  it("wraps a network/fetch failure as ProviderError (→ 502)", async () => {
    providerFetch.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/request failed/i);
  });

  it("wraps a malformed-JSON parse failure as ProviderError", async () => {
    providerFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("bad json")),
    });
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/request failed/i);
  });

  it("rounds a high-precision origin to 5 decimals (T9)", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(827), poly(1674), poly(2528)]));
    const result = await walkingIsochrone(44.426812345, 26.102534567);
    expect(result.origin).toEqual({ lat: 44.42681, lng: 26.10253 });
  });

  it("serves a cache hit without a second fetch and returns the same value", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(827), poly(1674), poly(2528)]));
    const first = await walkingIsochrone(44.4, 26.1);
    const second = await walkingIsochrone(44.4, 26.1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    // v3 key: pace-scoped; pre-051 cached rings must never be served again.
    expect([...store.keys()]).toEqual(["iso:foot:v3:normal:44.40000,26.10000"]);
  });

  it("coalesces two concurrent cold requests for the same origin into ONE fetch", async () => {
    let resolveFetch!: (v: unknown) => void;
    providerFetch.mockReturnValue(new Promise((r) => (resolveFetch = r)));
    const p1 = walkingIsochrone(44.4, 26.1);
    const p2 = walkingIsochrone(44.4, 26.1);
    await new Promise((r) => setTimeout(r, 0)); // drain cache reads + in-flight registration
    resolveFetch(orsResponse([poly(827), poly(1674), poly(2528)]));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it("throws ProviderError without touching the network when ORS_API_KEY is missing", async () => {
    serverEnv.mockReturnValue({});
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/ORS_API_KEY/);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("rejects a well-typed ring whose coordinates are null/empty (never reaches the client)", async () => {
    const bad = { properties: { value: 827 }, geometry: { type: "Polygon", coordinates: null } };
    providerFetch.mockResolvedValue(orsResponse([bad, poly(1674), poly(2528)]));
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/invalid geometry/i);

    const empty = { properties: { value: 827 }, geometry: { type: "Polygon", coordinates: [] } };
    providerFetch.mockResolvedValue(orsResponse([empty, poly(1674), poly(2528)]));
    await expect(walkingIsochrone(44.41, 26.11)).rejects.toThrow(/invalid geometry/i);
  });

  it("rejects garbage nested one level down ([null] / non-array members)", async () => {
    const nested = { properties: { value: 827 }, geometry: { type: "Polygon", coordinates: [null] } };
    providerFetch.mockResolvedValue(orsResponse([nested, poly(1674), poly(2528)]));
    await expect(walkingIsochrone(44.42, 26.12)).rejects.toThrow(/invalid geometry/i);

    const strings = { properties: { value: 827 }, geometry: { type: "Polygon", coordinates: ["x"] } };
    providerFetch.mockResolvedValue(orsResponse([strings, poly(1674), poly(2528)]));
    await expect(walkingIsochrone(44.43, 26.13)).rejects.toThrow(/invalid geometry/i);
  });

  it("502s (ProviderError) on a garbled envelope where features is not an array", async () => {
    providerFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ features: {} }) });
    await expect(walkingIsochrone(44.44, 26.14)).rejects.toThrow(/malformed response/i);
  });
});

describe("drivingIsochrone (car, task 053)", () => {
  // Car uses the driving-car profile, NOMINAL 600/1200/1800 s ranges, and
  // relabels to 10/20/30 min — the shared normalize/rate-limit/cache machinery
  // otherwise matches walk. These assertions pin the driving request CONTRACT
  // (profile URL, no Accept header, car ranges, iso:car cache key) so a future
  // refactor can't silently request foot polygons as car or 406 in prod.
  it("requests the driving-car profile with the car ranges, [lng,lat] order, and NO Accept header", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(600), poly(1200), poly(1800)]));
    await drivingIsochrone(44.4268, 26.1025);
    const [url, opts] = providerFetch.mock.calls[0] as [string, { init: { body: string; headers: Record<string, string> } }];
    expect(url).toBe("https://api.openrouteservice.org/v2/isochrones/driving-car");
    const parsed = JSON.parse(opts.init.body);
    expect(parsed.locations[0]).toEqual([26.1025, 44.4268]);
    expect(parsed.range).toEqual([600, 1200, 1800]);
    // ORS isochrones serves geo+json; an Accept: application/json → 406.
    expect(Object.keys(opts.init.headers)).not.toContain("Accept");
  });

  it("relabels the driving rings to 10/20/30 min, ascending regardless of input order", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(1800), poly(600), poly(1200)]));
    const result = await drivingIsochrone(44.4268, 26.1025);
    expect(result.rings.map((r) => r.minutes)).toEqual([10, 20, 30]);
    expect(result.origin).toEqual({ lat: 44.4268, lng: 26.1025 });
  });

  it("caches under an isolated iso:car:v1 key (never collides with the walk iso:foot key)", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(600), poly(1200), poly(1800)]));
    await drivingIsochrone(44.4, 26.1);
    await drivingIsochrone(44.4, 26.1);
    expect(providerFetch).toHaveBeenCalledTimes(1); // second served from cache
    expect([...store.keys()]).toEqual(["iso:car:v1:44.40000,26.10000"]);
  });

  it("rejects a driving response echoing the wrong (e.g. walk) ranges — the bijection is load-bearing", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(827), poly(1674), poly(2528)]));
    await expect(drivingIsochrone(44.4, 26.1)).rejects.toThrow(/requested ranges/i);
  });
});
