import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, providerFetch } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  providerFetch: vi.fn(),
}));

vi.mock("@/lib/api-cache", () => ({
  getCached: (key: string) => Promise.resolve(store.has(key) ? store.get(key) : null),
  setCached: (key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  },
}));

vi.mock("@/lib/providers/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  providerFetch,
}));

vi.mock("@/lib/env", () => ({ serverEnv: () => ({ orsApiKey: "test-key" }) }));

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

  it("filters malformed geometry and throws when no valid rings remain", async () => {
    providerFetch.mockResolvedValue(
      orsResponse([{ properties: { value: 900 }, geometry: { type: "LineString", coordinates: [] } }]),
    );
    await expect(walkingIsochrone(44.4, 26.1)).rejects.toThrow(/no isochrone/i);
  });

  it("serves a cache hit without a second upstream fetch", async () => {
    providerFetch.mockResolvedValue(orsResponse([poly(900), poly(1800), poly(2700)]));
    await walkingIsochrone(44.4, 26.1);
    await walkingIsochrone(44.4, 26.1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
});
