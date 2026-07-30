/**
 * Ring BANDS — the pure band primitives, shared by the client view layer and the
 * server-side amenity clip.
 *
 * Extracted from `isochrone-view.ts` (task 065) because the amenity clip now runs
 * per MODE on the server and needs `Band`/`bandMinutes`/the band-visibility rule.
 * Importing `isochrone-view.ts` from a `server/` module would pull the colour
 * ramps and the UI copy graph along with it, and `isochrone-view.ts`'s own header
 * anticipated this ("…until the isochrone contract grows its own types module").
 * Re-declaring the constants server-side was the other option and is the mistake
 * task 064 spent a gate deleting: `transit-grid.ts` had grown a SECOND speed
 * model that silently kept the old numbers. One home, two consumers.
 *
 * BANDS vs MINUTES. The three nested rings are fixed POSITIONS (inner → mid →
 * outer) with stable band ids 15/30/45 that key the MapLibre layers, the reveal
 * animation, the ring filter, the amenity band attribution and the e2e stamps —
 * mode-independent. The minute LABEL each band carries is per-mode: walk and
 * transit read 15/30/45 (band id == minute), a car reads 10/20/30 over the same
 * three bands. So "band 45" is the outer ring in every mode.
 */

// Cross-feature type-only edge (erased at build): Mode belongs to the selection
// state machine in features/map. Type-only, so no runtime dependency is created
// in either direction.
import type { Mode } from "@/features/map/selection-flow";

/** A ring band id (fixed position key; NOT necessarily the displayed minute). */
export type Band = 15 | 30 | 45;

/** Draw order: largest band first so smaller (brighter) rings sit on top. */
export const RING_BANDS = [45, 30, 15] as const;
/** Ascending band order — legend order, and the inner→outer order the amenity
 * band attribution walks. */
export const LEGEND_BANDS = [15, 30, 45] as const;

/** The minute label each band carries, per mode (see file header). */
const BAND_MINUTES: Record<Mode, Record<Band, number>> = {
  walk: { 15: 15, 30: 30, 45: 45 },
  transit: { 15: 15, 30: 30, 45: 45 },
  car: { 15: 10, 30: 20, 45: 30 },
};

/** The displayed minute label for a band in a mode (walk/transit 15/30/45; car 10/20/30). */
export function bandMinutes(mode: Mode, band: Band): number {
  return BAND_MINUTES[mode][band];
}

/** Which band(s) the map displays (task 024). All three rings are always
 * FETCHED (one provider call, cached); the filter only drives layer visibility.
 * The filter is band-keyed (position), so it survives a mode switch unchanged. */
export type RingFilter = "all" | Band;

/** Owner-picked (2026-07-18, reaffirmed 2026-07-29): a fresh selection shows the
 * inner band only, and widens on demand. Band-keyed, so it is the same default
 * (the smallest/innermost band) in every mode.
 *
 * It used to be documented as "matching the amenity clip", because the clip was a
 * fixed 15-minute WALK ring. Task 065 retired that coupling — the clip is now the
 * whole reach area of the CURRENT mode and the amenities visible at any moment are
 * the ones inside the bands actually shaded (`amenityBandsForFilter`). The owner
 * was asked whether this default should widen now that widening reveals more
 * places, and chose to keep the inner band (2026-07-29). */
export const DEFAULT_RING_FILTER: RingFilter = 15;

/** Control order: the narrow-to-wide bands, then the full stack. */
export const RING_FILTER_OPTIONS: readonly RingFilter[] = [15, 30, 45, "all"];

/**
 * The bands whose AMENITIES are visible under a ring filter — **cumulative**.
 *
 * This is the one band helper that is NOT "the selected band", and the difference
 * is load-bearing enough to spell out. Each ring feature's geometry is the WHOLE
 * reach polygon at that minute, not an annulus: the provider returns nested
 * isochrones (and `dropSmallComponents` preserves that nesting), and
 * `addIsochroneLayers` paints one fill layer per band over the full polygon. So
 * selecting band 30 shades the entire 30-minute area — **including the inner
 * 15-minute zone** — and every place inside that shading must stay on the map.
 *
 * Filtering amenities by the single selected band instead would make inner-band
 * markers VANISH the moment the user widens the rings, which is the exact
 * opposite of what widening asks for. `visibleLegendBands` (isochrone-view) is
 * deliberately different: the legend lists the band the user picked, not the
 * bands it contains.
 *
 * 15 → {15} · 30 → {15,30} · 45 or "all" → {15,30,45}.
 */
export function amenityBandsForFilter(filter: RingFilter): readonly Band[] {
  if (filter === "all") return LEGEND_BANDS;
  return LEGEND_BANDS.filter((band) => band <= filter);
}

/**
 * The one-line phrase describing WHICH area the amenity list covers (task 065).
 *
 * Follows the **shading**, not the clip: the payload is clipped to the outermost band,
 * but only the bands currently painted are drawn and counted, so the honest phrase
 * names the widest VISIBLE band. Minutes come from `bandMinutes`, so a car reads its
 * own labels (10/20/30) and the sentence can never disagree with the ring legend.
 *
 * This replaces the hardcoded "Within a 15-min walk", which was true only while the
 * clip was a 15-minute walk ring in every mode — in transit it under-claimed the area
 * by kilometres, and after this task it would have been simply false.
 */
export function amenityScopeLabel(mode: Mode, filter: RingFilter): string {
  // Derived totally rather than by indexing `amenityBandsForFilter` and guarding the
  // empty case: that guard was unreachable (the filter is always a band or "all", so
  // the list is never empty) and coverage flagged it as a dead branch.
  const widest: Band = filter === "all" ? LEGEND_BANDS[LEGEND_BANDS.length - 1] : filter;
  const minutes = bandMinutes(mode, widest);
  switch (mode) {
    case "walk":
      return `Within a ${minutes}-min walk`;
    case "transit":
      return `Within ${minutes} min by public transport`;
    case "car":
      return `Within a ${minutes}-min drive`;
  }
}
