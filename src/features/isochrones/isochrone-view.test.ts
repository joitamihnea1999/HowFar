import { describe, expect, it } from "vitest";

import {
  buildIsochroneFeatures,
  DEFAULT_RING_FILTER,
  legendColor,
  MARKER_COLOR,
  MODE_LABEL,
  RING_FILTER_OPTIONS,
  RING_MINUTES,
  ringLayerVisibility,
  visibleLegendMinutes,
} from "./isochrone-view";
import type { Ring } from "@/features/map/selection-flow";

const RINGS: Ring[] = [
  { minutes: 15, geometry: { type: "Polygon", coordinates: [] } },
  { minutes: 30, geometry: { type: "Polygon", coordinates: [] } },
  { minutes: 45, geometry: { type: "Polygon", coordinates: [] } },
];

describe("buildIsochroneFeatures", () => {
  it("carries per-mode fill/line colors and the minutes on each feature", () => {
    const features = buildIsochroneFeatures(RINGS, "walk");
    expect(features).toHaveLength(3);
    const f15 = features[0]!;
    expect(f15.properties).toMatchObject({ minutes: 15, fillColor: "#14b8a6", lineColor: "#99f6e4" });
    // The geometry is passed through unchanged.
    expect(f15.geometry).toBe(RINGS[0]!.geometry);
  });

  it("uses the transit ramp (violet) when in transit mode", () => {
    const features = buildIsochroneFeatures(RINGS, "transit");
    expect(features[2]!.properties).toMatchObject({ minutes: 45, fillColor: "#4c1d95", lineColor: "#a78bfa" });
  });

  it("leaves colors undefined for a ring minute outside the ramp (no crash)", () => {
    const odd = buildIsochroneFeatures([{ minutes: 20, geometry: null }], "walk");
    expect(odd[0]!.properties).toMatchObject({ minutes: 20, fillColor: undefined, lineColor: undefined });
  });
});

describe("legendColor / constants", () => {
  it("returns the line color for a known minute and undefined otherwise", () => {
    expect(legendColor("walk", 30)).toBe("#5eead4");
    expect(legendColor("transit", 15)).toBe("#ede9fe");
    expect(legendColor("walk", 99)).toBeUndefined();
  });

  it("draws largest ring first and labels both modes", () => {
    expect(RING_MINUTES).toEqual([45, 30, 15]);
    expect(MARKER_COLOR.transit).toBe("#a78bfa");
    expect(MODE_LABEL.walk).toBe("Walking");
  });
});

describe("ring filter (task 024)", () => {
  it("defaults to the 15-min band (owner-picked) and offers each band plus All", () => {
    expect(DEFAULT_RING_FILTER).toBe(15);
    expect(RING_FILTER_OPTIONS).toEqual([15, 30, 45, "all"]);
  });

  it('"all" makes every per-minute fill+line layer visible', () => {
    const vis = ringLayerVisibility("all");
    expect(Object.keys(vis)).toHaveLength(RING_MINUTES.length * 2);
    expect(Object.values(vis).every((v) => v === "visible")).toBe(true);
  });

  it("a single band shows exactly its own fill+line pair and hides the rest", () => {
    for (const band of [15, 30, 45] as const) {
      const vis = ringLayerVisibility(band);
      for (const m of RING_MINUTES) {
        const expected = m === band ? "visible" : "none";
        expect(vis[`iso-fill-${m}`]).toBe(expected);
        expect(vis[`iso-line-${m}`]).toBe(expected);
      }
    }
  });

  it("the legend mirrors the filter: one row for a band, all rows for All", () => {
    expect(visibleLegendMinutes(30)).toEqual([30]);
    expect(visibleLegendMinutes("all")).toEqual([15, 30, 45]);
  });
});
