/**
 * Pure view mapping for isochrone rings: the per-mode color ramps and the
 * GeoJSON feature construction, split out of `AppMap` so the color-by-minute
 * decision and the feature shape are unit-testable without MapLibre. The
 * component keeps the imperative `setData`/marker/layer calls.
 */

import type { Mode, Ring } from "./selection-flow";

// Per-mode sequential ramps (inner = brightest). Walk = teal, Transit = violet —
// a strong contrast on the dark basemap so toggling modes reads instantly.
const RAMPS: Record<Mode, Record<number, { fill: string; line: string }>> = {
  walk: {
    45: { fill: "#0d5c55", line: "#2dd4bf" },
    30: { fill: "#0f766e", line: "#5eead4" },
    15: { fill: "#14b8a6", line: "#99f6e4" },
  },
  transit: {
    45: { fill: "#4c1d95", line: "#a78bfa" },
    30: { fill: "#6d28d9", line: "#c4b5fd" },
    15: { fill: "#8b5cf6", line: "#ede9fe" },
  },
};

// Draw order: largest first so smaller (brighter) rings sit on top.
export const RING_MINUTES = [45, 30, 15] as const;
export const LEGEND_MINUTES = [15, 30, 45] as const;
export const MARKER_COLOR: Record<Mode, string> = { walk: "#2dd4bf", transit: "#a78bfa" };
export const MODE_LABEL: Record<Mode, string> = { walk: "Walking", transit: "Public transport" };

/** The legend swatch color (line ramp) for a ring at `minutes` in `mode`. */
export function legendColor(mode: Mode, minutes: number): string | undefined {
  return RAMPS[mode][minutes]?.line;
}

/**
 * Rings → GeoJSON features carrying per-mode `fillColor`/`lineColor` so the two
 * modes can share one set of MapLibre layers painting via `["get","fillColor"]`.
 */
export function buildIsochroneFeatures(rings: Ring[], mode: Mode): GeoJSON.Feature[] {
  const ramp = RAMPS[mode];
  return rings.map((r) => ({
    type: "Feature",
    properties: {
      minutes: r.minutes,
      fillColor: ramp[r.minutes]?.fill,
      lineColor: ramp[r.minutes]?.line,
    },
    geometry: r.geometry as GeoJSON.Geometry,
  }));
}
