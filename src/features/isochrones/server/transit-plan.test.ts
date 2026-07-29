import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, expiries, providerFetch } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  expiries: new Map<string, Date>(),
  providerFetch: vi.fn(),
}));

vi.mock("@/lib/api-cache", () => ({
  getCachedSafe: (key: string) => Promise.resolve(store.has(key) ? store.get(key) : null),
  setCachedSafe: (key: string, value: unknown, expiresAt: Date) => {
    store.set(key, value);
    expiries.set(key, expiresAt);
    return Promise.resolve();
  },
}));

vi.mock("@/lib/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provider-http")>()),
  providerFetch,
}));

import { REACH_TIMEOUT_MS } from "@/features/map/reach-directions-controller";

import {
  bestPlan,
  parseItinerary,
  planTrip,
  PLAN_BUDGET_MS,
  PLAN_MAX_POST_TRANSIT_S,
  TRANSFER_PENALTY_S,
  type ReachPlan,
} from "./transit-plan";
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
  expiries.clear();
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

  it("a malformed IN-BAND winner cannot hide a valid OVER-BAND trip (band partition, not filter)", () => {
    // The in-band candidate trims to no legs; the only real trip exceeds the
    // band. The old filter dropped over-band candidates whenever any in-band
    // one existed, turning this response into a false "not reachable".
    const brokenInBand = {
      duration: 20 * 60,
      transfers: 0,
      legs: [{ mode: "WALK", duration: 20, from: { name: "START" }, to: { name: "END" } }],
    };
    const plan = bestPlan({ itineraries: [brokenInBand, FAST] }, { maxSeconds: 30 * 60 }) as Extract<
      ReachPlan,
      { reachable: true }
    >;
    expect(plan.reachable).toBe(true);
    expect(plan.totalMinutes).toBe(57); // the over-band FAST trip, served with band-honest copy
  });

  it("skips a malformed winner whose legs all trim away and returns the next valid candidate", () => {
    // Fastest candidate has only a 0-min WALK stub — parseItinerary trims it to
    // no legs. That must not turn the whole answer into a false "not reachable"
    // while a valid runner-up exists.
    const degenerate = {
      duration: 10 * 60,
      transfers: 0,
      legs: [{ mode: "WALK", duration: 20, from: { name: "START" }, to: { name: "END" } }],
    };
    const plan = bestPlan({ itineraries: [degenerate, FAST] }) as Extract<ReachPlan, { reachable: true }>;
    expect(plan.reachable).toBe(true);
    expect(plan.totalMinutes).toBe(57);
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
    expect([...store.keys()][0]).toMatch(/^reach:plan:v5:44\.37600,26\.12500:44\.47800,26\.12800:/);
  });

  it("keys distinctly by maxMinutes (band) so a different band can't reuse another band's pick", async () => {
    providerFetch.mockResolvedValue(planResponse([SLOW, FAST]));
    await planTrip(FROM, TO, DEP, 30);
    await planTrip(FROM, TO, DEP, 45);
    // Two distinct provider calls + two cache rows (different band suffix).
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect([...store.keys()].every((k) => k.startsWith("reach:plan:v5:"))).toBe(true);
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

  it("matches the painted rings' walking contract: raised LAST street leg, default first leg, ring pedestrian params", async () => {
    providerFetch.mockResolvedValue(planResponse([FAST]));
    await planTrip(FROM, TO, DEP);
    const url = providerFetch.mock.calls[0][0] as string;
    // The rings' egress is our radial walk model (up to the whole remaining
    // band), so the planner must allow the same last-mile walking — with the
    // 900s default, points >15-min walk from every stop got "no route" while
    // painted reachable (the owner-reported right-click flake).
    expect(url).toContain(`maxPostTransitTime=${PLAN_MAX_POST_TRANSIT_S}`);
    expect(PLAN_MAX_POST_TRANSIT_S).toBe(2700); // = the 45-min outer band
    // Ingress stays at the MOTIS default — the rings' one-to-all sends no
    // override either, so raising it would surface trips the map never painted.
    expect(url).not.toContain("maxPreTransitTime");
    // Same pedestrian semantics as the one-to-all that painted the rings.
    expect(url).toContain("pedestrianSpeed=1.389");
    expect(url).toContain("useRoutedTransfers=true");
  });

  it("the server's END-TO-END plan budget stays strictly under the client directions deadline", () => {
    // The server must answer (or 502) while the client is still listening —
    // otherwise a slow success is cached after the client gave up and the very
    // next click "heals", which reads as a flaky product. The budget is
    // enforced by an ABSOLUTE abort signal spanning queue wait + attempt +
    // retry (a per-attempt timeout alone starts after the shared-host queue).
    expect(PLAN_BUDGET_MS).toBeLessThan(REACH_TIMEOUT_MS);
  });

  it("passes the absolute budget signal to every provider attempt", async () => {
    providerFetch.mockResolvedValue(planResponse([FAST]));
    await planTrip(FROM, TO, DEP);
    const opts = providerFetch.mock.calls[0][1] as { signal?: AbortSignal };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("budget overrun: the passed signal FIRES at the deadline, the trip fails as a ProviderError, and NOTHING is cached", async () => {
    vi.useFakeTimers();
    try {
      // The provider resolves only if aborted — mimicking a fetch parked
      // behind a slow shared-host queue that the budget must kill.
      providerFetch.mockImplementation(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => reject(new Error("aborted by budget")));
          }),
      );
      const pending = planTrip(FROM, TO, DEP);
      const guarded = expect(pending).rejects.toThrow(/request failed: aborted by budget/);
      await vi.advanceTimersByTimeAsync(PLAN_BUDGET_MS + 1);
      await guarded;
      // The heal-loop killer: a budget overrun must never write the cache.
      expect(store.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a no-route response is a cacheable not-reachable (not an error)", async () => {
    providerFetch.mockResolvedValue(planResponse([]));
    await expect(planTrip(FROM, TO, DEP)).resolves.toEqual({ reachable: false });
  });

  it("retries ONCE on an empty-itineraries body and serves the retry's routes (transient provider miss)", async () => {
    providerFetch
      .mockResolvedValueOnce(planResponse([]))
      .mockResolvedValueOnce(planResponse([FAST]));
    const plan = await planTrip(FROM, TO, DEP);
    expect(plan).toMatchObject({ reachable: true, totalMinutes: 57 });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    // The GOOD answer is what got cached.
    expect([...store.values()][0]).toMatchObject({ reachable: true });
  });

  it("retry is bounded: two empty bodies mean exactly two provider calls, then not-reachable", async () => {
    providerFetch.mockResolvedValue(planResponse([]));
    await expect(planTrip(FROM, TO, DEP)).resolves.toEqual({ reachable: false });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it("also retries when itineraries are present but ALL garbled (no transit answer emerges)", async () => {
    providerFetch
      .mockResolvedValueOnce(planResponse([{ duration: 0 }, null]))
      .mockResolvedValueOnce(planResponse([FAST]));
    const plan = await planTrip(FROM, TO, DEP);
    expect(plan).toMatchObject({ reachable: true, totalMinutes: 57 });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it("retries a positive-duration itinerary whose legs are all MODELESS (parses to no transit answer)", async () => {
    // `{duration, legs:[{duration}]}` parses to an UNKNOWN-mode leg, which must
    // NOT pass as public transport — and an answer that garbled warrants the
    // one bounded retry like any other effectively-empty response.
    providerFetch
      .mockResolvedValueOnce(planResponse([{ duration: 1200, legs: [{ duration: 1200 }] }]))
      .mockResolvedValueOnce(planResponse([FAST]));
    const plan = await planTrip(FROM, TO, DEP);
    expect(plan).toMatchObject({ reachable: true, totalMinutes: 57 });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a determinate direct-only answer (close destination — citizenship)", async () => {
    const walkDirect = {
      duration: 15 * 60,
      transfers: 0,
      legs: [{ mode: "WALK", duration: 15 * 60, from: { name: "START" }, to: { name: "END" } }],
    };
    providerFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ itineraries: [], direct: [walkDirect] }),
    });
    const plan = await planTrip(FROM, TO, DEP);
    expect(plan).toMatchObject({ reachable: true });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("a FAILED retry falls back to the first, determinate body instead of throwing", async () => {
    providerFetch
      .mockResolvedValueOnce(planResponse([]))
      .mockRejectedValueOnce(new TypeError("network blip"));
    await expect(planTrip(FROM, TO, DEP)).resolves.toEqual({ reachable: false });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    // The determinate answer got cached (short TTL), not dropped.
    expect([...store.values()][0]).toEqual({ reachable: false });
  });

  it("skips the retry when the budget is nearly spent (the deadline covers queue + attempts)", async () => {
    vi.useFakeTimers();
    try {
      providerFetch.mockImplementation(() => {
        // First attempt consumes almost the whole budget (e.g. parked behind a
        // slow one-to-all on the shared host queue) — the retry must not start.
        vi.advanceTimersByTime(PLAN_BUDGET_MS - 1000);
        return Promise.resolve(planResponse([]));
      });
      await expect(planTrip(FROM, TO, DEP)).resolves.toEqual({ reachable: false });
      expect(providerFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches a real transit plan for hours but a no-transit answer only for minutes", async () => {
    const hours = (key: string) => ((expiries.get(key)?.getTime() ?? 0) - Date.now()) / 3_600_000;
    providerFetch.mockResolvedValue(planResponse([FAST]));
    await planTrip(FROM, TO, DEP);
    const transitKey = [...store.keys()][0];
    expect(hours(transitKey)).toBeGreaterThan(1); // ~6h

    store.clear();
    expiries.clear();
    providerFetch.mockReset();
    // Unreachable: empty both attempts.
    providerFetch.mockResolvedValue(planResponse([]));
    await planTrip(FROM, TO, DEP, 30);
    const noneKey = [...store.keys()][0];
    expect(hours(noneKey)).toBeLessThan(0.2); // ~5 min — heals fast
    expect(hours(noneKey)).toBeGreaterThan(0);
  });

  it("a walk-only direct fallback (rendered as 'no route') also gets the short TTL", async () => {
    const walkOnly = {
      duration: 20 * 60,
      transfers: 0,
      legs: [{ mode: "WALK", duration: 20 * 60, from: { name: "START" }, to: { name: "END" } }],
    };
    providerFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ itineraries: [], direct: [walkOnly] }),
    });
    const plan = await planTrip(FROM, TO, DEP);
    expect(plan).toMatchObject({ reachable: true });
    const key = [...store.keys()][0];
    const ttlMin = ((expiries.get(key)?.getTime() ?? 0) - Date.now()) / 60_000;
    expect(ttlMin).toBeLessThan(10);
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
