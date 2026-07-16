import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, providerFetch, buildRingsMock } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  providerFetch: vi.fn(),
  buildRingsMock: vi.fn(),
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

// Delegate to the real grid builder by default; individual tests can override
// (e.g. to force a construction failure → ProviderError).
vi.mock("@/lib/providers/transit-grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transit-grid")>()),
  buildRings: (...args: unknown[]) => buildRingsMock(...args),
}));

import { representativeDeparture, transitIsochrone } from "./transit";

type Stop = { place?: { lat?: number; lon?: number }; duration?: number };
const stop = (lat: number, lon: number, duration: number): Stop => ({ place: { lat, lon }, duration });
function oneToAll(all: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve({ all }) };
}

beforeEach(async () => {
  store.clear();
  providerFetch.mockReset();
  buildRingsMock.mockReset();
  // importActual bypasses the mock above, so we delegate to the REAL builder by
  // default (tests that want a failure override buildRingsMock themselves).
  const actual = await vi.importActual<typeof import("./transit-grid")>("./transit-grid");
  buildRingsMock.mockImplementation((...args: Parameters<typeof actual.buildRings>) =>
    actual.buildRings(...args),
  );
});

describe("transitIsochrone", () => {
  it("returns the ORS-identical {origin, rings[15,30,45]} shape on a valid response", async () => {
    providerFetch.mockResolvedValue(oneToAll([stop(44.44, 26.12, 5), stop(44.475, 26.16, 20)]));
    const result = await transitIsochrone(44.4268, 26.1025);
    expect(result.origin).toEqual({ lat: 44.4268, lng: 26.1025 });
    expect(result.rings.map((r) => r.minutes)).toEqual([15, 30, 45]);
    expect(result.rings.every((r) => r.geometry.type === "MultiPolygon")).toBe(true);
  });

  it("parses NESTED place.lat/lon (reading item.lat would discard every stop)", async () => {
    providerFetch.mockResolvedValue(oneToAll([stop(44.475, 26.16, 20)]));
    await transitIsochrone(44.4268, 26.1025);
    // The far stop must have reached buildRings — assert it was passed a stop, not [].
    const passedStops = buildRingsMock.mock.calls[0][1] as unknown[];
    expect(passedStops).toHaveLength(1);
  });

  it("drops invalid stops (missing place, non-finite, dur>45, dur<=0, (0,0), out-of-bbox)", async () => {
    providerFetch.mockResolvedValue(
      oneToAll([
        {}, // no place
        stop(NaN, 26.1, 10),
        stop(44.44, 26.12, 99), // dur > 45
        stop(44.44, 26.12, 0), // dur <= 0
        stop(0, 0, 10), // bogus coords
        stop(45.9, 24.9, 10), // Sibiu — outside Bucharest bbox
        stop(44.44, 26.12, 8), // the only valid one
      ]),
    );
    await transitIsochrone(44.4268, 26.1025);
    const passedStops = buildRingsMock.mock.calls[0][1] as unknown[];
    expect(passedStops).toHaveLength(1);
  });

  it("does not throw (→ 500) on null/garbled stop entries; still parses the valid ones", async () => {
    providerFetch.mockResolvedValue(
      oneToAll([null, { place: null }, { duration: 5 }, stop(44.44, 26.12, 8)]),
    );
    const result = await transitIsochrone(44.4268, 26.1025);
    expect(result.rings).toHaveLength(3);
    expect(buildRingsMock.mock.calls[0][1] as unknown[]).toHaveLength(1);
  });

  it("a valid empty stop array yields origin-only rings (walk-only), not an error", async () => {
    providerFetch.mockResolvedValue(oneToAll([]));
    const result = await transitIsochrone(44.4268, 26.1025);
    expect(result.rings).toHaveLength(3);
    expect((buildRingsMock.mock.calls[0][1] as unknown[])).toHaveLength(0);
  });

  it("throws ProviderError when the envelope has no stop array (garbled 200)", async () => {
    providerFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    await expect(transitIsochrone(44.4, 26.1)).rejects.toThrow(/malformed/i);
  });

  it("throws ProviderError when `all` is not an array", async () => {
    providerFetch.mockResolvedValue(oneToAll("nope"));
    await expect(transitIsochrone(44.4, 26.1)).rejects.toThrow(/malformed/i);
  });

  it("throws ProviderError on a non-ok status", async () => {
    providerFetch.mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({}) });
    await expect(transitIsochrone(44.4, 26.1)).rejects.toThrow(/429/);
  });

  it("wraps a network failure as ProviderError (→ 502)", async () => {
    providerFetch.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    await expect(transitIsochrone(44.4, 26.1)).rejects.toThrow(/request failed/i);
  });

  it("wraps a malformed-JSON parse failure as ProviderError", async () => {
    providerFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("bad json")),
    });
    await expect(transitIsochrone(44.4, 26.1)).rejects.toThrow(/request failed/i);
  });

  it("maps a geometry-construction failure to ProviderError (→ 502), not a 500", async () => {
    providerFetch.mockResolvedValue(oneToAll([stop(44.44, 26.12, 5)]));
    buildRingsMock.mockImplementation(() => {
      throw new Error("contour blew up");
    });
    await expect(transitIsochrone(44.4, 26.1)).rejects.toThrow(/construction failed/i);
  });

  it("rounds a high-precision origin to 5 decimals", async () => {
    providerFetch.mockResolvedValue(oneToAll([]));
    const result = await transitIsochrone(44.426812345, 26.102534567);
    expect(result.origin).toEqual({ lat: 44.42681, lng: 26.10253 });
  });

  it("serves a cache hit without a second fetch", async () => {
    providerFetch.mockResolvedValue(oneToAll([stop(44.44, 26.12, 5)]));
    const first = await transitIsochrone(44.4, 26.1);
    const second = await transitIsochrone(44.4, 26.1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
});

describe("representativeDeparture", () => {
  it("pins the upcoming Wednesday at 08:30 Europe/Bucharest (05:30Z in summer / DST)", () => {
    const iso = representativeDeparture(new Date("2026-07-16T12:00:00Z")); // a Thursday in July (EEST +03)
    const d = new Date(iso);
    expect(d.getUTCDay()).toBe(3); // Wednesday
    expect([d.getUTCHours(), d.getUTCMinutes()]).toEqual([5, 30]);
    expect(d.getTime()).toBeGreaterThan(Date.parse("2026-07-16T12:00:00Z"));
  });

  it("is DST-correct in winter (08:30 EET = 06:30Z)", () => {
    const iso = representativeDeparture(new Date("2026-01-15T12:00:00Z")); // January (EET +02)
    const d = new Date(iso);
    expect(d.getUTCDay()).toBe(3);
    expect([d.getUTCHours(), d.getUTCMinutes()]).toEqual([6, 30]);
  });

  it("is strictly upcoming — on a Wednesday it picks next week's, never today", () => {
    const now = new Date("2026-07-22T12:00:00Z"); // a Wednesday
    const d = new Date(representativeDeparture(now));
    expect(d.getUTCDay()).toBe(3);
    expect(d.getTime() - now.getTime()).toBeGreaterThan(5 * 24 * 3600 * 1000); // ~7 days out
  });
});
