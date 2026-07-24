import type { Amenity, AmenityCounts } from "@/features/amenities/amenities";
import type { ReachLeg } from "@/features/isochrones/server/transit-plan";
import type { Mode, Origin, Ring } from "@/features/map/selection-flow";

/**
 * Shared lifecycle cell for the map effect (plan panel round-2 Critical, 3×
 * convergent): the style-load flag plus the buffers that replay a selection /
 * amenities response which arrived before MapLibre's `load`. Held in ONE object
 * threaded into every controller so they read the SAME state — a per-factory
 * `let styleLoaded` captured at create-time (before `load`) would stay false
 * forever, and each controller would buffer its own orphan `pending`.
 */
export interface LoadState {
  styleLoaded: boolean;
  pending: { origin: Origin; label: string; rings: Ring[]; mode: Mode } | null;
  pendingAmenities: { items: Amenity[]; counts: AmenityCounts } | null;
  /** A right-click journey whose draw arrived before `load` (task 054); replayed
   * once the reach-path source exists. Cleared on draw/clear. */
  pendingJourney: ReachLeg[] | null;
}

export function createLoadState(): LoadState {
  return { styleLoaded: false, pending: null, pendingAmenities: null, pendingJourney: null };
}
