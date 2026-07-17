import { describe, expect, it } from "vitest";

import { isNewAmenityOrigin, originKey } from "./amenities-flow";

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
