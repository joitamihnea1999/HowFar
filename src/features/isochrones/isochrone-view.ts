/**
 * Pure view mapping for isochrone rings: the per-mode color ramps, the legend and
 * explainer copy, and the GeoJSON feature construction, split out of `AppMap` so
 * the color/label decisions and the feature shape are unit-testable without
 * MapLibre. The component keeps the imperative `setData`/marker/layer calls.
 *
 * BANDS vs MINUTES (task 053) now live in the pure `bands.ts` (task 065), because
 * the server-side amenity clip needs them too and must not import this module's
 * colour/copy graph. The band primitives are re-exported here so existing client
 * call sites keep working; `bands.ts` is the single home.
 */

// Cross-feature type-only edge: Ring belongs to the selection state machine in
// features/map. `Mode` comes via bands.ts, which owns the per-mode band labels.
import type { Mode, Ring } from "@/features/map/selection-flow";

import {
  bandMinutes,
  LEGEND_BANDS,
  RING_BANDS,
  type Band,
  type RingFilter,
} from "@/features/isochrones/bands";

export {
  amenityBandsForFilter,
  bandMinutes,
  DEFAULT_RING_FILTER,
  LEGEND_BANDS,
  RING_BANDS,
  RING_FILTER_OPTIONS,
  type Band,
  type RingFilter,
} from "@/features/isochrones/bands";

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

export const MARKER_COLOR: Record<Mode, string> = { walk: "#2dd4bf", transit: "#a78bfa", car: "#3b82f6" };
export const MODE_LABEL: Record<Mode, string> = { walk: "Walking", transit: "Public transport", car: "Driving" };
/** CSS accent variable per mode (defined in globals.css). Exhaustive Record so a
 * new mode without an accent is a compile error — car never inherits transit's. */
export const MODE_ACCENT: Record<Mode, string> = {
  walk: "var(--hf-walk)",
  transit: "var(--hf-transit)",
  car: "var(--hf-car)",
};

/** The legend swatch color (line ramp) for a `band` in `mode`. `RAMPS` is an
 * exhaustive `Record<Mode, Record<Band, …>>`, so every (mode, band) resolves —
 * the return is always a defined color (impl F4: no dead optional chaining). */
export function legendColor(mode: Mode, band: Band): string {
  return RAMPS[mode][band].line;
}

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
 * One plain-language sentence saying what the shaded area(s) MEAN — the rings
 * are the product's core visualization, yet color dots + "N min" alone don't
 * tell a first-time user that teal/violet/blue areas are "everything you can
 * reach within N minutes by this mode" (owner, task: ring comprehension).
 * Minutes come from `visibleLegendBands` + `bandMinutes`, so the sentence can
 * never disagree with the painted rings or hardcode 15/30/45 (car reads
 * 10/20/30). Shared by the SelectionCard legend and the mobile peek hint.
 */
export function reachExplainer(mode: Mode, filter: RingFilter): string {
  const bands = visibleLegendBands(filter);
  const minutes = bands.map((b) => bandMinutes(mode, b));
  const area = bands.length > 1 ? "The shaded areas show" : "The shaded area shows";
  const span =
    minutes.length > 1
      ? `${minutes.slice(0, -1).join(", ")} or ${minutes[minutes.length - 1]} minutes`
      : `${minutes[0]} minutes`;
  switch (mode) {
    case "walk":
      return `${area} everything you can walk to within ${span}.`;
    case "transit":
      return `${area} everything you can reach by public transport within ${span}, walks to and from stops included.`;
    case "car":
      return `${area} everything you can drive to within ${span} in typical traffic.`;
  }
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
