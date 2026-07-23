import { describe, expect, it } from "vitest";

import {
  DEFAULT_PACE,
  NORMAL_ORS_RANGES_S,
  PACE_MODEL,
  PACES,
  parsePace,
  parsePaceStrict,
  STREET_DETOUR,
} from "@/features/isochrones/pace";

describe("PACE_MODEL", () => {
  it("BYTE-IDENTITY: normal reproduces the pre-051 constants exactly", () => {
    const n = PACE_MODEL.normal;
    expect(n.orsRangesS).toEqual([827, 1674, 2528]);
    expect(n.orsRangesS).toEqual([...NORMAL_ORS_RANGES_S]);
    expect(n.pedestrianSpeedMs).toBe("1.333"); // exact pre-051 literal, not 80/60
    expect(n.speedMPerMin).toBe(80);
    expect(n.egressMPerMin).toBeCloseTo(80 / STREET_DETOUR, 10);
  });

  it("scales non-normal ORS ranges linearly by speed/80, integer-rounded", () => {
    expect(PACE_MODEL.relaxed.orsRangesS).toEqual([682, 1381, 2086]); // ×66/80
    expect(PACE_MODEL.brisk.orsRangesS).toEqual([951, 1925, 2907]); // ×92/80
  });

  it("is monotonic relaxed < normal < brisk for range, speed and egress", () => {
    const [r, n, b] = [PACE_MODEL.relaxed, PACE_MODEL.normal, PACE_MODEL.brisk];
    for (let i = 0; i < 3; i++) {
      expect(r.orsRangesS[i]).toBeLessThan(n.orsRangesS[i]!);
      expect(n.orsRangesS[i]!).toBeLessThan(b.orsRangesS[i]!);
    }
    expect(r.speedMPerMin).toBeLessThan(n.speedMPerMin);
    expect(n.speedMPerMin).toBeLessThan(b.speedMPerMin);
    expect(r.egressMPerMin).toBeLessThan(n.egressMPerMin);
    expect(n.egressMPerMin).toBeLessThan(b.egressMPerMin);
  });

  it("egress = speed / detour for every pace", () => {
    for (const p of PACES) {
      expect(PACE_MODEL[p].egressMPerMin).toBeCloseTo(PACE_MODEL[p].speedMPerMin / STREET_DETOUR, 10);
    }
  });

  it("all speed fields stay mutually consistent (catches a future edit drifting one)", () => {
    // pedestrianSpeedMs ≈ speedMPerMin/60 and egressMPerMin ≈ speedMPerMin/detour
    // for EVERY pace — so nobody can tweak one speed field without the others.
    for (const p of PACES) {
      const m = PACE_MODEL[p];
      expect(Number(m.pedestrianSpeedMs)).toBeCloseTo(m.speedMPerMin / 60, 2);
      expect(m.egressMPerMin).toBeCloseTo(m.speedMPerMin / STREET_DETOUR, 6);
      // orsRanges scale from the SAME speed ratio the other fields use.
      expect(m.orsRangesS[0]).toBe(Math.round(827 * (m.speedMPerMin / 80)));
    }
  });

  it("carries UI copy (label/emoji/hint) for the control", () => {
    for (const p of PACES) {
      expect(PACE_MODEL[p].label.length).toBeGreaterThan(0);
      expect(PACE_MODEL[p].emoji.length).toBeGreaterThan(0);
      expect(PACE_MODEL[p].hint.length).toBeGreaterThan(0);
    }
  });
});

describe("parsePace", () => {
  it("passes through the three valid ids", () => {
    for (const p of PACES) expect(parsePace(p)).toBe(p);
  });
  it("defaults junk / null / empty to normal", () => {
    expect(parsePace("fast")).toBe(DEFAULT_PACE);
    expect(parsePace(null)).toBe(DEFAULT_PACE);
    expect(parsePace(undefined)).toBe(DEFAULT_PACE);
    expect(parsePace("")).toBe(DEFAULT_PACE);
    expect(DEFAULT_PACE).toBe("normal");
  });
});

describe("parsePaceStrict", () => {
  it("treats absent/empty as the default but junk as invalid (null)", () => {
    expect(parsePaceStrict(undefined)).toBe("normal");
    expect(parsePaceStrict(null)).toBe("normal");
    expect(parsePaceStrict("")).toBe("normal");
    expect(parsePaceStrict("brisk")).toBe("brisk");
    expect(parsePaceStrict("sprint")).toBeNull();
  });
});
