import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIME_CONTEXT,
  DEFAULT_TIME_PRESET,
  departureFields,
  parseTimeContext,
  quantizeMinute,
  TIME_PRESET_IDS,
  TIME_PRESETS,
  timeContextHint,
  timeContextSummary,
} from "@/features/isochrones/time-context";

describe("TIME_PRESETS", () => {
  it("has the four presets, default = weekday-morning == pre-051 Wed 08:30", () => {
    expect(TIME_PRESET_IDS).toEqual(["weekday-morning", "midday", "evening", "weekend"]);
    expect(DEFAULT_TIME_PRESET).toBe("weekday-morning");
    expect(DEFAULT_TIME_CONTEXT).toEqual({ kind: "preset", preset: "weekday-morning" });
    const wm = TIME_PRESETS["weekday-morning"];
    expect([wm.weekday, wm.hour, wm.minute]).toEqual([3, 8, 30]);
  });

  it("weekend uses Saturday (weekday 6); each preset has a why-hint", () => {
    expect(TIME_PRESETS.weekend.weekday).toBe(6);
    for (const id of TIME_PRESET_IDS) expect(TIME_PRESETS[id].hint.length).toBeGreaterThan(0);
  });
});

describe("quantizeMinute", () => {
  it("snaps to :00 below 30 and :30 at/above 30", () => {
    expect(quantizeMinute(0)).toBe(0);
    expect(quantizeMinute(14)).toBe(0);
    expect(quantizeMinute(29)).toBe(0);
    expect(quantizeMinute(30)).toBe(30);
    expect(quantizeMinute(47)).toBe(30);
    expect(quantizeMinute(59)).toBe(30);
  });
});

describe("departureFields", () => {
  it("preset → its fields, allowToday=false (strictly-future)", () => {
    const f = departureFields({ kind: "preset", preset: "evening" });
    expect(f).toEqual({ weekday: 3, hour: 18, minute: 0, allowToday: false });
  });

  it("custom → quantised minute, clamped hour, wrapped weekday, allowToday=true", () => {
    expect(departureFields({ kind: "custom", weekday: 5, hour: 14, minute: 47 })).toEqual({
      weekday: 5,
      hour: 14,
      minute: 30,
      allowToday: true,
    });
    // hour clamp + weekday wrap
    expect(departureFields({ kind: "custom", weekday: 8, hour: 30, minute: 5 })).toEqual({
      weekday: 1, // 8 % 7
      hour: 23, // clamped
      minute: 0,
      allowToday: true,
    });
  });
});

describe("summary / hint", () => {
  it("summarises a preset by its label and a custom by day + slot", () => {
    expect(timeContextSummary({ kind: "preset", preset: "midday" })).toBe("Midday");
    expect(timeContextSummary({ kind: "custom", weekday: 6, hour: 9, minute: 15 })).toBe("Saturday 09:00");
  });
  it("gives a why-hint for presets and a generic one for custom", () => {
    expect(timeContextHint({ kind: "preset", preset: "weekend" })).toBe(TIME_PRESETS.weekend.hint);
    expect(timeContextHint({ kind: "custom", weekday: 1, hour: 8, minute: 0 }).length).toBeGreaterThan(0);
  });
});

describe("parseTimeContext (route validation)", () => {
  it("no params → default (keeps pre-051 URLs working)", () => {
    expect(parseTimeContext({})).toEqual(DEFAULT_TIME_CONTEXT);
    expect(parseTimeContext({ preset: "", weekday: "", time: "" })).toEqual(DEFAULT_TIME_CONTEXT);
  });
  it("valid preset → preset context; unknown preset → null (400)", () => {
    expect(parseTimeContext({ preset: "evening" })).toEqual({ kind: "preset", preset: "evening" });
    expect(parseTimeContext({ preset: "lunchtime" })).toBeNull();
  });
  it("valid weekday+time → custom; requires BOTH", () => {
    expect(parseTimeContext({ weekday: "6", time: "09:30" })).toEqual({
      kind: "custom",
      weekday: 6,
      hour: 9,
      minute: 30,
    });
    expect(parseTimeContext({ weekday: "6" })).toBeNull(); // time missing
    expect(parseTimeContext({ time: "09:30" })).toBeNull(); // weekday missing
  });
  it("rejects out-of-range / malformed custom values", () => {
    expect(parseTimeContext({ weekday: "7", time: "09:30" })).toBeNull(); // weekday > 6
    expect(parseTimeContext({ weekday: "3", time: "24:00" })).toBeNull(); // hour > 23
    expect(parseTimeContext({ weekday: "3", time: "9:5" })).toBeNull(); // malformed
    expect(parseTimeContext({ weekday: "x", time: "09:30" })).toBeNull();
  });
});
