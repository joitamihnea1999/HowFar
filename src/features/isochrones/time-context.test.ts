import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIME_CONTEXT,
  DEFAULT_TIME_PRESET,
  departureFields,
  parseTimeContext,
  TIME_PRESET_IDS,
  TIME_PRESETS,
  timeContextHint,
  timeContextSummary,
} from "@/features/isochrones/time-context";

describe("TIME_PRESETS", () => {
  it("is exactly the two ids crowded, quiet; default = crowded == pre-059 Wed 08:30", () => {
    expect(TIME_PRESET_IDS).toEqual(["crowded", "quiet"]);
    expect(DEFAULT_TIME_PRESET).toBe("crowded");
    expect(DEFAULT_TIME_CONTEXT).toEqual({ kind: "preset", preset: "crowded" });
    // Byte-identity: crowded must carry the pre-059 default fields exactly.
    const c = TIME_PRESETS.crowded;
    expect([c.weekday, c.hour, c.minute]).toEqual([3, 8, 30]);
  });

  it("quiet is weekday midday (Wed 12:30); each preset has a hint, label and honesty phrase", () => {
    const q = TIME_PRESETS.quiet;
    expect([q.weekday, q.hour, q.minute]).toEqual([3, 12, 30]);
    expect(q.label).toBe("Not crowded");
    expect(TIME_PRESETS.crowded.label).toBe("Crowded");
    for (const id of TIME_PRESET_IDS) {
      expect(TIME_PRESETS[id].hint.length).toBeGreaterThan(0);
      expect(TIME_PRESETS[id].phrase.length).toBeGreaterThan(0);
    }
  });
});

describe("departureFields", () => {
  it("preset → its fields (strictly-future is applied by the resolver, no allowToday)", () => {
    expect(departureFields({ kind: "preset", preset: "crowded" })).toEqual({ weekday: 3, hour: 8, minute: 30 });
    expect(departureFields({ kind: "preset", preset: "quiet" })).toEqual({ weekday: 3, hour: 12, minute: 30 });
  });
});

describe("summary / hint", () => {
  it("summarises a preset by its natural time-phrase (reads inside 'Scheduled … for {…}')", () => {
    expect(timeContextSummary({ kind: "preset", preset: "crowded" })).toBe("a weekday rush hour");
    expect(timeContextSummary({ kind: "preset", preset: "quiet" })).toBe("a quieter midday");
  });
  it("gives a why-hint for each preset", () => {
    expect(timeContextHint({ kind: "preset", preset: "crowded" })).toBe(TIME_PRESETS.crowded.hint);
    expect(timeContextHint({ kind: "preset", preset: "quiet" })).toBe(TIME_PRESETS.quiet.hint);
  });
});

describe("parseTimeContext (route validation)", () => {
  it("no params → default crowded", () => {
    expect(parseTimeContext({})).toEqual(DEFAULT_TIME_CONTEXT);
    expect(parseTimeContext({ preset: "", weekday: "", time: "" })).toEqual(DEFAULT_TIME_CONTEXT);
  });
  it("valid preset → preset context; unknown/retired preset → null (400)", () => {
    expect(parseTimeContext({ preset: "crowded" })).toEqual({ kind: "preset", preset: "crowded" });
    expect(parseTimeContext({ preset: "quiet" })).toEqual({ kind: "preset", preset: "quiet" });
    // Retired ids are NOT aliased — they 400 (no live users, task 059).
    expect(parseTimeContext({ preset: "weekday-morning" })).toBeNull();
    expect(parseTimeContext({ preset: "midday" })).toBeNull();
    expect(parseTimeContext({ preset: "lunchtime" })).toBeNull();
  });
  it("FAIL-LOUD on retired custom params: any weekday/time present → null (400), never silent default", () => {
    expect(parseTimeContext({ weekday: "6", time: "09:30" })).toBeNull();
    expect(parseTimeContext({ weekday: "6" })).toBeNull(); // partial
    expect(parseTimeContext({ time: "09:30" })).toBeNull(); // partial
    // Even alongside a valid preset, a stray custom param is rejected.
    expect(parseTimeContext({ preset: "crowded", weekday: "6", time: "09:30" })).toBeNull();
  });
});
