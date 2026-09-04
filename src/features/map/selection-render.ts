import type maplibregl from "maplibre-gl";
import { mapGl } from "@/features/map/map-runtime";

import { MARKER_COLOR } from "@/features/isochrones/isochrone-view";
import { presetMinFor, type PresetIndex } from "@/features/isochrones/preset-reach";
import {
  buildPresetContourFeatures,
  buildPresetShellFeatures,
  PRESET_FILL_SOURCE,
  PRESET_LINE_SOURCE,
} from "@/features/isochrones/preset-view";
import type { LoadState } from "@/features/map/load-state";
import { EMPTY_FC } from "@/features/map/map-setup";
import type { EdgeInsets } from "@/features/map/route-framing";
import type { Mode, Origin, Ring } from "@/features/map/selection-flow";

/**
 * Paints (and clears) the phone-first PRESET reach + origin marker for a resolved
 * selection (phone-first). The client sends `?model=preset` (task 020's serving path),
 * so a resolution carries BOTH calibrated contours (walk [10,20] / transit
 * [20,40] / car [10,25]); this renderer paints the selected preset as the
 * decorative light→dark shells + the honest contour lines (`preset-view.ts`),
 * NOT the legacy fixed 15/30/45 iso bands. The chip index is pure client
 * visibility — `reselectPreset` repaints the stashed rings at the new index with
 * NO refetch and NO camera move (the route already returned both contours).
 *
 * A response that lands before MapLibre's `load` is buffered in the shared
 * `loadState.pending` and replayed by the load handler. Camera padding + settle
 * stamp + stop-popup teardown are delegated to their own controllers; this one
 * owns the preset GeoJSON write, the origin pin, the flyTo, and the
 * `data-selection`/`-mode`/`-preset-*` stamps. Owns the marker element, so
 * `dispose` removes it (the map teardown also drops it, but disposing is
 * explicit and cheap).
 */
