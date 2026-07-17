import { describe, expect, it } from "vitest";

import { RING_MINUTES } from "@/features/isochrones/isochrone-view";

import { addAmenityLayers, addIsochroneLayers, createMapStyle, EMPTY_FC } from "./map-setup";

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

  it("uses the protomaps-hosted glyphs and dark sprite, with a non-empty dark layer stack", () => {
    const style = createMapStyle("https://example.com/api/tiles");
    expect(style.glyphs).toBe("https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf");
    expect(style.sprite).toBe("https://protomaps.github.io/basemaps-assets/sprites/v4/dark");
    expect(Array.isArray(style.layers)).toBe(true);
    expect(style.layers.length).toBeGreaterThan(0);
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

describe("addAmenityLayers", () => {
  it("adds one empty geojson source and the category-colored, white-ringed circle layer", () => {
    const { host, sources, layerSpecs } = recorder();
    addAmenityLayers(host);

    expect(sources).toEqual([["amenities", { type: "geojson", data: EMPTY_FC }]]);
    expect(layerSpecs).toEqual([
      {
        id: "amenity-markers",
        type: "circle",
        source: "amenities",
        paint: {
          "circle-radius": 5,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-opacity": 0.9,
        },
      },
    ]);
  });
});
