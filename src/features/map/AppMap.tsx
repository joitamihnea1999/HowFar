"use client";

import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import "maplibre-gl/dist/maplibre-gl.css";

import {
  amenityCategoryLabel,
  buildAmenityFeatures,
  countByCategory,
  type Amenity,
  type AmenityCounts,
} from "@/features/amenities/amenities";
import {
  AMENITY_MAX_AUTO_RETRIES,
  AMENITY_RETRY_DELAY_MS,
  isNewAmenityOrigin,
  isRetryableAmenityFailure,
  originKey,
} from "@/features/amenities/amenities-flow";
import {
  buildRoutePathFeatures,
  routePathBounds,
  type RoutePath,
} from "@/features/amenities/route-path";
import type { StopLine } from "@/features/amenities/stop-lines";
import { buildStopPopupModel, STOP_POPUP_TEXT, type StopPopupModel } from "@/features/amenities/stop-popup";
import { BUCHAREST_MAX_BOUNDS } from "@/lib/bounds";
import {
  buildIsochroneFeatures,
  DEFAULT_RING_FILTER,
  MARKER_COLOR,
  RING_MINUTES,
  ringLayerVisibility,
  type RingFilter,
} from "@/features/isochrones/isochrone-view";
import AmenityPanel from "@/features/map/AmenityPanel";
import AttributionBadge from "@/features/map/AttributionBadge";
import EmptyState from "@/features/map/EmptyState";
import {
  addAmenityLayers,
  addIsochroneLayers,
  addRoutePathLayers,
  createMapStyle,
  EMPTY_FC,
  ISOCHRONE_FILL_OPACITY,
  ISOCHRONE_LINE_OPACITY,
} from "@/features/map/map-setup";
import { cameraPadding } from "@/features/map/camera";
import { MARKER_PICK_PAD_PX, pickNearestWithin } from "@/features/map/marker-pick";
import ModeToggle from "@/features/map/ModeToggle";
import RingSelector from "@/features/map/RingSelector";
import SearchForm from "@/features/map/SearchForm";
import SelectionCard from "@/features/map/SelectionCard";
import SuggestList from "@/features/map/SuggestList";
import {
  comboboxReducer,
  initialComboboxState,
  shouldFetchSuggest,
  type ComboboxAction,
  type ComboboxState,
  type Suggestion,
} from "@/features/search/combobox";
import {
  initialSelectionState,
  isochronePath,
  reverseIsFatal,
  selectionReducer,
  type Mode,
  type Origin,
  type Ring,
  type SelectInput,
  type SelectionAction,
  type SelectionState,
} from "@/features/map/selection-flow";

// Piața Unirii — the classic Bucharest reference point.
const BUCHAREST_CENTER: [number, number] = [26.1025, 44.4268];
const SUGGEST_DEBOUNCE_MS = 250;
// Client-side deadline on the stop-lines fetch so a degraded Overpass can't leave
// the popup on "Finding lines…" for the server's full ~18s host budget (task 021
// — the "never hang on loading" lesson from the search box, task 013).
const STOP_LINES_TIMEOUT_MS = 9000;
// Same rationale for the route-path fetch behind a clicked line row (task 024).
const ROUTE_PATH_TIMEOUT_MS = 9000;
/** Staged All-mode ring reveal: start delay + per-band dwell (ms). Dwell is long
 * enough to be perceptible and for tests to observe paint without racing a
 * sub-poll-interval transient. */
const RING_REVEAL_START_MS = 80;
const RING_REVEAL_STAGE_MS = 280;

interface GeoPoint {
  lat: number;
  lng: number;
  label: string;
}

/** Amenities are a property of the resolved address, independent of the travel
 * mode — so they live outside the selection state machine, in their own UI slice. */
type AmenityUi = {
  status: "idle" | "loading" | "ready" | "error";
  counts: AmenityCounts | null;
  items: Amenity[];
};

/** Shared result-surface predicate for the React shell and camera resize path. */
function hasResultSurface(
  sel: Pick<SelectionState, "status" | "label" | "message">,
  amenityStatus: AmenityUi["status"],
): boolean {
  return sel.status === "loading" || Boolean(sel.label || sel.message) || amenityStatus !== "idle";
}

interface AppMapProps {
  utilityHeader?: ReactNode;
}

