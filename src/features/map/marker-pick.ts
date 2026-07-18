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

/** Half-width of the square pick box around the cursor, in CSS pixels. Chosen
 * to match the hover-grown marker (9px radius + stroke) plus slack — NOT wider:
 * a blanket 20px+ pad in a dense amenity cluster would make bare-map clicks
 * (new-address selection) nearly impossible, the inverse of the complaint. */
export const MARKER_PICK_PAD_PX = 12;

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
