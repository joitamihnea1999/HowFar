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

vi.mock("@/lib/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provider-http")>()),
  providerFetch,
}));

import { bestPlan, parseItinerary, planTrip, type ReachPlan } from "./transit-plan";

// Trimmed from the real Transitous /plan probe (Berceni → north): a WALK→BUS→
// WALK→BUS→WALK itinerary, plus a faster alternative listed AFTER the slow one
// (MOTIS does not sort by duration).
const SLOW = {
  duration: 83 * 60,
  transfers: 1,
  legs: [
    { mode: "WALK", duration: 9 * 60, from: { name: "START" }, to: { name: "Emil Racovita" } },
    { mode: "BUS", duration: 50 * 60, from: { name: "Emil Racovita" }, to: { name: "Soseaua Colentina" }, routeShortName: "243", headsign: "Bd. Lacul Tei" },
    { mode: "WALK", duration: 2 * 60, from: { name: "Soseaua Colentina" }, to: { name: "Soseaua Colentina" } },
    { mode: "BUS", duration: 10 * 60, from: { name: "Soseaua Colentina" }, to: { name: "Fabrica de Glucoza" }, routeShortName: "290", headsign: "Complex Baneasa" },
    { mode: "WALK", duration: 5 * 60, from: { name: "Fabrica de Glucoza" }, to: { name: "END" } },
  ],
};
const FAST = {
  duration: 57 * 60,
  transfers: 0,
  legs: [
    { mode: "WALK", duration: 0, from: { name: "START" }, to: { name: "Piata Sudului" } }, // 0-min stub
    { mode: "SUBWAY", duration: 52 * 60, from: { name: "Piata Sudului" }, to: { name: "Pipera" }, routeShortName: "M2", headsign: "Pipera" },
    { mode: "WALK", duration: 5 * 60, from: { name: "Pipera" }, to: { name: "END" } },
  ],
};

function planResponse(itineraries: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve({ itineraries }) };
}

beforeEach(() => {
  store.clear();
  providerFetch.mockReset();
});

describe("parseItinerary", () => {
  it("trims legs to mode/line/headsign/stop-names/minutes and totals", () => {
    const plan = parseItinerary(SLOW) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.reachable).toBe(true);
    expect(plan.totalMinutes).toBe(83);
    expect(plan.transfers).toBe(1);
    expect(plan.legs).toHaveLength(5);
    expect(plan.legs[1]).toEqual({ mode: "BUS", line: "243", headsign: "Bd. Lacul Tei", fromName: "Emil Racovita", toName: "Soseaua Colentina", minutes: 50 });
    // WALK legs carry no line/headsign.
    expect(plan.legs[0].line).toBeUndefined();
  });

  it("drops negligible (<1 min) WALK stubs but keeps the transit leg", () => {
    const plan = parseItinerary(FAST) as Extract<ReachPlan, { reachable: true }>;
    // The 0-min START walk is dropped; SUBWAY + the 5-min END walk remain.
    expect(plan.legs.map((l) => l.mode)).toEqual(["SUBWAY", "WALK"]);
    expect(plan.legs[0].line).toBe("M2");
  });

  it("an itinerary that trims to no legs is not reachable", () => {
    expect(parseItinerary({ duration: 0, transfers: 0, legs: [{ mode: "WALK", duration: 0 }] })).toEqual({ reachable: false });
    expect(parseItinerary({ legs: [] })).toEqual({ reachable: false });
  });

  it("is defensive about missing/garbled fields", () => {
    const plan = parseItinerary({ legs: [{ mode: "BUS", duration: 120, from: null, to: undefined }] }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.legs[0]).toEqual({ mode: "BUS", fromName: "", toName: "", minutes: 2 });
  });
});