export function createSelectionRender({
  map,
  el,
  loadState,
  reducedMotion,
  presetIndexRef,
  cancelRingReveal,
  applyCameraPadding,
  closeStopPopup,
}: {
  map: maplibregl.Map;
  el: HTMLElement;
  loadState: LoadState;
  reducedMotion: MediaQueryList;
  /** The selected preset chip index (0 = smaller/default, 1 = larger). Read at
   * paint time so a chip change repaints the stashed rings without a refetch. */
  presetIndexRef: { current: PresetIndex };
  cancelRingReveal: (clearReadback?: boolean) => void;
  applyCameraPadding: (hasResults: boolean) => EdgeInsets;
  closeStopPopup: () => void;
}) {
  let marker: maplibregl.Marker | null = null;
  // The last resolved rings/mode/origin, so a chip change (reselectPreset) can
  // repaint the same served set at a new preset index without a refetch.
  let lastRender: { origin: Origin; rings: Ring[]; mode: Mode } | null = null;
  // Settle epoch: every renderSelection/clearSelection bumps it so a superseded
  // selection's pending moveend can't stamp data-camera-settled for the wrong fit.
  let settleEpoch = 0;

  /** Paint the preset shells + contour lines for the current chip index over the
   * given served rings, and stamp the deterministic read-back oracle (the binding
   * proof): the served contour minutes, the calibrated interior-line
   * minutes, and the selected preset. No camera move — callers own framing. */
  function paintPreset(origin: Origin, rings: Ring[], mode: Mode) {
    const selectedMin = presetMinFor(mode, presetIndexRef.current);
    const shells = buildPresetShellFeatures(rings, mode, selectedMin, origin);
    const contours = buildPresetContourFeatures(rings, mode, selectedMin);
    const fillSource = map.getSource(PRESET_FILL_SOURCE) as maplibregl.GeoJSONSource | undefined;
    const lineSource = map.getSource(PRESET_LINE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    fillSource?.setData({ type: "FeatureCollection", features: shells });
    lineSource?.setData({ type: "FeatureCollection", features: contours });
    // Deterministic oracle stamped from the ACTUALLY-BUILT features, NOT from the
    // client-side `presetContourMinutes(mode, chip)` constants — so if the served
    // set can't back the selection (a drifted server contract), nothing paints AND
    // the read-back reflects that (rule 13: the instrument must bind to the render,
    // not restate the request; the previous stamp would read "10,20" over a blank
    // map — impl review). `data-reach-empty` is the explicit failed-render stamp.
    if (contours.length === 0) {
      el.dataset.reachEmpty = "true";
      delete el.dataset.presetContours;
      delete el.dataset.interiorLines;
      delete el.dataset.selectedPreset;
      delete el.dataset.shellCount;
      return;
    }
    delete el.dataset.reachEmpty;
    const minutesOf = (kind: string) =>
      contours
        .filter((f) => f.properties?.kind === kind)
        .map((f) => f.properties!.minutes as number)
        .sort((a, b) => a - b);
    const interior = minutesOf("interior");
    const edge = minutesOf("edge");
    el.dataset.presetContours = [...interior, ...edge].sort((a, b) => a - b).join(",");
    el.dataset.interiorLines = interior.join(",");
    el.dataset.selectedPreset = String(edge[0] ?? selectedMin);
    el.dataset.shellCount = String(shells.length);
  }

  function renderSelection(origin: Origin, label: string, rings: Ring[], mode: Mode) {
    if (!loadState.styleLoaded) {
      loadState.pending = { origin, label, rings, mode };
      return;
    }
    lastRender = { origin, rings, mode };
    paintPreset(origin, rings, mode);

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
    marker = new (mapGl().Marker)({ element: markerElement, anchor: "center" });
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
    // THIS fit settles, so a test can wait for the camera to reach the origin
    // before projecting pixels — instead of a fixed sleep. An epoch guards
    // against a superseded selection's moveend (or an interrupt's synchronous
    // moveend) stamping the wrong fit. The `once` is registered AFTER flyTo so
    // the interrupt-of-a-previous-animation moveend (fired synchronously inside
    // flyTo) can't trigger it; a zero-duration (reduced-motion) fit is already
    // settled, so it stamps directly.
    const epoch = ++settleEpoch;
    delete el.dataset.cameraSettled;
    const instant = reducedMotion.matches;
    // Mode-aware default zoom: a car covers far more ground per minute, so its
    // reach is several times the walk reach; at zoom 13 the larger car preset
    // would fill the viewport as an edgeless wash. Frame car one level wider so
    // the reach BOUNDARY is visible. Walk/transit stay at 13 (transit stop-lines
    // pixel math depends on it — e2e).
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

  /** Repaint the last resolved rings at the CURRENT chip index — the chip is pure
   * client-side visibility (the route already returned both contours), so this
   * needs no refetch and no camera move. No-op before the first resolution or
   * before the style settles (a pre-load chip change is captured by the pending
   * replay, which paints at the then-current index). */
  function reselectPreset() {
    if (!lastRender || !loadState.styleLoaded) return;
    paintPreset(lastRender.origin, lastRender.rings, lastRender.mode);
  }

  function clearSelection() {
    loadState.pending = null;
    lastRender = null;
    settleEpoch++; // invalidate any pending settle stamp from a prior fit
    cancelRingReveal();
    closeStopPopup(); // a new selection dismisses any open stop popup
    (map.getSource(PRESET_FILL_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      EMPTY_FC as GeoJSON.FeatureCollection,
    );
    (map.getSource(PRESET_LINE_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      EMPTY_FC as GeoJSON.FeatureCollection,
    );
    marker?.remove();
    delete el.dataset.selection;
    delete el.dataset.isochroneRings;
    delete el.dataset.mode;
    delete el.dataset.presetContours;
    delete el.dataset.interiorLines;
    delete el.dataset.selectedPreset;
    delete el.dataset.shellCount;
    delete el.dataset.reachEmpty;
    delete el.dataset.cameraMotion;
    delete el.dataset.cameraSettled;
  }

  return {
    renderSelection,
    reselectPreset,
    clearSelection,
    dispose() {
      marker?.remove();
      marker = null;
    },
  };
}

export type SelectionRender = ReturnType<typeof createSelectionRender>;
