import maplibregl from "maplibre-gl";

import { buildIsochroneFeatures, MARKER_COLOR } from "@/features/isochrones/isochrone-view";
import type { LoadState } from "@/features/map/load-state";
import { EMPTY_FC } from "@/features/map/map-setup";
import type { EdgeInsets } from "@/features/map/route-framing";
import type { Mode, Origin, Ring } from "@/features/map/selection-flow";

/**
 * Paints (and clears) the isochrone rings + origin marker for a resolved
 * selection. A response that lands before MapLibre's `load` is buffered in the
 * shared `loadState.pending` and replayed by the load handler. Ring reveal +
 * camera padding + stop-popup teardown are delegated to their own controllers;
 * this one owns the isochrone GeoJSON write, the origin pin, the flyTo, and the
 * `data-selection`/`-isochrone-rings`/`-mode` stamps. Owns the marker element,
 * so `dispose` removes it (the map teardown also drops it, but disposing is
 * explicit and cheap).
 */
export function createSelectionRender({
  map,
  el,
  loadState,
  reducedMotion,
  revealRings,
  cancelRingReveal,
  applyCameraPadding,
  closeStopPopup,
}: {
  map: maplibregl.Map;
  el: HTMLElement;
  loadState: LoadState;
  reducedMotion: MediaQueryList;
  revealRings: () => void;
  cancelRingReveal: (clearReadback?: boolean) => void;
  applyCameraPadding: (hasResults: boolean) => EdgeInsets;
  closeStopPopup: () => void;
}) {
  let marker: maplibregl.Marker | null = null;
  // Settle epoch: every renderSelection/clearSelection bumps it so a superseded
  // selection's pending moveend can't stamp data-camera-settled for the wrong fit.
  let settleEpoch = 0;

  function renderSelection(origin: Origin, label: string, rings: Ring[], mode: Mode) {
    if (!loadState.styleLoaded) {
      loadState.pending = { origin, label, rings, mode };
      return;
    }
    const source = map.getSource("isochrone") as maplibregl.GeoJSONSource | undefined;
    source?.setData({
      type: "FeatureCollection",
      features: buildIsochroneFeatures(rings, mode),
    });
    revealRings();

    // A compact halo pin marks the exact origin without the visual weight or
    // transparent tail of MapLibre's default teardrop marker.
    marker?.remove();
    const markerElement = document.createElement("div");
    markerElement.className = "hf-origin-marker";
    markerElement.setAttribute("aria-hidden", "true");
    markerElement.style.setProperty("--hf-origin-color", MARKER_COLOR[mode]);
    const aura = document.createElement("span");
    aura.className = "hf-origin-marker__aura";
    const core = document.createElement("span");
    core.className = "hf-origin-marker__core";
    markerElement.append(aura, core);
    marker = new maplibregl.Marker({ element: markerElement, anchor: "center" });
    // Pointer-transparent: the origin pin is display-only, so it must never
    // swallow a click/hover meant for an amenity marker underneath (task 024
    // — closes the exact-origin transit stop limitation parked in task 021).
    marker.getElement().style.pointerEvents = "none";
    // Marker sits at the isochrone's rounded origin (T9) so it matches the rings.
    marker.setLngLat([origin.lng, origin.lat]).addTo(map);
    // Padded so the selection centers in the map area the dock doesn't cover
    // (the SHARED contract with any fitBounds — see features/map/camera.ts).
    const padding = applyCameraPadding(true);
    // Deterministic settle signal for e2e: cleared here, stamped "true" only when
    // THIS fit settles, so a test can wait for the camera to reach zoom-13 over
    // the origin before projecting pixels — instead of a fixed sleep. An epoch
    // guards against a superseded selection's moveend (or an interrupt's
    // synchronous moveend) stamping the wrong fit. The `once` is registered AFTER
    // flyTo so the interrupt-of-a-previous-animation moveend (fired synchronously
    // inside flyTo) can't trigger it; a zero-duration (reduced-motion) fit is
    // already settled, so it stamps directly.
    const epoch = ++settleEpoch;
    delete el.dataset.cameraSettled;
    const instant = reducedMotion.matches;
    // Mode-aware default zoom (task 053): a car covers far more ground per minute,
    // so its inner (default 10-min) ring is several times the walk 15-min ring;
    // at zoom 13 it would fill the viewport as an edgeless blue wash. Frame car
    // one level wider so the default ring's BOUNDARY is visible. Walk/transit
    // stay at 13 (transit stop-lines pixel math depends on it — e2e).
    const zoom = mode === "car" ? 12 : 13;
    map.flyTo({
      center: [origin.lng, origin.lat],
      zoom,
      essential: false,
      duration: instant ? 0 : 900,
      padding,
    });
    if (instant) {
      el.dataset.cameraSettled = "true";
    } else {
      map.once("moveend", () => {
        if (epoch === settleEpoch) el.dataset.cameraSettled = "true";
      });
    }
    el.dataset.cameraMotion = instant ? "instant" : "animated";

    el.dataset.selection = label;
    el.dataset.isochroneRings = String(rings.length);
    el.dataset.mode = mode;
  }

  function clearSelection() {
    loadState.pending = null;
    settleEpoch++; // invalidate any pending settle stamp from a prior fit
    cancelRingReveal();
    closeStopPopup(); // a new selection dismisses any open stop popup
    (map.getSource("isochrone") as maplibregl.GeoJSONSource | undefined)?.setData(
      EMPTY_FC as GeoJSON.FeatureCollection,
    );
    marker?.remove();
    delete el.dataset.selection;
    delete el.dataset.isochroneRings;
    delete el.dataset.mode;
    delete el.dataset.cameraMotion;
    delete el.dataset.cameraSettled;
  }

  return {
    renderSelection,
    clearSelection,
    dispose() {
      marker?.remove();
      marker = null;
    },
  };
}

export type SelectionRender = ReturnType<typeof createSelectionRender>;
