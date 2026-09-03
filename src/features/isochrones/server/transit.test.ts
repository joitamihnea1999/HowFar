import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, providerFetch, buildRingsMock, walkingIsochroneMock, walkingPresetIsochroneMock } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  providerFetch: vi.fn(),
  buildRingsMock: vi.fn(),
  walkingIsochroneMock: vi.fn(),
  walkingPresetIsochroneMock: vi.fn(),
}));

vi.mock("@/features/isochrones/server/ors", () => ({
  walkingIsochrone: walkingIsochroneMock,
  walkingPresetIsochrone: walkingPresetIsochroneMock,
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

// Delegate to the real grid builder by default; individual tests can override
// (e.g. to force a construction failure → ProviderError).
vi.mock("@/features/isochrones/server/transit-grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transit-grid")>()),
  buildRings: (...args: unknown[]) => buildRingsMock(...args),
}));

import { PACE_MODEL } from "@/features/isochrones/pace";
import { departureFields, TIME_PRESETS } from "@/features/isochrones/time-context";
import { ONE_TO_ALL_BUDGET_MS, representativeDeparture, transitIsochrone, transitPresetIsochrone } from "./transit";

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
  // Default: ORS unavailable → the provider takes the radial-origin fallback,
  // preserving the historical semantics every pre-union test asserts. The
  // rejection is consumed by transit.ts's immediate .catch (no unhandled).
  walkingIsochroneMock.mockRejectedValue(new Error("ORS down (test default)"));
  walkingPresetIsochroneMock.mockRejectedValue(new Error("ORS down (test default)"));
  errSpy?.mockRestore();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); // silence the fallback log
});

