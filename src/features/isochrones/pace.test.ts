import { describe, expect, it } from "vitest";

import {
  CALIBRATED_RANGES_S_AT_80,
  CALIBRATION_SPEED_M_PER_MIN,
  DEFAULT_PACE,
  PACE_MODEL,
  PACES,
  parsePaceStrict,
  STREET_DETOUR,
} from "@/features/isochrones/pace";

describe("PACE_MODEL", () => {
  // These two blocks are the ONLY place the shipped speeds are pinned to hard
  // literals, and they are what actually catches a wrong speed. Everything
  // below is a consistency/structure guard that a uniformly-wrong model would
  // still satisfy — see "the scaling property is structural, not a value check".
  it("normal is exactly 5 km/h and its derived values (owner, task 064)", () => {
    const n = PACE_MODEL.normal;
    expect(n.speedMPerMin).toBe(5000 / 60); // 83.33… m/min == 5 km/h
    expect((n.speedMPerMin * 60) / 1000).toBeCloseTo(5, 10);
    expect(n.orsRangesS).toEqual([861, 1744, 2633]); // ORS accepted+echoed these live
    expect(n.pedestrianSpeedMs).toBe("1.389"); // MOTIS request contract, 3 dp
    expect(n.egressMPerMin).toBeCloseTo(5000 / 60 / STREET_DETOUR, 10);
  });

  it("slow is exactly 3 km/h and its derived values (owner, task 064)", () => {
    const s = PACE_MODEL.slow;
    expect(s.speedMPerMin).toBe(50); // 3 km/h
    expect((s.speedMPerMin * 60) / 1000).toBeCloseTo(3, 10);
    expect(s.orsRangesS).toEqual([517, 1046, 1580]);
    expect(s.pedestrianSpeedMs).toBe("0.833");
    expect(s.egressMPerMin).toBeCloseTo(50 / STREET_DETOUR, 10);
  });

  it("no pace walks at the calibration anchor — it is a ruler, not a speed", () => {
    // The trap this module exists to prevent: if someone re-conflates the two,
    // `scaledRanges` would divide by a pace speed and silently change BOTH
    // paces' geometry. Pinning the anchor separately makes that visible.
    expect(CALIBRATION_SPEED_M_PER_MIN).toBe(80);
    expect([...CALIBRATED_RANGES_S_AT_80]).toEqual([827, 1674, 2528]);
    for (const p of PACES) {
      expect(PACE_MODEL[p].speedMPerMin).not.toBe(CALIBRATION_SPEED_M_PER_MIN);
      // …and nobody requests the raw anchor triple.
      expect(PACE_MODEL[p].orsRangesS).not.toEqual([...CALIBRATED_RANGES_S_AT_80]);
    }
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
    // STRUCTURAL guard, NOT a value check. It re-derives from `speedMPerMin`
    // exactly as the module does, so it stays green for ANY wrong speed — a
    // uniformly-wrong model satisfies it perfectly. What it does catch is a
    // partial edit: one field changed without the others, or a future pace
    // given an ad-hoc triple instead of the anchor rescale. Value-correctness
    // rests solely on the two literal-pin tests at the top of this file.
    for (const p of PACES) {
      const m = PACE_MODEL[p];
      expect(Number(m.pedestrianSpeedMs)).toBeCloseTo(m.speedMPerMin / 60, 2);
      expect(m.egressMPerMin).toBeCloseTo(m.speedMPerMin / STREET_DETOUR, 6);
      // Every pace's ranges are the ANCHOR triple rescaled — divided by the
      // calibration speed, never by a pace's own speed.
      for (let i = 0; i < 3; i++) {
        expect(m.orsRangesS[i]).toBe(
          Math.round(
            CALIBRATED_RANGES_S_AT_80[i]! * (m.speedMPerMin / CALIBRATION_SPEED_M_PER_MIN),
          ),
        );
      }
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

  it("the copy states the SPEEDS WE ACTUALLY WALK — no stale km/h can survive", () => {
    // The user-visible promise must track the model. Before task 064 the blurbs
    // said 4 / 4.8 km/h while nothing asserted the number, so wrong copy could
    // ship silently; these assertions tie the words to the constants.
    expect(PACE_MODEL.slow.blurb).toContain("3 km/h");
    expect(PACE_MODEL.normal.blurb).toContain("5 km/h");
    expect(PACE_MODEL.normal.hint).toContain("5 km/h");
    for (const p of PACES) {
      const copy = `${PACE_MODEL[p].blurb} ${PACE_MODEL[p].hint}`;
      expect(copy).not.toContain("4.8");
      expect(copy).not.toContain("4 km/h");
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
