import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { BUCHAREST_BBOX, BUCHAREST_MAX_BOUNDS, inBucharest } from "./bounds";

describe("inBucharest", () => {
  it("accepts every point inside the bbox (property)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: BUCHAREST_BBOX.minLat, max: BUCHAREST_BBOX.maxLat, noNaN: true }),
        fc.double({ min: BUCHAREST_BBOX.minLng, max: BUCHAREST_BBOX.maxLng, noNaN: true }),
        (lat, lng) => inBucharest(lat, lng),
      ),
    );
  });

  it("rejects every point with at least one coordinate outside the bbox (property)", () => {
    const inLat = fc.double({ min: BUCHAREST_BBOX.minLat, max: BUCHAREST_BBOX.maxLat, noNaN: true });
    const inLng = fc.double({ min: BUCHAREST_BBOX.minLng, max: BUCHAREST_BBOX.maxLng, noNaN: true });
    const outLat = fc.oneof(
      fc.double({ min: -90, max: BUCHAREST_BBOX.minLat, maxExcluded: true, noNaN: true }),
      fc.double({ min: BUCHAREST_BBOX.maxLat, minExcluded: true, max: 90, noNaN: true }),
    );
    const outLng = fc.oneof(
      fc.double({ min: -180, max: BUCHAREST_BBOX.minLng, maxExcluded: true, noNaN: true }),
      fc.double({ min: BUCHAREST_BBOX.maxLng, minExcluded: true, max: 180, noNaN: true }),
    );
    fc.assert(fc.property(outLat, inLng, (lat, lng) => !inBucharest(lat, lng)));
    fc.assert(fc.property(inLat, outLng, (lat, lng) => !inBucharest(lat, lng)));
    fc.assert(fc.property(outLat, outLng, (lat, lng) => !inBucharest(lat, lng)));
  });

  it("bbox edges are inside (inclusive bounds)", () => {
    expect(inBucharest(BUCHAREST_BBOX.minLat, BUCHAREST_BBOX.minLng)).toBe(true);
    expect(inBucharest(BUCHAREST_BBOX.maxLat, BUCHAREST_BBOX.maxLng)).toBe(true);
  });

  it("rejects NaN coordinates", () => {
    expect(inBucharest(Number.NaN, 26.1)).toBe(false);
    expect(inBucharest(44.4, Number.NaN)).toBe(false);
  });
});

describe("BUCHAREST_MAX_BOUNDS", () => {
  it("is [[west, south], [east, north]] of the same bbox (MapLibre order)", () => {
    expect(BUCHAREST_MAX_BOUNDS).toEqual([
      [BUCHAREST_BBOX.minLng, BUCHAREST_BBOX.minLat],
      [BUCHAREST_BBOX.maxLng, BUCHAREST_BBOX.maxLat],
    ]);
  });
});
