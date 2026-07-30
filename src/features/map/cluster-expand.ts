import {
  AMENITY_CATEGORIES,
  MAX_PER_CATEGORY_PER_BAND,
  type Amenity,
  type AmenityCategoryKey,
} from "@/features/amenities/amenities";
import { SPIDER_MAX_LEAVES } from "@/features/amenities/amenity-spider";
import { LEGEND_BANDS } from "@/features/isochrones/bands";

/**
 * Pure decisions for expanding an amenity cluster (task 061).
 *
 * Kept MapLibre-free so the two things most likely to go wrong — deciding whether
 * a cluster can be split by zooming, and turning cluster leaves back into
 * `Amenity` records — are unit-testable without a map.
 */

/** What clicking a cluster should do. */
export type ClusterAction =
  | { kind: "zoom"; zoom: number }
  | { kind: "list" };

/**
 * Fly-to-split, or show the leaves list?
 *
 * `getClusterExpansionZoom` returns a ZOOM, never an "unsplittable" flag — a
 * subtlety review had to point out, because "if it cannot split" reads
 * like a boolean exists. Since clustering is pinned to the map's maximum zoom, a
 * cluster of genuinely coincident places reports an expansion zoom ABOVE that
 * maximum: unreachable, so zooming would silently do nothing and the user would
 * be stuck clicking a donut that never opens. That case must go to the list.
 *
 * A non-finite expansion zoom (a failed/absent cluster) also goes to the list —
 * the always-correct branch is the safe default.
 */
export function decideClusterAction(expansionZoom: number, maxZoom: number): ClusterAction {
  if (!Number.isFinite(expansionZoom)) return { kind: "list" };
  if (expansionZoom > maxZoom) return { kind: "list" };
  return { kind: "zoom", zoom: expansionZoom };
}

/**
 * What activating a mark should do, once its leaves are known — the whole
 * resolution ladder as ONE pure decision (found in review).
 *
 * Extracted from the popup controller because review made the same point from
 * different directions: the composed condition was the only untested decision left in
 * this task (its sub-pieces were unit-tested, the composition was not), and it lives
 * in a coverage-excluded file — the exact rationale used to un-exclude the cluster
 * controller. The e2e that tried to cover it could only measure the fan's DECORATIVE
 * coordinates and passed with zero fans, so it would have stayed green if the
 * coincidence wiring were removed. Here the composition itself is testable.
 */
export type MarkAction =
  | { kind: "zoom"; zoom: number }
  | { kind: "fan" }
  | { kind: "list" };

/**
 * Decide the rung: fly-to-split, fan out, or list.
 *
 * The fan is the fussiest rung because it draws places at DECORATIVE offsets, so it
 * is only permitted where those offsets cannot misrepresent anything:
 *
 * - **One supercluster, no absorbed pins.** A merged mark is places whose centroids
 *   merely collided in SCREEN space; their leaves keep different real coordinates.
 * - **Genuinely coincident leaves.** The direct property, independent of how the mark
 *   formed — checked by the caller's `coincident` predicate.
 * - **Few enough to read**, and **fully enumerable** (`leafCount >= total`): fanning
 *   fewer legs than the hub counts would be a mark that under-reports.
 * - **Not a keyboard activation.** Fanned leaves are WebGL geometry with no focusable
 *   affordance, and opening a fan removes the donut button the keyboard user was
 *   standing on — so for them the fan is a dead end and the list is the answer
 *   (reviewers). Pointer users get the fan.
 */
export function decideMarkAction({
  expansionZoom,
  maxZoom,
  clusterCount,
  pinCount,
  leafCount,
  total,
  coincident,
  keyboard,
}: {
  expansionZoom: number;
  maxZoom: number;
  clusterCount: number;
  pinCount: number;
  leafCount: number;
  total: number;
  coincident: boolean;
  keyboard: boolean;
}): MarkAction {
  // Splitting apart a mark that is itself a collision of several clusters is not
  // meaningful — zooming cannot "unmerge" it — so only a lone cluster may zoom.
  if (clusterCount === 1 && pinCount === 0) {
    const zoomable = decideClusterAction(expansionZoom, maxZoom);
    if (zoomable.kind === "zoom") return zoomable;
  }
  const fannable =
    !keyboard &&
    clusterCount === 1 &&
    pinCount === 0 &&
    coincident &&
    leafCount > 1 &&
    leafCount <= SPIDER_MAX_LEAVES &&
    leafCount >= total;
  return fannable ? { kind: "fan" } : { kind: "list" };
}

