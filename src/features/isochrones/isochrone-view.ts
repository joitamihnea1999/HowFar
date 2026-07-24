/**
 * Pure view mapping for isochrone rings: the per-mode color ramps, the per-mode
 * minute labels, and the GeoJSON feature construction, split out of `AppMap` so
 * the color/label decisions and the feature shape are unit-testable without
 * MapLibre. The component keeps the imperative `setData`/marker/layer calls.
 *
 * BANDS vs MINUTES (task 053). The three nested rings are fixed POSITIONS
 * (inner → mid → outer). Their stable band ids — 15/30/45 — key the MapLibre
 * layers, the reveal animation, the ring filter, and the e2e stamps, and never
 * change with mode. The minute LABEL each band carries IS per-mode: walk and
 * transit label them 15/30/45 (band id == minute), but a car covers far more
 * ground per minute — a 45-min drive is ~3.5× the Bucharest map — so car labels
 * the same three bands 10/20/30 (owner decision), which fit the map extent. So
 * "band 45" is the outer ring in every mode; it just reads "45 min" for walk/
 * transit and "30 min" for car.
 */

// Cross-feature type-only edge: Mode/Ring belong to the selection state machine
// in features/map until the isochrone contract grows its own types module.
import type { Mode, Ring } from "@/features/map/selection-flow";

/** A ring band id (fixed position key; NOT necessarily the displayed minute). */
export type Band = 15 | 30 | 45;

// Per-mode sequential ramps keyed by BAND (inner = brightest). Walk = teal,
// Transit = violet, Car = blue — one mode's rings show at a time, so each hue
// just needs to read distinctly on mode-switch and against the (always-on,
// warm/green) amenity markers on the dark basemap. Car blue is deliberately
// clear of amenity orange/green/rose/sky and of the walk teal it replaces.
const RAMPS: Record<Mode, Record<Band, { fill: string; line: string }>> = {
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
  car: {
    45: { fill: "#1e3a8a", line: "#3b82f6" },
    30: { fill: "#1d4ed8", line: "#60a5fa" },
    15: { fill: "#2563eb", line: "#93c5fd" },
  },
};

/** The minute label each band carries, per mode (see file header). */
const BAND_MINUTES: Record<Mode, Record<Band, number>> = {
  walk: { 15: 15, 30: 30, 45: 45 },
  transit: { 15: 15, 30: 30, 45: 45 },
  car: { 15: 10, 30: 20, 45: 30 },
};

// Draw order: largest band first so smaller (brighter) rings sit on top.
export const RING_BANDS = [45, 30, 15] as const;
export const LEGEND_BANDS = [15, 30, 45] as const;
export const MARKER_COLOR: Record<Mode, string> = { walk: "#2dd4bf", transit: "#a78bfa", car: "#3b82f6" };
export const MODE_LABEL: Record<Mode, string> = { walk: "Walking", transit: "Public transport", car: "Driving" };
/** CSS accent variable per mode (defined in globals.css). Exhaustive Record so a
 * new mode without an accent is a compile error — car never inherits transit's. */
export const MODE_ACCENT: Record<Mode, string> = {
  walk: "var(--hf-walk)",
  transit: "var(--hf-transit)",
  car: "var(--hf-car)",
};

/** The displayed minute label for a band in a mode (walk/transit 15/30/45; car 10/20/30). */
export function bandMinutes(mode: Mode, band: Band): number {
  return BAND_MINUTES[mode][band];
}

/** The legend swatch color (line ramp) for a `band` in `mode`. `RAMPS` is an
 * exhaustive `Record<Mode, Record<Band, …>>`, so every (mode, band) resolves —
 * the return is always a defined color (impl F4: no dead optional chaining). */
export function legendColor(mode: Mode, band: Band): string {
  return RAMPS[mode][band].line;
}

/** Which band(s) the map displays (task 024). All three rings are always
 * FETCHED (one provider call, cached); the filter only drives layer visibility.
 * The filter is band-keyed (position), so it survives a mode switch unchanged. */
export type RingFilter = "all" | Band;

/** Owner-picked (2026-07-18): a fresh selection shows the inner band only —
 * matching the amenity clip — and widens on demand. Band-keyed, so it is the
 * same default (the smallest/innermost band) in every mode. */
export const DEFAULT_RING_FILTER: RingFilter = 15;

/** Control order: the narrow-to-wide bands, then the full stack. */
export const RING_FILTER_OPTIONS: readonly RingFilter[] = [15, 30, 45, "all"];

/**
 * Per-layer visibility for a ring filter, over the per-band layers that
 * `addIsochroneLayers` creates (they already filter features by `band`, so
 * showing one band is purely a layout toggle — no data repaint, works on a
 * live selection). Band-keyed, mode-independent.
 */
export function ringLayerVisibility(filter: RingFilter): Record<string, "visible" | "none"> {
  const out: Record<string, "visible" | "none"> = {};
  for (const b of RING_BANDS) {
    const v = filter === "all" || filter === b ? "visible" : "none";
    out[`iso-fill-${b}`] = v;
    out[`iso-line-${b}`] = v;
  }
  return out;
}

/** The legend bands for a filter — mirrors exactly what the map shows. Map each
 * to `bandMinutes(mode, band)` for the displayed label. */
export function visibleLegendBands(filter: RingFilter): readonly Band[] {
  return filter === "all" ? LEGEND_BANDS : [filter];
}

/**
 * Ordered bands for the staged All-mode reveal (largest→smallest, so the city
 * "opens up" then resolves around the origin). A single-band filter resolves
 * just that band. Extracted from `AppMap.revealRings` so the sequence is
 * unit-tested independently of the MapLibre paint timers that consume it.
 */
export function ringRevealStages(filter: RingFilter): Band[] {
  return filter === "all" ? [...RING_BANDS] : [filter];
}

/**
 * Rings → GeoJSON features carrying the fixed `band` (for the per-band layer
 * filter), the per-mode display `minutes`, and per-mode `fillColor`/`lineColor`
 * so the modes share one set of MapLibre layers painting via `["get","fillColor"]`.
 * Rings are sorted ascending and mapped to bands by position (inner→15), so the
 * provider's per-mode minute labels (walk 15/30/45; car 10/20/30) never need to
 * match the band ids.
 */
export function buildIsochroneFeatures(rings: Ring[], mode: Mode): GeoJSON.Feature[] {
  const ramp = RAMPS[mode];
  const ascending = [...rings].sort((a, b) => a.minutes - b.minutes);
  return ascending.map((r, i) => {
    // Position → band (inner→15). The `?? last` guard is belt-and-braces for a
    // hypothetical >3-ring response; `normalize` (ors.ts) already 502s unless
    // exactly 3 rings come back, so `i` is 0..2 in practice.
    const band = LEGEND_BANDS[i] ?? LEGEND_BANDS[LEGEND_BANDS.length - 1]!;
    return {
      type: "Feature",
      properties: {
        band,
        minutes: r.minutes,
        fillColor: ramp[band].fill,
        lineColor: ramp[band].line,
      },
      geometry: r.geometry as GeoJSON.Geometry,
    };
  });
}
