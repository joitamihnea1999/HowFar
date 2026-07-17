import { describe, expect, it } from "vitest";

import { buildIsochroneFeatures, legendColor, MARKER_COLOR, MODE_LABEL, RING_MINUTES } from "./isochrone-view";
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