/** Minimal shape of a leaf feature returned by `getClusterLeaves`. */
export interface LeafFeature {
  properties?: Record<string, unknown> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

/** A leaf that knows which source feature it came from — the shape the cluster
 * controller's absorbed-pin snapshots satisfy, so the popup can match them against
 * `pinIds` and re-query only the ones actually missing. */
export interface IdentifiedLeaf extends LeafFeature {
  id: number;
}

/**
 * Cluster leaf features → `Amenity` records for the list popup.
 *
 * Leaves come back as GeoJSON, and MapLibre flattens feature properties to
 * primitives, so `members` may be a JSON string; it is passed through untouched
 * because the popup's `parseAmenityMembers` already accepts either form. Leaves
 * without usable coordinates are dropped rather than rendered at (0,0) — a row
 * that flies the camera to the Gulf of Guinea is worse than a missing row.
 *
 * Sorted by served distance so the list reads nearest-first, matching how the
 * label priority and the browser list are ordered.
 */
export function leavesToAmenities(leaves: readonly LeafFeature[]): Amenity[] {
  const out: Amenity[] = [];
  for (const leaf of leaves) {
    const props = (leaf.properties ?? {}) as Record<string, unknown>;
    const coords = leaf.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const category = typeof props.category === "string" ? (props.category as AmenityCategoryKey) : null;
    if (!category) continue;

    // Band rides through so a popup opened from a cluster's leaves list can still be
    // closed when the ring filter narrows past it — every popup path must carry the band,
    // or the close only works for direct pin clicks.
    const band = LEGEND_BANDS.find((b) => b === props.band);
    const amenity: Amenity = {
      lat,
      lng,
      name: typeof props.name === "string" ? props.name : "",
      category,
      ...(band === undefined ? {} : { band }),
    };
    if (typeof props.osmType === "string") amenity.osmType = props.osmType;
    const osmId = Number(props.osmId);
    if (Number.isInteger(osmId) && osmId > 0) amenity.osmId = osmId;
    const distance = Number(props.distanceMeters);
    if (Number.isFinite(distance) && distance >= 0) amenity.distanceMeters = distance;
    // Kept in whatever form it arrived (string or array) — the popup parses both.
    if (props.members !== undefined) {
      (amenity as Amenity & { members?: unknown }).members = props.members as Amenity["members"];
    }
    out.push(amenity);
  }
  out.sort((a, b) => {
    const da = a.distanceMeters ?? Number.POSITIVE_INFINITY;
    const db = b.distanceMeters ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return (a.name || "").localeCompare(b.name || "");
  });
  return dedupeAmenities(out);
}

/**
 * Drop repeats of the same real place from a leaf set.
 *
 * The caller concatenates two sources — the cluster's own leaves and the snapshot of
 * pins absorbed into the same mark — and mid-zoom the source can briefly report one
 * POI in both roles (clustered in the new tiling, unclustered in the retained old
 * one), so the same place could appear twice in one list (review,
 * review). Identity is the OSM pair when present, else the coordinate + name, which
 *
 * Order-preserving, so the nearest-first sort above survives.
 */
export function dedupeAmenities(items: readonly Amenity[]): Amenity[] {
  const seen = new Set<string>();
  const out: Amenity[] = [];
  for (const item of items) {
    // Unidentifiable ⇒ NEVER dropped. An earlier version fell back to coordinate + name,
    // which would collapse two genuinely distinct unnamed POIs sharing a coordinate —
    // hiding a place, the exact defect this task exists to remove (found in review).
    // OSM identity is optional by contract, so its absence means "cannot prove these are
    // the same", not "assume they are"; showing a duplicate row is the safer error.
    if (!item.osmType || typeof item.osmId !== "number") {
      out.push(item);
      continue;
    }
    const key = `${item.osmType}/${item.osmId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Hard upper bound across all pages: above the server's own ceiling of returned
 * amenities, so it can never truncate a real cluster — it exists only as a runaway
 * guard. The unit test asserts it against the server constants rather than a
 * hand-written number, so raising a cap cannot silently reintroduce truncation.
 *
 * Task 065 re-derived it: the server cap became per (category, BAND), so the
 * ceiling gained a ×3 factor (5 categories × 3 bands × 100 = 1500, up from 150 × 5
 * = 750) and the old 800 would have started cutting the leaves list — quietly
 * breaking the "every place in this mark is reachable" guarantee the resolution
 * ladder makes. Derived from the constants, not restated, precisely so the next cap
 * change fails the test instead of the user. */
export const MAX_CLUSTER_LEAVES =
  MAX_PER_CATEGORY_PER_BAND * AMENITY_CATEGORIES.length * LEGEND_BANDS.length;

/** Leaves fetched per `getClusterLeaves` call; `collectClusterLeaves` pages by
 * offset up to `MAX_CLUSTER_LEAVES`. Paging matters because a cluster can hold
 * every returned amenity (150 x 5 categories), and a single un-paged call left the
 * rest unreachable while the UI still implied the whole cluster was listed. */
export const CLUSTER_LEAF_PAGE = 200;

/**
 * Walk every page of every cluster in a merged mark.
 *
 * Extracted from the popup controller so the loop that makes the "every place in
 * this mark is reachable" claim true is unit-testable (review: the only
 * coverage was an assertion that the cap constant exceeded 150, which a cap of 151
 * would also satisfy while a real cluster holds up to 750).
 *
 * `stillCurrent` is checked after every await: the caller's generation may have
 * been superseded by an Escape, a new address, or a recluster, and a superseded
 * walk must abandon rather than paint leaves over cleared state. Returning `null`
 * (not an empty array) keeps "superseded" distinguishable from "no leaves".
 */
export async function collectClusterLeaves(
  clusterIds: readonly number[],
  getPage: (clusterId: number, limit: number, offset: number) => Promise<readonly LeafFeature[]>,
  stillCurrent: () => boolean,
): Promise<LeafFeature[] | null> {
  const out: LeafFeature[] = [];
  for (const id of clusterIds) {
    for (let offset = 0; offset < MAX_CLUSTER_LEAVES; offset += CLUSTER_LEAF_PAGE) {
      const page = await getPage(id, CLUSTER_LEAF_PAGE, offset);
      if (!stillCurrent()) return null;
      out.push(...page);
      if (page.length < CLUSTER_LEAF_PAGE) break; // last page for this cluster
    }
  }
  return out;
}
