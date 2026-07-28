/**
 * Spiderfy geometry — fanning genuinely coincident places out into individual,
 * separately readable marks (task 061, W20).
 *
 * ## Why this exists
 *
 * Clustering is pinned to the map's maximum zoom, so places that share a building
 * (or a rounded coordinate) can never be separated by zooming: they stay one donut
 * at z22. The "N places here" list guarantees each of them is reachable and named,
 * but three review made the fair point that a list is read AFTER a
 * click — the owner asked to *see* the places, and Intent said spiderfy. So a
 * non-splittable mark now fans its members onto leader lines: each member becomes
 * its own pin, with its own icon and name, at a position the user can point at.
 *
 * ## The one hard requirement
 *
 * A fan must not recreate the crowding it resolves. These offsets are therefore
 * **provably separated**, by construction rather than by tuning:
 *
 * - members go on concentric rings around the hub;
 * - within a ring, the count is capped so the chord between neighbours is at least
 *   `sep` (= two leaf radii plus a gap), which also bounds every non-adjacent pair
 *   on that ring, since a longer arc means a longer chord;
 * - consecutive rings are `sep` apart radially, and two points on different rings
 *   are closest when their angles coincide — exactly `sep`;
 * - ring zero starts clear of the hub's own footprint.
 *
 * `spiderLegs` is pure screen-space offsets in CSS pixels. The caller re-projects
 * them every frame, so the fan keeps its shape and size while the map moves; that
 * is also why the geometry cannot be baked into coordinates once.
 *
 * A fan is only readable up to a point, so beyond `SPIDER_MAX_LEAVES` the leaves
 * list stays the answer. That is a deliberate ladder, not a fallback: 40 legs would
 * be less legible than 40 rows.
 */

/** Above this many members, the list is more readable than a fan. */
export const SPIDER_MAX_LEAVES = 12;

/** Fanned-leaf radius. Fixed rather than zoom-scaled: the fan is a transient,
 * focused view, and a 4px leaf (what `pinRadiusForZoom` gives at z11) would be
 * unreadable exactly when a user is trying to tell two places apart. */
export const SPIDER_LEAF_RADIUS_PX = 9;

/** Clear space between any two leaf footprints, and between a leaf and the hub. */
export const SPIDER_LEAF_GAP_PX = 7;

/** A member's screen offset from the hub, in CSS pixels (y grows downward). */
export interface SpiderLeg {
  dx: number;
  dy: number;
}

/**
 * Screen offsets for `count` members fanned around a hub of radius `hubRadius`.
 *
 * Returns an empty array for a non-positive or non-finite count, so a caller that
 * somehow spiderfies nothing draws nothing rather than throwing.
 */
export function spiderLegs(
  count: number,
  {
    hubRadius,
    leafRadius = SPIDER_LEAF_RADIUS_PX,
    gap = SPIDER_LEAF_GAP_PX,
  }: { hubRadius: number; leafRadius?: number; gap?: number },
): SpiderLeg[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  // Required centre-to-centre distance between two leaves: their footprints plus
  // the gap. Every separation claim below is expressed in this one quantity.
  const sep = 2 * leafRadius + gap;
  const legs: SpiderLeg[] = [];
  // Ring zero sits clear of the hub, measured footprint-to-footprint.
  let radius = hubRadius + leafRadius + gap;
  let ring = 0;

  while (legs.length < count) {
    const remaining = count - legs.length;
    // How many leaves fit on this ring with chord >= sep?
    //   chord = 2 r sin(pi/m) >= sep  <=>  m <= pi / asin(sep / 2r)
    const ratio = sep / (2 * radius);
    const capacity = ratio >= 1 ? 1 : Math.max(1, Math.floor(Math.PI / Math.asin(ratio)));
    const take = Math.min(remaining, capacity);
    // Half-step rotation per ring so leaves interleave instead of lining up on
    // spokes — purely cosmetic, and it cannot reduce the proven separations.
    const step = (2 * Math.PI) / take;
    const offset = -Math.PI / 2 + (ring % 2 === 0 ? 0 : step / 2);
    for (let i = 0; i < take; i++) {
      const angle = offset + i * step;
      legs.push({ dx: radius * Math.cos(angle), dy: radius * Math.sin(angle) });
    }
    radius += sep; // radial spacing == the required centre distance
    ring += 1;
  }
  return legs;
}

/**
 * Every pair of leaves that would render overlapping — the fan's own invariant,
 * asserted by its unit tests the same way `overlappingPairs` guards the map.
 *
 * Returns the offending index pairs so a failure names them instead of just
 * reporting "false".
 */
export function spiderOverlaps(
  legs: readonly SpiderLeg[],
  leafRadius: number = SPIDER_LEAF_RADIUS_PX,
): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const d = Math.hypot(legs[i].dx - legs[j].dx, legs[i].dy - legs[j].dy);
      // Tolerance absorbs float noise in the trig, not a real gap.
      if (d < 2 * leafRadius - 1e-9) pairs.push([i, j]);
    }
  }
  return pairs;
}

/**
 * How far apart the members of a fan may really be, in metres.
 *
 * A fan draws its members at DECORATIVE offsets around one hub, so it is only
 * truthful when those members are genuinely at the same spot. A reviewer
 * found the case that breaks it: `agglomerateClusters` merges clusters whose
 * centroids merely collide in SCREEN space, and their leaves keep different real
 * coordinates — so fanning such a mark draws pins where no place is, and clicking
 * one flies the camera away from the leaf the user just clicked (`inspectAmenity`
 * centres on the true coordinate). That is the "no mark lies" contract inverted.
 *
 * 8m is chosen from what the ladder actually produces: a cluster that cannot be
 * split at the map maximum holds members within `CLUSTER_RADIUS_PX` at z22, which is
 * on the order of one metre. 8m keeps that case (plus coordinate rounding) while
 * rejecting anything a user would recognise as two different places.
 */
export const SPIDER_MAX_SPAN_M = 8;

/** Metres between two lng/lat points — equirectangular, which is exact enough at
 * the metres scale this gate operates on (and avoids importing the server-side
 * haversine into client code). */
function approxMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lng - a.lng) * 111_320 * Math.cos(midLat);
  const dy = (b.lat - a.lat) * 110_574;
  return Math.hypot(dx, dy);
}

/**
 * Are these places coincident enough that fanning them tells the truth?
 *
 * Checked against every pair, not against a centroid: a chain of places 7m apart
 * each would pass a centroid test while spanning 50m.
 */
export function leavesAreCoincident(
  leaves: readonly { lat: number; lng: number }[],
  maxSpanM: number = SPIDER_MAX_SPAN_M,
): boolean {
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      if (approxMeters(leaves[i], leaves[j]) > maxSpanM) return false;
    }
  }
  return true;
}
