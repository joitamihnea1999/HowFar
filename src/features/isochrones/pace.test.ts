import { describe, expect, it } from "vitest";

import {
  DEFAULT_PACE,
  NORMAL_ORS_RANGES_S,
  PACE_MODEL,
  PACES,
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

  it("BYTE-IDENTITY: slow reuses the pre-059 'relaxed' constants exactly", () => {
    // Task 059 cut the set to slow+normal; `slow` MUST be the old relaxed object
    // (only id/label/copy changed) so its G6-bounded calibration is preserved.
    const s = PACE_MODEL.slow;
    expect(s.orsRangesS).toEqual([682, 1381, 2086]); // ×66/80, unchanged from relaxed
    expect(s.pedestrianSpeedMs).toBe("1.100");
    expect(s.speedMPerMin).toBe(66);
    expect(s.egressMPerMin).toBeCloseTo(66 / STREET_DETOUR, 10);
  });

  it("is exactly the two ids slow, normal (brisk dropped)", () => {
    expect([...PACES]).toEqual(["slow", "normal"]);
    expect(Object.keys(PACE_MODEL).sort()).toEqual(["normal", "slow"]);
  });

  it("is monotonic slow < normal for range, speed and egress", () => {
    const [s, n] = [PACE_MODEL.slow, PACE_MODEL.normal];
    for (let i = 0; i < 3; i++) {
      expect(s.orsRangesS[i]).toBeLessThan(n.orsRangesS[i]!);
    }
    expect(s.speedMPerMin).toBeLessThan(n.speedMPerMin);
    expect(s.egressMPerMin).toBeLessThan(n.egressMPerMin);
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

  it("carries UI copy (label/emoji/blurb/hint) for the control", () => {
    for (const p of PACES) {
      expect(PACE_MODEL[p].label.length).toBeGreaterThan(0);
      expect(PACE_MODEL[p].emoji.length).toBeGreaterThan(0);
      // Per-option meaning shown under BOTH buttons (task 059 owner ask).
      expect(PACE_MODEL[p].blurb.length).toBeGreaterThan(0);
      expect(PACE_MODEL[p].hint.length).toBeGreaterThan(0);
    }
  });
});

describe("parsePaceStrict (the single fail-loud parser used by every route)", () => {
  it("passes through the two valid ids", () => {
    for (const p of PACES) expect(parsePaceStrict(p)).toBe(p);
  });
  it("treats absent/empty as the default but junk (incl. retired ids) as invalid (null)", () => {
    expect(parsePaceStrict(undefined)).toBe("normal");
    expect(parsePaceStrict(null)).toBe("normal");
    expect(parsePaceStrict("")).toBe("normal");
    expect(DEFAULT_PACE).toBe("normal");
    expect(parsePaceStrict("slow")).toBe("slow");
    // Retired ids are NOT aliased (no live users, task 059): they 400, never
    // silently become Normal (the over-claiming direction).
    expect(parsePaceStrict("brisk")).toBeNull();
    expect(parsePaceStrict("relaxed")).toBeNull();
    expect(parsePaceStrict("sprint")).toBeNull();
  });
});
