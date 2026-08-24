import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provider-http")>()),
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

  it("502s (ProviderError) when features is present but not an array — garbled ≠ empty", async () => {
    providerFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ features: {} }) });
    await expect(suggest("garbled")).rejects.toThrow(/malformed response/i);
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

describe("config-driven host (task 007)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to today's public Photon host, byte-exact (URL + rateHost + focus)", async () => {
    providerFetch.mockResolvedValue(res([]));
    await suggest("default host");
    const [url, opts] = providerFetch.mock.calls[0] as [string, { rateHost: string }];
    expect(url.startsWith("https://photon.komoot.io/api?")).toBe(true);
    expect(url).toContain("lat=44.43&lon=26.10"); // focus kept byte-identical in P1
    expect(opts.rateHost).toBe("photon.komoot.io");
  });

  it("routes both the request URL and the rate-limit host to an override", async () => {
    vi.stubEnv("PHOTON_BASE_URL", "https://photon.internal/api");
    providerFetch.mockResolvedValue(res([]));
    await suggest("override host");
    const [url, opts] = providerFetch.mock.calls[0] as [string, { rateHost: string }];
    expect(url.startsWith("https://photon.internal/api?")).toBe(true);
    expect(opts.rateHost).toBe("photon.internal");
    // Cache key config-namespaced under an override (guards the taggedCacheKey wrapper).
    expect([...store.keys()].every((k) => /^[0-9a-f]{8}:suggest:/.test(k))).toBe(true);
  });
});
