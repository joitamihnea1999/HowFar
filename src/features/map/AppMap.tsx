"use client";

import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import "maplibre-gl/dist/maplibre-gl.css";

import {
  type Amenity,
  type AmenityCategoryKey,
} from "@/features/amenities/amenities";
import {
  ALL_AMENITY_CATEGORY_KEYS,
  AMENITY_PREFERENCE_KEY,
  normalizeAmenitySelection,
  parseAmenitySelection,
  serializeAmenitySelection,
} from "@/features/amenities/amenity-selection";
import { BUCHAREST_MAX_BOUNDS } from "@/lib/bounds";
import { DEFAULT_RING_FILTER, type RingFilter } from "@/features/isochrones/isochrone-view";
import AmenityPanel from "@/features/map/AmenityPanel";
import AttributionBadge from "@/features/map/AttributionBadge";
import EmptyState from "@/features/map/EmptyState";
import {
  addAmenityLayers,
  addIsochroneLayers,
  addReachPathLayers,
  addRoutePathLayers,
  createMapStyle,
} from "@/features/map/map-setup";
import { createAmenitiesController, type AmenityUi } from "@/features/map/amenities-controller";
import { createCameraController } from "@/features/map/camera-controller";
import { createHoverController } from "@/features/map/hover-controller";
import { createLoadState } from "@/features/map/load-state";
import { createPopupController } from "@/features/map/popup-controller";
import {
  createReachDirectionsController,
  type ReachDirectionsController,
  type ReachView,
} from "@/features/map/reach-directions-controller";
import { createReachJourneyController } from "@/features/map/reach-journey-controller";
import ReachPanel from "@/features/map/ReachPanel";
import { createRingRevealController } from "@/features/map/ring-reveal-controller";
import { createRoutePathController } from "@/features/map/route-path-controller";
import { createSelectFlowController } from "@/features/map/select-flow-controller";
import { createSelectionRender } from "@/features/map/selection-render";
import { createLongPress } from "@/features/map/long-press";
import { decideReach, reachBand } from "@/features/map/reach";
import { teardownInOrder } from "@/features/map/teardown";
import ModeToggle from "@/features/map/ModeToggle";
import PaceControl from "@/features/map/PaceControl";
import RingSelector from "@/features/map/RingSelector";
import SearchForm from "@/features/map/SearchForm";
import SelectionCard from "@/features/map/SelectionCard";
import TimeContextControl from "@/features/map/TimeContextControl";
import SuggestList from "@/features/map/SuggestList";
import {
  comboboxReducer,
  initialComboboxState,
  type ComboboxAction,
  type ComboboxState,
  type Suggestion,
} from "@/features/search/combobox";
import {
  createSearchSuggestController,
  type SearchSuggestController,
} from "@/features/search/search-suggest-controller";
import {
  effectivePace,
  initialSelectionState,
  sameTimeContext,
  selectionReducer,
  type CarMeta,
  type Mode,
  type Origin,
  type Ring,
  type SelectInput,
  type SelectionAction,
  type SelectionState,
} from "@/features/map/selection-flow";
import { type Pace } from "@/features/isochrones/pace";
import { type TimeContext } from "@/features/isochrones/time-context";

// Piața Unirii — the classic Bucharest reference point.
const BUCHAREST_CENTER: [number, number] = [26.1025, 44.4268];
const SUGGEST_DEBOUNCE_MS = 250;

/** Shared result-surface predicate for the React shell and camera resize path.
 * The reach directions panel occupies the SAME result-sheet slot (task 058), so
 * an active reach view is a result surface too — otherwise a pre-selection hint
 * or a reach view after an error-cleared selection would have no dock and the
 * resize padding would drop it (panel gpt5.5-2). */
function hasResultSurface(
  sel: Pick<SelectionState, "status" | "label" | "message">,
  amenityStatus: AmenityUi["status"],
  reachActive: boolean,
): boolean {
  return reachActive || sel.status === "loading" || Boolean(sel.label || sel.message) || amenityStatus !== "idle";
}

