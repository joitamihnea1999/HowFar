import maplibregl from "maplibre-gl";

import {
  AMENITY_CATEGORIES,
  type Amenity,
  type AmenityCategoryKey,
} from "@/features/amenities/amenities";
import { clusterFootprintRadius } from "@/features/amenities/amenity-cluster";
import { MIN_MARK_TAP_RADIUS_PX } from "@/features/map/amenity-cluster-controller";
import {
  SPIDER_LEAF_RADIUS_PX,
  spiderLegs,
  type SpiderLeg,
} from "@/features/amenities/amenity-spider";
import { buildDonutElement } from "@/features/map/amenity-cluster-controller";
import { SPIDER_SOURCE } from "@/features/map/map-setup";

/**
 * Spiderfy: fan a non-splittable cluster's members into individual marks
 * (task 061 W20, owner-ordered after review).
 *
 * Clustering is pinned to the map's maximum zoom, so places sharing a building can
 * never be separated by zooming. The leaves list already guaranteed each of them was
 * reachable and named, but a list is read after a click — Intent asked for the
 * places to be SEEN. Clicking such a mark now fans its members onto leader lines:
 * each becomes an ordinary-looking pin with its own icon and name.
 *
 * Three decisions are load-bearing:
 *
 * - **The fan owns the map while it is open.** Opening calls back so the amenities
 *   controller hides every other amenity mark (the same chokepoint the right-click
 *   journey uses). That is not decoration: fan positions are chosen to be provably
 *   separated from EACH OTHER and from the hub, and nothing can promise separation
 *   from an unrelated donut 20px away. Hiding the rest keeps the task's central
 *   no-overlap invariant true while a fan is open, and keeps the fan readable.
 * - **Positions are screen-space, recomputed on every camera change.** A fan is a
 *   pixel arrangement, not a set of places; baking it into coordinates once would
 *   smear the legs on the next pan and change the fan's size on every zoom.
 * - **The hub is the same donut element the cluster controller draws.** A mark that
 *   changed appearance when it expanded would lose the user's place; clicking it
 *   again (or Escape) collapses.
 */

/** Marker class for the fan's hub — deliberately the cluster class, since it IS
 * one; the extra data attribute is how the e2e tells a fanned hub apart. */
const HUB_DATA_FLAG = "spiderHub";

export interface AmenitySpiderController {
  /** Fan `leaves` around `hub`. Replaces any open fan. */
  open: (hub: [number, number], leaves: readonly Amenity[]) => void;
  close: () => void;
  isOpen: () => boolean;
  /**
   * Resolve a click against the open fan — hub, a leaf, or neither — in ONE pass.
   *
   * One entry point rather than `hitsHub` then `pickLeaf` (found in review): both
   * targets are widened to the 44px tap contract, so their areas can now overlap, and
   * asking the hub first would let it swallow a tap that was plainly on a leaf.
   * Nearest centre across hub AND leaves decides, which is unambiguous because leaves
   * sit ~25px apart and clear of the hub by construction.
   */
  resolveClick: (point: { x: number; y: number }) => SpiderHit;
  dispose: () => void;
}

/** Category colour, from the same SSOT the map pins and the AmenityPanel use. */
function categoryColor(category: AmenityCategoryKey): string {
  return AMENITY_CATEGORIES.find((c) => c.key === category)?.color ?? "#9ca9a0";
}

/** Per-category counts for the hub donut, in legend order, derived from the
 * leaves themselves — exact by construction, and no extra plumbing from the
 * cluster properties. */
function countLeaves(leaves: readonly Amenity[]): { category: AmenityCategoryKey; count: number }[] {
  const totals = new Map<AmenityCategoryKey, number>();
  for (const leaf of leaves) totals.set(leaf.category, (totals.get(leaf.category) ?? 0) + 1);
  return AMENITY_CATEGORIES.filter(({ key }) => (totals.get(key) ?? 0) > 0).map(({ key }) => ({
    category: key,
    count: totals.get(key) as number,
  }));
}

/** What a click on an open fan resolved to. */
export type SpiderHit =
  | { kind: "hub" }
  | { kind: "leaf"; leaf: Amenity }
  | { kind: "miss" };

