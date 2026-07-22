/**
 * Pure view mapping for isochrone rings: the per-mode color ramps and the
 * GeoJSON feature construction, split out of `AppMap` so the color-by-minute
 * decision and the feature shape are unit-testable without MapLibre. The
 * component keeps the imperative `setData`/marker/layer calls.
 */

// Cross-feature type-only edge: Mode/Ring belong to the selection state machine
// in features/map until the isochrone contract grows its own types module.
import type { Mode, Ring } from "@/features/map/selection-flow";

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

/** Which time band(s) the map displays (task 024). All three rings are always
 * FETCHED (one provider call, cached); the filter only drives layer visibility. */
export type RingFilter = "all" | 15 | 30 | 45;

/** Owner-picked (2026-07-18): a fresh selection shows the 15-min band only —
 * matching the amenity clip — and widens on demand. */
export const DEFAULT_RING_FILTER: RingFilter = 15;

/** Control order: the narrow-to-wide bands, then the full stack. */
export const RING_FILTER_OPTIONS: readonly RingFilter[] = [15, 30, 45, "all"];

/**
 * Per-layer visibility for a ring filter, over the per-minute layers that
 * `addIsochroneLayers` creates (they already filter features by `minutes`, so
 * showing one band is purely a layout toggle — no data repaint, works on a
 * live selection).
 */
export function ringLayerVisibility(filter: RingFilter): Record<string, "visible" | "none"> {
  const out: Record<string, "visible" | "none"> = {};
  for (const m of RING_MINUTES) {
    const v = filter === "all" || filter === m ? "visible" : "none";
    out[`iso-fill-${m}`] = v;
    out[`iso-line-${m}`] = v;
  }
  return out;
}

/** The legend rows for a filter — mirrors exactly what the map shows. */
export function visibleLegendMinutes(filter: RingFilter): readonly number[] {
  return filter === "all" ? LEGEND_MINUTES : [filter];
}

/**
 * Ordered bands for the staged All-mode reveal (largest→smallest, so the city
 * "opens up" then resolves around the origin). A single-band filter resolves
 * just that band. Extracted from `AppMap.revealRings` so the sequence is
 * unit-tested independently of the MapLibre paint timers that consume it.
 */
export function ringRevealStages(filter: RingFilter): (typeof RING_MINUTES)[number][] {
  return filter === "all" ? [...RING_MINUTES] : [filter];
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
