import type { ReachLeg } from "@/features/isochrones/server/transit-plan";

/**
 * Transit classification for a planned trip — the single source both sides use:
 * the server picks a cache TTL by it (a "no public transport" answer must heal
 * in minutes, not hours) and the client decides "is this a real public-transport
 * answer worth drawing" by it. Two drifting copies would let a plan be cached
 * long as transit yet rendered as "no route".
 *
 * The line is deliberately just "has a transit leg" — no walk-share heuristic.
 * A stricter walk-dominance guard was tried and reverted (review): the real
 * calibration capture behind the route ranking contains an owner-approved best
 * trip of a 3-min tram between 27 min of walking, which any such threshold
 * misclassifies as "no route" — and a drawn plan already shows its walking
 * legs honestly, so the rider can judge.
 *
 * Pure module (type-only import above is erased at build): safe to import from
 * both server code and client bundles — the same layering as `pace.ts`.
 */

/** Modes that are NOT public transport: `bestPlan` can fall back to a `direct`
 * walk-or-bike itinerary, and street legs ride along in every transit trip.
 * "UNKNOWN" is the parser's placeholder for an ABSENT/garbled mode string — a
 * leg that told us nothing must not classify (and draw, and 6h-cache) as
 * public transport; a real unfamiliar transit mode arrives under its own name
 * and still qualifies (review). */
export const NON_TRANSIT_MODES = new Set([
  "WALK",
  "BIKE",
  "BICYCLE",
  "CAR",
  "CAR_PARKING",
  "RENTAL",
  "SCOOTER",
  "ODM",
  "UNKNOWN",
]);

/** True when the plan has at least one public-transport leg. Any mode outside
 * NON_TRANSIT_MODES counts, so an unknown genuine transit mode still qualifies. */
export function hasTransitLeg(legs: ReachLeg[]): boolean {
  return legs.some((l) => !NON_TRANSIT_MODES.has(l.mode.toUpperCase()));
}