describe("bestPlan", () => {
  it("picks the FASTEST itinerary even when it is not first (MOTIS is unsorted)", () => {
    const plan = bestPlan({ itineraries: [SLOW, FAST] }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.totalMinutes).toBe(57); // the M2 trip, not the 83-min bus one
    expect(plan.legs[0].line).toBe("M2");
  });

  it("no itineraries → not reachable", () => {
    expect(bestPlan({ itineraries: [] })).toEqual({ reachable: false });
    expect(bestPlan({})).toEqual({ reachable: false });
  });

  it("drops malformed itineraries (missing/≤0 duration) so they can't win the sort (T2)", () => {
    const broken = { legs: [{ mode: "BUS", routeShortName: "9", duration: 60, from: { name: "X" }, to: { name: "Y" } }] }; // no duration
    const plan = bestPlan({ itineraries: [broken, FAST] }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.totalMinutes).toBe(57); // the valid trip, not the 0-minute broken one
  });

  it("tolerates a null/garbled itinerary or leg entry without throwing (T2)", () => {
    expect(() => bestPlan({ itineraries: [null as never, SLOW] })).not.toThrow();
    const plan = parseItinerary({ duration: 600, legs: [null as never, { mode: "BUS", routeShortName: "5", duration: 300, from: { name: "A" }, to: { name: "B" } }] }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0].line).toBe("5");
  });

  it("falls back to `direct` (walk-only) when there are no transit itineraries (T4)", () => {
    const walk = { duration: 8 * 60, legs: [{ mode: "WALK", duration: 8 * 60, from: { name: "START" }, to: { name: "END" } }] };
    const plan = bestPlan({ itineraries: [], direct: [walk] }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.totalMinutes).toBe(8);
    expect(plan.legs.every((l) => l.mode === "WALK")).toBe(true);
  });

  it("prefers a transit itinerary over `direct` when both exist (T4)", () => {
    const walk = { duration: 40 * 60, legs: [{ mode: "WALK", duration: 40 * 60, from: { name: "START" }, to: { name: "END" } }] };
    const plan = bestPlan({ itineraries: [FAST], direct: [walk] }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.legs.some((l) => l.mode === "SUBWAY")).toBe(true); // FAST's M2
  });

  it("breaks a duration tie by fewer transfers, tolerating a missing transfer count", () => {
    // `a` has NO transfers field (Number(undefined) → NaN → the `|| 0` fallback
    // treats it as 0); `b` has 2 → `a` wins the tie.
    const a = { duration: 40 * 60, legs: [{ mode: "SUBWAY", routeShortName: "M1", duration: 60, from: { name: "A" }, to: { name: "B" } }] };
    const b = { duration: 40 * 60, transfers: 2, legs: [{ mode: "BUS", routeShortName: "1", duration: 60, from: { name: "A" }, to: { name: "B" } }] };
    const plan = bestPlan({ itineraries: [b, a] }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.legs[0].line).toBe("M1"); // a (0 via fallback) beats b (2)
    expect(plan.transfers).toBe(0);
  });
});

describe("planTrip", () => {
  const FROM = { lat: 44.376, lng: 26.125 };
  const TO = { lat: 44.478, lng: 26.128 };
  const DEP = "2026-07-29T05:30:00.000Z";

  it("fetches, parses the best itinerary, and caches under a from/to/departure key", async () => {
    providerFetch.mockResolvedValue(planResponse([SLOW, FAST]));
    const first = await planTrip(FROM, TO, DEP);
    expect(first).toMatchObject({ reachable: true, totalMinutes: 57 });
    // Second call hits the cache — no second provider request.
    const second = await planTrip(FROM, TO, DEP);
    expect(second).toEqual(first);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect([...store.keys()][0]).toMatch(/^reach:plan:v1:44\.37600,26\.12500:44\.47800,26\.12800:/);
  });

  it("passes fromPlace/toPlace/time to the plan endpoint", async () => {
    providerFetch.mockResolvedValue(planResponse([FAST]));
    await planTrip(FROM, TO, DEP);
    const url = providerFetch.mock.calls[0][0] as string;
    expect(url).toContain("fromPlace=44.37600,26.12500");
    expect(url).toContain("toPlace=44.47800,26.12800");
    expect(url).toContain(`time=${encodeURIComponent(DEP)}`);
  });

  it("a no-route response is a cacheable not-reachable (not an error)", async () => {
    providerFetch.mockResolvedValue(planResponse([]));
    await expect(planTrip(FROM, TO, DEP)).resolves.toEqual({ reachable: false });
  });

  it("a malformed body (no itineraries array) is a ProviderError", async () => {
    providerFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    await expect(planTrip(FROM, TO, DEP)).rejects.toThrow(/malformed/);
  });

  it("a non-ok upstream is a ProviderError (→ 502 at the route)", async () => {
    providerFetch.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) });
    await expect(planTrip(FROM, TO, DEP)).rejects.toThrow(/503/);
  });

  it("a network failure (fetch rejects) is wrapped as a ProviderError", async () => {
    providerFetch.mockRejectedValueOnce(new TypeError("network down"));
    await expect(planTrip(FROM, TO, DEP)).rejects.toThrow(/request failed: network down/);
  });
});
