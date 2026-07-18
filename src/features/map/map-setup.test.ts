import { layers, namedFlavor } from "@protomaps/basemaps";
import { describe, expect, it } from "vitest";

import { RING_MINUTES } from "@/features/isochrones/isochrone-view";

import {
  addAmenityLayers,
  addIsochroneLayers,
  addRoutePathLayers,
  createMapStyle,
  EMPTY_FC,
  ROUTE_PATH_COLOR,
} from "./map-setup";

/** Recording stub for the addSource/addLayer slice the helpers touch. */
function recorder() {
  const sources: [string, Record<string, unknown>][] = [];
  const layerSpecs: Record<string, unknown>[] = [];
  const host = {
    addSource: (id: string, s: unknown) => void sources.push([id, s as Record<string, unknown>]),
    addLayer: (l: unknown) => void layerSpecs.push(l as Record<string, unknown>),
  } as unknown as Parameters<typeof addIsochroneLayers>[0];
  return { host, sources, layerSpecs };
}

describe("createMapStyle", () => {
  it("builds a v8 style serving the given tiles URL through the pmtiles protocol", () => {
    const style = createMapStyle("http://localhost:8080/api/tiles");
    expect(style.version).toBe(8);
    const protomaps = (style.sources as Record<string, { type?: string; url?: string; attribution?: string }>)
      .protomaps;
    expect(protomaps.type).toBe("vector");
    expect(protomaps.url).toBe("pmtiles://http://localhost:8080/api/tiles");
    expect(protomaps.attribution).toContain("openstreetmap.org/copyright");
  });

  it("uses the protomaps-hosted glyphs and dark sprite, with exactly the dark/en basemap stack", () => {
    const style = createMapStyle("https://example.com/api/tiles");
    expect(style.glyphs).toBe("https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf");
    expect(style.sprite).toBe("https://protomaps.github.io/basemaps-assets/sprites/v4/dark");
    // Pin the flavor and label language, not just non-emptiness: switching to
    // another namedFlavor or language must fail here.
    expect(style.layers).toEqual(layers("protomaps", namedFlavor("dark"), { lang: "en" }));
  });

  it("is pure: two calls with different URLs do not share state", () => {
    const a = createMapStyle("http://a/api/tiles");
    const b = createMapStyle("http://b/api/tiles");
    expect((a.sources as Record<string, { url?: string }>).protomaps.url).toBe("pmtiles://http://a/api/tiles");
    expect((b.sources as Record<string, { url?: string }>).protomaps.url).toBe("pmtiles://http://b/api/tiles");
  });
});

describe("addIsochroneLayers", () => {
  it("adds one empty geojson source and a fill+line layer pair per ring, filtered by minutes", () => {
    const { host, sources, layerSpecs } = recorder();
    addIsochroneLayers(host);

    expect(sources).toEqual([["isochrone", { type: "geojson", data: EMPTY_FC }]]);
    expect(layerSpecs.map((l) => l.id)).toEqual(
      RING_MINUTES.flatMap((m) => [`iso-fill-${m}`, `iso-line-${m}`]),
    );

    for (const minutes of RING_MINUTES) {
      const fill = layerSpecs.find((l) => l.id === `iso-fill-${minutes}`);
      const line = layerSpecs.find((l) => l.id === `iso-line-${minutes}`);
      const filter = ["==", ["get", "minutes"], minutes];
      expect(fill).toEqual({
        id: `iso-fill-${minutes}`,
        type: "fill",
        source: "isochrone",
        filter,
        paint: { "fill-color": ["get", "fillColor"], "fill-opacity": 0.22 },
      });
      expect(line).toEqual({
        id: `iso-line-${minutes}`,
        type: "line",
        source: "isochrone",
        filter,
        paint: { "line-color": ["get", "lineColor"], "line-width": 1.5, "line-opacity": 0.9 },
      });
    }
  });
});

describe("layer composition", () => {
  it("draws route path above isochrone fills but UNDER the amenity markers (documented order)", () => {
    const { host, layerSpecs } = recorder();
    addIsochroneLayers(host);
    addRoutePathLayers(host);
    addAmenityLayers(host);
    expect(layerSpecs.at(-1)?.id).toBe("amenity-markers");
    expect(layerSpecs.map((l) => l.id).slice(-5)).toEqual([
      "route-path-casing",
      "route-path-line",
      "route-path-stops",
      "route-path-labels",
      "amenity-markers",
    ]);
    expect(layerSpecs).toHaveLength(RING_MINUTES.length * 2 + 5);
  });
});

describe("addRoutePathLayers", () => {
  it("adds one source with casing+line for track and ringed dots for stops, split by geometry type", () => {
    const { host, sources, layerSpecs } = recorder();
    addRoutePathLayers(host);

    expect(sources).toEqual([["route-path", { type: "geojson", data: EMPTY_FC }]]);
    const isLine = ["==", ["geometry-type"], "LineString"];
    expect(layerSpecs).toEqual([
      {
        id: "route-path-casing",
        type: "line",
        source: "route-path",
        filter: isLine,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#09090b", "line-width": 7, "line-opacity": 0.85 },
      },
      {
        id: "route-path-line",
        type: "line",
        source: "route-path",
        filter: isLine,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ROUTE_PATH_COLOR, "line-width": 3, "line-opacity": 0.95 },
      },
      {
        id: "route-path-stops",
        type: "circle",
        source: "route-path",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 4.5,
          "circle-color": "#09090b",
          "circle-stroke-color": ROUTE_PATH_COLOR,
          "circle-stroke-width": 2,
        },
      },
      {
        id: "route-path-labels",
        type: "symbol",
        source: "route-path",
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Medium"],
          "text-size": 11,
          "text-anchor": "top",
          "text-offset": [0, 0.7],
        },
        paint: {
          "text-color": ROUTE_PATH_COLOR,
          "text-halo-color": "#09090b",
          "text-halo-width": 1.5,
        },
      },
    ]);
  });
});

describe("addAmenityLayers", () => {
  const hoverCase = (hovered: number, rest: number) => [
    "case",
    ["boolean", ["feature-state", "hover"], false],
    hovered,
    rest,
  ];

  it("adds an id-generating geojson source and the category-colored, hover-growing circle layer", () => {
    const { host, sources, layerSpecs } = recorder();
    addAmenityLayers(host);

    // generateId is what makes the hover feature-state addressable — osmId
    // can't serve as promoteId (optional + only unique per osmType).
    expect(sources).toEqual([["amenities", { type: "geojson", data: EMPTY_FC, generateId: true }]]);
    expect(layerSpecs).toEqual([
      {
        id: "amenity-markers",
        type: "circle",
        source: "amenities",
        paint: {
          "circle-radius": hoverCase(9, 5),
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": hoverCase(2.5, 1.5),
          "circle-opacity": hoverCase(1, 0.9),
        },
      },
    ]);
  });
});
