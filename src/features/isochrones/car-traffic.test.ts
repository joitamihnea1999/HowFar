import { describe, expect, it } from "vitest";

import {
  CAR_FACTOR_REVISION,
  carTrafficSlot,
  carTrafficSlotFor,
  scaledCarRangesS,
} from "@/features/isochrones/car-traffic";
import { TIME_PRESETS } from "@/features/isochrones/time-context";

describe("carTrafficSlot — weekday buckets", () => {
  // weekday 3 = Wednesday
  it.each([
    [0, "night", 1.05],
    [5, "night", 1.05],
    [6, "shoulder", 1.4],
    [7, "am-peak", 2.1],
    [9, "am-peak", 2.1],
    [10, "midday", 1.5],
    [15, "midday", 1.5],
    [16, "pm-peak", 2.2],
    [19, "pm-peak", 2.2],
    [20, "evening-late", 1.25],
    [22, "evening-late", 1.25],
    [23, "night", 1.05],
  ])("hour %i → %s (×%f)", (hour, slotId, factor) => {
    const slot = carTrafficSlot(3, hour);
    expect(slot.slotId).toBe(slotId);
    expect(slot.factor).toBe(factor);
  });

  it("boundaries are half-open on the lower edge (06:59 shoulder, 07:00 am-peak, 09:59 am-peak, 10:00 midday)", () => {
    expect(carTrafficSlot(3, 6, 59).slotId).toBe("shoulder");
    expect(carTrafficSlot(3, 7, 0).slotId).toBe("am-peak");
    expect(carTrafficSlot(3, 9, 59).slotId).toBe("am-peak");
    expect(carTrafficSlot(3, 10, 0).slotId).toBe("midday");
    expect(carTrafficSlot(3, 15, 59).slotId).toBe("midday");
    expect(carTrafficSlot(3, 16, 0).slotId).toBe("pm-peak");
    expect(carTrafficSlot(3, 19, 59).slotId).toBe("pm-peak");
    expect(carTrafficSlot(3, 20, 0).slotId).toBe("evening-late");
    expect(carTrafficSlot(3, 22, 59).slotId).toBe("evening-late");
    expect(carTrafficSlot(3, 23, 0).slotId).toBe("night");
  });
});

describe("carTrafficSlot — weekend buckets", () => {
  it.each([
    [6, 12, "weekend-day", 1.3], // Saturday midday
    [0, 15, "weekend-day", 1.3], // Sunday afternoon
    [6, 20, "weekend-day", 1.3], // Saturday evening (still daytime window, 10–22)
    [6, 9, "weekend-off", 1.1], // Saturday early
    [0, 22, "weekend-off", 1.1], // Sunday late (>=22 → off-peak)
    [6, 3, "weekend-off", 1.1], // Saturday overnight
  ])("weekday %i hour %i → %s (×%f)", (weekday, hour, slotId, factor) => {
    const slot = carTrafficSlot(weekday, hour);
    expect(slot.slotId).toBe(slotId);
    expect(slot.factor).toBe(factor);
  });

  it("weekend overrides the weekday peak windows (Sat 08:00 is NOT am-peak)", () => {
    expect(carTrafficSlot(6, 8).slotId).toBe("weekend-off");
    expect(carTrafficSlot(6, 18).slotId).toBe("weekend-day");
  });
});

describe("carTrafficSlot — input hygiene", () => {
  it("clamps hour and normalises weekday", () => {
    expect(carTrafficSlot(3, 99).canonical.hour).toBe(23);
    expect(carTrafficSlot(3, -5).canonical.hour).toBe(0);
    expect(carTrafficSlot(10, 12).canonical.weekday).toBe(3); // 10 % 7 = 3
    expect(carTrafficSlot(-1, 12).canonical.weekday).toBe(6); // -1 → 6 (Sat)
  });
  it("echoes the resolved wall-clock in canonical", () => {
    expect(carTrafficSlot(3, 8, 30).canonical).toEqual({ weekday: 3, hour: 8, minute: 30 });
  });
});

describe("carTrafficSlotFor — preset mapping matches the plan", () => {
  it("weekday-morning → am-peak, midday → midday, evening → pm-peak, weekend → weekend-day", () => {
    expect(carTrafficSlotFor({ kind: "preset", preset: "weekday-morning" }).slotId).toBe("am-peak");
    expect(carTrafficSlotFor({ kind: "preset", preset: "midday" }).slotId).toBe("midday");
    expect(carTrafficSlotFor({ kind: "preset", preset: "evening" }).slotId).toBe("pm-peak");
    expect(carTrafficSlotFor({ kind: "preset", preset: "weekend" }).slotId).toBe("weekend-day");
  });
  it("preset canonical instants line up with TIME_PRESETS", () => {
    const wm = carTrafficSlotFor({ kind: "preset", preset: "weekday-morning" });
    expect(wm.canonical).toEqual({
      weekday: TIME_PRESETS["weekday-morning"].weekday,
      hour: TIME_PRESETS["weekday-morning"].hour,
      minute: TIME_PRESETS["weekday-morning"].minute,
    });
  });
  it("custom buckets through the same table", () => {
    expect(carTrafficSlotFor({ kind: "custom", weekday: 2, hour: 8, minute: 30 }).slotId).toBe("am-peak");
    expect(carTrafficSlotFor({ kind: "custom", weekday: 6, hour: 13, minute: 0 }).slotId).toBe("weekend-day");
  });
});

describe("scaledCarRangesS", () => {
  const NOMINAL = [600, 1200, 1800];

  it("divides each range by the factor and rounds", () => {
    expect(scaledCarRangesS(NOMINAL, 2.0)).toEqual([300, 600, 900]);
  });
  it("heavier traffic shrinks the rings monotonically vs lighter traffic", () => {
    const peak = scaledCarRangesS(NOMINAL, 2.2);
    const light = scaledCarRangesS(NOMINAL, 1.1);
    peak.forEach((v, i) => expect(v).toBeLessThan(light[i]!));
  });
  it("always returns a strictly ascending, distinct, >=60s triple", () => {
    for (const f of [1.0, 1.5, 2.1, 2.2, 3.9, 4.0]) {
      const r = scaledCarRangesS(NOMINAL, f);
      expect(r[0]).toBeGreaterThanOrEqual(60);
      expect(r[1]).toBeGreaterThan(r[0]!);
      expect(r[2]).toBeGreaterThan(r[1]!);
    }
  });
  it("clamps out-of-range factors to [1.0, 4.0]", () => {
    expect(scaledCarRangesS(NOMINAL, 0.5)).toEqual(scaledCarRangesS(NOMINAL, 1.0));
    expect(scaledCarRangesS(NOMINAL, 99)).toEqual(scaledCarRangesS(NOMINAL, 4.0));
  });
  it("the 60s floor + ascending guard fire when tiny ranges would collide", () => {
    // 100/4=25→60, 130/4=33→60 (=prev → +1 = 61), 160/4=40→60 (≤61 → 62).
    expect(scaledCarRangesS([100, 130, 160], 4)).toEqual([60, 61, 62]);
  });
});

describe("CAR_FACTOR_REVISION", () => {
  it("is a stable non-empty token (feeds cache keys)", () => {
    expect(CAR_FACTOR_REVISION).toBe("c1");
  });
});
