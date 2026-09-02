import { describe, expect, it, vi } from "vitest";
import type maplibregl from "maplibre-gl";

import {
  activeGuardHasFeature,
  hitTestHasFeature,
  safeQueryRenderedFeatures,
  safeQuerySourceFeatures,
} from "@/features/map/query-features";

const bbox = [
  [0, 0],
  [10, 10],
] as [maplibregl.PointLike, maplibregl.PointLike];

describe("safeQueryRenderedFeatures", () => {
  it("passes the map's features through on a normal query", () => {
    const feats = [{ id: 1 }, { id: 2 }] as unknown as maplibregl.MapGeoJSONFeature[];
    const map = { queryRenderedFeatures: vi.fn(() => feats) } as unknown as maplibregl.Map;
    expect(safeQueryRenderedFeatures(map, bbox, { layers: ["amenity-markers"] })).toBe(feats);
  });

  it("returns [] when queryRenderedFeatures THROWS (source mid-setData swap — 'feature index out of bounds')", () => {
    const map = {
      queryRenderedFeatures: vi.fn(() => {
        throw new Error("feature index out of bounds");
      }),
    } as unknown as maplibregl.Map;
    expect(safeQueryRenderedFeatures(map, bbox, { layers: ["amenity-markers"] })).toEqual([]);
  });
});

describe("hitTestHasFeature (fail-CLOSED click guard)", () => {
  it("reports whether a feature is under the point on a normal query", () => {
    const withFeature = { queryRenderedFeatures: vi.fn(() => [{ id: 1 }]) } as unknown as maplibregl.Map;
    const empty = { queryRenderedFeatures: vi.fn(() => []) } as unknown as maplibregl.Map;
    expect(hitTestHasFeature(withFeature, bbox, { layers: ["route-path-line"] })).toBe(true);
    expect(hitTestHasFeature(empty, bbox, { layers: ["route-path-line"] })).toBe(false);
  });

  it("fails CLOSED — returns TRUE when the query throws mid-swap, so a click guard swallows the click instead of resetting the selection", () => {
    const map = {
      queryRenderedFeatures: vi.fn(() => {
        throw new Error("feature index out of bounds");
      }),
    } as unknown as maplibregl.Map;
    expect(hitTestHasFeature(map, bbox, { layers: ["route-path-line"] })).toBe(true);
  });
});

describe("activeGuardHasFeature (fail-closed click guard for route-path/reach-journey)", () => {
  const bboxLayers = ["route-path-stops", "route-path-line"];
  it("reports a hit when a resolved layer has a feature under the point", () => {
    const map = {
      getLayer: (id: string) => (id === "route-path-line" ? {} : undefined),
      queryRenderedFeatures: vi.fn(() => [{ id: 1 }]),
    } as unknown as maplibregl.Map;
    expect(activeGuardHasFeature(map, bbox, bboxLayers)).toBe(true);
  });
  it("returns false (no hit) when resolved layers have nothing under the point", () => {
    const map = {
      getLayer: () => ({}),
      queryRenderedFeatures: vi.fn(() => []),
    } as unknown as maplibregl.Map;
    expect(activeGuardHasFeature(map, bbox, bboxLayers)).toBe(false);
  });
  it("fails CLOSED (true) when NONE of the layers resolve yet (mid-style-reload race — no throw)", () => {
    const map = {
      getLayer: () => undefined, // no layers exist
      queryRenderedFeatures: vi.fn(() => []),
    } as unknown as maplibregl.Map;
    expect(activeGuardHasFeature(map, bbox, bboxLayers)).toBe(true);
  });
  it("fails CLOSED (true) when the query throws mid source-swap", () => {
    const map = {
      getLayer: () => ({}),
      queryRenderedFeatures: vi.fn(() => {
        throw new Error("feature index out of bounds");
      }),
    } as unknown as maplibregl.Map;
    expect(activeGuardHasFeature(map, bbox, bboxLayers)).toBe(true);
  });
});

describe("safeQuerySourceFeatures (rAF stamp-poll guard)", () => {
  it("passes source features through on a normal query", () => {
    const feats = [{ properties: { kind: "leg" } }];
    const map = { querySourceFeatures: vi.fn(() => feats) } as unknown as maplibregl.Map;
    expect(safeQuerySourceFeatures(map, "reach-path")).toBe(feats);
  });

  it("returns [] when querySourceFeatures THROWS mid source-swap, so the rAF poll never raises an Uncaught Error", () => {
    const map = {
      querySourceFeatures: vi.fn(() => {
        throw new Error("feature index out of bounds");
      }),
    } as unknown as maplibregl.Map;
    expect(safeQuerySourceFeatures(map, "route-path")).toEqual([]);
  });
});
