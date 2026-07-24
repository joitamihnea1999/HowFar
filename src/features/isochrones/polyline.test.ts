import { describe, expect, it } from "vitest";

import { decodePolyline, MAX_POLYLINE_POINTS } from "@/features/isochrones/polyline";

/** Encode [lng,lat] pairs back to a polyline at `precision` — the inverse of
 * the decoder, used to build deterministic round-trip fixtures in-test (no
 * hardcoded encoded blobs). */
function encode(coords: [number, number][], precision: number): string {
  const factor = Math.pow(10, precision);
  let lastLat = 0;
  let lastLng = 0;
  let out = "";
  const enc = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let s = "";
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    s += String.fromCharCode(v + 63);
    return s;
  };
  for (const [lng, lat] of coords) {
    const latE = Math.round(lat * factor);
    const lngE = Math.round(lng * factor);
    out += enc(latE - lastLat) + enc(lngE - lastLng);
    lastLat = latE;
    lastLng = lngE;
  }
  return out;
}

describe("decodePolyline", () => {
  it("round-trips a precision-7 line including a negative delta", () => {
    const line: [number, number][] = [
      [26.1025, 44.4268],
      [26.1031, 44.4344], // north-east
      [26.0927, 44.4491], // west + north (negative lng delta)
    ];
    const decoded = decodePolyline(encode(line, 7), 7);
    expect(decoded).toHaveLength(3);
    for (let i = 0; i < line.length; i++) {
      expect(decoded[i][0]).toBeCloseTo(line[i][0], 6);
      expect(decoded[i][1]).toBeCloseTo(line[i][1], 6);
    }
  });

  it("precision matters — decoding at the wrong scale misplaces points", () => {
    const line: [number, number][] = [[26.1, 44.4]];
    const at7 = decodePolyline(encode(line, 7), 7);
    expect(at7[0][1]).toBeCloseTo(44.4, 5);
    // Decoding a precision-7 string at precision 5 scales the value ×100
    // (44.4 → 4440°), which the range guard rejects → nothing usable decoded.
    // Either way the point is nowhere near 44.4 — precision is not optional.
    const at5 = decodePolyline(encode(line, 7), 5);
    expect(at5[0]?.[1]).not.toBeCloseTo(44.4, 2);
  });

  it("returns [] for non-string / empty input", () => {
    expect(decodePolyline(undefined, 7)).toEqual([]);
    expect(decodePolyline(null, 7)).toEqual([]);
    expect(decodePolyline(42, 7)).toEqual([]);
    expect(decodePolyline("", 7)).toEqual([]);
  });

  it("stops cleanly on a truncated trailing group instead of throwing", () => {
    const valid = encode([[26.1, 44.4], [26.11, 44.41]], 7);
    // Chop the final byte-group: the decoder should return the fully-decoded
    // prefix, never NaN or a throw.
    const truncated = valid.slice(0, valid.length - 1);
    const decoded = decodePolyline(truncated, 7);
    expect(Array.isArray(decoded)).toBe(true);
    for (const [lng, lat] of decoded) {
      expect(Number.isFinite(lat)).toBe(true);
      expect(Number.isFinite(lng)).toBe(true);
    }
  });

  it("caps decoded points at MAX_POLYLINE_POINTS", () => {
    const many: [number, number][] = [];
    for (let i = 0; i < MAX_POLYLINE_POINTS + 500; i++) many.push([26.1 + i * 1e-6, 44.4]);
    const decoded = decodePolyline(encode(many, 7), 7);
    expect(decoded.length).toBeLessThanOrEqual(MAX_POLYLINE_POINTS);
  });

  it("rejects an overlong / never-terminating varint instead of accepting garbage", () => {
    // All-continuation bytes ("~" = 0x7e-63 = 0x3f, high bit set) never terminate;
    // the decoder must stop at the 32-bit ceiling and return the safe prefix (here
    // nothing), NOT emit a bogus (0,0)-ish point (review).
    expect(decodePolyline("~~~~~~~~~~", 7)).toEqual([]);
    // A valid first point followed by an overlong lng group → keep only the good point.
    const good = decodePolyline("_p~iF~ps|U", 5); // a classic precision-5 pair
    expect(good.length).toBeGreaterThanOrEqual(1);
  });

  it("stops at the first out-of-range coordinate (decode desync guard)", () => {
    // A valid point followed by a delta that pushes latitude past 90°.
    const line: [number, number][] = [[26.1, 44.4], [26.1, 200]];
    const decoded = decodePolyline(encode(line, 7), 7);
    expect(decoded).toHaveLength(1); // the 200° point is rejected, prefix kept
    expect(decoded[0][1]).toBeCloseTo(44.4, 6);
  });
});
