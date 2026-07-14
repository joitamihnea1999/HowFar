import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseByteRange } from "./byte-range";

const SIZE = 25_000_000;
const CAP = 8 * 1024 * 1024;

describe("parseByteRange", () => {
  it("parses an explicit range", () => {
    expect(parseByteRange("bytes=0-127", SIZE, CAP)).toEqual({ start: 0, end: 127 });
  });

  it("clamps an open-ended range to the file end (within cap)", () => {
    expect(parseByteRange(`bytes=${SIZE - 100}-`, SIZE, CAP)).toEqual({ start: SIZE - 100, end: SIZE - 1 });
  });

  it("clamps an end beyond the file to the last byte", () => {
    expect(parseByteRange("bytes=10-999999999999", 100, CAP)).toEqual({ start: 10, end: 99 });
  });

  it("parses a suffix range", () => {
    expect(parseByteRange("bytes=-100", SIZE, CAP)).toEqual({ start: SIZE - 100, end: SIZE - 1 });
  });

  it("rejects malformed headers", () => {
    for (const bad of ["bytes=", "bytes=a-b", "bytes=5-2", "octets=0-1", "bytes=0-1,5-9", "bytes=--5", ""]) {
      expect(parseByteRange(bad, SIZE, CAP), bad).toBeNull();
    }
  });

  it("rejects unsatisfiable and degenerate ranges", () => {
    expect(parseByteRange(`bytes=${SIZE}-`, SIZE, CAP)).toBeNull(); // start == size
    expect(parseByteRange("bytes=-0", SIZE, CAP)).toBeNull(); // empty suffix
    expect(parseByteRange("bytes=0-", 0, CAP)).toBeNull(); // empty resource
  });

  it("rejects ranges larger than the cap (DoS guard)", () => {
    expect(parseByteRange("bytes=0-", SIZE, CAP)).toBeNull(); // whole 25MB > 8MB cap
    expect(parseByteRange(`bytes=0-${CAP - 1}`, SIZE, CAP)).toEqual({ start: 0, end: CAP - 1 });
    expect(parseByteRange(`bytes=0-${CAP}`, SIZE, CAP)).toBeNull(); // one byte over
  });

  it("property: any header yields null or a range within [0, size) and <= cap", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(), // arbitrary garbage
          fc
            .tuple(fc.nat(2 * SIZE), fc.option(fc.nat(2 * SIZE), { nil: undefined }))
            .map(([a, b]) => `bytes=${a}-${b ?? ""}`),
          fc.nat(2 * SIZE).map((n) => `bytes=-${n}`),
        ),
        fc.integer({ min: 1, max: 2 * SIZE }),
        (header, size) => {
          const range = parseByteRange(header, size, CAP);
          if (range === null) return true;
          return (
            Number.isSafeInteger(range.start) &&
            Number.isSafeInteger(range.end) &&
            range.start >= 0 &&
            range.start <= range.end &&
            range.end < size &&
            range.end - range.start + 1 <= CAP
          );
        },
      ),
    );
  });
});
