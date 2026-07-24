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

import { bestPlan, parseItinerary, planTrip, TRANSFER_PENALTY_S, type ReachPlan } from "./transit-plan";
import sample from "./__fixtures__/reach-plan-sample.json";
import multi from "./__fixtures__/reach-plan-multi.json";

// Build a minimal itinerary (transit legs named by their line) for penalty tests.
function itin(durationSec: number, transfers: number, lines: string[]) {
  return {
    duration: durationSec,
    transfers,
    legs: lines.map((l, i) => ({ mode: "BUS", routeShortName: l, duration: Math.round(durationSec / lines.length), from: { name: `S${i}` }, to: { name: `S${i + 1}` } })),
  };
}
const transitLines = (p: Extract<ReachPlan, { reachable: true }>) => p.legs.filter((l) => l.mode !== "WALK").map((l) => l.line);

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
    // These fixtures carry names only (no lat/lon/legGeometry), so from/to are
    // undefined (dropped by toEqual) and path is []. Real geometry is exercised
    // by the self-consistent fixture test below.
    expect(plan.legs[1]).toEqual({ mode: "BUS", line: "243", headsign: "Bd. Lacul Tei", fromName: "Emil Racovita", toName: "Soseaua Colentina", minutes: 50, path: [] });
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
    expect(plan.legs[0]).toEqual({ mode: "BUS", fromName: "", toName: "", minutes: 2, path: [] });
  });

  it("does NOT coerce null/blank endpoint coords to (0,0) — a leg with no numeric coords has undefined from/to", () => {
    // Number(null)===0 / Number("")===0 would otherwise plant a false (0,0) stop
    // off West Africa and draw a bogus straight route there (review).
    const plan = parseItinerary({
      legs: [{ mode: "BUS", duration: 300, from: { name: "X", lat: null, lon: null }, to: { name: "Y", lat: "", lon: "" } }],
    }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.legs[0].from).toBeUndefined();
    expect(plan.legs[0].to).toBeUndefined();
  });

  it("caps legs per itinerary so a degenerate response can't build an unbounded plan", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ mode: "BUS", duration: 120, from: { name: `S${i}` }, to: { name: `S${i + 1}` } }));
    const plan = parseItinerary({ duration: 3600, transfers: 0, legs: many }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.legs.length).toBeLessThanOrEqual(24);
  });

  // Self-consistent geometry check (plan-panel, Critical): rather than pin the
  // precision-7 decode to hardcoded magic numbers, assert that each leg's decoded
  // legGeometry endpoints reproduce THAT leg's own from/to coords, from a real
  // committed /plan capture. If the MOTIS scale ever changes, this fails loudly
  // instead of enshrining a wrong precision that still "passes".
  it("decodes each fixture leg's geometry consistently with its own from/to coords", () => {
    const plan = parseItinerary(sample.itineraries[0]) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.legs.length).toBeGreaterThan(0);
    let drawnLegs = 0;
    for (const leg of plan.legs) {
      expect(leg.from).toBeDefined();
      expect(leg.to).toBeDefined();
      if (leg.path && leg.path.length >= 2) {
        drawnLegs++;
        const first = leg.path[0];
        const last = leg.path[leg.path.length - 1];
        expect(first[0]).toBeCloseTo(leg.from!.lng, 3);
        expect(first[1]).toBeCloseTo(leg.from!.lat, 3);
        expect(last[0]).toBeCloseTo(leg.to!.lng, 3);
        expect(last[1]).toBeCloseTo(leg.to!.lat, 3);
      }
    }
    expect(drawnLegs).toBeGreaterThan(0); // the fixture must actually exercise decoding
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

describe("bestPlan transfer penalty + within-band (task 057)", () => {
  it("prefers the DIRECT Tram-1 trip over the marginally-faster Tram+Bus, on the real fixture", () => {
    const plan = bestPlan(multi) as Extract<ReachPlan, { reachable: true }>;
    // The direct itinerary is Tram 1 only (0 transfers, 1800s); the old pure-fastest
    // pick was Tram 1 + Bus 116 (1 transfer, 1500s) — a 5-min saving not worth a transfer.
    expect(plan.transfers).toBe(0);
    expect(transitLines(plan)).toEqual(["1"]);
    expect(plan.totalMinutes).toBe(30);
  });

  it("keeps the direct trip at the exact penalty boundary (Δ === penalty → fewer transfers wins)", () => {
    const direct = itin(1800, 0, ["1"]);
    const transfer = itin(1800 - TRANSFER_PENALTY_S, 1, ["1", "116"]); // saves exactly the penalty
    const plan = bestPlan({ itineraries: [transfer, direct] }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.transfers).toBe(0);
    expect(transitLines(plan)).toEqual(["1"]);
  });

  it("still takes the transfer when it saves MORE than the penalty", () => {
    const direct = itin(3600, 0, ["1"]); // 60 min direct
    const transfer = itin(1800, 1, ["1", "116"]); // 30 min — saves 30 min >> 6 min penalty
    const plan = bestPlan({ itineraries: [direct, transfer] }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.transfers).toBe(1);
    expect(transitLines(plan)).toEqual(["1", "116"]);
  });

  it("tolerates malformed/negative/missing transfer counts and still scores correctly against a real multi-transfer trip", () => {
    // "oops" must normalise to 0 (NOT NaN — a NaN cost would sort unpredictably in
    // Array.sort and could let the worse trip win). The malformed 0-transfer trip
    // (cost 1600) must beat the real 2-transfer trip (cost 1500 + 2×360 = 2220).
    const malformed = { duration: 1600, transfers: "oops", legs: [{ mode: "TRAM", routeShortName: "1", duration: 1600, from: { name: "A" }, to: { name: "B" } }] };
    const realTwoTransfer = { duration: 1500, transfers: 2, legs: [{ mode: "BUS", routeShortName: "9", duration: 1500, from: { name: "A" }, to: { name: "B" } }] };
    const plan = bestPlan({ itineraries: [realTwoTransfer as never, malformed as never] }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.transfers).toBe(0); // malformed normalised to 0
    expect(transitLines(plan)).toEqual(["1"]); // the malformed 0-transfer trip won on penalised cost
    // A negative count also clamps to 0 (no negative reward).
    const neg = bestPlan({ itineraries: [{ duration: 1500, transfers: -5, legs: [{ mode: "BUS", routeShortName: "7", duration: 1500, from: { name: "A" }, to: { name: "B" } }] } as never] }) as Extract<ReachPlan, { reachable: true }>;
    expect(neg.transfers).toBe(0);
  });

  it("within-band pre-filter excludes an over-band faster/simpler trip so the reach claim holds", () => {
    const withinTransfer = itin(1500, 1, ["1", "116"]); // 25 min, within a 30-min band
    const overBandDirect = itin(1700, 0, ["4"]); // 28.3 min, 0 transfers — would WIN on penalty…
    // …but it is over a 26-min (1560s) band. With the band it must be excluded.
    const body = { itineraries: [withinTransfer, overBandDirect] };
    // No band: the over-band direct wins on the penalty (1700 < 1500+360=1860).
    expect(transitLines(bestPlan(body) as Extract<ReachPlan, { reachable: true }>)).toEqual(["4"]);
    // With a 1560s band: the over-band direct is filtered out → the within-band trip wins.
    expect(transitLines(bestPlan(body, { maxSeconds: 1560 }) as Extract<ReachPlan, { reachable: true }>)).toEqual(["1", "116"]);
  });

  it("keeps all candidates when NONE fit the band (never returns unreachable just because the band is tight)", () => {
    const a = itin(2000, 0, ["1"]);
    const b = itin(2200, 1, ["1", "116"]);
    const plan = bestPlan({ itineraries: [a, b] }, { maxSeconds: 600 }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.reachable).toBe(true);
    expect(transitLines(plan)).toEqual(["1"]); // cheapest overall, band ignored since none qualify
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
    expect([...store.keys()][0]).toMatch(/^reach:plan:v3:44\.37600,26\.12500:44\.47800,26\.12800:/);
  });

  it("keys distinctly by maxMinutes (band) so a different band can't reuse another band's pick", async () => {
    providerFetch.mockResolvedValue(planResponse([SLOW, FAST]));
    await planTrip(FROM, TO, DEP, 30);
    await planTrip(FROM, TO, DEP, 45);
    // Two distinct provider calls + two cache rows (different band suffix).
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect([...store.keys()].every((k) => k.startsWith("reach:plan:v3:"))).toBe(true);
    expect(new Set([...store.keys()]).size).toBe(2);
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