interface AppMapProps {
  utilityHeader?: ReactNode;
}

export default function AppMap({ utilityHeader }: AppMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const selectRef = useRef<((input: SelectInput, opts?: { recompute?: boolean }) => void) | null>(null);
  // The most recent user SelectInput, so a pace/time change before the first
  // selection resolves can re-issue it rather than lose the change (finding G).
  const pendingInputRef = useRef<SelectInput | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The rings + mode of the last resolved selection, stashed so a right-click
  // ("how do I get there?") can classify a clicked point against the EXACT
  // geometry the map drew (task 052 D) — walk band client-side, transit via a
  // /api/reach trip plan. Cleared on a new/failed selection.
  const reachRef = useRef<{ rings: Ring[]; mode: Mode; origin: Origin; car: CarMeta | null } | null>(null);
  // The right-click directions view (task 058), mirrored from the reach-
  // directions controller into React so the result-sheet dock can render it in
  // place of the amenity filters. A ref mirror lets the resize handler read it
  // without re-binding, and the controller ref lets render-scope handlers
  // (ReachPanel close/highlight) drive it.
  const reachControllerRef = useRef<ReachDirectionsController | null>(null);
  const [reachView, setReachView] = useState<ReachView | null>(null);
  // Mirrored so the resize handler (empty-deps effect) reads the latest active
  // flag without re-binding. Set SYNCHRONOUSLY in the controller's subscribe
  // callback (below) — NOT in a [reachView] effect, which would lag a rotate/
  // resize by one tick and drop the dock padding (panel grok-2).
  const reachActiveRef = useRef(false);

  // Amenities: keyed by rounded origin (NOT the selection token, which a mode
  // toggle bumps) so a Walk↔Transit toggle persists the markers with no refetch;
  // a generation guards stale responses. A transient failure auto-retries once
  // (task 024: the public-Overpass race flakes and recovers seconds later), and
  // the last origin is kept so the panel's Retry button can refetch it.
  // Kept so the panel's Retry button (component scope) can refetch the last
  // origin; the fetch's abort/gen/key/timer state is internal to the controller.
  const amenityOriginRef = useRef<Origin | null>(null);
  const clearAmenitiesRef = useRef<(() => void) | null>(null);
  const fetchAmenitiesRef = useRef<((origin: Origin, attempt: number, pace: Pace) => void) | null>(null);
  const inspectAmenityRef = useRef<((item: Amenity) => void) | null>(null);
  const applyAmenitySelectionRef = useRef<((categories: AmenityCategoryKey[]) => void) | null>(null);
  const [amenity, setAmenity] = useState<AmenityUi>({ status: "idle", counts: null, items: [] });
  const [selectedAmenityCategories, setSelectedAmenityCategories] = useState<AmenityCategoryKey[]>(
    ALL_AMENITY_CATEGORY_KEYS,
  );
  const selectedAmenityCategoriesRef = useRef<AmenityCategoryKey[]>(ALL_AMENITY_CATEGORY_KEYS);
  // Mirrored so the map effect's resize handler (empty deps) can read the latest
  // amenity status without re-binding listeners. Updated in an effect — not during
  // render — to satisfy the react-hooks/refs lint rule.
  const amenityRef = useRef(amenity);
  useEffect(() => {
    amenityRef.current = amenity;
  }, [amenity]);

  useEffect(() => {
    let frame: number | null = null;
    try {
      const stored = parseAmenitySelection(window.localStorage.getItem(AMENITY_PREFERENCE_KEY));
      if (stored !== null) {
        frame = window.requestAnimationFrame(() => {
          selectedAmenityCategoriesRef.current = stored;
          setSelectedAmenityCategories(stored);
          applyAmenitySelectionRef.current?.(stored);
        });
      }
    } catch {
      // Storage may be unavailable in privacy-restricted browsing contexts.
    }
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  function selectAmenityCategories(categories: AmenityCategoryKey[]) {
    const next = normalizeAmenitySelection(categories);
    selectedAmenityCategoriesRef.current = next;
    setSelectedAmenityCategories(next);
    try {
      window.localStorage.setItem(AMENITY_PREFERENCE_KEY, serializeAmenitySelection(next));
    } catch {
      // Selection still works for this session when persistence is unavailable.
    }
    applyAmenitySelectionRef.current?.(next);
  }

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

  // Autocomplete debounce/fetch glue — created once in an effect (so no ref is
  // read during render); the combobox handlers below drive it via suggestRef. It
  // owns its own timer + abort, disposed on unmount.
  const suggestRef = useRef<SearchSuggestController | null>(null);
  useEffect(() => {
    const controller = createSearchSuggestController({
      comboRef,
      dispatchCombo,
      debounceMs: SUGGEST_DEBOUNCE_MS,
    });
    suggestRef.current = controller;
    return () => controller.dispose();
  }, []);

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
    // Expose the map instance for e2e RENDERED-state assertions (task 054): the
    // draw/declutter/highlight suites verify actual `queryRenderedFeatures` /
    // `querySourceFeatures` output, not just the code's own `data-*` stamps
    // (which can false-pass — impl-panel). Harmless in prod (a handle
    // to the already-visible map); cleared on teardown.
    (window as unknown as { __hfMap?: maplibregl.Map }).__hfMap = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), "bottom-right");

    // Shared lifecycle cell replayed at `load` (see load-state.ts). Buffers a
    // selection / amenities response that arrived before the style existed.
    const loadState = createLoadState();

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    // --- Controllers (created in acyclic order; each returns its methods +
    // dispose). Leaves first: camera + hover + ring depend only on map/el/state.
    const camera = createCameraController({ map, el });
    const { applyCameraPadding } = camera;
    const hover = createHoverController({ map, el, loadState });
    const {
      pickAmenity,
      setHoveredAmenity,
      scheduleAmenityHover,
      cancelPendingAmenityHover,
      resetAmenityHover,
    } = hover;
    const ring = createRingRevealController({ map, el, loadState, reducedMotion, ringFilterRef });
    const { revealRings, applyRingFilter, cancelRingReveal } = ring;
    applyRingFilterRef.current = applyRingFilter;
    const route = createRoutePathController({ map, el, loadState, reducedMotion, applyCameraPadding });
    const { hitsActiveRoutePath } = route;
    // The right-click journey draw (task 054). Created before the popup (no popup
    // dep); the popup drives it. Amenity declutter is wired via a holder AFTER the
    // amenities controller exists (it is created after the popup), breaking the
    // popup↔amenities construction cycle (plan-panel K).
    const reachJourney = createReachJourneyController({ map, el, loadState, reducedMotion });
    const reachDeclutter: { set: (on: boolean) => void } = { set: () => {} };
    // The directions controller and the popup controller are mutually-exclusive
    // "active map surfaces" (panel opus-1). Each must be able to close the other,
    // so the popup's `closeStopPopup` is injected into the directions controller
    // through a holder (the popup is created just after), breaking the cycle.
    const closeStopPopupHolder: { current: () => void } = { current: () => {} };
    const reachDirections = createReachDirectionsController({
      el,
      journey: reachJourney,
      reachDeclutter,
      applyCameraPadding,
      closeStopPopup: () => closeStopPopupHolder.current(),
    });
    reachControllerRef.current = reachDirections;
    // Mirror the active flag SYNCHRONOUSLY (panel grok-2) — the resize handler
    // reads reachActiveRef, and a rotate/resize before React's effect ran would
    // otherwise drop the dock's camera padding for a reach-only (hint) surface.
    reachDirections.subscribe((v) => {
      reachActiveRef.current = v !== null;
      setReachView(v);
    });
    const popup = createPopupController({ map, el, reducedMotion, route, applyCameraPadding, closeReach: reachDirections.close });
    const { openAmenityPopup, inspectAmenity, closeStopPopup } = popup;
    closeStopPopupHolder.current = closeStopPopup;
    inspectAmenityRef.current = inspectAmenity;
    const amenities = createAmenitiesController({
      map,
      el,
      loadState,
      setAmenity,
      amenityRef,
      amenityOriginRef,
      selectedCategoriesRef: selectedAmenityCategoriesRef,
      resetAmenityHover,
      getPopupCategory: popup.getPopupCategory,
      closeStopPopup,
    });
    const { renderAmenities, clearAmenities, fetchAmenities, maybeFetchAmenities, applyAmenitySelection } =
      amenities;
    // Now that the amenities controller exists, let the popup toggle declutter.
    reachDeclutter.set = amenities.setReachView;
    clearAmenitiesRef.current = clearAmenities;
    fetchAmenitiesRef.current = fetchAmenities;
    applyAmenitySelectionRef.current = applyAmenitySelection;
    const selectionRender = createSelectionRender({
      map,
      el,
      loadState,
      reducedMotion,
      revealRings,
      cancelRingReveal,
      applyCameraPadding,
      closeStopPopup,
    });
    const { renderSelection, clearSelection } = selectionRender;
    // Stash the rendered rings+mode+origin for the right-click reach popup, and
    // clear them whenever the selection is dropped, so a right-click never reads
    // stale geometry (task 052 D).
    const renderSelectionStash = (origin: Origin, label: string, rings: Ring[], mode: Mode) => {
      // `dispatchSel({type:"resolved",…,car})` runs synchronously BEFORE this in
      // the controller, so `selRef.current.car` is the fresh basis for THIS
      // resolution (null for walk/transit) — snapshot it into the atomic reach
      // stash so a right-click car band names the traffic it was computed for.
      reachRef.current = { rings, mode, origin, car: selRef.current.car };
      renderSelection(origin, label, rings, mode);
    };
    const clearSelectionReach = () => {
      reachRef.current = null;
      clearSelection();
    };
    const selectFlow = createSelectFlowController({
      dispatchSel,
      selRef,
      pendingInputRef,
      abortRef,
      clearSelection: clearSelectionReach,
      clearAmenities,
      maybeFetchAmenities,
      renderSelection: renderSelectionStash,
    });
    selectRef.current = selectFlow.select;

    map.on("load", () => {
      // Source + layer specs live in map-setup (unit-tested). Add order = draw
      // order: isochrone fills, then a selected line's path, then the amenity
      // markers on top (their hover/click affordance stays primary).
      addIsochroneLayers(map);
      addRoutePathLayers(map);
      addReachPathLayers(map); // task 054: between the OSM route path and the markers
      addAmenityLayers(map);

      loadState.styleLoaded = true;
      applyCameraPadding(false);
      // Layers are born all-visible; bring them in line with the active filter
      // (the ref reads the state mirror set by selectRingFilter — on first load
      // that is the default).
      applyRingFilter(ringFilterRef.current);
      if (loadState.pending) {
        const p = loadState.pending;
        loadState.pending = null;
        renderSelectionStash(p.origin, p.label, p.rings, p.mode);
      }
      if (loadState.pendingAmenities) {
        const a = loadState.pendingAmenities;
        loadState.pendingAmenities = null;
        renderAmenities(a.items, a.counts);
      }
      reachJourney.flushPending(); // replay a right-click journey that raced `load`
      // A journey replayed from a pre-load right-click was buffered without a
      // camera fit — reframe it now so the path isn't left off-screen with the
      // dock open (panel luna-1/terra-1). No-op when nothing was drawn.
      reachDirections.reframe();
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
      const hasResults = hasResultSurface(selRef.current, amenityRef.current.status, reachActiveRef.current);
      // applyCameraPadding already commits map.setPadding + dataset read-backs.
      applyCameraPadding(hasResults);
      map.resize();
      // A route is a user-selected subject, not disposable camera state. Refit
      // it after every responsive shell change so orientation never clips it.
      if (route.hasActiveBounds()) requestAnimationFrame(() => route.refit(0));
      // Same for a drawn right-click journey (task 057): reframe it (instant) so a
      // rotation / responsive change never clips the path. No-op when none is drawn.
      requestAnimationFrame(() => reachDirections.reframe());
    };
    window.addEventListener("resize", onResize);

    // Right-click / long-press "how do I get there?" (task 052 D). Answers for
    // the ACTIVE mode against the SAME rings the map drew: walk = client-side
    // band; transit = a MOTIS trip plan via /api/reach. Only computes on demand.
    const handleReach = (lngLat: { lng: number; lat: number }) => {
      const sel = selRef.current;
      const stash = reachRef.current;
      const coords: [number, number] = [lngLat.lng, lngLat.lat];
      // Deliberately does NOT defer to pickAmenity (unlike the left-click, which
      // opens a marker's popup): the reach question is "how do I get to THIS
      // point", answerable anywhere on the map — including over a marker.
      // No resolved selection yet (or one still loading): explain what to do.
      if (!sel.lastSelection || sel.status === "loading" || !stash) {
        return void reachDirections.open({ kind: "hint", coords });
      }
      // Classify the point against the SAME rings the map drew (all modes) so
      // the answer can never contradict the painted reach (task 052 P2 / impl T1).
      // Exhaustive switch: only the `transit` arm fetches /api/reach, so car (and
      // walk) can NEVER fall through to a public-transport plan (plan-panel C-A).
      const action = decideReach(stash.mode, reachBand(coords, stash.rings));
      switch (action.kind) {
        case "walk":
          return void reachDirections.open({ kind: "walk", coords, band: action.band });
        case "car":
          // Car reach is band-only, resolved client-side — no provider call.
          // Carry the stashed car basis/slot so the copy names the traffic.
          return void reachDirections.open({ kind: "car", coords, band: action.band, carMeta: stash.car });
        case "transit-unreachable":
          // Outside every transit ring → answer honestly with NO provider call.
          return void reachDirections.open({ kind: "transit-unreachable", coords });
        case "transit": {
          const params = new URLSearchParams({
            fromLat: String(stash.origin.lat),
            fromLng: String(stash.origin.lng),
            toLat: String(lngLat.lat),
            toLng: String(lngLat.lng),
            // The band the point fell in, so the planner prefers a trip within the
            // painted "~N-min reach" rather than a faster over-band detour (task 057).
            maxMinutes: String(action.band),
          });
          // Prefer the selection's resolved departure so the trip matches the
          // rings on screen; else pass the preset for the server. (Preset-only
          // since task 059 removed Custom; task 060 rewrites this handler.)
          if (sel.departure?.iso) params.set("departure", sel.departure.iso);
          else params.set("preset", sel.timeContext.preset);
          return void reachDirections.open({ kind: "transit", coords, band: action.band, url: `/api/reach?${params.toString()}` });
        }
        default: {
          const _exhaustive: never = action;
          return _exhaustive;
        }
      }
    };

    // Touch long-press for iOS Safari (which never emits contextmenu). A fired
    // long-press suppresses the synthetic click that follows on lift, so it
    // never also starts a new selection.
    let suppressNextClick = false;
    let touchActive = false;
    const longPress = createLongPress({ onLongPress: (info) => handleReach(info.lngLat) });

    // Desktop right-click. On a touch device the long-press recognizer owns the
    // gesture, so we skip the contextmenu path there (Android also emits
    // contextmenu mid-press) — this avoids double-handling and the trailing-click
    // selection bug (impl T7). preventDefault always stops the browser menu.
    map.on("contextmenu", (e) => {
      e.originalEvent?.preventDefault?.();
      if (touchActive) return;
      handleReach(e.lngLat);
    });
    map.on("touchstart", (e) => {
      touchActive = true;
      // A fresh press starts a fresh interaction: clear any stale suppression
      // left by a prior gesture whose synthetic click never arrived (else it
      // would wrongly swallow THIS tap's selection — a load-timing race).
      suppressNextClick = false;
      longPress.start(e.point, e.lngLat, e.originalEvent?.touches?.length ?? 1);
    });
    map.on("touchmove", (e) => longPress.move(e.point));
    // A pan cancels the pending long-press immediately — more robust than waiting
    // for a touchmove that CPU contention can delay past the hold threshold.
    map.on("dragstart", () => longPress.cancel());
    map.on("touchend", () => {
      touchActive = false;
      if (longPress.end()) suppressNextClick = true;
    });
    // An OS-interrupted touch (system UI, gesture takeover) emits touchcancel,
    // not touchend — kill the pending timer so no ghost popup fires (impl T3).
    map.on("touchcancel", () => {
      touchActive = false;
      longPress.cancel();
    });

    map.on("click", (e) => {
      // A long-press just fired the reach popup — swallow the follow-up click so
      // it doesn't also start a selection.
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      // ANY amenity click opens its popup and does NOT start a selection (no
      // geocode/reverse/isochrone) — the owner's ask: inspecting a marker must
      // never recompute the address (task 024). A click on the active drawn
      // route is a no-op (viewing, not reselecting). Only a click hitting
      // neither falls through to the normal selection.
      const hit = pickAmenity(e.point);
      if (hit) return void openAmenityPopup(hit.feature, hit.coords);
      if (hitsActiveRoutePath(e.point)) return;
      // A click on the drawn right-click journey (a leg line or a used-stop dot)
      // is a no-op, not a new selection — mirrors the OSM route-path guard so
      // inspecting the journey never moves the origin (task 054, plan-panel C).
      if (reachJourney.hitsActiveJourney(e.point)) return;
      selectRef.current?.({ kind: "click", lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    map.on("mousemove", (e) => {
      scheduleAmenityHover(e.point);
    });
    map.on("mouseout", () => {
      cancelPendingAmenityHover();
      setHoveredAmenity(null);
    });
    map.on("dragend", () => {
      el.dataset.mapDrag = String(Number(el.dataset.mapDrag ?? "0") + 1);
    });

    return () =>
      // Phase 1 = every controller disposer in REVERSE create order + the window
      // listener + the React bridge refs; phase 2 (removeMap) runs LAST so no
      // disposer ever touches a removed map. Order proven in teardown.test.ts.
      teardownInOrder(
        [
          selectFlow.dispose,
          selectionRender.dispose,
          amenities.dispose,
          popup.dispose,
          reachDirections.dispose,
          reachJourney.dispose,
          route.dispose,
          ring.dispose,
          hover.dispose,
          camera.dispose,
          () => longPress.cancel(),
          () => window.removeEventListener("resize", onResize),
          () => {
            applyAmenitySelectionRef.current = null;
            clearAmenitiesRef.current = null;
            fetchAmenitiesRef.current = null;
            inspectAmenityRef.current = null;
            applyRingFilterRef.current = null;
            selectRef.current = null;
            reachControllerRef.current = null;
          },
        ],
        () => {
          if ((window as unknown as { __hfMap?: maplibregl.Map }).__hfMap === map) {
            delete (window as unknown as { __hfMap?: maplibregl.Map }).__hfMap;
          }
          map.remove();
          maplibregl.removeProtocol("pmtiles");
          mapRef.current = null;
        },
      );
  }, []);

  // Combobox autocomplete wiring: the debounce timer + AbortController live in
  // search-suggest-controller; these handlers only dispatch reducer transitions
  // and drive that controller.
  function onQueryChange(value: string) {
    suggestRef.current?.abortInflight(); // cancel any in-flight fetch synchronously
    suggestRef.current?.schedule(dispatchCombo({ type: "queryChanged", value }));
  }

  function closeSuggest() {
    suggestRef.current?.cancel();
    dispatchCombo({ type: "close" });
  }

  function pickSuggestion(s: Suggestion) {
    suggestRef.current?.cancel();
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

  // Recompute the current point after a pace / departure-context change, exactly
  // like switchMode: abort any in-flight request, snapshot the new setting via
  // the reducer (which bumps the token), then re-issue. A pace change re-runs
  // rings AND amenities (new radius); a time change re-runs transit rings only
  // (amenities dedupe on same origin+pace). With no resolved selection yet, a
  // still-loading first request is re-issued from its pending input so the
  // change is not lost (finding G); otherwise there's nothing to recompute.
  function recomputeCurrent() {
    const last = selRef.current.lastSelection;
    if (last) {
      selectRef.current?.({ kind: "point", lat: last.lat, lng: last.lng, label: last.label }, { recompute: true });
    } else if (pendingInputRef.current) {
      selectRef.current?.(pendingInputRef.current, { recompute: true });
    }
  }

  function setPace(next: Pace) {
    if (next === selRef.current.pace) return;
    abortRef.current?.abort();
    dispatchSel({ type: "setPace", pace: next });
    recomputeCurrent();
  }

  function setTimeContext(next: TimeContext) {
    if (sameTimeContext(next, selRef.current.timeContext)) return;
    abortRef.current?.abort();
    dispatchSel({ type: "setTimeContext", timeContext: next });
    // Departure affects transit AND car (task 058: car reach is time-aware for
    // traffic realism). In walk mode just record it for when the user switches
    // to a time-aware mode (no recompute needed).
    if (selRef.current.mode !== "walk") recomputeCurrent();
  }

  // Manual retry from the AmenityPanel error state. Restarts the attempt
  // counter (a fresh user gesture earns a fresh auto-retry); the origin is the
  // one whose fetch failed — an error never clears it, only a new selection does.
  function retryAmenities() {
    const origin = amenityOriginRef.current;
    // Same effective-pace rule as the main fetch (task 052 P4): a retry in a
    // non-walk mode must use Normal, not a pace remembered from Walk.
    if (origin) fetchAmenitiesRef.current?.(origin, 0, effectivePace(selRef.current.mode, selRef.current.pace));
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
  const reachActive = reachView !== null;
  // The reach directions dock counts as a result surface (task 058): the sheet
  // renders — and camera padding holds — whenever there's a selection OR reach.
  const hasResults = hasResultSurface(sel, amenity.status, reachActive);
  const showFirstRun = !hasResults && sel.lastSelection === null;
  const closeReachPanel = () => {
    reachControllerRef.current?.close();
    // Return focus to the map container (the panel took it on open) — the div is
    // tabIndex=-1 so it can receive focus (panel terra-5).
    containerRef.current?.focus();
  };

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
            {/* Stacked full-width rows by default so the 3-up mode toggle (task
                053) keeps ≥44px-wide touch targets and "Public transport" never
                clips on phones (impl panel: 375/412px). Two columns only at md+,
                where the dock is a fixed 388px and MUST stay one settings row
                tall to clear the result sheet pinned at md:top-[21.3rem]; on
                mobile the result sheet is a bottom sheet, so the extra row is free. */}
            <div className="hf-command-settings mt-3 grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,.82fr)_minmax(184px,1.18fr)]">
              <ModeToggle mode={sel.mode} onSwitch={switchMode} />
              <RingSelector value={ringFilter} mode={sel.mode} onSelect={selectRingFilter} />
            </div>
          </section>
        </div>

        {hasResults ? (
          <section
            data-testid="result-sheet"
            aria-label={reachActive ? "Directions" : "Location result"}
            className="hf-result-sheet pointer-events-auto absolute inset-x-3 bottom-[max(2.8rem,calc(env(safe-area-inset-bottom)+2.3rem))] z-20 max-h-[min(30dvh,14.5rem)] overflow-y-auto overscroll-contain rounded-[1.5rem] border border-white/[.11] bg-[#0d110e]/94 p-2.5 shadow-[0_24px_70px_rgba(0,0,0,.4)] backdrop-blur-2xl sm:inset-x-4 md:bottom-auto md:left-4 md:right-auto md:top-[21.3rem] md:max-h-[calc(100dvh-22.3rem)] md:w-[388px] md:p-3"
          >
            {/* Right-click directions REPLACE the selection card + filters while
                active (task 058, owner item 2). The selection block stays MOUNTED
                but hidden + inert (panel grok-5) so the AmenityPanel keeps its
                open Browse list / text filter — unmounting it would wipe that and
                "restore" would feel broken. */}
            {reachActive ? (
              <ReachPanel view={reachView!} onHighlight={(i) => reachControllerRef.current?.highlight(i)} onClose={closeReachPanel} />
            ) : null}
            <div hidden={reachActive} inert={reachActive}>
              <SelectionCard
                label={sel.label}
                message={sel.message}
                mode={sel.mode}
                ringFilter={ringFilter}
                loading={sel.status === "loading"}
                departure={sel.departure}
                car={sel.car}
              />
              {/* Reach refinements live WITH the result they adjust. The two
                  controls are gated INDEPENDENTLY (plan-panel grok-3): PaceControl
                  is strictly Walk (pace is a walking concept, task 052 P4);
                  TimeContextControl is transit OR car (task 058 — car reach is
                  time-aware for traffic realism). They are never merged into one
                  non-walk wrapper (that would resurrect pace in car). Exactly one
                  control renders per mode, so the bordered cluster is never empty.
                  Keeps the top command dock compact (no map-covering rail). */}
              <div className="mt-2.5 grid gap-2.5 border-t border-white/[.07] pt-2.5">
                {sel.mode === "walk" ? <PaceControl pace={sel.pace} onSelect={setPace} /> : null}
                {sel.mode === "transit" || sel.mode === "car" ? (
                  <TimeContextControl value={sel.timeContext} onSelect={setTimeContext} mode={sel.mode} />
                ) : null}
              </div>
              <AmenityPanel
                // Key on amenity IDENTITY (resolved origin + pace) — the only
                // things that change the amenity set — NOT sel.token. A mode
                // toggle or a transit time change keeps the same origin+pace, so
                // the panel no longer remounts and lose its open Browse list /
                // text filter (impl-panel finding); a new origin or pace change
                // still remounts to reset that transient state. Keyed on the
                // EFFECTIVE pace (task 052 P4) so it matches the pace the amenities
                // were actually fetched at — the common Normal-pace toggle keeps
                // the panel mounted; only a Slow-walk→transit toggle
                // remounts, which is correct since the amenity set changed.
                key={`${sel.lastSelection?.lat ?? "x"},${sel.lastSelection?.lng ?? "x"}:${effectivePace(sel.mode, sel.pace)}`}
                status={amenity.status}
                counts={amenityCounts}
                items={amenity.items}
                selectedCategories={selectedAmenityCategories}
                onSelectedCategoriesChange={selectAmenityCategories}
                onRetry={retryAmenities}
                onInspect={(item) => inspectAmenityRef.current?.(item)}
              />
            </div>
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
        // tabIndex -1 so directions can return focus here on close (panel
        // terra-5): the map container is otherwise not focusable.
        tabIndex={-1}
        className="h-full w-full outline-none"
      />

      <AttributionBadge elevated={hasResults} />
    </div>
  );
}
