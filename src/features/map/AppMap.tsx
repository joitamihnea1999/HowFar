"use client";

import type maplibregl from "maplibre-gl";
import type { Protocol as PmtilesProtocol } from "pmtiles";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import "maplibre-gl/dist/maplibre-gl.css";

import {
  AMENITY_CATEGORIES,
  type Amenity,
  type AmenityCategoryKey,
} from "@/features/amenities/amenities";
// Amenities are DEFERRED in preset mode (phone-first) — the category
// selection UI + its persistence return in a later amenity pass. Only the "all categories"
// default is needed here for the dormant amenities controller.
import { ALL_AMENITY_CATEGORY_KEYS } from "@/features/amenities/amenity-selection";
import { LAUNCH_MAX_BOUNDS } from "@/lib/bounds";
import { DEFAULT_RING_FILTER, type RingFilter } from "@/features/isochrones/isochrone-view";
import {
  DEFAULT_PRESET_INDEX,
  presetMinFor,
  type PresetIndex,
} from "@/features/isochrones/preset-reach";
import { selectPresetRings } from "@/features/isochrones/preset-view";
import { clusterMarkerSizePx, DONUT_HOVER_SCALE, MAP_MAX_ZOOM } from "@/features/amenities/amenity-cluster";
import AttributionBadge from "@/features/map/AttributionBadge";
import {
  createAmenityClusterController,
  type AmenityClusterController,
  type ClusterPick,
} from "@/features/map/amenity-cluster-controller";
import {
  AMENITY_ENCODING,
  hasAllAmenityIcons,
  registerAmenityIcons,
} from "@/features/map/amenity-sprite";
import EmptyState from "@/features/map/EmptyState";
import {
  addAmenityLayers,
  addAmenitySpiderLayers,
  addIsochroneLayers,
  addPresetReachLayers,
  addReachPathLayers,
  addRoutePathLayers,
  createMapStyle,
} from "@/features/map/map-setup";
import { createAmenitySpiderController } from "@/features/map/amenity-spider-controller";
import { createAmenitiesController, type AmenityUi } from "@/features/map/amenities-controller";
import { createCameraController, type CameraController } from "@/features/map/camera-controller";
import { DOCK_BREAKPOINT_PX } from "@/features/map/camera";
import { createHoverController } from "@/features/map/hover-controller";
import { deriveShell, type ShellState } from "@/features/map/shell-state";
import StatePill from "@/features/map/StatePill";
import { createLoadState } from "@/features/map/load-state";
import { setMapGl, type MapGl } from "@/features/map/map-runtime";
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
import { reachBand } from "@/features/map/reach";
import { teardownInOrder } from "@/features/map/teardown";
import ModePresetBar from "@/features/map/ModePresetBar";
import PaceControl from "@/features/map/PaceControl";
import LegendPill from "@/features/map/LegendPill";
import MapPlaceholder from "@/features/map/MapPlaceholder";
import SearchForm from "@/features/map/SearchForm";
import RingHint from "@/features/map/RingHint";
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
import { TIME_PRESETS, type TimeContext } from "@/features/isochrones/time-context";

// Piața Unirii — the classic Bucharest reference point.
const BUCHAREST_CENTER: [number, number] = [26.1025, 44.4268];
const SUGGEST_DEBOUNCE_MS = 250;

