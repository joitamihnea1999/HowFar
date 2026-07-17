import { layers, namedFlavor } from "@protomaps/basemaps";
import type maplibregl from "maplibre-gl";

import { RING_MINUTES } from "@/features/isochrones/isochrone-view";

/**
 * Pure MapLibre setup: the basemap style and the source/layer definitions,
 * split out of `AppMap` so the exact specs are unit-testable without a map.
 * No closure state and no `window` — the origin-dependent tiles URL is a
 * parameter so this module stays node-safe.
 */

/** Empty FeatureCollection used to initialise and clear GeoJSON sources. */
export const EMPTY_FC = { type: "FeatureCollection" as const, features: [] as unknown[] };

/** The narrow slice of `maplibregl.Map` the layer helpers touch. */
type LayerHost = Pick<maplibregl.Map, "addSource" | "addLayer">;

/** Style for the self-hosted Protomaps basemap. `tilesUrl` is the absolute
 * `/api/tiles` URL (the caller computes it from `window.location.origin`). */
export function createMapStyle(tilesUrl: string): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: "https://protomaps.github.io/basemaps-assets/sprites/v4/dark",
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${tilesUrl}`,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    layers: layers("protomaps", namedFlavor("dark"), { lang: "en" }),
  };
}

/** One fill + one line layer per ring, filtered by the feature's `minutes`.
 * Color comes from the feature (per-mode ramp) so both modes reuse these layers. */
export function addIsochroneLayers(map: LayerHost): void {
  map.addSource("isochrone", { type: "geojson", data: EMPTY_FC as GeoJSON.FeatureCollection });
  for (const minutes of RING_MINUTES) {
    const filter = ["==", ["get", "minutes"], minutes] as maplibregl.FilterSpecification;
    map.addLayer({
      id: `iso-fill-${minutes}`,
      type: "fill",
      source: "isochrone",
      filter,
      paint: { "fill-color": ["get", "fillColor"], "fill-opacity": 0.22 },
    });
    map.addLayer({
      id: `iso-line-${minutes}`,
      type: "line",
      source: "isochrone",
      filter,
      paint: { "line-color": ["get", "lineColor"], "line-width": 1.5, "line-opacity": 0.9 },
    });
  }
}

/** Amenity markers: one circle layer on top of the isochrone fills, colored
 * per category via the feature's own `color` (the isochrone-layer pattern).
 * The white stroke gives figure/ground pop AND a secondary encoding beyond
 * hue (the palette's residual CVD proximity is covered by this + the legend). */
export function addAmenityLayers(map: LayerHost): void {
  map.addSource("amenities", { type: "geojson", data: EMPTY_FC as GeoJSON.FeatureCollection });
  map.addLayer({
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
  });
}
