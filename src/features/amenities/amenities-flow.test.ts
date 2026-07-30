import { describe, expect, it } from "vitest";

import {
  amenityFetchKey,
  AMENITY_MAX_AUTO_RETRIES,
  classifyAmenityFailure,
  isNewAmenityOrigin,
  isRetryableAmenityFailure,
  originKey,
} from "./amenities-flow";

describe("originKey", () => {
  it("rounds to 5 decimals so a pre-round and a rounded origin share a key", () => {
    expect(originKey(44.426812345, 26.102534567)).toBe("44.42681,26.10253");
    // The isochrone returns the already-rounded origin; both must key the same.
    expect(originKey(44.42681, 26.10253)).toBe(originKey(44.426812345, 26.102534567));
  });
});

describe("isNewAmenityOrigin", () => {
  it("is true from a null baseline (first selection)", () => {
    expect(isNewAmenityOrigin(null, originKey(44.4, 26.1))).toBe(true);
  });

  it("is false for an unchanged KEY (⇒ persist; the key itself now carries mode/time)", () => {
    const key = originKey(44.4, 26.1);
    expect(isNewAmenityOrigin(key, key)).toBe(false);
  });

  it("is true for a different origin (a genuinely-new selection → refetch)", () => {
    expect(isNewAmenityOrigin(originKey(44.4, 26.1), originKey(44.5, 26.2))).toBe(true);
  });
});

describe("isRetryableAmenityFailure", () => {
  it("retries transient failures: network errors (null), provider, DB and catalogue 5xx", () => {
    expect(isRetryableAmenityFailure(null)).toBe(true);
    expect(isRetryableAmenityFailure(500)).toBe(true);
    expect(isRetryableAmenityFailure(502)).toBe(true);
    expect(isRetryableAmenityFailure(503)).toBe(true);
    expect(isRetryableAmenityFailure(504)).toBe(true);
  });

  it("never retries deterministic failures: 422 out-of-area, other 4xx, malformed 200", () => {
    expect(isRetryableAmenityFailure(422)).toBe(false);
    expect(isRetryableAmenityFailure(400)).toBe(false);
    expect(isRetryableAmenityFailure(404)).toBe(false);
    // A completed 200 whose body failed shape validation reports its real
    // status — same body would come back on a retry.
    expect(isRetryableAmenityFailure(200)).toBe(false);
  });

  it("caps automatic retries at one (stacked ~18s provider budgets otherwise)", () => {
    expect(AMENITY_MAX_AUTO_RETRIES).toBe(1);
  });
});

describe("classifyAmenityFailure", () => {
  it("retries a transient failure while an attempt budget remains", () => {
    expect(classifyAmenityFailure(null, 0)).toBe("retry");
    expect(classifyAmenityFailure(502, 0)).toBe("retry");
  });

  it("surfaces once the auto-retry budget is spent, even if transient", () => {
    // attempt 1 with max 1 → no budget left → surface (clears origin key upstream).
    expect(classifyAmenityFailure(502, AMENITY_MAX_AUTO_RETRIES)).toBe("surface");
    expect(classifyAmenityFailure(null, 1)).toBe("surface");
  });

  it("surfaces a deterministic failure immediately (never retries a 422/4xx/malformed 200)", () => {
    expect(classifyAmenityFailure(422, 0)).toBe("surface");
    expect(classifyAmenityFailure(404, 0)).toBe("surface");
    expect(classifyAmenityFailure(200, 0)).toBe("surface");
  });

  it("honours an explicit maxRetries override", () => {
    expect(classifyAmenityFailure(500, 1, 2)).toBe("retry");
    expect(classifyAmenityFailure(500, 2, 2)).toBe("surface");
  });
});

describe("amenityFetchKey — what does and does not trigger a refetch (task 065)", () => {
  const origin = { lat: 44.4268, lng: 26.1025 };
  const crowded = { kind: "preset", preset: "crowded" } as const;
  const quiet = { kind: "preset", preset: "quiet" } as const;
  const base = { origin, mode: "walk", pace: "normal", timeContext: crowded } as const;

  it("changes on a MODE toggle — the clip follows the mode, so the place set really differs", () => {
    // This is the contract task 065 REVERSED. Before it, a Walk↔Transit toggle
    // deliberately kept the same key so markers persisted; now they must refetch.
    const walk = amenityFetchKey(base);
    const transit = amenityFetchKey({ ...base, mode: "transit" });
    const car = amenityFetchKey({ ...base, mode: "car" });
    expect(new Set([walk, transit, car]).size).toBe(3);
  });

  it("changes on a crowded↔quiet toggle in the time-aware modes", () => {
    expect(amenityFetchKey({ ...base, mode: "transit", timeContext: crowded })).not.toBe(
      amenityFetchKey({ ...base, mode: "transit", timeContext: quiet }),
    );
    expect(amenityFetchKey({ ...base, mode: "car", timeContext: crowded })).not.toBe(
      amenityFetchKey({ ...base, mode: "car", timeContext: quiet }),
    );
  });

  it("changes on a walking-pace change in walk mode", () => {
    expect(amenityFetchKey({ ...base, pace: "slow" })).not.toBe(amenityFetchKey(base));
  });

  it("is UNCHANGED by a pace change outside walk (effectivePace forces Normal)", () => {
    // A Slow pace left over from Walk must not fragment the transit cache, and must
    // not disagree with the pace the server will actually clip at.
    expect(amenityFetchKey({ ...base, mode: "transit", pace: "slow" })).toBe(
      amenityFetchKey({ ...base, mode: "transit", pace: "normal" }),
    );
    expect(amenityFetchKey({ ...base, mode: "car", pace: "slow" })).toBe(
      amenityFetchKey({ ...base, mode: "car", pace: "normal" }),
    );
  });

  it("changes on a new origin, and is stable for the same origin pre/post rounding", () => {
    expect(amenityFetchKey({ ...base, origin: { lat: 44.5, lng: 26.2 } })).not.toBe(
      amenityFetchKey(base),
    );
    expect(amenityFetchKey({ ...base, origin: { lat: 44.426801, lng: 26.102499 } })).toBe(
      amenityFetchKey({ ...base, origin: { lat: 44.4268, lng: 26.1025 } }),
    );
  });

  it("carries NO ring-filter term — widening or narrowing the rings must not refetch", () => {
    // All three bands arrive in one response and band visibility is applied
    // client-side, so the ring filter is a free local toggle. If a ring-filter term
    // ever leaks into this key, every toggle becomes a request.
    const key = amenityFetchKey(base);
    expect(key).toBe("44.42680,26.10250:walk:normal:crowded");
    for (const filter of [15, 30, 45, "all"]) {
      expect(key).not.toContain(String(filter));
    }
  });
});
