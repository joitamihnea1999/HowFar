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
  addRoutePathLayers,
  createMapStyle,
} from "@/features/map/map-setup";
import { createAmenitiesController, type AmenityUi } from "@/features/map/amenities-controller";
import { createCameraController } from "@/features/map/camera-controller";
import { createHoverController } from "@/features/map/hover-controller";
import { createLoadState } from "@/features/map/load-state";
import { createPopupController } from "@/features/map/popup-controller";
import { createRingRevealController } from "@/features/map/ring-reveal-controller";
import { createRoutePathController } from "@/features/map/route-path-controller";
import { createSelectFlowController } from "@/features/map/select-flow-controller";
import { createSelectionRender } from "@/features/map/selection-render";
import { teardownInOrder } from "@/features/map/teardown";
import ModeToggle from "@/features/map/ModeToggle";
import RingSelector from "@/features/map/RingSelector";
import SearchForm from "@/features/map/SearchForm";
import SelectionCard from "@/features/map/SelectionCard";
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
  initialSelectionState,
  selectionReducer,
  type Mode,
  type Origin,
  type SelectInput,
  type SelectionAction,
  type SelectionState,
} from "@/features/map/selection-flow";

// Piața Unirii — the classic Bucharest reference point.
const BUCHAREST_CENTER: [number, number] = [26.1025, 44.4268];
const SUGGEST_DEBOUNCE_MS = 250;

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
  const selectRef = useRef<((input: SelectInput, opts?: { recompute?: boolean }) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Amenities: keyed by rounded origin (NOT the selection token, which a mode
  // toggle bumps) so a Walk↔Transit toggle persists the markers with no refetch;
  // a generation guards stale responses. A transient failure auto-retries once
  // (task 024: the public-Overpass race flakes and recovers seconds later), and
  // the last origin is kept so the panel's Retry button can refetch it.
  // Kept so the panel's Retry button (component scope) can refetch the last
  // origin; the fetch's abort/gen/key/timer state is internal to the controller.
  const amenityOriginRef = useRef<Origin | null>(null);
  const clearAmenitiesRef = useRef<(() => void) | null>(null);
  const fetchAmenitiesRef = useRef<((origin: Origin, attempt: number) => void) | null>(null);
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
    const popup = createPopupController({ map, el, reducedMotion, route, applyCameraPadding });
    const { openAmenityPopup, inspectAmenity, closeStopPopup } = popup;
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
    const selectFlow = createSelectFlowController({
      dispatchSel,
      selRef,
      abortRef,
      clearSelection,
      clearAmenities,
      maybeFetchAmenities,
      renderSelection,
    });
    selectRef.current = selectFlow.select;

    map.on("load", () => {
      // Source + layer specs live in map-setup (unit-tested). Add order = draw
      // order: isochrone fills, then a selected line's path, then the amenity
      // markers on top (their hover/click affordance stays primary).
      addIsochroneLayers(map);
      addRoutePathLayers(map);
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
        renderSelection(p.origin, p.label, p.rings, p.mode);
      }
      if (loadState.pendingAmenities) {
        const a = loadState.pendingAmenities;
        loadState.pendingAmenities = null;
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
      if (route.hasActiveBounds()) requestAnimationFrame(() => route.refit(0));
    };
    window.addEventListener("resize", onResize);

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
          route.dispose,
          ring.dispose,
          hover.dispose,
          camera.dispose,
          () => window.removeEventListener("resize", onResize),
          () => {
            applyAmenitySelectionRef.current = null;
            clearAmenitiesRef.current = null;
            fetchAmenitiesRef.current = null;
            inspectAmenityRef.current = null;
            applyRingFilterRef.current = null;
            selectRef.current = null;
          },
        ],
        () => {
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
              selectedCategories={selectedAmenityCategories}
              onSelectedCategoriesChange={selectAmenityCategories}
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
