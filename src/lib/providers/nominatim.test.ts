import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory cache + a stubbed providerFetch (so the real rate limiter isn't
// exercised here — that's covered in http.test.ts).
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

import { geocode, reverseGeocode } from "./nominatim";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  store.clear();
  providerFetch.mockReset();
});

describe("geocode", () => {
  it("coerces string lat/lon to numbers and returns the top match", async () => {
    providerFetch.mockResolvedValue(
      jsonResponse([{ lat: "44.4268", lon: "26.1025", display_name: "Piața Unirii, București" }]),
    );
    await expect(geocode("Piata Unirii")).resolves.toEqual({
      lat: 44.4268,
      lng: 26.1025,
      label: "Piața Unirii, București",
    });
  });

  it("returns null for empty results", async () => {
    providerFetch.mockResolvedValue(jsonResponse([]));
    await expect(geocode("nowhere zzz")).resolves.toBeNull();
  });

  it("treats malformed rows (no coords) as no result", async () => {
    providerFetch.mockResolvedValue(jsonResponse([{ display_name: "no coords" }]));
    await expect(geocode("bad")).resolves.toBeNull();
  });

  it("caches NEGATIVE results — a repeat query issues zero upstream fetches", async () => {
    providerFetch.mockResolvedValue(jsonResponse([]));
    await geocode("ghost address");
    await geocode("ghost address");
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("caches positive results — a repeat query issues zero upstream fetches", async () => {
    providerFetch.mockResolvedValue(jsonResponse([{ lat: "44.4", lon: "26.1", display_name: "x" }]));
    await geocode("dup");
    await geocode("dup");
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
});

describe("reverseGeocode", () => {
  it("normalizes the single reverse object", async () => {
    providerFetch.mockResolvedValue(
      jsonResponse({ lat: "44.5", lon: "26.2", display_name: "Somewhere, București" }),
    );
    await expect(reverseGeocode(44.5, 26.2)).resolves.toEqual({
      lat: 44.5,
      lng: 26.2,
      label: "Somewhere, București",
    });
  });
});

describe("error handling", () => {
  it("wraps a network/fetch failure as ProviderError (→ 502)", async () => {
    providerFetch.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    await expect(geocode("x")).rejects.toThrow(/request failed/i);
  });

  it("wraps a malformed-JSON parse failure as ProviderError", async () => {
    providerFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("bad json")),
    });
    await expect(geocode("y")).rejects.toThrow(/request failed/i);
  });
});
