import { describe, expect, it } from "vitest";

import {
  amenityBandsForFilter,
  amenityScopeLabel,
  bandMinutes,
  DEFAULT_RING_FILTER,
  LEGEND_BANDS,
} from "./bands";

describe("amenityBandsForFilter — CUMULATIVE, because ring polygons are nested (task 065)", () => {
  it("includes every band the selected filter actually shades", () => {
    // A ring layer paints the WHOLE reach polygon for its band, not an annulus, so
    // selecting 30 shades the 30-minute area INCLUDING the inner 15 zone. Filtering
    // amenities to the single selected band would make inner markers vanish exactly
    // when the user widens the rings — the opposite of what widening asks for.
    expect(amenityBandsForFilter(15)).toEqual([15]);
    expect(amenityBandsForFilter(30)).toEqual([15, 30]);
    expect(amenityBandsForFilter(45)).toEqual([15, 30, 45]);
    expect(amenityBandsForFilter("all")).toEqual([15, 30, 45]);
  });

  it("never shrinks as the filter widens (monotonic)", () => {
    const sizes = [15, 30, 45, "all"].map((f) => amenityBandsForFilter(f as 15 | 30 | 45 | "all").length);
    for (let i = 1; i < sizes.length; i += 1) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]!);
  });

  it("covers the default filter and every legend band", () => {
    expect(amenityBandsForFilter(DEFAULT_RING_FILTER)).toEqual([15]);
    expect(amenityBandsForFilter("all")).toEqual([...LEGEND_BANDS]);
  });

  it("keeps per-mode minute labels (a car's outer band reads 30, not 45)", () => {
    expect(bandMinutes("walk", 45)).toBe(45);
    expect(bandMinutes("transit", 45)).toBe(45);
    expect(bandMinutes("car", 45)).toBe(30);
    expect(bandMinutes("car", 15)).toBe(10);
  });
});

describe("amenityScopeLabel — the phrase follows the SHADING, not the clip (task 065)", () => {
  it("names the widest VISIBLE band, per mode", () => {
    // The payload is clipped to the outer band, but only painted bands are shown, so
    // the sentence must describe what is visible or it over-claims.
    expect(amenityScopeLabel("walk", 15)).toBe("Within a 15-min walk");
    expect(amenityScopeLabel("walk", 30)).toBe("Within a 30-min walk");
    expect(amenityScopeLabel("walk", "all")).toBe("Within a 45-min walk");
    expect(amenityScopeLabel("transit", 15)).toBe("Within 15 min by public transport");
    expect(amenityScopeLabel("transit", "all")).toBe("Within 45 min by public transport");
  });

  it("uses the CAR's own minute labels, never the band ids", () => {
    // Car bands read 10/20/30; quoting 45 would contradict the ring legend.
    expect(amenityScopeLabel("car", 15)).toBe("Within a 10-min drive");
    expect(amenityScopeLabel("car", 30)).toBe("Within a 20-min drive");
    expect(amenityScopeLabel("car", "all")).toBe("Within a 30-min drive");
  });

  it("keeps the pre-065 wording at the default filter in walk mode", () => {
    // Deliberate: the default view is unchanged for the owner, so existing copy
    // assertions stay valid and only the widened/other-mode cases are new.
    expect(amenityScopeLabel("walk", DEFAULT_RING_FILTER)).toBe("Within a 15-min walk");
  });
});