export function createAmenitySpiderController({
  map,
  el,
  onActiveChange,
}: {
  map: maplibregl.Map;
  el: HTMLElement;
  /** Fires on every open/close so the amenities controller can hide (and restore)
   * the marks the fan replaces. */
  onActiveChange: (active: boolean) => void;
}): AmenitySpiderController {
  let hub: [number, number] | null = null;
  let leaves: Amenity[] = [];
  let legs: SpiderLeg[] = [];
  let hubRadius = 0;
  let hubMarker: maplibregl.Marker | null = null;
  /** Leaf screen positions from the last recompute — what `pickLeaf` measures, so
   * a pick can never disagree with what is drawn. */
  let points: { x: number; y: number }[] = [];
  let raf = 0;
  let disposed = false;

  function source(): maplibregl.GeoJSONSource | undefined {
    return map.getSource(SPIDER_SOURCE) as maplibregl.GeoJSONSource | undefined;
  }

  /** Project the hub, lay the legs out around it, and write the fan. */
  function render() {
    if (disposed || !hub || leaves.length === 0) return;
    const origin = map.project(hub);
    points = legs.map((leg) => ({ x: origin.x + leg.dx, y: origin.y + leg.dy }));

    const features: GeoJSON.Feature[] = [];
    points.forEach((p, index) => {
      const leaf = leaves[index];
      if (!leaf) return;
      const at = map.unproject([p.x, p.y]);
      const coords: [number, number] = [at.lng, at.lat];
      features.push({
        type: "Feature",
        id: index,
        properties: {
          category: leaf.category,
          color: categoryColor(leaf.category),
          name: leaf.name,
          radius: SPIDER_LEAF_RADIUS_PX,
          // Label placement priority (lower wins). Names are collision-managed, so a
          // full fan of long names may have to drop some; ordering by leaf index makes
          // WHICH ones drop deterministic between repaints rather than arbitrary.
          leafOrder: index,
        },
        geometry: { type: "Point", coordinates: coords },
      });
      features.push({
        type: "Feature",
        properties: { leafIndex: index },
        geometry: { type: "LineString", coordinates: [hub as [number, number], coords] },
      });
    });
    source()?.setData({ type: "FeatureCollection", features });
    hubMarker?.setLngLat(hub);
  }

  function schedule() {
    if (disposed || raf || !hub) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  }

  function open(nextHub: [number, number], nextLeaves: readonly Amenity[]) {
    // A disposed controller must be inert, not merely quiet: without this, a late
    // callback (a resolved cluster expansion racing an unmount) would add a DOM
    // marker to a map that is about to be removed — the leak class the dispose
    // contract exists to prevent.
    if (disposed || nextLeaves.length === 0) return;
    close(); // one fan at a time; a second click elsewhere replaces it
    hub = nextHub;
    leaves = [...nextLeaves];
    const counts = countLeaves(leaves);
    hubRadius = clusterFootprintRadius(leaves.length);
    legs = spiderLegs(leaves.length, { hubRadius });

    const button = buildDonutElement(counts, leaves.length);
    button.dataset[HUB_DATA_FLAG] = "1";
    // The hub's job changes while expanded, and its label has to say so — the
    // built-in one offers to list the places, which is what expanding replaced.
    button.setAttribute(
      "aria-label",
      `${leaves.length} places here, fanned out below. Activate to collapse.`,
    );
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      close();
    });
    hubMarker = new maplibregl.Marker({ element: button }).setLngLat(nextHub).addTo(map);

    el.dataset.amenitySpider = String(leaves.length);
    onActiveChange(true);
    render(); // draw immediately; do not wait for the next frame
  }

  function close() {
    const wasOpen = hub !== null;
    hub = null;
    leaves = [];
    legs = [];
    points = [];
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    hubMarker?.remove();
    hubMarker = null;
    source()?.setData({ type: "FeatureCollection", features: [] });
    delete el.dataset.amenitySpider;
    // Only announce a real transition: an unconditional call would re-apply the
    // amenity filter on every unrelated close and fight the reach view for it.
    if (wasOpen) onActiveChange(false);
  }

  // A fan is a screen-space arrangement anchored to one place, so every camera
  // change has to re-lay it out. `move` covers pan/zoom/rotate/pitch including
  // animation frames; `resize` changes the projection without moving the camera.
  map.on("move", schedule);
  map.on("resize", schedule);

  return {
    open,
    close,
    isOpen: () => hub !== null,
    resolveClick(point) {
      if (!hub) return { kind: "miss" };
      // Both targets honour the same 44px contract the donut path established: a
      // 9px-radius leaf demanded near-pixel precision, and on touch a 3px miss used to
      // DESTROY the fan the user had just opened.
      const candidates: { hit: SpiderHit; d: number }[] = [];
      const hubPoint = map.project(hub);
      const hubD = Math.hypot(hubPoint.x - point.x, hubPoint.y - point.y);
      if (hubD <= Math.max(hubRadius, MIN_MARK_TAP_RADIUS_PX)) {
        candidates.push({ hit: { kind: "hub" }, d: hubD });
      }
      points.forEach((p, index) => {
        const leaf = leaves[index];
        if (!leaf) return;
        const d = Math.hypot(p.x - point.x, p.y - point.y);
        if (d > Math.max(SPIDER_LEAF_RADIUS_PX + 2, MIN_MARK_TAP_RADIUS_PX)) return;
        candidates.push({ hit: { kind: "leaf", leaf }, d });
      });
      if (candidates.length === 0) return { kind: "miss" };
      // Nearest centre wins across BOTH kinds — the hub does not get priority just for
      // being asked first.
      candidates.sort((a, b) => a.d - b.d);
      return candidates[0].hit;
    },
    dispose() {
      disposed = true;
      map.off("move", schedule);
      map.off("resize", schedule);
      close();
    },
  };
}
