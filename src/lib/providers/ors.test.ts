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

vi.mock("@/lib/providers/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  providerFetch,
}));

vi.mock("@/lib/env", () => ({ serverEnv }));

import { walkingIsochrone } from "./ors";

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
    providerFetch.mockResolvedValue(orsResponse([poly(2700), poly(900), poly(1800)]));
    const result = await walkingIsochrone(44.4268, 26.1025);
    expect(result.rings.map((r) => r.minutes)).toEqual([15, 30, 45]);
    expect(result.origin).toEqual({ lat: 44.4268, lng: 26.1025 });
  });

  it("sends [lng, lat] order in the request body", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(900), poly(1800), poly(2700)]));
    await walkingIsochrone(44.4268, 26.1025);
    const opts = providerFetch.mock.calls[0][1] as { init: { body: string } };
    expect(JSON.parse(opts.init.body).locations[0]).toEqual([26.1025, 44.4268]);
  });

  it("throws ProviderError on a non-ok status", async () => {
    providerFetch.mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({}) });
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/429/);
  });

  it("throws when the 3 requested rings (15/30/45) are not all present", async () => {
    // one malformed → 0 valid rings
    providerFetch.mockResolvedValue(
      orsResponse([{ properties: { value: 900 }, geometry: { type: "LineString", coordinates: [] } }]),
    );
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/unexpected rings/i);
  });

  it("throws when a requested range is missing (only 2 rings)", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(900), poly(1800)]));
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/unexpected rings/i);
  });

  it("throws when a range is duplicated instead of the full 15/30/45 set", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(900), poly(900), poly(1800)]));
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/unexpected rings/i);
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
    providerFetch.mockResolvedValue(orsResponse([poly(900), poly(1800), poly(2700)]));
    const result = await walkingIsochrone(44.426812345, 26.102534567);
    expect(result.origin).toEqual({ lat: 44.42681, lng: 26.10253 });
  });

  it("serves a cache hit without a second fetch and returns the same value", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(900), poly(1800), poly(2700)]));
    const first = await walkingIsochrone(44.4, 26.1);
    const second = await walkingIsochrone(44.4, 26.1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("throws ProviderError without touching the network when ORS_API_KEY is missing", async () => {
    serverEnv.mockReturnValue({});
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/ORS_API_KEY/);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("rejects a well-typed ring whose coordinates are null/empty (never reaches the client)", async () => {
    const bad = { properties: { value: 900 }, geometry: { type: "Polygon", coordinates: null } };
    providerFetch.mockResolvedValue(orsResponse([bad, poly(1800), poly(2700)]));
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/unexpected rings/i);

    const empty = { properties: { value: 900 }, geometry: { type: "Polygon", coordinates: [] } };
    providerFetch.mockResolvedValue(orsResponse([empty, poly(1800), poly(2700)]));
    await expect(walkingIsochrone(44.41, 26.11)).rejects.toThrow(/unexpected rings/i);
  });

  it("rejects garbage nested one level down ([null] / non-array members)", async () => {
    const nested = { properties: { value: 900 }, geometry: { type: "Polygon", coordinates: [null] } };
    providerFetch.mockResolvedValue(orsResponse([nested, poly(1800), poly(2700)]));
    await expect(walkingIsochrone(44.42, 26.12)).rejects.toThrow(/unexpected rings/i);

    const strings = { properties: { value: 900 }, geometry: { type: "Polygon", coordinates: ["x"] } };
    providerFetch.mockResolvedValue(orsResponse([strings, poly(1800), poly(2700)]));
    await expect(walkingIsochrone(44.43, 26.13)).rejects.toThrow(/unexpected rings/i);
  });

  it("502s (ProviderError) on a garbled envelope where features is not an array", async () => {
    providerFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ features: {} }) });
    await expect(walkingIsochrone(44.44, 26.14)).rejects.toThrow(/malformed response/i);
  });
});
