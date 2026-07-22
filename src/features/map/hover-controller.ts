import type maplibregl from "maplibre-gl";

import type { LoadState } from "@/features/map/load-state";
import { MARKER_PICK_PAD_PX, pickNearestWithin } from "@/features/map/marker-pick";

export interface AmenityPick {
  feature: maplibregl.MapGeoJSONFeature;
  coords: [number, number];
}

/**
 * Amenity hover + pick (task 024/042). The padded nearest-marker decision lives
 * in the pure, unit-tested `pickNearestWithin`; this controller only projects
 * the rendered features into pixel space and drives MapLibre feature-state +
 * the `data-amenity-hover` stamp. Hover hit-tests are coalesced to one
 * `queryRenderedFeatures` per animation frame so dense layers don't run pick
 * work on every mousemove. `dispose` cancels any queued frame so a late
 * callback can't touch a torn-down map.
 */
export function createHoverController({
  map,
  el,
  loadState,
}: {
  map: maplibregl.Map;
  el: HTMLElement;
  loadState: LoadState;
}) {
  // Pick the amenity marker nearest the cursor within a ±MARKER_PICK_PAD_PX box
  // — ANY category. Used by BOTH the click and hover handlers, so the hover
  // affordance always predicts what a click will do.
  function pickAmenity(point: maplibregl.Point): AmenityPick | null {
    if (!loadState.styleLoaded) return null;
    const pad = MARKER_PICK_PAD_PX;
    const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
      [point.x - pad, point.y - pad],
      [point.x + pad, point.y + pad],
    ];
    const hits = map.queryRenderedFeatures(bbox, { layers: ["amenity-markers"] });
    const candidates = [];
    for (const f of hits) {
      if (f.geometry.type !== "Point") continue;
      const [lng, lat] = f.geometry.coordinates;
      const p = map.project([lng, lat]);
      candidates.push({ x: p.x, y: p.y, feature: f, coords: [lng, lat] as [number, number] });
    }
    const hit = pickNearestWithin(candidates, point, pad);
    return hit ? { feature: hit.feature, coords: hit.coords } : null;
  }

  // Hover feedback: the hovered marker grows via feature-state and the cursor
  // turns pointer. `data-amenity-hover` exposes it to e2e.
  let hoveredAmenityId: string | number | null = null;
  function setHoveredAmenity(id: string | number | null) {
    if (id === hoveredAmenityId) return;
    if (hoveredAmenityId !== null) {
      map.setFeatureState({ source: "amenities", id: hoveredAmenityId }, { hover: false });
    }
    hoveredAmenityId = id;
    if (id !== null) {
      map.setFeatureState({ source: "amenities", id }, { hover: true });
      el.dataset.amenityHover = String(id);
    } else {
      delete el.dataset.amenityHover;
    }
    map.getCanvas().style.cursor = id !== null ? "pointer" : "";
  }

  // Coalesce hover hit-tests to one queryRenderedFeatures per animation frame.
  let hoverRaf = 0;
  let pendingHoverPoint: maplibregl.Point | null = null;
  function cancelPendingAmenityHover() {
    if (hoverRaf) cancelAnimationFrame(hoverRaf);
    hoverRaf = 0;
    pendingHoverPoint = null;
  }
  function scheduleAmenityHover(point: maplibregl.Point) {
    pendingHoverPoint = point;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const p = pendingHoverPoint;
      pendingHoverPoint = null;
      if (!p) return;
      const hit = pickAmenity(p);
      setHoveredAmenity(hit && hit.feature.id !== undefined ? hit.feature.id : null);
    });
  }

  // Feature-state outlives setData for a given generated id, so a repaint or
  // clear must drop the hover before the ids get reassigned to new markers.
  // Also drop any queued rAF so a late frame cannot re-apply hover after clear.
  function resetAmenityHover() {
    cancelPendingAmenityHover();
    if (!loadState.styleLoaded || !map.getSource("amenities")) return;
    setHoveredAmenity(null);
    map.removeFeatureState({ source: "amenities" });
  }

  return {
    pickAmenity,
    setHoveredAmenity,
    scheduleAmenityHover,
    cancelPendingAmenityHover,
    resetAmenityHover,
    dispose() {
      cancelPendingAmenityHover();
    },
  };
}

export type HoverController = ReturnType<typeof createHoverController>;
