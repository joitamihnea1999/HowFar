import { describe, expect, it } from "vitest";

import {
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

  it("is false for the same origin (a mode toggle → persist, no refetch)", () => {
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
