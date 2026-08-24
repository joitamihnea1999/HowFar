import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BUCHAREST_BBOX, BUCHAREST_MAX_BOUNDS, MAX_BBOX_SPAN_DEG, inBucharest, parseBbox } from "./bounds";

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

describe("default extent (byte-identity, task 007)", () => {
  // NOT self-referential: pins the DEFAULT box to today's exact literals so the
  // config lift cannot silently move the current Bucharest deployment.
  it("with NEXT_PUBLIC_MAP_BBOX unset, is exactly Bucharest+Ilfov", () => {
    expect(BUCHAREST_BBOX).toEqual({ minLng: 25.8, minLat: 44.2, maxLng: 26.4, maxLat: 44.7 });
  });
});

describe("parseBbox (task 007)", () => {
  it("parses a well-formed single-city box", () => {
    expect(parseBbox("23.4,46.6,23.7,46.9")).toEqual({
      minLng: 23.4,
      minLat: 46.6,
      maxLng: 23.7,
      maxLat: 46.9,
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseBbox(" 25.8 , 44.2 , 26.4 , 44.7 ")).toEqual({
      minLng: 25.8,
      minLat: 44.2,
      maxLng: 26.4,
      maxLat: 44.7,
    });
  });

  it("returns null for every malformed shape", () => {
    expect(parseBbox(null)).toBeNull();
    expect(parseBbox(undefined)).toBeNull();
    expect(parseBbox("")).toBeNull();
    expect(parseBbox("25.8,44.2,26.4")).toBeNull(); // wrong arity
    expect(parseBbox("25.8,44.2,26.4,44.7,extra")).toBeNull();
    expect(parseBbox("a,b,c,d")).toBeNull(); // non-finite
    expect(parseBbox("26.4,44.2,25.8,44.7")).toBeNull(); // minLng >= maxLng
    expect(parseBbox("25.8,44.7,26.4,44.2")).toBeNull(); // minLat >= maxLat
    expect(parseBbox("-181,44.2,26.4,44.7")).toBeNull(); // out of world range
  });

  it("rejects a span beyond the single-city cap (all-Romania guard)", () => {
    // ~7° wide — an all-country extent that would OOM the transit grid.
    expect(parseBbox("20,44,27,48")).toBeNull();
    expect(MAX_BBOX_SPAN_DEG).toBe(2);
  });

  it("rejects empty interior tokens (Number('') is 0, must not slip through)", () => {
    expect(parseBbox("-1,,1,1")).toBeNull();
    expect(parseBbox("25.8,44.2,,44.7")).toBeNull();
  });
});

describe("resolveBbox via NEXT_PUBLIC_MAP_BBOX (task 007, fresh module load)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("a valid override moves BUCHAREST_BBOX, inBucharest, and BUCHAREST_MAX_BOUNDS", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_MAP_BBOX", "23.4,46.6,23.7,46.9"); // Cluj-ish
    const fresh = await import("./bounds");
    expect(fresh.BUCHAREST_BBOX).toEqual({ minLng: 23.4, minLat: 46.6, maxLng: 23.7, maxLat: 46.9 });
    expect(fresh.inBucharest(46.7, 23.5)).toBe(true); // inside the override
    expect(fresh.inBucharest(44.4, 26.1)).toBe(false); // old Bucharest point now outside
    expect(fresh.BUCHAREST_MAX_BOUNDS).toEqual([
      [23.4, 46.6],
      [23.7, 46.9],
    ]);
  });

  it("FAILS CLOSED at import on a set-but-invalid extent (no silent Bucharest fallback)", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_MAP_BBOX", "not,a,bbox,really");
    await expect(import("./bounds")).rejects.toThrow(/Invalid NEXT_PUBLIC_MAP_BBOX/);
  });

  it("FAILS CLOSED on a set-but-blank extent (a stray NEXT_PUBLIC_MAP_BBOX= must not use the default city)", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_MAP_BBOX", "   ");
    await expect(import("./bounds")).rejects.toThrow(/set but blank/);
  });
});
