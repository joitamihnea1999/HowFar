import { describe, expect, it } from "vitest";

import {
  bandMinutes,
  buildIsochroneFeatures,
  DEFAULT_RING_FILTER,
  legendColor,
  MARKER_COLOR,
  MODE_ACCENT,
  MODE_LABEL,
  RING_BANDS,
  RING_FILTER_OPTIONS,
  ringLayerVisibility,
  ringRevealStages,
  visibleLegendBands,
} from "./isochrone-view";
import type { Ring } from "@/features/map/selection-flow";

const RINGS: Ring[] = [
  { minutes: 15, geometry: { type: "Polygon", coordinates: [] } },
  { minutes: 30, geometry: { type: "Polygon", coordinates: [] } },
  { minutes: 45, geometry: { type: "Polygon", coordinates: [] } },
];
// Car rings carry the car minute LABELS (10/20/30) but map to the same bands.
const CAR_RINGS: Ring[] = [
  { minutes: 10, geometry: { type: "Polygon", coordinates: [] } },
  { minutes: 20, geometry: { type: "Polygon", coordinates: [] } },
  { minutes: 30, geometry: { type: "Polygon", coordinates: [] } },
];

describe("buildIsochroneFeatures", () => {
  it("carries the fixed band, per-mode minutes, and per-mode colors (walk)", () => {
    const features = buildIsochroneFeatures(RINGS, "walk");
    expect(features).toHaveLength(3);
    // Inner ring → band 15 (position, not minute), walk teal ramp.
    expect(features[0]!.properties).toMatchObject({
      band: 15,
      minutes: 15,
      fillColor: "#14b8a6",
      lineColor: "#99f6e4",
    });
    expect(features[0]!.geometry).toBe(RINGS[0]!.geometry);
  });

  it("maps car rings to the SAME bands by position but keeps the 10/20/30 minute labels + blue ramp", () => {
    const features = buildIsochroneFeatures(CAR_RINGS, "car");
    // Inner car ring: band 15, labelled 10 min, inner blue.
    expect(features[0]!.properties).toMatchObject({ band: 15, minutes: 10, fillColor: "#2563eb", lineColor: "#93c5fd" });
    // Outer car ring: band 45, labelled 30 min, outer blue.
    expect(features[2]!.properties).toMatchObject({ band: 45, minutes: 30, fillColor: "#1e3a8a", lineColor: "#3b82f6" });
  });

  it("uses the transit ramp (violet) when in transit mode", () => {
    const features = buildIsochroneFeatures(RINGS, "transit");
    expect(features[2]!.properties).toMatchObject({ band: 45, minutes: 45, fillColor: "#4c1d95", lineColor: "#a78bfa" });
  });

  it("sorts rings ascending by minutes before banding, regardless of input order", () => {
    const shuffled = [RINGS[2]!, RINGS[0]!, RINGS[1]!];
    const features = buildIsochroneFeatures(shuffled, "walk");
    expect(features.map((f) => f.properties!.band)).toEqual([15, 30, 45]);
    expect(features.map((f) => f.properties!.minutes)).toEqual([15, 30, 45]);
  });
});

describe("legendColor / bandMinutes / constants", () => {
  it("returns the per-mode line color for a band", () => {
    expect(legendColor("walk", 30)).toBe("#5eead4");
    expect(legendColor("transit", 15)).toBe("#ede9fe");
    expect(legendColor("car", 15)).toBe("#93c5fd");
    expect(legendColor("car", 45)).toBe("#3b82f6");
  });

  it("labels each band per mode (walk/transit 15/30/45; car 10/20/30)", () => {
    expect(bandMinutes("walk", 45)).toBe(45);
    expect(bandMinutes("transit", 30)).toBe(30);
    expect(bandMinutes("car", 15)).toBe(10);
    expect(bandMinutes("car", 30)).toBe(20);
    expect(bandMinutes("car", 45)).toBe(30);
  });

  it("draws largest band first and defines the car marker/label/accent", () => {
    expect(RING_BANDS).toEqual([45, 30, 15]);
    expect(MARKER_COLOR.car).toBe("#3b82f6");
    expect(MODE_LABEL.car).toBe("Driving");
    expect(MODE_ACCENT.car).toBe("var(--hf-car)");
  });
});

describe("ring filter (task 024)", () => {
  it("defaults to the inner band (owner-picked) and offers each band plus All", () => {
    expect(DEFAULT_RING_FILTER).toBe(15);
    expect(RING_FILTER_OPTIONS).toEqual([15, 30, 45, "all"]);
  });

  it('"all" makes every per-band fill+line layer visible', () => {
    const vis = ringLayerVisibility("all");
    expect(Object.keys(vis)).toHaveLength(RING_BANDS.length * 2);
    expect(Object.values(vis).every((v) => v === "visible")).toBe(true);
  });

  it("a single band shows exactly its own fill+line pair and hides the rest", () => {
    for (const band of [15, 30, 45] as const) {
      const vis = ringLayerVisibility(band);
      for (const b of RING_BANDS) {
        const expected = b === band ? "visible" : "none";
        expect(vis[`iso-fill-${b}`]).toBe(expected);
        expect(vis[`iso-line-${b}`]).toBe(expected);
      }
    }
  });

  it("the legend mirrors the filter: one band for a single filter, all bands for All", () => {
    expect(visibleLegendBands(30)).toEqual([30]);
    expect(visibleLegendBands("all")).toEqual([15, 30, 45]);
  });

  it("reveal stages run largest→smallest for All, single band otherwise", () => {
    expect(ringRevealStages("all")).toEqual([45, 30, 15]);
    expect(ringRevealStages("all")).toEqual([...RING_BANDS]);
    expect(ringRevealStages(15)).toEqual([15]);
    expect(ringRevealStages(45)).toEqual([45]);
  });

  it("reveal stages returns a fresh array (mutating it must not corrupt RING_BANDS)", () => {
    const stages = ringRevealStages("all");
    (stages as number[]).push(999);
    expect([...RING_BANDS]).toEqual([45, 30, 15]);
  });
});
