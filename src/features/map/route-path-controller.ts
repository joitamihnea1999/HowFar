import type maplibregl from "maplibre-gl";

import {
  buildRoutePathFeatures,
  routePathBounds,
  type RoutePath,
} from "@/features/amenities/route-path";
import type { EdgeInsets } from "@/features/map/route-framing";
import {
  computeRouteFraming,
  nextStampAction,
  routeFitBreathingRoom,
} from "@/features/map/route-framing";
import type { LoadState } from "@/features/map/load-state";
import { EMPTY_FC } from "@/features/map/map-setup";
import { MARKER_PICK_PAD_PX } from "@/features/map/marker-pick";

/** Client deadline on the route-path fetch behind a clicked line row (task 024)
 * — the "never hang on loading" lesson. */
const ROUTE_PATH_TIMEOUT_MS = 9000;

/**
 * The selected transit line's drawn path (task 024). Fetched from the stop
 * popup: clicking a line row fetches the OSM route relation's track + stops and
 * paints them; clicking the active row again clears. One active line at a time.
 * The camera-fit corridor math and the stamp-retry rule are pure (tested in
 * route-framing); this controller owns the imperative fetch/draw/fit + the
 * `data-route-*` stamps. Exposes the small surface the popup and bootstrap
 * handlers need (`getActiveRelationId`, `setActiveRouteButton`, `hasActiveBounds`,
 * `refit`, `hitsActiveRoutePath`, `toggleRoutePath`, `clearRoutePath`) so callers
 * never read its private state directly. `dispose` clears + aborts.
 */
export function createRoutePathController({
  map,
  el,
  loadState,
  reducedMotion,
  applyCameraPadding,
}: {
  map: maplibregl.Map;
  el: HTMLElement;
  loadState: LoadState;
  reducedMotion: MediaQueryList;
  applyCameraPadding: (hasResults: boolean) => EdgeInsets;
}) {
  let activeRouteRelId: number | null = null;
  let activeRouteButton: HTMLButtonElement | null = null;
  let activeRouteBounds: ReturnType<typeof routePathBounds> = null;
  let abort: AbortController | null = null;
  // Generation guard: bumped by clear/replace/timeout so a late response can't
  // draw over a superseded or cleared state.
  let gen = 0;

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
    abort?.abort();
    gen += 1;
    activeRouteRelId = null;
    activeRouteBounds = null;
    setActiveRouteButton(null);
    if (loadState.styleLoaded) {
      (map.getSource("route-path") as maplibregl.GeoJSONSource | undefined)?.setData(
        EMPTY_FC as GeoJSON.FeatureCollection,
      );
    }
    delete el.dataset.routePath;
    delete el.dataset.routeFramed;
    delete el.dataset.routeFitSettled;
    delete el.dataset.routeCorridorHeight;
    delete el.dataset.routeFrame;
  }

  function routeFitPadding(): EdgeInsets {
    // Dock insets committed here; the breathing-room math is pure. MapLibre's
    // bounds solver already includes the map's dock padding, so these are
    // ADDITIONAL room only — passing the absolute dock values would double-count
    // and make a 390px viewport impossible to fit.
    const dock = applyCameraPadding(true);
    return routeFitBreathingRoom(dock, el.clientWidth, el.clientHeight);
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
    // Projection + padding are imperative; the in/out-of-corridor decision and
    // read-back strings are pure (tested in route-framing).
    const { framed, corridorHeight, frame } = computeRouteFraming(
      a,
      b,
      padding,
      el.clientWidth,
      el.clientHeight,
    );
    el.dataset.routeFramed = String(framed);
    el.dataset.routeCorridorHeight = String(corridorHeight);
    el.dataset.routeFrame = frame;
  }

  function fitActiveRoute(duration: number) {
    if (!activeRouteBounds) return;
    const padding = routeFitPadding();
    const camera = map.cameraForBounds(activeRouteBounds, { padding, maxZoom: 14 });
    if (!camera) {
      el.dataset.routeFramed = "false";
      return;
    }
    // routeFitSettled is stamped ONLY from the settle moveend (not the early rAF
    // read-back), so an e2e wait on it can never release mid-animation even when
    // the bounds already fit the current corridor. routeFramed stays the
    // best-effort framing read-back for assertions.
    delete el.dataset.routeFitSettled;
    map.once("moveend", () => {
      stampRouteFraming();
      el.dataset.routeFitSettled = "true";
    });
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
    // Stamp the dataset from a RENDER read-back, not the input: the e2e contract
    // is "the path is on the map", so the attribute must only appear once the
    // source actually holds features (gen-guarded — a clear/replace before idle
    // must not resurrect it). A single once("idle") is not enough after permanent
    // setPadding + easeTo: idle can fire before the source is queryable, leaving
    // data-route-path unset while route-framed is already true (CI flake on
    // stop-lines selection-clear). The retry decision is the pure nextStampAction.
    const drawGen = gen;
    let attempts = 0;
    const stampWhenRendered = () => {
      if (drawGen !== gen) return;
      const hasFeatures = map.querySourceFeatures("route-path").length > 0;
      const action = nextStampAction(hasFeatures, attempts++);
      if (action === "stamp") el.dataset.routePath = String(relationId);
      else if (action === "retry") map.once("idle", stampWhenRendered);
    };
    map.once("idle", stampWhenRendered);
    requestAnimationFrame(() => requestAnimationFrame(stampWhenRendered));
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

    const reqGen = gen;
    const controller = new AbortController();
    abort = controller;
    const timer = setTimeout(() => {
      if (reqGen === gen) fail();
      controller.abort();
    }, ROUTE_PATH_TIMEOUT_MS);

    const fail = () => {
      // Bump the generation so a response whose json resolved JUST before the
      // deadline can't slip past the gen checks and draw over the error state.
      gen += 1;
      activeRouteRelId = null;
      setActiveRouteButton(button, "error");
    };

    // The stop's own location rides along for the same out-of-area guard the
    // stop-lines route uses (fair-use posture; see /api/route-path).
    fetch(`/api/route-path?rel=${relationId}&lat=${anchor[1]}&lng=${anchor[0]}`, { signal: controller.signal })
      .then(async (res) => {
        if (reqGen !== gen) return;
        if (!res.ok) return void fail();
        const path = (await res.json()) as RoutePath;
        if (reqGen !== gen) return;
        // A wrong-shape body must not reach the GeoJSON source.
        if (!Array.isArray(path?.segments) || !Array.isArray(path?.stops)) return void fail();
        setActiveRouteButton(button, "active");
        drawRoutePath(relationId, path);
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError" || reqGen !== gen) return;
        fail();
      })
      .finally(() => clearTimeout(timer));
  }

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

  return {
    toggleRoutePath,
    clearRoutePath,
    hitsActiveRoutePath,
    setActiveRouteButton,
    getActiveRelationId: () => activeRouteRelId,
    hasActiveBounds: () => activeRouteBounds !== null,
    refit: (duration: number) => fitActiveRoute(duration),
    dispose() {
      clearRoutePath();
    },
  };
}

export type RoutePathController = ReturnType<typeof createRoutePathController>;