export default function AppMap({ utilityHeader }: AppMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const selectRef = useRef<((input: SelectInput, opts?: { recompute?: boolean }) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const suggestAbortRef = useRef<AbortController | null>(null);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Amenities: keyed by rounded origin (NOT the selection token, which a mode
  // toggle bumps) so a Walk↔Transit toggle persists the markers with no refetch;
  // a generation guards stale responses. A transient failure auto-retries once
  // (task 024: the public-Overpass race flakes and recovers seconds later), and
  // the last origin is kept so the panel's Retry button can refetch it.
  const amenityAbortRef = useRef<AbortController | null>(null);
  const amenityGenRef = useRef(0);
  const amenityKeyRef = useRef<string | null>(null);
  const amenityOriginRef = useRef<Origin | null>(null);
  const amenityRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearAmenitiesRef = useRef<(() => void) | null>(null);
  const fetchAmenitiesRef = useRef<((origin: Origin, attempt: number) => void) | null>(null);
  const inspectAmenityRef = useRef<((item: Amenity) => void) | null>(null);
  const [amenity, setAmenity] = useState<AmenityUi>({ status: "idle", counts: null, items: [] });
  // Mirrored so the map effect's resize handler (empty deps) can read the latest
  // amenity status without re-binding listeners. Updated in an effect — not during
  // render — to satisfy the react-hooks/refs lint rule.
  const amenityRef = useRef(amenity);
  useEffect(() => {
    amenityRef.current = amenity;
  }, [amenity]);

  // Transit-stop line popup (task 021): a click on a transit marker opens a
  // MapLibre popup with the lines serving it. Independent of the selection
  // machine (it never starts an isochrone); a generation + abort guard drops a
  // stale response when the user clicks another stop or starts a new selection.
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const stopLinesAbortRef = useRef<AbortController | null>(null);
  const stopLinesGenRef = useRef(0);
  const closeStopPopupRef = useRef<(() => void) | null>(null);

  // Selected transit line's drawn path (task 024). Cleared by re-clicking the
  // row, by the popup closing (X, replacement, new selection, mode toggle —
  // all remove the popup, which fires MapLibre's `close`), and by unmount.
  const routePathAbortRef = useRef<AbortController | null>(null);
  const routePathGenRef = useRef(0);

  // The two extracted state machines drive the render via useState, but each is
  // mirrored in a ref so a dispatch can be read back synchronously in the same
  // tick (fresh token/generation) from the imperative fetch orchestration —
  // see features/map/selection-flow and features/search/combobox. Render reads the state; callbacks
  // read the ref.
  const [selState, setSelState] = useState<SelectionState>(initialSelectionState);
  const [comboState, setComboState] = useState<ComboboxState>(initialComboboxState);
  const selRef = useRef<SelectionState>(initialSelectionState);
  const comboRef = useRef<ComboboxState>(initialComboboxState);

  // Ring display filter (task 024): which time band(s) the isochrone layers
  // show. State drives the control + legend; the ref-mirrored applier flips
  // layer visibility imperatively (the layers persist across selections and
  // mode toggles, so the filter survives both for free).
  const [ringFilter, setRingFilter] = useState<RingFilter>(DEFAULT_RING_FILTER);
  const ringFilterRef = useRef<RingFilter>(DEFAULT_RING_FILTER);
  const applyRingFilterRef = useRef<((filter: RingFilter) => void) | null>(null);

  function selectRingFilter(next: RingFilter) {
    // No-op re-clicks of the active filter must not cancel an in-flight staged
    // reveal (applyRingFilter snaps every band to full opacity).
    if (next === ringFilterRef.current) return;
    ringFilterRef.current = next;
    setRingFilter(next);
    applyRingFilterRef.current?.(next);
  }

  function dispatchSel(action: SelectionAction): SelectionState {
    const next = selectionReducer(selRef.current, action);
    if (next !== selRef.current) {
      selRef.current = next;
      setSelState(next);
    }
    return next;
  }
  function dispatchCombo(action: ComboboxAction): ComboboxState {
    const next = comboboxReducer(comboRef.current, action);
    if (next !== comboRef.current) {
      comboRef.current = next;
      setComboState(next);
    }
    return next;
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Non-null capture so nested closures (renderSelection, load) keep the type.
    const el: HTMLDivElement = container;

    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    const map = new maplibregl.Map({
      container,
      style: createMapStyle(`${window.location.origin}/api/tiles`),
      center: BUCHAREST_CENTER,
      zoom: 11.5,
      maxBounds: BUCHAREST_MAX_BOUNDS,
      attributionControl: { compact: false },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), "bottom-right");

    // Buffer the latest selection until the style (and isochrone source/layers)
    // exist — a search that resolves before `load` would otherwise drop its rings.
    let styleLoaded = false;
    let pending: { origin: Origin; label: string; rings: Ring[]; mode: Mode } | null = null;
    let pendingAmenities: { items: Amenity[]; counts: AmenityCounts } | null = null;
    let ringRevealTimers: Array<ReturnType<typeof setTimeout>> = [];

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    function applyCameraPadding(hasResults: boolean) {
      const padding = cameraPadding(el.clientWidth, el.clientHeight, hasResults);
      // Permanent MapLibre edge insets — route fit and interrupted flyTo paths
      // read map.getPadding(), so dataset stamps alone are not enough.
      map.setPadding(padding);
      const live = map.getPadding();
      const applied = {
        top: live.top ?? padding.top,
        right: live.right ?? padding.right,
        bottom: live.bottom ?? padding.bottom,
        left: live.left ?? padding.left,
      };
      el.dataset.cameraPadTop = String(applied.top);
      el.dataset.cameraPadRight = String(applied.right);
      el.dataset.cameraPadBottom = String(applied.bottom);
      el.dataset.cameraPadLeft = String(applied.left);
      return applied;
    }

    function cancelRingReveal(clearReadback = true) {
      for (const timer of ringRevealTimers) clearTimeout(timer);
      ringRevealTimers = [];
      if (clearReadback) {
        delete el.dataset.ringReveal;
        delete el.dataset.ringRevealSequence;
        delete el.dataset.ringPaintTrace;
        delete el.dataset.ringPaint15;
        delete el.dataset.ringPaint30;
        delete el.dataset.ringPaint45;
      }
    }

    function setRingTransition(duration: number) {
      for (const minutes of RING_MINUTES) {
        map.setPaintProperty(`iso-fill-${minutes}`, "fill-opacity-transition", { duration, delay: 0 });
        map.setPaintProperty(`iso-line-${minutes}`, "line-opacity-transition", { duration, delay: 0 });
      }
    }

    function stampRingPaintReadbacks() {
      for (const minutes of RING_MINUTES) {
        el.dataset[`ringPaint${minutes}`] = String(
          map.getPaintProperty(`iso-fill-${minutes}`, "fill-opacity"),
        );
      }
    }

    /** Cumulative paint trace: each stage records live fill opacities in
     * RING_MINUTES order (45,30,15). Tests assert the settled attribute instead
     * of racing a sub-poll-interval intermediate. */
    function appendRingPaintTrace(stage: string) {
      const paints = RING_MINUTES.map((minutes) =>
        String(map.getPaintProperty(`iso-fill-${minutes}`, "fill-opacity")),
      ).join(",");
      const entry = `${stage}:${paints}`;
      const prev = el.dataset.ringPaintTrace;
      el.dataset.ringPaintTrace = prev ? `${prev}|${entry}` : entry;
    }

    function setRingRevealed(minutes: (typeof RING_MINUTES)[number], revealed: boolean) {
      map.setPaintProperty(`iso-fill-${minutes}`, "fill-opacity", revealed ? ISOCHRONE_FILL_OPACITY : 0);
      map.setPaintProperty(`iso-line-${minutes}`, "line-opacity", revealed ? ISOCHRONE_LINE_OPACITY : 0);
      // Paint-property READ-BACK (not requested-state echo): keeps the signature
      // transition objectively testable through MapLibre's live style.
      stampRingPaintReadbacks();
    }

    // Largest-to-smallest reads as the city opening up, then resolving around
    // the selected address. The active ring filter still owns layer visibility;
    // this only animates the bands that are currently visible.
    function revealRings() {
      cancelRingReveal(false);
      delete el.dataset.ringPaintTrace;
      if (reducedMotion.matches) {
        setRingTransition(0); // no inherited 320ms fade under reduced motion
        for (const minutes of RING_MINUTES) setRingRevealed(minutes, true);
        el.dataset.ringReveal = "settled";
        el.dataset.ringRevealSequence = "instant";
        appendRingPaintTrace("instant");
        return;
      }

      // Reveal what the user can actually see. A single-band filter resolves
      // that band immediately; All tells the full outer-to-inner story. Hidden
      // bands remain at their final opacity so changing filters never exposes a
      // band stranded at zero. The zero-duration hide prevents a flash/fade-out
      // before the reveal transition begins.
      const stages = ringFilterRef.current === "all" ? [...RING_MINUTES] : [ringFilterRef.current];
      setRingTransition(0);
      for (const minutes of stages) setRingRevealed(minutes, false);
      setRingTransition(320);
      el.dataset.ringReveal = "starting";
      el.dataset.ringRevealSequence = "";
      appendRingPaintTrace("start");
      const sequence: number[] = [];
      for (const [index, minutes] of stages.entries()) {
        ringRevealTimers.push(
          setTimeout(() => {
            setRingRevealed(minutes, true);
            sequence.push(minutes);
            el.dataset.ringReveal = String(minutes);
            el.dataset.ringRevealSequence = sequence.join(",");
            appendRingPaintTrace(String(minutes));
          }, RING_REVEAL_START_MS + index * RING_REVEAL_STAGE_MS),
        );
      }
      ringRevealTimers.push(
        setTimeout(() => {
          el.dataset.ringReveal = "settled";
          appendRingPaintTrace("settled");
          ringRevealTimers = [];
        }, RING_REVEAL_START_MS + (stages.length - 1) * RING_REVEAL_STAGE_MS + 340),
      );
    }

    function renderSelection(origin: Origin, label: string, rings: Ring[], mode: Mode) {
      if (!styleLoaded) {
        pending = { origin, label, rings, mode };
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
      markerRef.current?.remove();
      const markerElement = document.createElement("div");
      markerElement.className = "hf-origin-marker";
      markerElement.setAttribute("aria-hidden", "true");
      markerElement.style.setProperty("--hf-origin-color", MARKER_COLOR[mode]);
      const aura = document.createElement("span");
      aura.className = "hf-origin-marker__aura";
      const core = document.createElement("span");
      core.className = "hf-origin-marker__core";
      markerElement.append(aura, core);
      markerRef.current = new maplibregl.Marker({ element: markerElement, anchor: "center" });
      // Pointer-transparent: the origin pin is display-only, so it must never
      // swallow a click/hover meant for an amenity marker underneath (task 024
      // — closes the exact-origin transit stop limitation parked in task 021).
      markerRef.current.getElement().style.pointerEvents = "none";
      // Marker sits at the isochrone's rounded origin (T9) so it matches the rings.
      markerRef.current.setLngLat([origin.lng, origin.lat]).addTo(map);
      // Padded so the selection centers in the map area the dock doesn't cover
      // (the SHARED contract with any fitBounds — see features/map/camera.ts).
      const padding = applyCameraPadding(true);
      map.flyTo({
        center: [origin.lng, origin.lat],
        zoom: 13,
        essential: false,
        duration: reducedMotion.matches ? 0 : 900,
        padding,
      });
      el.dataset.cameraMotion = reducedMotion.matches ? "instant" : "animated";

      el.dataset.selection = label;
      el.dataset.isochroneRings = String(rings.length);
      el.dataset.mode = mode;
    }

    function clearSelection() {
      pending = null;
      cancelRingReveal();
      closeStopPopupRef.current?.(); // a new selection dismisses any open stop popup
      (map.getSource("isochrone") as maplibregl.GeoJSONSource | undefined)?.setData(
        EMPTY_FC as GeoJSON.FeatureCollection,
      );
      markerRef.current?.remove();
      delete el.dataset.selection;
      delete el.dataset.isochroneRings;
      delete el.dataset.mode;
      delete el.dataset.cameraMotion;
    }

    // `counts` are the server's TRUE clipped totals (may exceed the rendered
    // marker count when a category was capped) — the chips show these, not a
    // recount of the capped markers.
    function renderAmenities(items: Amenity[], counts: AmenityCounts) {
      // Buffer until the style (and the amenities source) exist — an amenity
      // response can land before `load`, exactly like the isochrone.
      if (!styleLoaded) {
        pendingAmenities = { items, counts };
        setAmenity({ status: "ready", counts, items });
        return;
      }
      resetAmenityHover(); // generated ids are about to be reassigned
      (map.getSource("amenities") as maplibregl.GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: buildAmenityFeatures(items) as GeoJSON.Feature[],
      });
      el.dataset.amenityCount = String(items.length);
      setAmenity({ status: "ready", counts, items });
    }

    // Drop amenity markers/counts and supersede any in-flight fetch or pending
    // retry. Called only on a genuinely-new selection — NOT on a mode toggle
    // (which must persist).
    function clearAmenities() {
      amenityAbortRef.current?.abort();
      if (amenityRetryTimerRef.current) clearTimeout(amenityRetryTimerRef.current);
      amenityGenRef.current += 1;
      amenityKeyRef.current = null;
      amenityOriginRef.current = null;
      pendingAmenities = null;
      resetAmenityHover();
      (map.getSource("amenities") as maplibregl.GeoJSONSource | undefined)?.setData(
        EMPTY_FC as GeoJSON.FeatureCollection,
      );
      delete el.dataset.amenityCount;
      setAmenity({ status: "idle", counts: null, items: [] });
    }
    clearAmenitiesRef.current = clearAmenities;

    // One amenity fetch attempt. On a transient failure (5xx/network — see
    // isRetryableAmenityFailure) the first attempt schedules ONE delayed retry,
    // staying in "loading" so the user never sees an error that would self-heal.
    // Any failure that DOES surface clears the origin key — an error must never
    // pin the key, or the panel's Retry button and a mode-toggle recompute would
    // be swallowed by the isNewAmenityOrigin guard.
    function fetchAmenities(origin: Origin, attempt: number) {
      amenityKeyRef.current = originKey(origin.lat, origin.lng);
      amenityOriginRef.current = origin;
      const gen = (amenityGenRef.current += 1);
      amenityAbortRef.current?.abort();
      const controller = new AbortController();
      amenityAbortRef.current = controller;
      setAmenity({ status: "loading", counts: null, items: [] });

      const failWith = (httpStatus: number | null) => {
        if (isRetryableAmenityFailure(httpStatus) && attempt < AMENITY_MAX_AUTO_RETRIES) {
          amenityRetryTimerRef.current = setTimeout(() => {
            if (gen !== amenityGenRef.current) return; // superseded meanwhile
            fetchAmenities(origin, attempt + 1);
          }, AMENITY_RETRY_DELAY_MS);
          return;
        }
        amenityKeyRef.current = null;
        setAmenity({ status: "error", counts: null, items: [] });
      };

      fetch(`/api/amenities?lat=${origin.lat}&lng=${origin.lng}`, { signal: controller.signal })
        .then(async (res) => {
          if (gen !== amenityGenRef.current) return;
          if (!res.ok) return void failWith(res.status);
          const data = (await res.json()) as { amenities?: unknown; counts?: AmenityCounts };
          if (gen !== amenityGenRef.current) return;
          // A valid-but-wrong-shape body (no array) is an error, not "no
          // amenities" — and deterministic, so it reports the real (non-5xx)
          // status and is never auto-retried.
          if (!Array.isArray(data.amenities)) return void failWith(res.status);
          const items = data.amenities as Amenity[];
          renderAmenities(items, data.counts ?? countByCategory(items));
        })
        .catch((err) => {
          if ((err as Error)?.name === "AbortError" || gen !== amenityGenRef.current) return;
          failWith(null);
        });
    }
    fetchAmenitiesRef.current = fetchAmenities;

    // Fetch amenities for a resolved origin, in parallel with the isochrone. A
    // toggle recompute resolves the same origin ⇒ no refetch — unless the last
    // fetch FAILED (the error path cleared the key), in which case the same
    // origin fetches again. A failure surfaces an amenity-only error and never
    // touches the isochrone.
    function maybeFetchAmenities(origin: Origin) {
      const key = originKey(origin.lat, origin.lng);
      if (!isNewAmenityOrigin(amenityKeyRef.current, key)) return;
      fetchAmenities(origin, 0);
    }

    // --- Selected transit line's path (task 024) ---------------------------
    // Drawn from the stop popup: clicking a line row fetches the OSM route
    // relation's track + stops and paints them; clicking the active row again
    // clears. One active line at a time.
    let activeRouteRelId: number | null = null;
    let activeRouteButton: HTMLButtonElement | null = null;
    let activeRouteBounds: ReturnType<typeof routePathBounds> = null;

    function setActiveRouteButton(button: HTMLButtonElement | null, state?: "loading" | "active" | "error") {
      activeRouteButton?.classList.remove(
        "hf-stop-popup__route--loading",
        "hf-stop-popup__route--active",
        "hf-stop-popup__route--error",
      );
      activeRouteButton = button;
      if (button && state) button.classList.add(`hf-stop-popup__route--${state}`);
    }

    function clearRoutePath() {
      routePathAbortRef.current?.abort();
      routePathGenRef.current += 1;
      activeRouteRelId = null;
      activeRouteBounds = null;
      setActiveRouteButton(null);
      if (styleLoaded) {
        (map.getSource("route-path") as maplibregl.GeoJSONSource | undefined)?.setData(
          EMPTY_FC as GeoJSON.FeatureCollection,
        );
      }
      delete el.dataset.routePath;
      delete el.dataset.routeFramed;
      delete el.dataset.routeCorridorHeight;
      delete el.dataset.routeFrame;
    }

    function routeFitPadding() {
      const dock = applyCameraPadding(true);
      // Keep a real viewing corridor even when the short-landscape command and
      // result docks consume most of the height. Larger canvases still receive
      // the preferred 40px breathing room on every available edge.
      const verticalRoom = Math.max(0, el.clientHeight - dock.top - dock.bottom - 72);
      const horizontalRoom = Math.max(0, el.clientWidth - dock.left - dock.right - 96);
      const verticalExtra = Math.min(40, verticalRoom / 2);
      const horizontalExtra = Math.min(40, horizontalRoom / 2);
      // MapLibre's bounds solver already includes the map's current (dock)
      // padding. These values are additional breathing room only; passing the
      // absolute dock values would double-count them and make a 390px viewport
      // mathematically impossible to fit.
      return {
        top: verticalExtra,
        bottom: verticalExtra,
        right: horizontalExtra,
        left: horizontalExtra,
      };
    }

    function stampRouteFraming() {
      if (!activeRouteBounds) return;
      const [southWest, northEast] = activeRouteBounds;
      const a = map.project(southWest);
      const b = map.project(northEast);
      const currentPadding = map.getPadding();
      const padding = {
        top: currentPadding.top ?? 0,
        right: currentPadding.right ?? 0,
        bottom: currentPadding.bottom ?? 0,
        left: currentPadding.left ?? 0,
      };
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      el.dataset.routeFramed = String(
        minX >= padding.left - 2 &&
          maxX <= el.clientWidth - padding.right + 2 &&
          minY >= padding.top - 2 &&
          maxY <= el.clientHeight - padding.bottom + 2,
      );
      el.dataset.routeCorridorHeight = String(
        Math.round(el.clientHeight - padding.top - padding.bottom),
      );
      el.dataset.routeFrame = [
        minX.toFixed(1),
        maxX.toFixed(1),
        minY.toFixed(1),
        maxY.toFixed(1),
        padding.left.toFixed(1),
        padding.right.toFixed(1),
        padding.top.toFixed(1),
        padding.bottom.toFixed(1),
      ].join(",");
    }

    function fitActiveRoute(duration: number) {
      if (!activeRouteBounds) return;
      const padding = routeFitPadding();
      const camera = map.cameraForBounds(activeRouteBounds, { padding, maxZoom: 14 });
      if (!camera) {
        el.dataset.routeFramed = "false";
        return;
      }
      map.once("moveend", stampRouteFraming);
      map.easeTo({
        ...camera,
        duration,
        essential: false,
      });
      requestAnimationFrame(stampRouteFraming);
      el.dataset.cameraMotion = duration === 0 ? "instant" : "animated";
    }

    function drawRoutePath(relationId: number, path: RoutePath) {
      (map.getSource("route-path") as maplibregl.GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: buildRoutePathFeatures(path),
      });
      // Stamp the dataset from a RENDER read-back, not the input: the e2e
      // contract is "the path is on the map", so the attribute must only appear
      // once the source actually holds features (gen-guarded — a clear/replace
      // before idle must not resurrect it).
      const gen = routePathGenRef.current;
      map.once("idle", () => {
        if (gen !== routePathGenRef.current) return;
        if (map.querySourceFeatures("route-path").length > 0) {
          el.dataset.routePath = String(relationId);
        }
      });
      const bounds = routePathBounds(path);
      if (!bounds) return;
      activeRouteBounds = bounds;
      fitActiveRoute(reducedMotion.matches ? 0 : 900);
    }

    function toggleRoutePath(relationId: number, button: HTMLButtonElement, anchor: [number, number]) {
      if (activeRouteRelId === relationId) return void clearRoutePath(); // re-click = off
      clearRoutePath(); // replace any other line
      activeRouteRelId = relationId;
      setActiveRouteButton(button, "loading");

      const gen = routePathGenRef.current;
      const controller = new AbortController();
      routePathAbortRef.current = controller;
      const timer = setTimeout(() => {
        if (gen === routePathGenRef.current) fail();
        controller.abort();
      }, ROUTE_PATH_TIMEOUT_MS);

      const fail = () => {
        // Bump the generation so a response whose json resolved JUST before the
        // deadline can't slip past the gen checks and draw over the error state.
        routePathGenRef.current += 1;
        activeRouteRelId = null;
        setActiveRouteButton(button, "error");
      };

      // The stop's own location rides along for the same out-of-area guard the
      // stop-lines route uses (fair-use posture; see /api/route-path).
      fetch(`/api/route-path?rel=${relationId}&lat=${anchor[1]}&lng=${anchor[0]}`, { signal: controller.signal })
        .then(async (res) => {
          if (gen !== routePathGenRef.current) return;
          if (!res.ok) return void fail();
          const path = (await res.json()) as RoutePath;
          if (gen !== routePathGenRef.current) return;
          // A wrong-shape body must not reach the GeoJSON source.
          if (!Array.isArray(path?.segments) || !Array.isArray(path?.stops)) return void fail();
          setActiveRouteButton(button, "active");
          drawRoutePath(relationId, path);
        })
        .catch((err) => {
          if ((err as Error)?.name === "AbortError" || gen !== routePathGenRef.current) return;
          fail();
        })
        .finally(() => clearTimeout(timer));
    }

    // --- Transit-stop line popup ------------------------------------------
    // Build the popup DOM from the pure model. textContent everywhere (never
    // innerHTML) — OSM names/headsigns are untrusted; this is the XSS guard.
    // A row whose line carries a relationId becomes a BUTTON that draws the
    // line's full path + stops (task 024); rows without one stay informational.
    function renderStopPopup(model: StopPopupModel, anchor: [number, number]): HTMLElement {
      const root = document.createElement("div");
      root.className = "hf-stop-popup";
      root.dataset.testid = "stop-popup";
      root.dataset.state = model.kind;

      const title = document.createElement("div");
      title.className = "hf-stop-popup__title";
      title.textContent = model.title;
      root.appendChild(title);

      const message = (text: string) => {
        const m = document.createElement("div");
        m.className = "hf-stop-popup__msg";
        m.textContent = text;
        root.appendChild(m);
      };

      if (model.kind === "loading") message(STOP_POPUP_TEXT.loading);
      else if (model.kind === "error") message(STOP_POPUP_TEXT.error);
      else if (model.kind === "empty") message(STOP_POPUP_TEXT.empty);
      else {
        const list = document.createElement("ul");
        list.className = "hf-stop-popup__lines";
        for (const row of model.rows) {
          const li = document.createElement("li");
          li.className = "hf-stop-popup__line";

          const label = document.createElement("span");
          label.className = "hf-stop-popup__ref";
          label.textContent = `${row.modeLabel} ${row.ref}`;

          const parts: HTMLElement[] = [label];
          if (row.direction) {
            const dir = document.createElement("span");
            dir.className = "hf-stop-popup__dir";
            dir.textContent = `→ ${row.direction}`;
            parts.push(dir);
          }

          if (row.relationId) {
            const relationId = row.relationId;
            const button = document.createElement("button");
            button.type = "button";
            button.className = "hf-stop-popup__route";
            button.title = "Show this line's route and stops";
            for (const part of parts) button.appendChild(part);
            button.addEventListener("click", () => toggleRoutePath(relationId, button, anchor));
            if (relationId === activeRouteRelId) setActiveRouteButton(button, "active");
            li.appendChild(button);
          } else {
            for (const part of parts) li.appendChild(part);
          }
          list.appendChild(li);
        }
        root.appendChild(list);
      }
      return root;
    }

    // Generic amenity info popup (task 024): name + category for any marker
    // that is not an identifiable transit stop. Same XSS posture as the stop
    // popup (textContent only — OSM names are untrusted). This is the mounting
    // point for per-place details (e.g. reviews) later.
    function renderPoiPopup(name: string, category: string): HTMLElement {
      const root = document.createElement("div");
      root.className = "hf-stop-popup";
      root.dataset.testid = "poi-popup";
      root.dataset.state = "ready";

      const label = amenityCategoryLabel(category);
      const title = document.createElement("div");
      title.className = "hf-stop-popup__title";
      title.textContent = name || label; // unnamed POIs fall back to the category
      root.appendChild(title);

      if (name) {
        const sub = document.createElement("div");
        sub.className = "hf-stop-popup__msg";
        sub.textContent = label;
        root.appendChild(sub);
      }
      return root;
    }

    function openPoiPopup(feature: maplibregl.MapGeoJSONFeature, coords: [number, number]) {
      closeStopPopup(); // shared popup slot: replaces any open popup + aborts its fetch
      const props = feature.properties ?? {};
      const name = typeof props.name === "string" ? props.name.trim() : "";
      const category = typeof props.category === "string" ? props.category : "";
      const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "280px" })
        .setLngLat(coords)
        .setDOMContent(renderPoiPopup(name, category))
        .addTo(map);
      popupRef.current = popup;
    }

    // Route a picked amenity to its popup: an identifiable transit stop gets
    // the line list; everything else — including a transit stop with no usable
    // OSM identity — gets the generic info popup (never silence, task 024).
    function openAmenityPopup(feature: maplibregl.MapGeoJSONFeature, coords: [number, number]) {
      const props = feature.properties ?? {};
      const osmType = typeof props.osmType === "string" ? props.osmType : "";
      const osmId = Number(props.osmId);
      if (props.category === "transit" && osmType && Number.isInteger(osmId) && osmId > 0) {
        return openStopPopup(feature, coords);
      }
      openPoiPopup(feature, coords);
    }

    // Keyboard-accessible companion to the WebGL markers. It feeds the same
    // popup router, frames the chosen place inside the shared camera corridor,
    // then moves focus to MapLibre's close button so the detail is operable.
    function inspectAmenity(item: Amenity) {
      el.dataset.amenityInspect = "opening";
      const returnTarget = document.querySelector<HTMLElement>('[data-testid="amenity-browser-trigger"]');
      const coords: [number, number] = [item.lng, item.lat];
      const feature = {
        type: "Feature",
        properties: {
          name: item.name,
          category: item.category,
          osmType: item.osmType,
          osmId: item.osmId,
        },
        geometry: { type: "Point", coordinates: coords },
      } as unknown as maplibregl.MapGeoJSONFeature;
      map.flyTo({
        center: coords,
        zoom: Math.max(14, map.getZoom()),
        padding: applyCameraPadding(true),
        essential: false,
        duration: reducedMotion.matches ? 0 : 650,
      });
      openAmenityPopup(feature, coords);
      const popup = popupRef.current;
      if (!popup) {
        el.dataset.amenityInspect = "unavailable";
        return;
      }
      el.dataset.amenityInspect = item.name || amenityCategoryLabel(item.category);
      popup.getElement().dataset.keyboardManaged = "true";
      popup.on("close", () => returnTarget?.focus());
      popup.getElement().addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          popup.remove();
          return;
        }
        // MapLibre places its close control after the supplied content in DOM
        // order. Make the visual close -> details order explicit for keyboard
        // users, and keep Shift+Tab symmetrical when a route row is present.
        const close = popup.getElement().querySelector<HTMLButtonElement>(".maplibregl-popup-close-button");
        const firstAction = popup.getElement().querySelector<HTMLButtonElement>(".hf-stop-popup__route");
        if (event.key === "Tab" && !event.shiftKey && event.target === close && firstAction) {
          event.preventDefault();
          firstAction.focus();
        } else if (event.key === "Tab" && event.shiftKey && event.target === firstAction && close) {
          event.preventDefault();
          close.focus();
        }
      });
      focusKeyboardPopup(popup);
    }
    inspectAmenityRef.current = inspectAmenity;

    // Async transit details can update a popup after keyboard focus has moved
    // into it. Restore focus to its stable close control after each replacement
    // so loading -> ready/error never drops the user back to the document body.
    function focusKeyboardPopup(popup: maplibregl.Popup) {
      if (popup.getElement().dataset.keyboardManaged !== "true") return;
      requestAnimationFrame(() => {
        if (popupRef.current !== popup) return;
        popup.getElement().querySelector<HTMLButtonElement>(".maplibregl-popup-close-button")?.focus();
      });
    }

    function updateStopPopup(popup: maplibregl.Popup, model: StopPopupModel, coords: [number, number]) {
      popup.setDOMContent(renderStopPopup(model, coords));
      focusKeyboardPopup(popup);
    }

    // Tear down the popup AND invalidate its in-flight fetch (bumping the gen so
    // a late response can't repaint a removed popup). Called on a new stop click
    // and at the start of any new selection.
    function closeStopPopup() {
      stopLinesAbortRef.current?.abort();
      stopLinesGenRef.current += 1;
      popupRef.current?.remove();
      popupRef.current = null;
    }
    closeStopPopupRef.current = closeStopPopup;

    function openStopPopup(feature: maplibregl.MapGeoJSONFeature, coords: [number, number]) {
      const props = feature.properties ?? {};
      const osmType = typeof props.osmType === "string" ? props.osmType : "";
      const osmId = Number(props.osmId);
      const name = typeof props.name === "string" ? props.name : "";
      closeStopPopup();
      // No usable identity ⇒ can't look up lines. Bail with no popup — but the
      // caller has ALREADY decided this is a transit hit, so we never fall
      // through to a reselection that would wipe the user's markers (task 021).
      if (!osmType || !Number.isInteger(osmId) || osmId <= 0) return;

      const gen = stopLinesGenRef.current;
      const controller = new AbortController();
      stopLinesAbortRef.current = controller;

      const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "280px" })
        .setLngLat(coords)
        .setDOMContent(renderStopPopup(buildStopPopupModel(name, "loading"), coords))
        .addTo(map);
      popupRef.current = popup;
      // ANY way this popup goes away (its ×, replacement by another popup, a new
      // selection, a mode toggle, unmount — all end in Popup.remove, which fires
      // `close`) also clears the line path drawn from it.
      popup.on("close", clearRoutePath);

      // Client deadline: transition to the error state (and abort) if the server
      // is slow, so the popup never sits on "Finding lines…" indefinitely.
      const timer = setTimeout(() => {
        if (gen === stopLinesGenRef.current) {
          updateStopPopup(popup, buildStopPopupModel(name, "error"), coords);
        }
        controller.abort();
      }, STOP_LINES_TIMEOUT_MS);

      const q = `?type=${encodeURIComponent(osmType)}&id=${osmId}&lat=${coords[1]}&lng=${coords[0]}&name=${encodeURIComponent(name)}`;
      fetch(`/api/stop-lines${q}`, { signal: controller.signal })
        .then(async (res) => {
          if (gen !== stopLinesGenRef.current) return;
          if (!res.ok) return void updateStopPopup(popup, buildStopPopupModel(name, "error"), coords);
          const data = (await res.json()) as { lines?: unknown };
          if (gen !== stopLinesGenRef.current) return;
          const lines = (Array.isArray(data.lines) ? data.lines : []) as StopLine[];
          updateStopPopup(popup, buildStopPopupModel(name, "ready", lines), coords);
        })
        .catch((err) => {
          if ((err as Error)?.name === "AbortError" || gen !== stopLinesGenRef.current) return;
          updateStopPopup(popup, buildStopPopupModel(name, "error"), coords);
        })
        .finally(() => clearTimeout(timer));
    }

    // Pick the amenity marker nearest the cursor within a ±MARKER_PICK_PAD_PX
    // box — ANY category (task 024: every amenity is inspectable, not just
    // transit). The decision lives in the pure pickNearestWithin (unit-tested);
    // this wrapper only projects the rendered features into pixel space. Used
    // by BOTH the click and the hover handlers, so the hover affordance always
    // predicts what a click will do.
    function pickAmenity(point: maplibregl.Point): { feature: maplibregl.MapGeoJSONFeature; coords: [number, number] } | null {
      if (!styleLoaded) return null;
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

    // Hover feedback: the hovered marker grows via feature-state (see
    // addAmenityLayers) and the cursor turns pointer. Driven by the SAME padded
    // pick as the click handler. `data-amenity-hover` exposes it to e2e.
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
    // Feature-state outlives setData for a given generated id, so a repaint or
    // clear must drop the hover before the ids get reassigned to new markers.
    function resetAmenityHover() {
      if (!styleLoaded || !map.getSource("amenities")) return;
      setHoveredAmenity(null);
      map.removeFeatureState({ source: "amenities" });
    }

    async function select(input: SelectInput, opts?: { recompute?: boolean }) {
      // Snapshot the mode ONCE (from the selection machine) so this response's
      // endpoint, colors, legend and data-mode all agree even if the user
      // toggles mid-flight; `start` bumps the token that guards staleness. A
      // toggle-driven recompute preserves lastSelection so a further toggle
      // before it resolves can still recover the origin.
      const mode = selRef.current.mode;
      const { token } = dispatchSel({ type: "start", mode, preserveLast: opts?.recompute });
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;
      const stale = () => token !== selRef.current.token;

      clearSelection(); // drop the previous marker/rings the moment a new selection starts
      // A genuinely-new selection also drops the old amenities; a mode toggle
      // (recompute) leaves them so they persist across Walk↔Transit.
      if (!opts?.recompute) clearAmenities();

      try {
        // Resolve the origin (what the isochrone + marker use) and its label.
        let origin: Origin;
        let label: string;

        if (input.kind === "search") {
          const res = await fetch(`/api/geocode?q=${encodeURIComponent(input.query)}`, { signal });
          if (stale()) return;
          if (!res.ok) return void dispatchSel({ type: "failed", token, stage: "geocode", httpStatus: res.status });
          const point = (await res.json()) as GeoPoint;
          origin = { lat: point.lat, lng: point.lng };
          label = point.label;
        } else if (input.kind === "point") {
          // A picked autocomplete suggestion: point + label already resolved —
          // go straight to the isochrone, NO geocode/reverse round-trip.
          origin = { lat: input.lat, lng: input.lng };
          label = input.label;
        } else {
          // A map click: the origin IS the clicked point (not a reverse-geocoded
          // centroid); reverse geocoding only supplies the human-readable label.
          origin = { lat: input.lat, lng: input.lng };
          label = "Selected point";
          const res = await fetch(`/api/reverse?lat=${input.lat}&lng=${input.lng}`, { signal });
          if (stale()) return;
          // Only out-of-area is fatal; a missing/errored address keeps the
          // generic label and still shows the reach.
          if (reverseIsFatal(res.status))
            return void dispatchSel({ type: "failed", token, stage: "reverse", httpStatus: res.status });
          if (res.ok) {
            // A malformed body is non-fatal: keep the generic label and still
            // show the reach, matching the reverse-non-fatal contract. Guard
            // both a parse error AND a valid-but-wrong-shape body (missing or
            // non-string label).
            try {
              const body = (await res.json()) as { label?: unknown };
              if (typeof body.label === "string" && body.label.trim()) label = body.label;
            } catch {
              /* keep "Selected point" */
            }
          }
        }

        // Fire amenities in parallel with the isochrone (both use `origin`); its
        // own generation/abort make it independent of this selection's token.
        maybeFetchAmenities(origin);

        const isoRes = await fetch(`${isochronePath(mode)}?lat=${origin.lat}&lng=${origin.lng}`, { signal });
        if (stale()) return;
        if (!isoRes.ok) {
          // Invariant: amenity markers never render without rings. The rings
          // were already dropped when this run started (clearSelection above),
          // so a failed reach — fresh selection OR toggle recompute — clears
          // the amenities too; a recompute back will refetch (server-cached).
          clearAmenities();
          return void dispatchSel({ type: "failed", token, stage: "isochrone", httpStatus: isoRes.status });
        }
        const iso = (await isoRes.json()) as { origin: Origin; rings: Ring[] };
        if (stale()) return;

        // Fresh (stale() just checked): accept and paint. Reducer records the
        // isochrone's rounded origin so a mode toggle recomputes the same point.
        dispatchSel({ type: "resolved", token, origin: iso.origin, label });
        renderSelection(iso.origin, label, iso.rings, mode);
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || stale()) return;
        clearAmenities(); // same invariant as the failed-reach branch above
        dispatchSel({ type: "crash", token });
      }
    }

    selectRef.current = select;

    // Flip the per-minute layers' visibility to match a ring filter. The layers
    // are created once (on load) and persist, so this is the ONLY paint work a
    // filter change needs — data and legend never re-fetch. Cancels any in-flight
    // staged reveal and snaps every band to full opacity so a mid-reveal switch
    // (e.g. All → 15) never exposes a layout-visible band stuck at opacity 0.
    function applyRingFilter(filter: RingFilter) {
      if (!styleLoaded) return; // load applies the current filter itself
      cancelRingReveal(false);
      setRingTransition(0);
      for (const minutes of RING_MINUTES) setRingRevealed(minutes, true);
      el.dataset.ringReveal = "settled";
      if (!el.dataset.ringRevealSequence) el.dataset.ringRevealSequence = "filter";
      for (const [layerId, visibility] of Object.entries(ringLayerVisibility(filter))) {
        map.setLayoutProperty(layerId, "visibility", visibility);
      }
      el.dataset.ringFilter = String(filter);
      // Derived from a layer READ-BACK, not the requested filter: the e2e
      // contract is "these bands are visible on the map", so the attribute must
      // reflect what the layers actually say.
      el.dataset.visibleRings = [...RING_MINUTES]
        .filter((m) => map.getLayoutProperty(`iso-fill-${m}`, "visibility") !== "none")
        .sort((a, b) => a - b)
        .join(",");
    }
    applyRingFilterRef.current = applyRingFilter;

    map.on("load", () => {
      // Source + layer specs live in map-setup (unit-tested). Add order = draw
      // order: isochrone fills, then a selected line's path, then the amenity
      // markers on top (their hover/click affordance stays primary).
      addIsochroneLayers(map);
      addRoutePathLayers(map);
      addAmenityLayers(map);

      styleLoaded = true;
      applyCameraPadding(false);
      // Layers are born all-visible; bring them in line with the active filter
      // (the ref reads the state mirror set by selectRingFilter — on first load
      // that is the default).
      applyRingFilter(ringFilterRef.current);
      if (pending) {
        const p = pending;
        pending = null;
        renderSelection(p.origin, p.label, p.rings, p.mode);
      }
      if (pendingAmenities) {
        const a = pendingAmenities;
        pendingAmenities = null;
        renderAmenities(a.items, a.counts);
      }
      if (map.getLayer("amenity-markers") && map.getLayer("amenity-glyphs")) {
        el.dataset.amenityEncoding = "color+glyph";
      }
      el.dataset.mapLoaded = "true";
      const center = map.getCenter();
      el.dataset.cameraCenter = `${center.lng.toFixed(5)},${center.lat.toFixed(5)}`;
    });

    map.on("moveend", () => {
      const center = map.getCenter();
      el.dataset.cameraCenter = `${center.lng.toFixed(5)},${center.lat.toFixed(5)}`;
    });

    // Keep the visible-map contract in sync through browser resizing and
    // orientation changes, including after a result has already been framed.
    const onResize = () => {
      const hasResults = hasResultSurface(selRef.current, amenityRef.current.status);
      // applyCameraPadding already commits map.setPadding + dataset read-backs.
      applyCameraPadding(hasResults);
      map.resize();
      // A route is a user-selected subject, not disposable camera state. Refit
      // it after every responsive shell change so orientation never clips it.
      if (activeRouteBounds) requestAnimationFrame(() => fitActiveRoute(0));
    };
    window.addEventListener("resize", onResize);

    // True when the click lands on the ACTIVE drawn route (its line or a stop
    // dot). Inspecting the line one just drew must not tear it down with a
    // reselection — the mirror of the amenity misclick complaint.
    function hitsActiveRoutePath(point: maplibregl.Point): boolean {
      if (activeRouteRelId === null) return false;
      const pad = MARKER_PICK_PAD_PX;
      const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
        [point.x - pad, point.y - pad],
        [point.x + pad, point.y + pad],
      ];
      return map.queryRenderedFeatures(bbox, { layers: ["route-path-stops", "route-path-line"] }).length > 0;
    }

    map.on("click", (e) => {
      // ANY amenity click opens its popup and does NOT start a selection (no
      // geocode/reverse/isochrone) — the owner's ask: inspecting a marker must
      // never recompute the address (task 024). A click on the active drawn
      // route is a no-op (viewing, not reselecting). Only a click hitting
      // neither falls through to the normal selection.
      const hit = pickAmenity(e.point);
      if (hit) return void openAmenityPopup(hit.feature, hit.coords);
      if (hitsActiveRoutePath(e.point)) return;
      selectRef.current?.({ kind: "click", lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    map.on("mousemove", (e) => {
      const hit = pickAmenity(e.point);
      setHoveredAmenity(hit && hit.feature.id !== undefined ? hit.feature.id : null);
    });
    map.on("mouseout", () => setHoveredAmenity(null));
    map.on("dragend", () => {
      el.dataset.mapDrag = String(Number(el.dataset.mapDrag ?? "0") + 1);
    });

    return () => {
      abortRef.current?.abort();
      suggestAbortRef.current?.abort();
      amenityAbortRef.current?.abort();
      stopLinesAbortRef.current?.abort();
      routePathAbortRef.current?.abort();
      popupRef.current?.remove();
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
      if (amenityRetryTimerRef.current) clearTimeout(amenityRetryTimerRef.current);
      cancelRingReveal();
      window.removeEventListener("resize", onResize);
      map.remove();
      maplibregl.removeProtocol("pmtiles");
      mapRef.current = null;
    };
  }, []);

  // --- Combobox (autocomplete) wiring: the debounce timer + AbortController are
  // imperative; the combobox reducer owns the transitions. Every fetch tags
  // itself with the generation current when it was scheduled so a superseded
  // response (or one after close/pick) is dropped by the reducer.
  function runSuggest(generation: number, q: string) {
    // Defensive: a timer is always cleared before a new one is set, so this
    // should already hold — but never disturb a newer request's in-flight fetch.
    if (generation !== comboRef.current.generation) return;
    dispatchCombo({ type: "fetchStarted", generation });
    suggestAbortRef.current?.abort();
    const controller = new AbortController();
    suggestAbortRef.current = controller;
    fetch(`/api/suggest?q=${encodeURIComponent(q)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return void dispatchCombo({ type: "fetchError", generation });
        const data = (await res.json()) as { suggestions?: unknown };
        // A valid-but-wrong-shape body (no array) is an error, not "no matches" —
        // and must not reach the render, which reads `.length`.
        if (!Array.isArray(data.suggestions)) return void dispatchCombo({ type: "fetchError", generation });
        dispatchCombo({ type: "suggestionsLoaded", generation, suggestions: data.suggestions as Suggestion[] });
      })
      .catch((err) => {
        // A superseded/blurred request is aborted — leave its state to the newer
        // run. A genuine network/parse failure surfaces the error state so the
        // dropdown does not sit forever on "Searching…" (the reducer drops it if
        // the generation is already stale).
        if ((err as Error)?.name === "AbortError") return;
        dispatchCombo({ type: "fetchError", generation });
      });
  }

  function scheduleSuggest(state: ComboboxState) {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    if (!shouldFetchSuggest(state)) return;
    const generation = state.generation;
    const q = state.query.trim();
    suggestTimerRef.current = setTimeout(() => runSuggest(generation, q), SUGGEST_DEBOUNCE_MS);
  }

  function onQueryChange(value: string) {
    suggestAbortRef.current?.abort(); // cancel any in-flight fetch synchronously
    scheduleSuggest(dispatchCombo({ type: "queryChanged", value }));
  }

  function closeSuggest() {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestAbortRef.current?.abort();
    dispatchCombo({ type: "close" });
  }

  function pickSuggestion(s: Suggestion) {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestAbortRef.current?.abort();
    dispatchCombo({ type: "pick", suggestion: s });
    selectRef.current?.({ kind: "point", lat: s.lat, lng: s.lng, label: s.label });
  }

  function switchMode(next: Mode) {
    if (next === selRef.current.mode) return;
    // Invalidate any in-flight select so a walk response can't land under a
    // transit toggle (or vice-versa); the reducer bumps the token to match.
    abortRef.current?.abort();
    dispatchSel({ type: "toggle", next });
    // Recompute the current point in the new mode — no geocode/reverse. With no
    // resolved selection the reducer already reset status to idle.
    const last = selRef.current.lastSelection;
    if (last) {
      selectRef.current?.({ kind: "point", lat: last.lat, lng: last.lng, label: last.label }, { recompute: true });
    } else {
      // Toggling away from a still-loading first selection cancels it — drop its
      // in-flight amenities too, so a late response can't paint orphan markers.
      clearAmenitiesRef.current?.();
    }
  }

  // Manual retry from the AmenityPanel error state. Restarts the attempt
  // counter (a fresh user gesture earns a fresh auto-retry); the origin is the
  // one whose fetch failed — an error never clears it, only a new selection does.
  function retryAmenities() {
    const origin = amenityOriginRef.current;
    if (origin) fetchAmenitiesRef.current?.(origin, 0);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const combo = comboRef.current;
    const active = combo.open && combo.activeIndex >= 0 ? combo.suggestions[combo.activeIndex] : undefined;
    if (active) return pickSuggestion(active);
    const q = combo.query.trim();
    if (q) {
      closeSuggest();
      selectRef.current?.({ kind: "search", query: q });
    }
  }

  function onSearchKeyDown(e: React.KeyboardEvent) {
    const combo = comboRef.current;
    if (!combo.open || combo.suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      dispatchCombo({ type: "arrowDown" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      dispatchCombo({ type: "arrowUp" });
    } else if (e.key === "Escape") {
      closeSuggest();
    }
    // Enter is handled by the form's onSubmit (which picks the active option).
  }

  const sel = selState;
  const combo = comboState;
  const amenityCounts = amenity.counts;
  const hasResults = hasResultSurface(sel, amenity.status);
  const showFirstRun = !hasResults && sel.lastSelection === null;

  return (
    <div className="hf-map-shell absolute inset-0" data-has-results={hasResults ? "true" : "false"}>
      {/* The overlay plane stays pointer-transparent. Individual command/result
          surfaces opt back in, keeping the map usable through every gap. */}
      <div className="pointer-events-none absolute inset-0 z-20">
        <div className="hf-command-dock absolute inset-x-3 top-[4.7rem] z-30 sm:inset-x-4 sm:top-[5.25rem] md:bottom-auto md:left-4 md:right-auto md:top-[5.15rem] md:w-[388px]">
          <section
            data-testid="command-surface"
            aria-label="Explore a location"
            className="hf-command-surface pointer-events-auto relative overflow-visible rounded-[1.5rem] border border-white/[.11] bg-[#0d110e]/92 p-3 shadow-[0_24px_70px_rgba(0,0,0,.38)] backdrop-blur-2xl sm:p-3.5 md:p-4"
          >
            <div className="hf-command-intro mb-2.5 flex items-center justify-between gap-3 px-1 md:mb-3">
              <div>
                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-[#c7f36b]">Explore your reach</p>
                <p className="mt-1 hidden text-xs text-[#78857b] md:block">Start from any address in Bucharest</p>
              </div>
              <span className="rounded-full border border-white/[.09] bg-white/[.045] px-2.5 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-[#9ca9a0]">
                Bucharest
              </span>
            </div>
            <div className="hf-command-search relative z-20">
              <SearchForm
                query={combo.query}
                open={combo.open}
                activeIndex={combo.activeIndex}
                loading={sel.status === "loading"}
                onSubmit={onSubmit}
                onQueryChange={onQueryChange}
                onKeyDown={onSearchKeyDown}
                onFocus={() => dispatchCombo({ type: "focus" })}
                onBlur={closeSuggest}
              />
              <SuggestList
                combo={combo}
                onPick={pickSuggestion}
                onHover={(index) => dispatchCombo({ type: "hover", index })}
              />
            </div>
            <div className="hf-command-settings mt-3 grid grid-cols-[minmax(0,.82fr)_minmax(184px,1.18fr)] gap-2 max-[350px]:grid-cols-1">
              <ModeToggle mode={sel.mode} onSwitch={switchMode} />
              <RingSelector value={ringFilter} onSelect={selectRingFilter} />
            </div>
          </section>
        </div>

        {hasResults ? (
          <section
            data-testid="result-sheet"
            aria-label="Location result"
            className="hf-result-sheet pointer-events-auto absolute inset-x-3 bottom-[max(2.8rem,calc(env(safe-area-inset-bottom)+2.3rem))] z-20 max-h-[min(30dvh,14.5rem)] overflow-y-auto overscroll-contain rounded-[1.5rem] border border-white/[.11] bg-[#0d110e]/94 p-2.5 shadow-[0_24px_70px_rgba(0,0,0,.4)] backdrop-blur-2xl sm:inset-x-4 md:bottom-auto md:left-4 md:right-auto md:top-[21.3rem] md:max-h-[calc(100dvh-22.3rem)] md:w-[388px] md:p-3"
          >
            <SelectionCard
              label={sel.label}
              message={sel.message}
              mode={sel.mode}
              ringFilter={ringFilter}
              loading={sel.status === "loading"}
            />
            <AmenityPanel
              key={sel.token}
              status={amenity.status}
              counts={amenityCounts}
              items={amenity.items}
              onRetry={retryAmenities}
              onInspect={(item) => inspectAmenityRef.current?.(item)}
            />
          </section>
        ) : showFirstRun ? (
          <div className="absolute inset-x-3 bottom-[max(3.6rem,calc(env(safe-area-inset-bottom)+3rem))] z-10 sm:inset-x-4 md:bottom-auto md:left-4 md:right-auto md:top-[21.3rem] md:w-[388px]">
            <EmptyState />
          </div>
        ) : null}
      </div>

      {utilityHeader}

      {/* Kept after the command UI in DOM order so keyboard navigation starts
          with search, while the explicit overlay z-index still places the
          controls visually above this full-bleed canvas. */}
      <div
        ref={containerRef}
        data-testid="app-map"
        aria-label="Interactive map of travel reach and nearby places in Bucharest"
        className="h-full w-full"
      />

      <AttributionBadge elevated={hasResults} />
    </div>
  );
}