let errSpy: ReturnType<typeof vi.spyOn> | undefined;

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

  it("throws ProviderError on a non-ok status, and does NOT retry a deterministic status (1 call)", async () => {
    providerFetch.mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({}) });
    await expect(transitIsochrone(44.4, 26.1)).rejects.toThrow(/429/);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("wraps a PERSISTENT network failure as ProviderError (→ 502) after ONE retry (2 calls)", async () => {
    providerFetch.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    await expect(transitIsochrone(44.4, 26.1)).rejects.toThrow(/request failed/i);
    expect(providerFetch).toHaveBeenCalledTimes(2); // transient → retried once
  });

  it("bounds each one-to-all attempt by the absolute budget (single modestly-long attempt, task 018 G1/G3)", async () => {
    providerFetch.mockResolvedValue(oneToAll([stop(44.475, 26.16, 20)]));
    await transitIsochrone(44.4, 26.1);
    const opts = providerFetch.mock.calls[0][1] as { timeoutMs?: number; signal?: AbortSignal };
    expect(opts.timeoutMs).toBe(ONE_TO_ALL_BUDGET_MS); // NOT a shorter split value
    expect(opts.signal).toBeInstanceOf(AbortSignal); // absolute budget signal
  });

  it("RETRIES a fast abort-shaped failure then succeeds (owner: 'identical retries succeed') — 2 calls (task 018)", async () => {
    providerFetch
      .mockRejectedValueOnce(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce(oneToAll([stop(44.475, 26.16, 20)]));
    const res = await transitIsochrone(44.4, 26.1);
    expect(res.rings.map((r) => r.minutes)).toEqual([15, 30, 45]);
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it("RETRIES a mid-body read failure (undici 'terminated' from res.json()) then succeeds — 2 calls (task 018 F3)", async () => {
    providerFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.reject(new TypeError("terminated")) })
      .mockResolvedValueOnce(oneToAll([stop(44.475, 26.16, 20)]));
    const res = await transitIsochrone(44.4, 26.1);
    expect(res.rings.map((r) => r.minutes)).toEqual([15, 30, 45]);
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it("HEALS a transient one-to-all failure: fail-then-succeed returns rings via 2 calls (task 018)", async () => {
    providerFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(oneToAll([stop(44.44, 26.12, 5), stop(44.475, 26.16, 20)]));
    const res = await transitIsochrone(44.4, 26.1);
    expect(res.rings.map((r) => r.minutes)).toEqual([15, 30, 45]);
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it("a fully-stalled one-to-all is bounded by the budget signal — rejects (honest 502) within ONE_TO_ALL_BUDGET_MS, never hangs (task 018)", async () => {
    vi.useFakeTimers();
    try {
      // Resolves only if aborted — mimics a remote that never answers; the
      // absolute budget signal we pass must abort it and bound the whole call.
      providerFetch.mockImplementation(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted by budget"), { name: "AbortError" })),
);
          }),
);
      const pending = transitIsochrone(44.4, 26.1);
      const guarded = expect(pending).rejects.toThrow(/request failed/i);
      await vi.advanceTimersByTimeAsync(ONE_TO_ALL_BUDGET_MS + 1000);
      await guarded;
    } finally {
      vi.useRealTimers();
    }
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

  it("skips the radial origin stamp and unions the walk rings when ORS succeeds", async () => {
    const sq = (half: number) => [[
      [26.1025 - half, 44.4268 - half], [26.1025 + half, 44.4268 - half],
      [26.1025 + half, 44.4268 + half], [26.1025 - half, 44.4268 + half],
      [26.1025 - half, 44.4268 - half],
    ]];
    walkingIsochroneMock.mockResolvedValue({
      origin: { lat: 44.4268, lng: 26.1025 },
      rings: [15, 30, 45].map((m, i) => ({
        minutes: m,
        geometry: { type: "Polygon", coordinates: sq(0.005 * (i + 1)) },
      })),
    });
    providerFetch.mockResolvedValue(oneToAll([stop(44.475, 26.16, 20)]));
    const result = await transitIsochrone(44.4268, 26.1025);
    // buildRings was told NOT to stamp the origin (egress speed also threaded)...
    expect(buildRingsMock.mock.calls[0][2]).toMatchObject({ stampOrigin: false });
    // ...and the walk square landed in the output via the union: the ORIGIN
    // (inside the walk square, far from the only stop) is in its own 15-ring.
    expect(result.rings.map((r) => r.minutes)).toEqual([15, 30, 45]);
    const [r15] = result.rings;
    expect((r15.geometry.coordinates as unknown[]).length).toBeGreaterThan(0);
    expect(booleanPointInPolygon([26.1025, 44.4268], {
      type: "Feature", properties: {},
      geometry: r15.geometry as never,
    })).toBe(true);
  });

  it("rebuilds the WHOLE family with the radial stamp when the union fails (no mixed rings)", async () => {
    walkingIsochroneMock.mockResolvedValue({
      origin: { lat: 44.4268, lng: 26.1025 },
      rings: [15, 30, 45].map((m) => ({
        minutes: m,
        geometry: { type: "Polygon", coordinates: [[["x"]]] }, // degenerate → union fails
      })),
    });
    providerFetch.mockResolvedValue(oneToAll([stop(44.44, 26.12, 5)]));
    const result = await transitIsochrone(44.4268, 26.1025);
    // First build skipped the origin stamp (walk rings were expected); the
    // all-or-nothing union returned null → one full radial rebuild, never a mix.
    expect(buildRingsMock.mock.calls.map((c) => (c[2] as { stampOrigin: boolean }).stampOrigin)).toEqual([
      false,
      true,
    ]);
    // Both builds carry the normal-pace egress speed EXACTLY (a `typeof
    // === "number"` check here would have passed the pre-064 speed unchanged).
    for (const c of buildRingsMock.mock.calls) {
      expect((c[2] as { egressMPerMin: number }).egressMPerMin).toBeCloseTo(PACE_MODEL.normal.egressMPerMin, 10);
    }
    expect(booleanPointInPolygon([26.1025, 44.4268], {
      type: "Feature", properties: {},
      geometry: result.rings[0].geometry as never,
    })).toBe(true); // origin present via the radial stamp
  });

  it("ships with the radial fallback when the walk rings hang (bounded wait, no hostage response)", async () => {
    vi.useFakeTimers();
    try {
      walkingIsochroneMock.mockReturnValue(new Promise(() => {})); // stalled body / deep queue
      providerFetch.mockResolvedValue(oneToAll([stop(44.44, 26.12, 5)]));
      const pending = transitIsochrone(44.4268, 26.1025);
      await vi.advanceTimersByTimeAsync(8_100); // past WALK_RINGS_TIMEOUT_MS
      const result = await pending;
      expect(result.rings).toHaveLength(3);
      expect(buildRingsMock.mock.calls[0][2]).toMatchObject({ stampOrigin: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("zero stops + walk rings available ⇒ the response IS the walk rings (as MultiPolygons)", async () => {
    const sq = (half: number) => [[
      [26.1025 - half, 44.4268 - half], [26.1025 + half, 44.4268 - half],
      [26.1025 + half, 44.4268 + half], [26.1025 - half, 44.4268 + half],
      [26.1025 - half, 44.4268 - half],
    ]];
    const walkRings = [15, 30, 45].map((m, i) => ({
      minutes: m,
      geometry: { type: "Polygon" as const, coordinates: sq(0.005 * (i + 1)) },
    }));
    walkingIsochroneMock.mockResolvedValue({ origin: { lat: 44.4268, lng: 26.1025 }, rings: walkRings });
    providerFetch.mockResolvedValue(oneToAll([]));
    const result = await transitIsochrone(44.4268, 26.1025);
    expect(result.rings).toEqual(
      walkRings.map((w) => ({
        minutes: w.minutes,
        geometry: { type: "MultiPolygon", coordinates: [w.geometry.coordinates] },
      })),
);
  });

  it("falls back to the radial origin stamp when ORS fails (response still ships)", async () => {
    providerFetch.mockResolvedValue(oneToAll([stop(44.44, 26.12, 5)]));
    const result = await transitIsochrone(44.4268, 26.1025); // default mock: ORS down
    expect(buildRingsMock.mock.calls[0][2]).toMatchObject({ stampOrigin: true });
    expect(result.rings).toHaveLength(3);
    expect(booleanPointInPolygon([26.1025, 44.4268], {
      type: "Feature", properties: {},
      geometry: result.rings[0].geometry as never,
    })).toBe(true); // origin walk area present via the radial fallback
  });

  it("serves a cache hit without a second fetch, under the v5 key", async () => {
    providerFetch.mockResolvedValue(oneToAll([stop(44.44, 26.12, 5)]));
    const first = await transitIsochrone(44.4, 26.1);
    const second = await transitIsochrone(44.4, 26.1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    // v5 key (task 064): pace+departure scoped; pre-064 (v4) rings were built at
    // the old walk speed and must never serve.
    expect([...store.keys()].every((k) => k.startsWith("transit:v5:"))).toBe(true);
  });

  it("pins the speed model and routed transfers in the one-to-all request", async () => {
    providerFetch.mockResolvedValue(oneToAll([]));
    await transitIsochrone(44.4, 26.1);
    const url = providerFetch.mock.calls[0][0] as string;
    expect(url).toContain("pedestrianSpeed=1.389");
    expect(url).toContain("useRoutedTransfers=true");
  });

  it("defaults to today's public Transitous host, and a TRANSIT_BASE_URL override moves URL + rateHost (task 007)", async () => {
    providerFetch.mockResolvedValue(oneToAll([]));
    await transitIsochrone(44.4, 26.1);
    const [defUrl, defOpts] = providerFetch.mock.calls[0] as [string, { rateHost: string; provider: string; minIntervalMs: number }];
    expect(defUrl.startsWith("https://api.transitous.org/api/v6/one-to-all?")).toBe(true);
    expect(defOpts.rateHost).toBe("api.transitous.org");
    // task 009: shares the `transit` bucket with transit-plan; interval default 1500
    expect(defOpts.provider).toBe("transit");
    expect(defOpts.minIntervalMs).toBe(1500);

    vi.stubEnv("TRANSIT_BASE_URL", "https://motis.internal");
    try {
      providerFetch.mockClear();
      store.clear();
      providerFetch.mockResolvedValue(oneToAll([]));
      await transitIsochrone(44.41, 26.11); // fresh coords → not cached
      const [url, opts] = providerFetch.mock.calls[0] as [string, { rateHost: string }];
      expect(url.startsWith("https://motis.internal/api/v6/one-to-all?")).toBe(true);
      expect(opts.rateHost).toBe("motis.internal");
      // Cache key config-namespaced under the override (guards the wrapper).
      expect([...store.keys()].every((k) => /^[0-9a-f]{8}:transit:/.test(k))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads the interval from config, not a hardcoded constant (non-default, above floor)", async () => {
    vi.stubEnv("TRANSIT_MIN_INTERVAL_MS", "9999");
    try {
      providerFetch.mockResolvedValue(oneToAll([]));
      await transitIsochrone(44.4, 26.1);
      const opts = providerFetch.mock.calls[0][1] as { minIntervalMs: number };
      expect(opts.minIntervalMs).toBe(9999);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("threads SLOW all the way through: MOTIS access speed, egress stamping, and the cache key", async () => {
    // Task 064: every transit contract test ran at the default
    // pace, so a broken pace→provider path would have shipped green. Slow must
    // reach BOTH provider surfaces and the key, with its OWN egress speed.
    providerFetch.mockResolvedValue(oneToAll([]));
    await transitIsochrone(44.4, 26.1, "slow");
    const url = providerFetch.mock.calls[0][0] as string;
    expect(url).toContain("pedestrianSpeed=0.833");
    for (const call of buildRingsMock.mock.calls) {
      expect((call[2] as { egressMPerMin: number }).egressMPerMin).toBeCloseTo(
        PACE_MODEL.slow.egressMPerMin,
        10,
);
    }
    expect([...store.keys()].every((k) => k.startsWith("transit:v5:slow:"))).toBe(true);
    // …and the origin walk ring was requested at the same pace (one source).
    expect(walkingIsochroneMock).toHaveBeenCalledWith(44.4, 26.1, "slow");
  });

  it("returns the pinned representative departure so the UI can qualify the claim", async () => {
    providerFetch.mockResolvedValue(oneToAll([]));
    const result = await transitIsochrone(44.4, 26.1);
    expect(result.departure).toBe(representativeDeparture());
  });

  it("coalesces two concurrent cold requests for the same origin into ONE one-to-all", async () => {
    let resolveFetch!: (v: unknown) => void;
    providerFetch.mockReturnValue(new Promise((r) => (resolveFetch = r)));
    const p1 = transitIsochrone(44.4, 26.1);
    const p2 = transitIsochrone(44.4, 26.1);
    await new Promise((r) => setTimeout(r, 0)); // drain cache reads + in-flight registration
    resolveFetch(oneToAll([stop(44.44, 26.12, 5)]));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
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

  it("resolves every preset to its own weekday + local hour/minute (summer)", () => {
    const now = new Date("2026-07-20T09:00:00Z"); // Monday, EEST +03
    for (const p of Object.values(TIME_PRESETS)) {
      const d = new Date(representativeDeparture(now, departureFields({ kind: "preset", preset: p.id })));
      expect(d.getUTCDay()).toBe(p.weekday);
      // local wall time = UTC + 3 in summer
      expect((d.getUTCHours() + 3) % 24).toBe(p.hour);
      expect(d.getUTCMinutes()).toBe(p.minute);
      expect(d.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("is DST-correct across a fall-back weekend (offset fixpoint) — raw upcoming fields", () => {
    // The resolver takes DepartureFields directly, so DST correctness is still
    // proven without the removed Custom mode (task 059). now: Fri 2026-10-23
    // (EEST +03). Bucharest falls back Sun 2026-10-25 03:00, so the upcoming
    // Sunday 10:00 is post-transition ⇒ EET (+02) ⇒ 10:00 local = 08:00Z.
    // (Naively applying now's +03 offset would give the wrong instant.)
    const now = new Date("2026-10-23T09:00:00Z");
    const d = new Date(representativeDeparture(now, { weekday: 0, hour: 10, minute: 0 }));
    expect(d.getUTCDay()).toBe(0); // Sunday
    expect(d.getUTCDate()).toBe(25);
    expect([d.getUTCHours(), d.getUTCMinutes()]).toEqual([8, 0]); // 10:00 EET(+2) = 08:00Z
  });

  it("PROPERTY: always strictly future & the requested weekday, across a week of `now`s and every preset", () => {
    for (let h = 0; h < 7 * 24; h += 5) {
      const now = new Date(Date.parse("2026-07-13T00:00:00Z") + h * 3600 * 1000);
      for (const p of Object.values(TIME_PRESETS)) {
        const d = new Date(representativeDeparture(now, departureFields({ kind: "preset", preset: p.id })));
        expect(d.getTime()).toBeGreaterThan(now.getTime());
        expect(d.getUTCDay()).toBe(p.weekday);
      }
    }
  });
});

// --- phone-first preset: PRESET transit path (thresholds [20,40], fail-closed) ------------
describe("transitPresetIsochrone (phone-first preset: [20,40], field-at-45, FAIL-CLOSED)", () => {
  const sq = (half: number) => [[
    [26.1025 - half, 44.4268 - half], [26.1025 + half, 44.4268 - half],
    [26.1025 + half, 44.4268 + half], [26.1025 - half, 44.4268 + half],
    [26.1025 - half, 44.4268 - half],
  ]];
  const presetWalk = (coords: (half: number) => number[][][]) => ({
    origin: { lat: 44.4268, lng: 26.1025 },
    // walkingPresetIsochrone returns [10,20,40]; the preset variant slices to [20,40].
    rings: [10, 20, 40].map((m, i) => ({ minutes: m, geometry: { type: "Polygon" as const, coordinates: coords(0.006 * (i + 1)) } })),
  });

  it("returns rings labelled [20,40] via the walk UNION and caches under transit:preset:v1", async () => {
    walkingPresetIsochroneMock.mockResolvedValue(presetWalk(sq));
    providerFetch.mockResolvedValue(oneToAll([stop(44.475, 26.16, 25)]));
    const result = await transitPresetIsochrone(44.4268, 26.1025);
    expect(result.rings.map((r) => r.minutes)).toEqual([20, 40]);
    // buildRings was told the preset thresholds + the field-at-45 (exact invariance).
    expect(buildRingsMock.mock.calls[0][2]).toMatchObject({ stampOrigin: false, thresholds: [20, 40], fieldMaxMin: 45 });
    expect([...store.keys()].some((k) => k.includes("transit:preset:v1:normal:"))).toBe(true);
    expect([...store.keys()].some((k) => k.includes("transit:v5:"))).toBe(false);
  });

  it("FAILS CLOSED (502, no cache write) when the walk rings are unavailable — never the radial fallback", async () => {
    walkingPresetIsochroneMock.mockRejectedValue(new Error("ORS down"));
    providerFetch.mockResolvedValue(oneToAll([stop(44.475, 26.16, 25)]));
    await expect(transitPresetIsochrone(44.4268, 26.1025)).rejects.toThrow(/fail-closed|unavailable/i);
    expect([...store.keys()].some((k) => k.includes("transit:preset:v1"))).toBe(false);
  });

  it("FAILS CLOSED when the walk-ring UNION cannot be formed (degenerate walk geometry) — no radial rebuild", async () => {
    walkingPresetIsochroneMock.mockResolvedValue(presetWalk(() => [[["x"] as unknown as number[]]]));
    providerFetch.mockResolvedValue(oneToAll([stop(44.44, 26.12, 10)]));
    await expect(transitPresetIsochrone(44.4268, 26.1025)).rejects.toThrow(/fail-closed|unavailable/i);
    expect([...store.keys()].some((k) => k.includes("transit:preset:v1"))).toBe(false);
  });

  it("legacy transitIsochrone still radial-falls-back (unchanged) while preset fails closed — the two are isolated", async () => {
    // Legacy: walk unavailable → radial rings [15,30,45] (historical behavior).
    providerFetch.mockResolvedValue(oneToAll([stop(44.44, 26.12, 10)]));
    const legacy = await transitIsochrone(44.4268, 26.1025);
    expect(legacy.rings.map((r) => r.minutes)).toEqual([15, 30, 45]);
  });
});
