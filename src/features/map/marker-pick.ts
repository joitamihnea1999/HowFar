/**
 * Pure nearest-marker pick decision for map clicks and hovers (task 024). The
 * owner's complaint was hit-testing: a 5px circle demanded pixel-precise
 * clicks, and a near-miss silently reselected the map point (full recompute).
 * This helper gives every amenity marker one generous, deterministic target —
 * shared by the click handler AND the hover handler, so the hover affordance
 * (grown circle, pointer cursor) always predicts exactly what a click will do.
 *
 * Pixel-space only (the component projects lng/lat before calling) so the
 * decision is unit-testable without MapLibre.
 */

/** Floor for the pick box half-width, in CSS pixels. Not wider by default: a blanket
 * 20px+ pad in a dense amenity cluster would make bare-map clicks (new-address
 * selection) nearly impossible, the inverse of the original complaint. */
export const MARKER_PICK_PAD_PX = 12;

/**
 * The pick pad to use at a given zoom.
 *
 * Task 061 made pins zoom-scaled, and the fixed 12px pad silently stopped covering
 * them: at z19 a hovered pin renders out to ~20.7px, so its visible outer ring could
 * be clicked and ignored (found in review). The pad now tracks the rendered
 * footprint, and never shrinks below the historical floor — so low zooms keep exactly
 * the generous target they had, and high zooms stop under-reaching the mark. Bare-map
 * clicking is unaffected in the dense case, because dense areas cluster into donuts
 * long before pins reach that size.
 */
export function markerPickPad(pinFootprint: number): number {
  return Math.max(MARKER_PICK_PAD_PX, pinFootprint);
}

export interface PickPoint {
  x: number;
  y: number;
}

/**
 * The single nearest candidate whose CENTER lies within a ±pad box of `point`
 * (squared-euclidean order; ties keep the earliest), or null when the box is
 * empty. Center-in-box — not rendered-circle-intersects-box — so the target
 * size is the same for every marker regardless of its paint radius.
 */
export function pickNearestWithin<T extends PickPoint>(
  candidates: readonly T[],
  point: PickPoint,
  pad: number,
): T | null {
  let nearest: T | null = null;
  let nearestD = Infinity;
  for (const c of candidates) {
    if (Math.abs(c.x - point.x) > pad || Math.abs(c.y - point.y) > pad) continue;
    const d = (c.x - point.x) ** 2 + (c.y - point.y) ** 2;
    if (d < nearestD) {
      nearestD = d;
      nearest = c;
    }
  }
  return nearest;
}

/**
 * EVERY candidate inside the pad box, nearest first (task 061).
 *
 * `pickNearestWithin` answers "which one did they mean?", which silently discards
 * the others — so in a tight clump some markers were unreachable by pointer at
 * all: the cursor could never get closer to them than to a neighbour. This
 * returns the whole set so the caller can offer a choice instead of guessing.
 *
 * Display-level clustering (task 061) already prevents most of these, since
 * anything closer than `CLUSTER_RADIUS_PX` becomes one donut with its own leaves
 * list. This covers the remaining sub-pad near-misses among *unclustered* pins.
 *
 * `key` deduplicates: MapLibre returns a feature once per tile it appears in, so
 * a marker on a tile boundary would otherwise be listed twice.
 */
export function pickAllWithin<T extends PickPoint>(
  candidates: readonly T[],
  point: PickPoint,
  pad: number,
  key?: (candidate: T) => string,
): T[] {
  const hits: { candidate: T; d: number }[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (Math.abs(c.x - point.x) > pad || Math.abs(c.y - point.y) > pad) continue;
    if (key) {
      const k = key(c);
      if (seen.has(k)) continue;
      seen.add(k);
    }
    hits.push({ candidate: c, d: (c.x - point.x) ** 2 + (c.y - point.y) ** 2 });
  }
  // Stable nearest-first: equal distances keep their input order, so repeated
  // clicks on the same spot always produce the same list order.
  hits.sort((a, b) => a.d - b.d);
  return hits.map((h) => h.candidate);
}