// Mobile shell breakpoint (task 062): the stacked dock/sheet layout below `md`.
// Shares `DOCK_BREAKPOINT_PX` with the camera-padding math so "which layout is
// on screen" and "which insets frame the map" can never disagree.
const MOBILE_SHELL_QUERY = `(max-width: ${DOCK_BREAKPOINT_PX - 0.02}px)`;
function subscribeToMobileShell(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_SHELL_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
function readMobileShell(): boolean {
  return window.matchMedia(MOBILE_SHELL_QUERY).matches;
}

// Hover is a pointer concept: touch browsers synthesize mousemove on tap, which
// would flash the cluster grow+preview underneath the click ladder (plan panel,
// task 062) — so every hover affordance is gated on a real fine pointer.
const HOVER_CAPABLE_QUERY = "(hover: hover) and (pointer: fine)";

/** What the cluster hover-preview panel renders (task 062) — a copy of the
 * hovered mark's own reconcile-time data plus its frozen screen anchor. */
interface ClusterHoverPreview {
  key: string;
  x: number;
  y: number;
  total: number;
  counts: { category: AmenityCategoryKey; count: number }[];
  /** Distance from the mark centre to the panel edge (hovered footprint + gap). */
  offset: number;
}

/** Shared result-surface predicate for the React shell and camera resize path.
 * The reach directions panel occupies the SAME result-sheet slot (task 058), so
 * an active reach view is a result surface too — otherwise a pre-selection hint
 * or a reach view after an error-cleared selection would have no dock and the
 * resize padding would drop it (found in review). */
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
  // A user selection made while the deferred map engine is still loading (task 017). The search
  // box is interactive in the eager shell before the map exists, so a submit before `selectRef`
  // is wired is buffered here and replayed once the map is ready — never dropped.
  const pendingSelectRef = useRef<SelectInput | null>(null);
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
  // resize by one tick and drop the dock padding (found in review).
  const reachActiveRef = useRef(false);

  // Amenities: keyed by `amenityFetchKey` — origin + mode + effective pace + departure
  // context (NOT the selection token, which every recompute bumps). Task 065 made the
  // clip mode-dependent, so a Walk↔Transit or crowded↔quiet toggle now CLEARS and
  // refetches; a generation guards stale responses. A transient failure auto-retries once
  // (task 024: the public-Overpass race flakes and recovers seconds later), and
  // the last origin is kept so the review's Retry button can refetch it.
  // Kept so the review's Retry button (component scope) can refetch the last
  // origin; the fetch's abort/gen/key/timer state is internal to the controller.
  const amenityOriginRef = useRef<Origin | null>(null);
  const clearAmenitiesRef = useRef<(() => void) | null>(null);
  const fetchAmenitiesRef = useRef<
    ((origin: Origin, attempt: number, pace: Pace, mode: Mode, timeContext: TimeContext) => void) | null
  >(null);
  const inspectAmenityRef = useRef<((item: Amenity) => void) | null>(null);
  // Holder for the donut-cluster controller: it is built after the amenities
  // controller (whose source it reads), but the amenities controller's visibility
  // chokepoint has to be able to hide it — so they are wired through a ref rather
  // than a constructor argument, the same pattern as the reach-declutter holder.
  const amenityClustersRef = useRef<AmenityClusterController | null>(null);
  const amenityClusterDisposeRef = useRef<(() => void) | null>(null);
  const applyAmenitySelectionRef = useRef<((categories: AmenityCategoryKey[]) => void) | null>(null);
  const [amenity, setAmenity] = useState<AmenityUi>({ status: "idle", counts: null, countsByBand: null, items: [] });
  // The amenity category selection is DORMANT in preset mode (amenities are
  // deferred to a later amenity pass). The ref is still handed to the amenities
  // controller at construction, pinned at "all categories" — no UI reads or
  // writes it while the client is preset-only. a later amenity pass restores the category
  // preference UI + its localStorage persistence together with the markers.
  const selectedAmenityCategoriesRef = useRef<AmenityCategoryKey[]>(ALL_AMENITY_CATEGORY_KEYS);
  // Mirrored so the map effect's resize handler (empty deps) can read the latest
  // amenity status without re-binding listeners. Updated in an effect — not during
  // render — to satisfy the react-hooks/refs lint rule.
  const amenityRef = useRef(amenity);
  useEffect(() => {
    amenityRef.current = amenity;
  }, [amenity]);

  // The two extracted state machines drive the render via useState, but each is
  // mirrored in a ref so a dispatch can be read back synchronously in the same
  // tick (fresh token/generation) from the imperative fetch orchestration —
  // see features/map/selection-flow and features/search/combobox. Render reads the state; callbacks
  // read the ref.
  const [selState, setSelState] = useState<SelectionState>(initialSelectionState);
  const [comboState, setComboState] = useState<ComboboxState>(initialComboboxState);
  const selRef = useRef<SelectionState>(initialSelectionState);
  const comboRef = useRef<ComboboxState>(initialComboboxState);

  // Phone-first PRESET chip (phone-first): which of the two calibrated presets is the
  // OUTER reach edge (index 0 = smaller/default — walk 10 / transit 20 / car 10;
  // index 1 = larger). State drives the chip row + legend; the ref-mirrored
  // repaint redraws the stashed served rings at the new index — NO refetch (the
  // route returned BOTH contours), so the chip is pure client-side visibility.
  const [presetIndex, setPresetIndex] = useState<PresetIndex>(DEFAULT_PRESET_INDEX);
  const presetIndexRef = useRef<PresetIndex>(DEFAULT_PRESET_INDEX);
  const reselectPresetRef = useRef<(() => void) | null>(null);
  // The legacy ring filter is retired from the phone-first UI but the
  // amenities controller (dormant in preset mode — amenities are deferred to
  // a later amenity pass) still reads this ref at construction. Pinned at the default; never
  // changes while the client is preset-only, so the legacy path stays untouched.
  const ringFilterRef = useRef<RingFilter>(DEFAULT_RING_FILTER);

  function selectPreset(next: PresetIndex) {
    if (next === presetIndexRef.current) return;
    presetIndexRef.current = next;
    setPresetIndex(next);
    // Repaint the stashed served rings at the new index — no network, no camera
    // move (the route already returned both calibrated contours).
    reselectPresetRef.current?.();
  }

  // --- Mobile shell state (task 062): dock pill + sheet peek. The user flags
  // are mirrored in refs (same pattern as selRef) so the camera controller's
  // shell getter — called synchronously inside the selection flow, before the
  // flyTo — always reads the value the upcoming render will show.
  const isMobileShell = useSyncExternalStore(subscribeToMobileShell, readMobileShell, () => false);
  const [userDockOpen, setUserDockOpen] = useState(false);
  const [userSheetExpanded, setUserSheetExpanded] = useState(false);
  const userDockOpenRef = useRef(false);
  const userSheetExpandedRef = useRef(false);
  const cameraRef = useRef<CameraController | null>(null);
  function setDockOpen(open: boolean) {
    userDockOpenRef.current = open;
    setUserDockOpen(open);
  }
  function setSheetExpanded(expanded: boolean) {
    userSheetExpandedRef.current = expanded;
    setUserSheetExpanded(expanded);
  }
  // Cluster hover preview (task 062): set only on key change, rendered
  // pointer-events-none, closed by mouseout/movestart/click/hover-loss.
  const [clusterPreview, setClusterPreview] = useState<ClusterHoverPreview | null>(null);

  // Deep-links from the peek chips: expand the sheet, then land on the control
  // the chip summarizes (owner: state must show "where to change and how").
  const refineBlockRef = useRef<HTMLDivElement | null>(null);
  const amenityBlockRef = useRef<HTMLDivElement | null>(null);
  function expandSheetTo(target: "refine" | "amenities") {
    setSheetExpanded(true);
    requestAnimationFrame(() => {
      const block = target === "refine" ? refineBlockRef.current : amenityBlockRef.current;
      block?.scrollIntoView({ block: "nearest" });
      block?.querySelector<HTMLElement>("button, input")?.focus();
    });
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

  // Defer the MapLibre engine (327 KB gz) off the first-load critical path (task 017): the eager
  // shell above (search, header, controls) is already interactive; only the map canvas waits.
  // `hf:interactive` marks the split the bundle instrument reads (JS requested AFTER it is LAZY);
  // the engine is dynamically imported on the first idle slot after that mark, so it lands in a
  // lazy chunk and never blocks TTI. The map then fades in behind the shell.
  const [mapEngine, setMapEngine] = useState<{ gl: MapGl; Protocol: typeof PmtilesProtocol } | null>(null);
  // A deferred dynamic import CAN fail in ways the old eager bundle could not — a flaky mobile
  // network, or (routinely) a stale client whose cached HTML points at a hashed chunk a redeploy
  // has purged (ChunkLoadError). Without handling, `mapEngine` stays null forever: the shell looks
  // fully interactive but the map — the headline surface — never appears, which violates the
  // "core flow survives degradation" invariant [node 1]. So: one silent auto-retry, then surface a
  // actionable error whose manual recovery is a full page reload (see the overlay below).
  const [mapLoadFailed, setMapLoadFailed] = useState(false);
  // Flips true once the live map's `load` fires — the first-paint placeholder
  // is then covered by the opaque MapLibre canvas and hidden.
  const [mapReady, setMapReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (typeof performance !== "undefined" && performance.mark) {
      performance.mark("hf:interactive");
    }
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      Promise.all([import("maplibre-gl"), import("pmtiles")])
        .then(([gl, pm]) => {
          if (cancelled) return;
          setMapLoadFailed(false);
          setMapGl(gl);
          setMapEngine({ gl, Protocol: pm.Protocol });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          console.error(`[map] engine chunk failed to load: ${(error as Error)?.message ?? error}`);
          attempts += 1;
          if (attempts < 2) {
            retry = setTimeout(load, 1500); // one silent retry (transient network / CDN blip)
          } else {
            setMapLoadFailed(true); // give the user a visible, retryable error instead of a blank map
          }
        });
    };
    const win = window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let idleHandle: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (typeof win.requestIdleCallback === "function") {
      idleHandle = win.requestIdleCallback(load, { timeout: 2000 });
    } else {
      timer = setTimeout(load, 200);
    }
    return () => {
      cancelled = true;
      if (idleHandle !== null && typeof win.cancelIdleCallback === "function") win.cancelIdleCallback(idleHandle);
      if (timer !== null) clearTimeout(timer);
      if (retry !== null) clearTimeout(retry);
    };
  }, []);

  useEffect(() => {
    if (!mapEngine) return;
    // The engine, dynamically imported off the critical path (effect above). `gl` is the loaded
    // runtime namespace; the type-only `maplibregl` module import still serves every TYPE use.
    const gl = mapEngine.gl;
    const Protocol = mapEngine.Protocol;
    const container = containerRef.current;
    if (!container) return;
    // Non-null capture so nested closures (renderSelection, load) keep the type.
    const el: HTMLDivElement = container;

    const protocol = new Protocol();
    gl.addProtocol("pmtiles", protocol.tile);

    const map = new gl.Map({
      container,
      style: createMapStyle(`${window.location.origin}/api/tiles`),
      center: BUCHAREST_CENTER,
      zoom: 11.5,
      // Pinned explicitly (MapLibre's default is also 22) so the amenity
      // clustering contract is anchored to a number this code owns: cluster
      // aggregation runs to exactly this zoom, and the "can this cluster split?"
      // test compares `getClusterExpansionZoom` against it (task 061). Leaving it
      // implicit would silently decouple the two if MapLibre's default changed.
      maxZoom: MAP_MAX_ZOOM,
      maxBounds: LAUNCH_MAX_BOUNDS,
      attributionControl: { compact: false },
    });
    mapRef.current = map;
    // Expose the map instance for e2e RENDERED-state assertions (task 054): the
    // draw/declutter/highlight suites verify actual `queryRenderedFeatures` /
    // `querySourceFeatures` output, not just the code's own `data-*` stamps
    // (which can false-pass). Harmless in prod (a handle
    // to the already-visible map); cleared on teardown.
    (window as unknown as { __hfMap?: maplibregl.Map }).__hfMap = map;
    map.addControl(new gl.NavigationControl({ showCompass: true, showZoom: true }), "bottom-right");

    // Shared lifecycle cell replayed at `load` (see load-state.ts). Buffers a
    // selection / amenities response that arrived before the style existed.
    const loadState = createLoadState();

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    // --- Controllers (created in acyclic order; each returns its methods +
    // dispose). Leaves first: camera + hover + ring depend only on map/el/state.
    const camera = createCameraController({
      map,
      el,
      // Fresh shell from the synchronously-updated refs: padding committed just
      // before a selection flyTo already reflects the dock that is about to
      // collapse (task 062 ordering contract — see renderSelectionStash).
      shell: () =>
        deriveShell({
          isMobile: readMobileShell(),
          selStatus: selRef.current.status,
          hasSelection: selRef.current.lastSelection !== null,
          userDockOpen: userDockOpenRef.current,
          userSheetExpanded: userSheetExpandedRef.current,
          reachActive: reachActiveRef.current,
        }),
    });
    cameraRef.current = camera;
    const { applyCameraPadding } = camera;
    const hover = createHoverController({ map, el, loadState });
    const {
      pickAmenitiesAt,
      setHoveredAmenity,
      scheduleAmenityHover,
      cancelPendingAmenityHover,
      resetAmenityHover,
    } = hover;
    // The ring-reveal controller drives the LEGACY iso-* band layers, which the
    // preset-only client leaves empty. Kept constructed so `cancelRingReveal`
    // (selection-render teardown) and the on-load visibility pass stay defined;
    // the staged `revealRings` is no longer used (the preset shells are the reach).
    const ring = createRingRevealController({ map, el, loadState, reducedMotion, ringFilterRef });
    const { applyRingFilter, cancelRingReveal } = ring;
    const route = createRoutePathController({ map, el, loadState, reducedMotion, applyCameraPadding });
    const { hitsActiveRoutePath } = route;
    // The right-click journey draw (task 054). Created before the popup (no popup
    // dep); the popup drives it. Amenity declutter is wired via a holder AFTER the
    // amenities controller exists (it is created after the popup), breaking the
    // popup↔amenities construction cycle (found in review).
    const reachJourney = createReachJourneyController({ map, el, loadState, reducedMotion });
    const reachDeclutter: { set: (on: boolean) => void } = { set: () => {} };
    // Spiderfy (task 061 W20). Created BEFORE the popup because the popup's cluster
    // ladder ends in `spider.open`, and its own declutter is wired through a holder
    // AFTER the amenities controller exists — the same cycle-breaking pattern as
    // `reachDeclutter` right above.
    const spiderDeclutter: { set: (on: boolean) => void } = { set: () => {} };
    const spider = createAmenitySpiderController({
      map,
      el,
      onActiveChange: (active) => spiderDeclutter.set(active),
    });
    // The directions controller and the popup controller are mutually-exclusive
    // "active map surfaces" (found in review). Each must be able to close the other,
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
    // Mirror the active flag SYNCHRONOUSLY (found in review) — the resize handler
    // reads reachActiveRef, and a rotate/resize before React's effect ran would
    // otherwise drop the dock's camera padding for a reach-only (hint) surface.
    reachDirections.subscribe((v) => {
      reachActiveRef.current = v !== null;
      // Directions and a fan are mutually-exclusive map surfaces: both declutter the
      // amenities, and whichever restored them second would repaint over the other.
      if (v !== null) spider.close();
      setReachView(v);
    });
    const popup = createPopupController({
      map,
      el,
      reducedMotion,
      route,
      applyCameraPadding,
      closeReach: reachDirections.close,
      spiderfy: spider.open,
    });
    const { openAmenityPopup, openAmenityChoicePopup, inspectAmenity, closeStopPopup } = popup;
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
      ringFilterRef,
      resetAmenityHover,
      getPopupCategory: popup.getPopupCategory,
      getPopupBand: popup.getPopupBand,
      closeStopPopup,
      clustersRef: amenityClustersRef,
      invalidateClusters: () => popup.invalidateClusters(),
      // A fan's leaves were read from the PREVIOUS indexing, so a recluster (category
      // toggle) or a cleared selection makes them stale in exactly the way the absorbed-pin case
      // described for the leaves list — and a fan can even show a category the user
      // just hid. Closing it is the honest answer.
      closeSpider: spider.close,
    });
    // `maybeFetchAmenities` is intentionally NOT destructured: amenities are
    // DEFERRED in preset mode (phone-first). The
    // preset-only client runs NO amenity fetch — a later amenity pass re-adds amenities together
    // with the band-model migration. The controller stays fully constructed
    // (clusters/spider/popup depend on it) but dormant: its source never receives
    // data, so every amenity pick/hover falls through to selection.
    const { renderAmenities, clearAmenities, fetchAmenities, applyAmenitySelection } = amenities;
    // Donut clusters are created AFTER the amenities controller (they read its
    // source) and handed back through the holder, so the controller's single
    // visibility chokepoint can hide them along with the WebGL layers.
    // Cluster hover preview glue (task 062). The panel state is React's, the
    // grow is the controller's; this layer only decides WHEN. `suppressedKey`
    // implements "the panel yields to an explicit interaction": clicking a mark
    // closes its preview and keeps it closed while the pointer stays on that
    // same mark, so it never floats over the list popup the click just opened.
    // Declared BEFORE the cluster controller so `onHoverLost` routes through
    // the SAME bookkeeping — bypassing it left `previewKey` stale, and a
    // same-key mark rebuilt under a still pointer re-grew without its panel
    // (found in review).
    const hoverCapable = window.matchMedia(HOVER_CAPABLE_QUERY);
    let previewKey: string | null = null;
    let suppressedKey: string | null = null;
    const updateClusterPreview = (pick: ClusterPick | null) => {
      const key = pick ? pick.key : null;
      if (key === null) suppressedKey = null;
      const shown = key !== null && key !== suppressedKey ? key : null;
      if (shown === previewKey) return;
      previewKey = shown;
      if (!pick || shown === null) return void setClusterPreview(null);
      const p = map.project(pick.coords);
      setClusterPreview({
        key: pick.key,
        x: p.x,
        y: p.y,
        total: pick.total,
        counts: pick.counts,
        offset: (clusterMarkerSizePx(pick.total) / 2) * DONUT_HOVER_SCALE + 10,
      });
    };
    const closeClusterPreview = (suppressCurrent = false) => {
      suppressedKey = suppressCurrent ? (previewKey ?? suppressedKey) : null;
      if (previewKey === null) return;
      previewKey = null;
      setClusterPreview(null);
    };

    const clusters = createAmenityClusterController({
      map,
      el,
      loadState,
      onClusterClick: (clusterIds, coords, total, pinIds, pins, keyboard) =>
        void popup.openClusterPopup(clusterIds, coords, total, pinIds, pins, keyboard),
      // An absorbed pin is already drawn as part of a donut, so the pin layer must
      // stop painting it (the absorbed-pin case).
      onAbsorbedChange: () => amenities.reapplyFilter(),
      // The hovered mark vanished under a still pointer (reconcile/recluster/
      // clear) — the preview must never outlive its mark, and the glue's own
      // key bookkeeping must reset with it (task 062, found in review).
      onHoverLost: () => closeClusterPreview(),
    });
    amenityClustersRef.current = clusters;
    amenityClusterDisposeRef.current = clusters.dispose;
    // Now that the amenities controller exists, let the popup toggle declutter.
    reachDeclutter.set = amenities.setReachView;
    spiderDeclutter.set = amenities.setSpiderView;
    clearAmenitiesRef.current = clearAmenities;
    fetchAmenitiesRef.current = fetchAmenities;
    applyAmenitySelectionRef.current = applyAmenitySelection;
    const selectionRender = createSelectionRender({
      map,
      el,
      loadState,
      reducedMotion,
      presetIndexRef,
      cancelRingReveal,
      applyCameraPadding,
      closeStopPopup,
    });
    const { renderSelection, reselectPreset, clearSelection } = selectionRender;
    reselectPresetRef.current = reselectPreset;
    // Stash the rendered rings+mode+origin for the right-click reach popup, and
    // clear them whenever the selection is dropped, so a right-click never reads
    // stale geometry (task 052 D).
    // Origin of the last RESOLVED selection — a recompute at the same origin
    // keeps the user's dock/sheet state (see renderSelectionStash).
    let lastResolvedOrigin: { lat: number; lng: number } | null = null;
    const renderSelectionStash = (origin: Origin, label: string, rings: Ring[], mode: Mode) => {
      // `dispatchSel({type:"resolved",…,car})` runs synchronously BEFORE this in
      // the controller, so `selRef.current.car` is the fresh basis for THIS
      // resolution (null for walk/transit) — snapshot it into the atomic reach
      // stash so a right-click car band names the traffic it was computed for.
      reachRef.current = { rings, mode, origin, car: selRef.current.car };
      // A NEW-origin resolution re-collapses the mobile dock and resets the
      // sheet to peek (task 062). A same-origin recompute (pace/time/mode
      // change) keeps the user's surfaces exactly as they are — resetting on
      // every resolution snapped the sheet shut mid-comparison (tap "Slow"
      // from the expanded sheet → sheet collapsed, focus dropped to body) and
      // re-collapsed a deliberately reopened dock (found in review). Refs
      // FIRST, then state: renderSelection commits its padding via the camera
      // controller's shell getter on the next line, so the insets the flyTo
      // frames against already describe the collapsed shell — flipping this
      // after the flyTo would either frame against stale expanded-dock insets
      // or cancel the animation (setPadding→jumpTo→stop).
      const isNewOrigin =
        lastResolvedOrigin === null ||
        Math.abs(lastResolvedOrigin.lat - origin.lat) > 1e-9 ||
        Math.abs(lastResolvedOrigin.lng - origin.lng) > 1e-9;
      lastResolvedOrigin = { lat: origin.lat, lng: origin.lng };
      if (isNewOrigin) {
        userDockOpenRef.current = false;
        userSheetExpandedRef.current = false;
        setUserDockOpen(false);
        setUserSheetExpanded(false);
      }
      renderSelection(origin, label, rings, mode);
      // Camera-race guard (task 060, review): a cross-mode right-click
      // fires switchMode("transit"), whose recompute lands here and flyTo's the
      // origin — which could clip an already-drawn right-click journey if the
      // isochrone resolves AFTER the MOTIS plan. Re-fit the journey so its frame
      // stays authoritative. No-op when nothing is drawn. (If that transit
      // recompute instead FAILS, the drawn journey stays and Back reveals the
      // standard error card — accepted low-likelihood degradation, review-parked.)
      reachDirections.reframe();
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
      // Amenities are deferred in preset mode (phone-first) — the select flow never
      // fetches them. A no-op keeps the orchestrator generic (a later amenity pass restores a
      // real fetch here with the band-model migration).
      maybeFetchAmenities: () => {},
      renderSelection: renderSelectionStash,
    });
    selectRef.current = selectFlow.select;
    // Replay a selection the user made while the engine was still loading (task 017): the shell's
    // search was interactive before this point, so an early submit was buffered — apply it now.
    // load-state's pre-`load` replay buffer handles rendering if the style hasn't settled yet.
    if (pendingSelectRef.current) {
      const buffered = pendingSelectRef.current;
      pendingSelectRef.current = null;
      selectFlow.select(buffered);
    }

    map.on("load", () => {
      // Source + layer specs live in map-setup (unit-tested). Add order = draw
      // order: isochrone fills, then a selected line's path, then the amenity
      // markers on top (their hover/click affordance stays primary).
      addIsochroneLayers(map);
      // Phone-first PRESET reach layers (phone-first) — additive, alongside the legacy
      // iso-* bands; the preset-only client paints these (the legacy bands stay
      // for the byte-identical non-preset serving path + migrated e2e).
      addPresetReachLayers(map);
      addRoutePathLayers(map);
      addReachPathLayers(map); // task 054: between the OSM route path and the markers
      addAmenityLayers(map);
      // On top of the amenity layers: a fan replaces what it expands, so it must
      // never be drawn under it.
      addAmenitySpiderLayers(map);
      // Icons must be registered before the icon layer paints, or pins render
      // blank for a frame (task 061). Fire-and-forget: the layer declares
      // `icon-optional`, so a slow decode degrades to the coloured circle rather
      // than dropping the marker.
      // `.catch` and a disposal guard: the decode can finish AFTER unmount, and touching a
      // removed map (or leaving the rejection unhandled) is the late-write class the
      // dispose contract exists to prevent (found in review).
      void registerAmenityIcons(map)
        .then(() => {
          if (mapRef.current !== map) return;
          if (hasAllAmenityIcons(map)) el.dataset.amenityEncoding = AMENITY_ENCODING;
        })
        .catch(() => {});

      // Runtime-added images do not survive a style reload, and an icon layer whose
      // sprite is gone paints bare dots. This handler was DOCUMENTED here but never
      // actually registered (found in review) — the comment claimed a safety
      // net that did not exist. `registerAmenityIcons` is idempotent, so re-running it
      // on demand is safe.
      map.on("styleimagemissing", (e) => {
        if (!String(e.id ?? "").startsWith("amenity-icon-")) return;
        void registerAmenityIcons(map)
          .then(() => {
            if (mapRef.current !== map) return;
            if (hasAllAmenityIcons(map)) el.dataset.amenityEncoding = AMENITY_ENCODING;
          })
          .catch(() => {});
      });

      loadState.styleLoaded = true;
      applyCameraPadding(false);
      // Legacy iso-* band layers are born all-visible; pin them to the default
      // filter so they hold a defined (empty, in preset mode) visibility state.
      applyRingFilter(ringFilterRef.current);
      if (loadState.pending) {
        const p = loadState.pending;
        loadState.pending = null;
        renderSelectionStash(p.origin, p.label, p.rings, p.mode);
      }
      if (loadState.pendingAmenities) {
        const a = loadState.pendingAmenities;
        loadState.pendingAmenities = null;
        renderAmenities(a.items, a.countsByBand);
      }
      reachJourney.flushPending(); // replay a right-click journey that raced `load`
      // A journey replayed from a pre-load right-click was buffered without a
      // camera fit — reframe it now so the path isn't left off-screen with the
      // dock open (review/review). No-op when nothing was drawn.
      reachDirections.reframe();
      el.dataset.mapLoaded = "true";
      setMapReady(true); // cover + hide the first-paint placeholder
      // Symmetric with `hf:interactive` (task 017): marks when the deferred engine has finished
      // loading and the map is visible unprompted — the perf harness reports both, so shell-
      // interactive vs map-visible are separable on the emulator AND a real device.
      if (typeof performance !== "undefined" && performance.mark) performance.mark("hf:map-ready");
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

    // Escape collapses an open fan, from anywhere. The fan is a map-owned surface
    // with no focusable container of its own (its hub is a marker button, and focus
    // may well be in the search field), so this has to be a document listener —
    // the same shape `ReachPanel` uses for the directions dock. Guarded on `isOpen`
    // so it never swallows an Escape meant for the search command surface.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !spider.isOpen()) return;
      spider.close();
    };
    document.addEventListener("keydown", onKeyDown);

    // Right-click / long-press "how do I get there?" — task 060: ONE action in
    // every mode. Right-clicking anywhere means "get me there by public
    // transport": auto-switch to transit (from walk/car) and draw the journey +
    // path in the directions dock (owner ask). The walk/car band answers are
    // gone. Deliberately does NOT defer to pickAmenity (unlike the left-click):
    // the reach question is "how do I get to THIS point", answerable anywhere —
    // including over a marker.
    const handleReach = (lngLat: { lng: number; lat: number }) => {
      const sel = selRef.current;
      const coords: [number, number] = [lngLat.lng, lngLat.lat];
      // No resolved origin yet (true first-load): explain what to do. Guard on
      // lastSelection ONLY — a right-click DURING a transit recompute still has a
      // stable origin and must open directions, not fall to the hint (found in review).
      if (!sel.lastSelection) {
        return void reachDirections.open({ kind: "hint", coords });
      }
      // Snapshot everything the request needs BEFORE switchMode (which nulls the
      // ring stash + starts an async recompute) so the URL is built from stable
      // values (found in review). The band is the point's transit ring band when the
      // stash already holds transit rings, else the 45-min transit max — ALWAYS a
      // number so the honesty copy never renders "undefined", and it bounds the
      // planner's within-band ranking cross-mode (found in review).
      const origin = sel.lastSelection;
      const departureIso = sel.departure?.iso;
      const preset = sel.timeContext.preset;
      const stash = reachRef.current;
      // The reach CEILING the trip is framed against (task 057). It must be the
      // reach the map ACTUALLY DRAWS — the SELECTED transit preset — not a hidden
      // larger contour: the client paints only the selected chip, so a point beyond
      // it is "beyond your ~{selected}-min reach", never framed against the 40-min
      // contour when the 20 chip is showing (impl review). When transit rings are
      // already drawn, refine to the point's own band within the DRAWN set. Always
      // a number, so the honesty copy never renders "undefined".
      const transitSelectedMin = presetMinFor("transit", presetIndexRef.current);
      let band = transitSelectedMin;
      if (stash && stash.mode === "transit") {
        const drawn = selectPresetRings(stash.rings, "transit", transitSelectedMin);
        const drawnRings = drawn ? [...drawn.interiorRings, drawn.outer] : stash.rings;
        band = reachBand(coords, drawnRings) ?? transitSelectedMin;
      }
      const params = new URLSearchParams({
        fromLat: String(origin.lat),
        fromLng: String(origin.lng),
        toLat: String(lngLat.lat),
        toLng: String(lngLat.lng),
        // Prefer a within-band trip over a faster over-band detour (task 057).
        maxMinutes: String(band),
      });
      // Prefer the selection's resolved departure (exact match to the rings on
      // screen once transit resolves); else the preset (preset-only since 059).
      if (departureIso) params.set("departure", departureIso);
      else params.set("preset", preset);
      // Release the shared popup slot unconditionally (found in review).
      // `switchMode` only tears the popup down when the mode actually changes, so a
      // right-click while ALREADY in transit left a POI/cluster popup floating over the
      // drawn journey — two "mutually exclusive" surfaces coexisting. Called before
      // `open()` so it cannot close the directions it is about to start (closeStopPopup
      // funnels through closeReach).
      closeStopPopup();
      // Switch to transit FIRST: select({recompute}) runs clearSelection →
      // closeStopPopup → closeReach synchronously, tearing down any prior
      // directions BEFORE we open the new ones (teardown-race-safe). No-ops when
      // already in transit (no redundant recompute).
      if (sel.mode !== "transit") switchMode("transit");
      reachDirections.open({ kind: "transit", coords, band, url: `/api/reach?${params.toString()}` });
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
      // An open fan owns the map: its leaves and hub are the only amenity marks
      // drawn, so it resolves the click first and a click that misses everything
      // collapses it (a dismissal) rather than starting a new selection underneath.
      if (spider.isOpen()) {
        const hit = spider.resolveClick(e.point);
        if (hit.kind === "hub") return void spider.close();
        if (hit.kind === "leaf") {
          // Collapse the fan before opening the place's detail (review
          // reviewers, reversing an earlier decision of mine to keep it open as "context").
          // Leaving it open leaves every OTHER amenity hidden behind `spiderView` while
          // the user reads one card — which reads as "the amenities vanished", the kind
          // of hidden state this task exists to remove.
          spider.close();
          return void inspectAmenity(hit.leaf);
        }
        return void spider.close();
      }
      // A cluster donut takes precedence: it is drawn on top, and it is
      // `pointer-events: none` (so it cannot swallow map gestures), which means the
      // map handler is what resolves a click on it.
      // Touch gets the 44px target; a mouse gets the drawn ring plus a small margin, so
      // clicking bare map between donuts still picks a new address (found in review).
      const coarsePointer = (e.originalEvent as PointerEvent | undefined)?.pointerType === "touch";
      const clusterHit = clusters.pickAt(e.point, coarsePointer);
      // Individual-pin hits are resolved FIRST so a donut cannot steal a click that
      // landed visibly inside a pin. The donut's tap target is widened to the 44px
      // contract, and the no-overlap guarantee only makes footprints non-intersecting —
      // so the widened target can reach over a neighbouring pin's disc. Nearest centre
      // wins between the two (found in review).
      const pinHits = pickAmenitiesAt(e.point);
      const nearestPin = pinHits.length
        ? Math.min(
            ...pinHits.map((hit) => {
              const p = map.project(hit.coords);
              return Math.hypot(p.x - e.point.x, p.y - e.point.y);
            }),
          )
        : Number.POSITIVE_INFINITY;
      if (clusterHit && clusterHit.distance <= nearestPin) {
        // The click supersedes the hover preview: close it and keep it closed
        // while the pointer stays on this mark, so it never floats over the
        // list popup the click opens (task 062).
        closeClusterPreview(true);
        // `pinIds` MUST be forwarded: an absorbed pin is hidden from the pin layer,
        // so if the pointer path drops it the place becomes completely unreachable —
        // the exact defect this task exists to remove (found in review).
        return void popup.openClusterPopup(
          clusterHit.ids,
          clusterHit.coords,
          clusterHit.total,
          clusterHit.pinIds,
          // The absorbed pins' own data, snapshotted when the mark was built, so
          // resolving them never depends on a second source query (found in review).
          clusterHit.pins,
        );
      }
      // Multiple unclustered markers inside the pick pad ⇒ offer the choice
      // instead of silently resolving to the nearest, which used to leave a
      // clumped marker permanently unclickable (task 061). Clustering handles the
      // dense case; this covers sub-pad near-misses among individual pins.
      const hits = pinHits;
      if (hits.length > 1) return void openAmenityChoicePopup(hits, e.lngLat.toArray() as [number, number]);
      if (hits.length === 1) return void openAmenityPopup(hits[0].feature, hits[0].coords);
      // A donut is on screen here but its ids are momentarily stale (mid-recluster), so
      // `pickAt` refused it. Swallow the click rather than fall through: recomputing the
      // whole address because the user clicked a visible marker is precisely what this
      // app promises never to do (found in review).
      if (clusters.covers(e.point, coarsePointer)) return;
      if (hitsActiveRoutePath(e.point)) return;
      // A click on the drawn right-click journey (a leg line or a used-stop dot)
      // is a no-op, not a new selection — mirrors the OSM route-path guard so
      // inspecting the journey never moves the origin (task 054, review).
      if (reachJourney.hitsActiveJourney(e.point)) return;
      selectRef.current?.({ kind: "click", lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    map.on("mousemove", (e) => {
      // Donuts are `pointer-events:none`, so the hover path (which queries the pin layer)
      // cannot see them: the most prominent mark in a dense district gave no feedback while
      // a click on it opened a list. The donut hint is passed INTO the hover controller
      // rather than written here — writing the cursor directly was immediately overwritten
      // by the controller's own cursor logic, so the affordance never appeared
      // (found in review).
      // Hover grow + preview only for a real fine pointer (touch synthesizes
      // mousemove on tap — plan panel); the cursor hint works for both.
      const pick = hoverCapable.matches ? clusters.hoverAt(e.point) : clusters.pickAt(e.point);
      if (hoverCapable.matches) updateClusterPreview(pick);
      scheduleAmenityHover(e.point, pick !== null);
    });
    map.on("mouseout", () => {
      clusters.hoverAt(null);
      closeClusterPreview();
      cancelPendingAmenityHover();
      setHoveredAmenity(null);
    });
    // A camera move invalidates the frozen panel anchor AND re-lays the marks —
    // drop the hover; the next mousemove re-establishes it if still over one.
    map.on("movestart", () => {
      clusters.hoverAt(null);
      closeClusterPreview();
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
          // Before popup.dispose, and in reverse create order: it detaches the
          // render/sourcedata listeners and removes every donut DOM marker, which
          // must happen while the map still exists (phase 2 removes it).
          clusters.dispose,
          popup.dispose,
          reachDirections.dispose,
          // Reverse create order: the fan was built just after reachJourney, and its
          // dispose removes a DOM marker + detaches move/resize while the map lives.
          spider.dispose,
          reachJourney.dispose,
          route.dispose,
          ring.dispose,
          hover.dispose,
          camera.dispose,
          () => longPress.cancel(),
          () => window.removeEventListener("resize", onResize),
          () => document.removeEventListener("keydown", onKeyDown),
          () => {
            applyAmenitySelectionRef.current = null;
            clearAmenitiesRef.current = null;
            fetchAmenitiesRef.current = null;
            inspectAmenityRef.current = null;
            amenityClustersRef.current = null;
            amenityClusterDisposeRef.current = null;
            reselectPresetRef.current = null;
            selectRef.current = null;
            reachControllerRef.current = null;
          },
        ],
        () => {
          if ((window as unknown as { __hfMap?: maplibregl.Map }).__hfMap === map) {
            delete (window as unknown as { __hfMap?: maplibregl.Map }).__hfMap;
          }
          map.remove();
          gl.removeProtocol("pmtiles");
          mapRef.current = null;
        },
      );
    // Runs once, when the deferred engine finishes loading (mapEngine: null → set, never back).
    // Deliberately depends ONLY on mapEngine: this builds the map + all controllers exactly once.
    // `switchMode` (a non-memoized component function) is called inside but must NOT be a dep —
    // it changes identity every render, and re-running would tear down and rebuild the whole map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapEngine]);

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
    runUserSelect({ kind: "point", lat: s.lat, lng: s.lng, label: s.label });
  }

  // Route a user-initiated selection so it survives the deferred-map window (task 017): if the
  // map engine has not finished loading yet, `selectRef` is null — buffer the input and replay it
  // on map-ready (effect above) instead of dropping the user's search.
  function runUserSelect(input: SelectInput) {
    if (selectRef.current) selectRef.current(input);
    else pendingSelectRef.current = input;
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
  // the reducer (which bumps the token), then re-issue. A pace change re-runs rings AND
  // amenities; since task 065 a TIME change re-runs the amenities too (the clip is the
  // mode's reach area at that departure context, so crowded↔quiet changes which places
  // are in range — `amenityFetchKey` includes the preset). With no resolved selection yet, a
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

  // (Amenity manual-retry lived here; removed with the AmenityPanel in preset
  // mode — amenities are deferred to a later amenity pass, which restores both.)

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const combo = comboRef.current;
    const active = combo.open && combo.activeIndex >= 0 ? combo.suggestions[combo.activeIndex] : undefined;
    if (active) return pickSuggestion(active);
    const q = combo.query.trim();
    if (q) {
      closeSuggest();
      runUserSelect({ kind: "search", query: q });
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
  // The selected preset minute for the active mode (walk 10/20, transit 20/40,
  // car 10/25) — the reach edge every label/legend/copy derives from, so they can
  // never disagree with the painted contour.
  const selectedMin = presetMinFor(sel.mode, presetIndex);
  const reachActive = reachView !== null;
  // The reach directions dock counts as a result surface (task 058): the sheet
  // renders — and camera padding holds — whenever there's a selection OR reach.
  const hasResults = hasResultSurface(sel, amenity.status, reachActive);
  const showFirstRun = !hasResults && sel.lastSelection === null;
  // Mobile shell (task 062): same derivation the camera's shell getter uses,
  // fed from render state instead of the ref mirrors — the two can only differ
  // within a single commit, in the direction the next paint will show.
  const shell: ShellState = deriveShell({
    isMobile: isMobileShell,
    selStatus: sel.status,
    hasSelection: sel.lastSelection !== null,
    userDockOpen,
    userSheetExpanded,
    reachActive,
  });
  const sheetPeek = shell.sheet === "peek" && hasResults;
  const closeReachPanel = () => {
    reachControllerRef.current?.close();
    // Return focus to the map container (the review took it on open) — the div is
    // tabIndex=-1 so it can receive focus (found in review).
    containerRef.current?.focus();
  };

  // Re-commit padding when the shell changes shape WITHOUT its own camera move
  // (pill tap, sheet peek/expand, reach open/close, breakpoint cross). The safe
  // variant defers to `moveend` when an animation is in flight — `setPadding`
  // runs `jumpTo`, which `stop()`s whatever is animating (task-060 trap).
  // Selection resolutions don't need this: their padding is committed inside
  // the selection flow before the flyTo starts.
  useEffect(() => {
    cameraRef.current?.applyCameraPaddingSafe(
      hasResultSurface(selRef.current, amenityRef.current.status, reachActiveRef.current),
    );
  }, [shell.dock, shell.sheet]);

  return (
    <div
      // `isolate` establishes a stacking context so the first-paint placeholder's
      // `-z-10` stays WITHIN this shell (above the shell's transparent backdrop,
      // below the static map canvas) instead of escaping to the page's isolated
      // <main> and painting behind its opaque background — where it was invisible
      // during MapLibre load (impl review).
      className="hf-map-shell absolute inset-0 isolate"
      data-has-results={hasResults ? "true" : "false"}
      data-dock-state={shell.dock}
      data-sheet-state={shell.sheet}
    >
      {/* The overlay plane stays pointer-transparent. Individual command/result
          surfaces opt back in, keeping the map usable through every gap. */}
      <div className="pointer-events-none absolute inset-0 z-20">
        {/* Mobile ring-meaning hint: the SelectionCard explainer is hidden by
            the default peek sheet, so first-time mobile users get this
            dismissible floating one-liner instead (see RingHint). */}
        <RingHint
          mode={sel.mode}
          selectedMin={selectedMin}
          // Gated on !loading so a mode toggle (which flips sel.mode + selectedMin
          // immediately, then recomputes) never shows the NEW mode's reach copy
          // while the map is mid-fetch and the reach is cleared (impl review).
          active={isMobileShell && sheetPeek && !reachActive && sel.lastSelection !== null && sel.status !== "loading"}
        />
        <div className="hf-command-dock absolute inset-x-3 top-[4.7rem] z-30 sm:inset-x-4 sm:top-[5.25rem] md:bottom-auto md:left-4 md:right-auto md:top-[5.15rem] md:w-[388px]">
          {shell.dock === "collapsed" && sel.lastSelection ? (
            <StatePill
              label={sel.lastSelection.label}
              mode={sel.mode}
              selectedMin={selectedMin}
              loading={sel.status === "loading"}
              onExpand={() => {
                setDockOpen(true);
                // Disclosure pattern: focus lands in the expanded controls.
                requestAnimationFrame(() => {
                  document.querySelector<HTMLInputElement>('.hf-command-search input[role="combobox"]')?.focus();
                });
              }}
            />
          ) : (
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
              <div className="flex items-center gap-1.5">
                <span className="rounded-full border border-white/[.09] bg-white/[.045] px-2.5 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-[#9ca9a0]">
                  Bucharest
                </span>
                {/* Mobile-only: hand the screen back to the map without waiting
                    for a recompute. Rendered only when the derivation WOULD
                    collapse (a resolved, non-error selection exists). */}
                {isMobileShell && sel.lastSelection && sel.status !== "error" ? (
                  <button
                    type="button"
                    data-testid="dock-collapse"
                    aria-label="Collapse search panel and show the map"
                    onClick={() => setDockOpen(false)}
                    className="flex size-11 items-center justify-center rounded-full text-[#9ca9a0] transition-colors hover:bg-white/[.055] hover:text-[#edf2ed] md:hidden"
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="m6 12 4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                ) : null}
              </div>
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
            {/* One compact ~48px bar (phone-first design): three mode icons +
                the active mode's two calibrated presets, inline. Replaces the
                stacked ModeToggle + 4-option RingSelector — the phone-first client
                is preset-only, so the reach is a single selected time. A mode
                whose reach failed is flagged on its icon (the degraded state — never a
                takeover). */}
            <div className="hf-command-settings mt-3">
              <ModePresetBar
                mode={sel.mode}
                presetIndex={presetIndex}
                onSwitchMode={switchMode}
                onSelectPreset={selectPreset}
                failedMode={sel.status === "error" ? sel.mode : null}
              />
            </div>
          </section>
          )}
        </div>

        {/* Slim legend pill (phone-first design): a map-corner pill that expands to
            the labeled ramp and auto-collapses — never a permanent map cover. Shown
            once a reach is drawn and the map is mostly free (desktop, or the mobile
            peek sheet); hidden while directions occupy the sheet. */}
        {sel.lastSelection && !reachActive && sel.status !== "loading" && (!isMobileShell || sheetPeek) ? (
          <div className="absolute left-3 z-20 bottom-[max(3.7rem,calc(env(safe-area-inset-bottom)+3.2rem))] sm:left-4 md:bottom-6 md:left-auto md:right-4">
            <LegendPill mode={sel.mode} selectedMin={selectedMin} />
          </div>
        ) : null}

        {hasResults ? (
          <section
            data-testid="result-sheet"
            aria-label={reachActive ? "Directions" : "Location result"}
            className="hf-result-sheet pointer-events-auto absolute inset-x-3 bottom-[max(2.8rem,calc(env(safe-area-inset-bottom)+2.3rem))] z-20 max-h-[min(30dvh,14.5rem)] overflow-y-auto overscroll-contain rounded-[1.5rem] border border-white/[.11] bg-[#0d110e]/94 p-2.5 shadow-[0_24px_70px_rgba(0,0,0,.4)] backdrop-blur-2xl sm:inset-x-4 md:bottom-auto md:left-4 md:right-auto md:top-[21.3rem] md:max-h-[calc(100dvh-22.3rem)] md:w-[388px] md:p-3"
          >
            {/* Right-click directions REPLACE the selection card + filters while
                active (task 058, owner item 2). The selection block stays MOUNTED
                but hidden + inert (found in review) so the AmenityPanel keeps its
                open Browse list / text filter — unmounting it would wipe that and
                "restore" would feel broken. */}
            {/* Peek/expand handle (task 062, mobile only): the sheet opens as a
                one-line bar so the map keeps the screen; the bar names the
                place and its chips deep-link to the control they summarize.
                Directions force the sheet expanded (shell-state), so the bar
                then only offers collapse-back. */}
            {isMobileShell ? (
            <div className="flex items-center gap-1.5 md:hidden">
              {/* During directions the sheet is FORCED expanded (shell-state),
                  so the toggle would be a dead control promising collapse —
                  it becomes a plain label until the directions close
                  (found in review). */}
              <button
                type="button"
                data-testid="sheet-toggle"
                aria-expanded={!sheetPeek}
                aria-label={sheetPeek ? "Expand results" : "Collapse results to a bar"}
                onClick={() => setSheetExpanded(sheetPeek)}
                disabled={reachActive}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-1.5 text-left transition-colors enabled:hover:bg-white/[.045]"
              >
                <span aria-hidden="true" className="h-1 w-6 shrink-0 rounded-full bg-white/[.18]" />
                <span className="min-w-0 flex-1 truncate text-[0.78rem] font-semibold text-[#edf2ed]">
                  {reachActive ? "Directions" : (sel.lastSelection?.label ?? sel.label ?? "Result")}
                </span>
                {reachActive ? null : (
                  <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5 shrink-0 text-[#78857b]" fill="none" stroke="currentColor" strokeWidth="1.8">
                    {sheetPeek ? (
                      <path d="m6 12 4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                    ) : (
                      <path d="m6 8 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                    )}
                  </svg>
                )}
              </button>
              {/* The refine chip summarises the one live control (walk pace /
                  transit-car departure) and deep-links to it. The amenity-filters
                  peek chip is gone in preset mode — amenities are deferred to
                  a later amenity pass. */}
              {sheetPeek && !reachActive ? (
                <button
                  type="button"
                  data-testid="peek-chip-refine"
                  aria-label={`${
                    sel.mode === "walk"
                      ? `Walking pace: ${sel.pace === "normal" ? "Normal" : "Slow"}`
                      : `Time: ${TIME_PRESETS[sel.timeContext.preset].label}`
                  }. Open settings`}
                  onClick={() => expandSheetTo("refine")}
                  className="min-h-11 shrink-0 rounded-full border border-white/[.09] bg-white/[.045] px-3 text-[0.66rem] font-semibold text-[#9ca9a0] transition-colors hover:bg-white/[.08] hover:text-[#edf2ed]"
                >
                  {sel.mode === "walk"
                    ? (sel.pace === "normal" ? "Normal" : "Slow")
                    : TIME_PRESETS[sel.timeContext.preset].label}
                </button>
              ) : null}
            </div>
            ) : null}
            {reachActive ? (
              <ReachPanel view={reachView!} onHighlight={(i) => reachControllerRef.current?.highlight(i)} onClose={closeReachPanel} />
            ) : null}
            <div hidden={reachActive || sheetPeek} inert={reachActive || sheetPeek}>
              <SelectionCard
                label={sel.label}
                message={sel.message}
                mode={sel.mode}
                selectedMin={selectedMin}
                loading={sel.status === "loading"}
                departure={sel.departure}
                car={sel.car}
              />
              {/* Reach refinements live WITH the result they adjust. The two
                  controls are gated INDEPENDENTLY (found in review): PaceControl
                  is strictly Walk (pace is a walking concept, task 052 P4);
                  TimeContextControl is transit OR car (task 058 — car reach is
                  time-aware for traffic realism). They are never merged into one
                  non-walk wrapper (that would resurrect pace in car). Exactly one
                  control renders per mode, so the bordered cluster is never empty.
                  Amenities are deferred to a later amenity pass, so this refine cluster is the
                  whole expanded sheet body in preset mode. */}
              <div ref={refineBlockRef} className="mt-2.5 grid gap-2.5 border-t border-white/[.07] pt-2.5">
                {sel.mode === "walk" ? <PaceControl pace={sel.pace} onSelect={setPace} /> : null}
                {sel.mode === "transit" || sel.mode === "car" ? (
                  <TimeContextControl value={sel.timeContext} onSelect={setTimeContext} mode={sel.mode} />
                ) : null}
              </div>
            </div>
          </section>
        ) : showFirstRun ? (
          <div className="absolute inset-x-3 bottom-[max(3.6rem,calc(env(safe-area-inset-bottom)+3rem))] z-10 sm:inset-x-4 md:bottom-auto md:left-4 md:right-auto md:top-[21.3rem] md:w-[388px]">
            <EmptyState />
          </div>
        ) : null}
      </div>

      {/* Cluster hover preview (task 062): what's inside the hovered donut,
          rendered synchronously from the mark's own reconcile-time counts —
          zero source queries, pointer-transparent, and closed the moment the
          camera moves or the mark disappears. Names stay one click away in
          the list popup (deliberate scope line). z-30: a transient
          pointer-anchored tooltip floats ABOVE the shell chrome — at z-10 it
          rendered invisibly BEHIND the dock/sheet for marks hovered near them
          (found in review). */}
      {clusterPreview ? (
        <div
          data-testid="cluster-preview"
          className={`pointer-events-none absolute z-30 w-max max-w-[230px] -translate-x-1/2 rounded-xl border border-white/[.12] bg-[#0d110e]/95 px-3 py-2 shadow-[0_14px_36px_rgba(0,0,0,.34)] backdrop-blur-xl ${
            clusterPreview.y - clusterPreview.offset < 150 ? "" : "-translate-y-full"
          }`}
          style={{
            left: Math.min(Math.max(clusterPreview.x, 118), (typeof window !== "undefined" ? window.innerWidth : 1200) - 118),
            top:
              clusterPreview.y - clusterPreview.offset < 150
                ? clusterPreview.y + clusterPreview.offset
                : clusterPreview.y - clusterPreview.offset,
          }}
        >
          <p className="text-[0.72rem] font-semibold text-[#edf2ed]">
            {clusterPreview.total} {clusterPreview.total === 1 ? "place" : "places"} here
          </p>
          <ul className="mt-1 grid gap-0.5">
            {AMENITY_CATEGORIES.filter((c) => clusterPreview.counts.some((n) => n.category === c.key && n.count > 0)).map(
              (c) => (
                <li key={c.key} className="flex items-center gap-1.5 text-[0.66rem] text-[#9ca9a0]">
                  <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: c.color }} />
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  <span className="pl-2 font-semibold text-[#edf2ed]">
                    {clusterPreview.counts.find((n) => n.category === c.key)?.count}
                  </span>
                </li>
              ),
            )}
          </ul>
          <p className="mt-1 text-[0.6rem] text-[#6f7d73]">Click to open</p>
        </div>
      ) : null}

      {utilityHeader}

      {/* First-paint realistic map placeholder (phone-first design): sits behind the map
          canvas so no state ever shows a dark void; covered + hidden once MapLibre
          mounts. Inline SVG, no network/JS on the critical path (task-017 contract). */}
      <MapPlaceholder hidden={mapReady} />

      {/* Kept after the command UI in DOM order so keyboard navigation starts
          with search, while the explicit overlay z-index still places the
          controls visually above this full-bleed canvas. */}
      <div
        ref={containerRef}
        data-testid="app-map"
        aria-label="Interactive map of travel reach and nearby places in Bucharest"
        // tabIndex -1 so directions can return focus here on close (panel
        // review): the map container is otherwise not focusable.
        tabIndex={-1}
        className="h-full w-full outline-none"
      />

      {/* Deferred map engine failed to load (task 017): rather than leave the headline canvas
          silently blank we surface an actionable message. The dominant cause is a stale client
          whose cached HTML points at a hashed chunk a redeploy has purged — for that case a same-
          session re-import just replays the bundler's cached rejection, so the manual recovery is
          a full page RELOAD (fresh HTML → fresh chunk hashes), not another in-page import. The copy
          stays honest: a user-submitted search is buffered until the engine loads and is NOT served
          while the map is down, so we do not claim otherwise. */}
      {mapLoadFailed && (
        <div
          role="alert"
          data-testid="map-load-error"
          className="pointer-events-auto absolute inset-x-0 bottom-24 z-30 mx-auto flex w-fit max-w-[90%] items-center gap-3 rounded-xl border border-white/10 bg-[#111614]/95 px-4 py-3 text-sm text-[#f4f7f2] shadow-lg"
        >
          <span>The map couldn’t load. Reload to try again.</span>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-[#d8ff87]/25 bg-[#c7f36b] px-3 py-1.5 font-medium text-[#172008]"
            onClick={() => {
              if (typeof window !== "undefined") window.location.reload();
            }}
          >
            Reload
          </button>
        </div>
      )}

      {/* Basemap attribution (OSM · ESA WorldCover · Natural Earth) is present in
          EVERY state via the always-on MapLibre AttributionControl (map init).
          The Transitous provider credit is the ADDITIONAL transit obligation
          (phone-first design) — shown whenever transit data is displayed: a transit
          reach, or a right-click journey (MOTIS/Transitous). Not on walk/car
          states, where showing it would imply transit data that isn't there. */}
      {sel.mode === "transit" || reachActive ? <AttributionBadge elevated={hasResults} /> : null}
    </div>
  );
}
