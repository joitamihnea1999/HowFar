import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, providerFetch } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  providerFetch: vi.fn(),
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

import { suggest } from "./photon";

// Bucharest bbox ≈ 25.8..26.4 lng, 44.2..44.7 lat.
const point = (name: string, lon: number, lat: number, extra: Record<string, unknown> = {}) => ({
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { name, ...extra },
});
function res(features: unknown[]) {
  return { ok: true, status: 200, json: () => Promise.resolve({ features }) };
}

beforeEach(() => {
  store.clear();
  providerFetch.mockReset();
});

describe("photon suggest", () => {
  it("normalizes in-area features to {label,lat,lng}", async () => {
    providerFetch.mockResolvedValue(res([point("Union Square", 26.1025, 44.428, { city: "Bucharest" })]));
    await expect(suggest("union")).resolves.toEqual([
      { label: "Union Square, Bucharest", lat: 44.428, lng: 26.1025 },
    ]);
  });

  it("filters out-of-Bucharest features (defensive geofence)", async () => {
    providerFetch.mockResolvedValue(
      res([
        point("In Town", 26.1, 44.43, { city: "Bucharest" }),
        point("Cluj City", 23.6, 46.77, { city: "Cluj-Napoca" }), // far outside bbox
      ]),
    );
    const out = await suggest("x");
    expect(out.map((s) => s.label)).toEqual(["In Town, Bucharest"]);
  });

  it("drops features whose composed label is empty", async () => {
    providerFetch.mockResolvedValue(res([{ geometry: { type: "Point", coordinates: [26.1, 44.43] }, properties: {} }]));
    await expect(suggest("x")).resolves.toEqual([]);
  });

  it("rejects malformed / non-Point / non-finite geometry", async () => {
    providerFetch.mockResolvedValue(
      res([
        { geometry: { type: "LineString", coordinates: [] }, properties: { name: "Line" } },
        { geometry: { type: "Point", coordinates: [26.1] }, properties: { name: "Short" } },
        { geometry: { type: "Point", coordinates: ["x", "y"] }, properties: { name: "NaN" } },
      ]),
    );
    await expect(suggest("x")).resolves.toEqual([]);
  });

  it("returns [] for an empty feature list", async () => {
    providerFetch.mockResolvedValue(res([]));
    await expect(suggest("nowhere")).resolves.toEqual([]);
  });

  it("serves a cache hit without a second fetch", async () => {
    providerFetch.mockResolvedValue(res([point("A", 26.1, 44.43, { city: "Bucharest" })]));
    await suggest("dup");
    await suggest("dup");
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("returns [] for a 200 with a null/garbled body (no 500)", async () => {
    providerFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(null) });
    await expect(suggest("weird")).resolves.toEqual([]);
  });

  it("de-duplicates identical composed labels", async () => {
    providerFetch.mockResolvedValue(
      res([
        point("Dup", 26.1, 44.43, { city: "Bucharest" }),
        point("Dup", 26.11, 44.44, { city: "Bucharest" }),
      ]),
    );
    await expect(suggest("dup")).resolves.toHaveLength(1);
  });

  it("throws ProviderError on a non-ok status", async () => {
    providerFetch.mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({}) });
    await expect(suggest("union")).rejects.toThrow(/responded 429/);
  });

  it("drops a feature with no properties at all (label would be empty)", async () => {
    providerFetch.mockResolvedValue(
      res([{ geometry: { type: "Point", coordinates: [26.1, 44.43] } }, point("Kept", 26.11, 44.44)]),
    );
    await expect(suggest("something")).resolves.toEqual([{ label: "Kept", lat: 44.44, lng: 26.11 }]);
  });

  it("wraps a fetch failure as ProviderError", async () => {
    providerFetch.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    await expect(suggest("x")).rejects.toThrow(/request failed/i);
  });
});
