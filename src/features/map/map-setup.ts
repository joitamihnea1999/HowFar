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

export const ISOCHRONE_FILL_OPACITY = 0.2;
export const ISOCHRONE_LINE_OPACITY = 0.94;

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
      paint: {
        "fill-color": ["get", "fillColor"],
        "fill-opacity": ISOCHRONE_FILL_OPACITY,
        "fill-opacity-transition": { duration: 320, delay: 0 },
      },
    });
    map.addLayer({
      id: `iso-line-${minutes}`,
      type: "line",
      source: "isochrone",
      filter,
      paint: {
        "line-color": ["get", "lineColor"],
        "line-width": 2,
        "line-opacity": ISOCHRONE_LINE_OPACITY,
        "line-opacity-transition": { duration: 320, delay: 0 },
      },
    });
  }
}

/** Highlighted transit-route color (task 024): near-white reads as "figure" on
 * the dark basemap and collides with no category hue or mode ramp. */
export const ROUTE_PATH_COLOR = "#fafafa";
const ROUTE_PATH_CASING = "#09090b";

/** Selected transit line (task 024): dark casing under a bright line, plus the
 * route's stops as casing-colored dots ringed in the line color. One GeoJSON
 * source; the layers split track from stops by geometry type. Added BETWEEN
 * the isochrone fills and the amenity markers, so a drawn path never covers
 * the interactive dots. */
export function addRoutePathLayers(map: LayerHost): void {
  map.addSource("route-path", { type: "geojson", data: EMPTY_FC as GeoJSON.FeatureCollection });
  const isLine = ["==", ["geometry-type"], "LineString"] as maplibregl.FilterSpecification;
  const round = { "line-cap": "round" as const, "line-join": "round" as const };
  map.addLayer({
    id: "route-path-casing",
    type: "line",
    source: "route-path",
    filter: isLine,
    layout: round,
    paint: { "line-color": ROUTE_PATH_CASING, "line-width": 8, "line-opacity": 0.88 },
  });
  map.addLayer({
    id: "route-path-line",
    type: "line",
    source: "route-path",
    filter: isLine,
    layout: round,
    paint: { "line-color": ROUTE_PATH_COLOR, "line-width": 3.5, "line-opacity": 0.97 },
  });
  map.addLayer({
    id: "route-path-stops",
    type: "circle",
    source: "route-path",
    filter: ["==", ["geometry-type"], "Point"] as maplibregl.FilterSpecification,
    paint: {
      "circle-radius": 5,
      "circle-color": ROUTE_PATH_CASING,
      "circle-stroke-color": ROUTE_PATH_COLOR,
      "circle-stroke-width": 2,
    },
  });
  // The stop NAMES are the point of the feature ("know all the places it
  // stops") — halo-on-dark labels; MapLibre's symbol collision thins them
  // automatically where stops crowd.
  map.addLayer({
    id: "route-path-labels",
    type: "symbol",
    source: "route-path",
    filter: ["==", ["geometry-type"], "Point"] as maplibregl.FilterSpecification,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Medium"],
      "text-size": 11,
      "text-anchor": "top",
      "text-offset": [0, 0.7],
    },
    paint: {
      "text-color": ROUTE_PATH_COLOR,
      "text-halo-color": ROUTE_PATH_CASING,
      "text-halo-width": 1.5,
    },
  });
}

/** Amenity marker sizing: rest vs hover (task 024). The hover radius nearly
 * doubles the target and is what the shared 12px pick pad is calibrated to. */
export const AMENITY_RADIUS = 7;
export const AMENITY_RADIUS_HOVER = 10;

/** Feature-state-driven value: `hovered` when the pointer's pick lands on the
 * marker (AppMap sets `hover` via setFeatureState), else `rest`. */
function hoverCase(hovered: number, rest: number): maplibregl.DataDrivenPropertyValueSpecification<number> {
  return ["case", ["boolean", ["feature-state", "hover"], false], hovered, rest];
}

/** Amenity markers: one circle layer on top of the isochrone fills, colored
 * per category via the feature's own `color` (the isochrone-layer pattern).
 * The white stroke gives figure/ground pop AND a secondary encoding beyond
 * hue (the palette's residual CVD proximity is covered by this + the legend).
 * `generateId` gives every feature a stable numeric id for the hover feature
 * state — `osmId` cannot serve (optional, and only unique per osmType). */
export function addAmenityLayers(map: LayerHost): void {
  map.addSource("amenities", {
    type: "geojson",
    data: EMPTY_FC as GeoJSON.FeatureCollection,
    generateId: true,
  });
  map.addLayer({
    id: "amenity-markers",
    type: "circle",
    source: "amenities",
    paint: {
      "circle-radius": hoverCase(AMENITY_RADIUS_HOVER, AMENITY_RADIUS),
      "circle-color": ["get", "color"],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": hoverCase(2.5, 1.75),
      "circle-opacity": hoverCase(1, 0.96),
    },
  });
  // A compact, always-consistent non-color encoding. Single ASCII glyphs stay
  // legible at city zoom without competing with place-name labels; the circle
  // remains the sole hit layer so this symbol cannot change pick behavior.
  map.addLayer({
    id: "amenity-glyphs",
    type: "symbol",
    source: "amenities",
    minzoom: 12.5,
    layout: {
      "text-field": [
        "match",
        ["get", "category"],
        "groceries",
        "G",
        "pharmacies",
        "+",
        "parks",
        "P",
        "schools",
        "S",
        "transit",
        "T",
        "•",
      ],
      "text-font": ["Noto Sans Medium"],
      "text-size": 8.5,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#08100d",
      "text-halo-color": "rgba(255,255,255,0.18)",
      "text-halo-width": 0.5,
    },
  });
}
