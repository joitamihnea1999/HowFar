import type maplibregl from "maplibre-gl";

import type { ReachLeg } from "@/features/isochrones/server/transit-plan";
import { journeyLegs, journeyStops } from "@/features/map/reach";
import type { EdgeInsets } from "@/features/map/route-framing";
import type { LoadState } from "@/features/map/load-state";
import { EMPTY_FC } from "@/features/map/map-setup";
import { MARKER_PICK_PAD_PX } from "@/features/map/marker-pick";
import { routeFitBreathingRoom, runRoutePathStampPoll } from "@/features/map/route-framing";

/**
 * The drawn right-click journey (task 054): paints a reachable public-transport
 * trip onto the `reach-path` source — one line per leg (walk dashed / transit
 * solid, from the decoded MOTIS `legGeometry` or a straight from→to fallback) and
 * the used stops (board → transfer(s) → alight). The pure derivation lives in
 * `reach.ts` (`journeyLegs` / `journeyStops`); this controller is the imperative
 * MapLibre glue (setData, the e2e stamp, hover highlight, hit-testing, teardown),
 * so it is coverage-excluded and proven by the Playwright suite.
 *
 * Camera fit (task 057): after drawing, `frame()` fits the journey bounds with
 * the shell padding so the whole path is visible beside the compact directions
 * popup — the owner couldn't see the path under the old full-size popup. This
 * SUPERSEDES the task-054 "no fit" note: that objection was to fitting while a
 * large click-anchored popup fought the origin/ring framing; here the popup is
 * compact and the fit's explicit job is to reveal the drawn journey. The stamp
 * uses the same rAF+wall-clock poll as the route path — NOT `map.once("idle")`,
 * which after the permanent setPadding settles fires once and never re-fires
 * (mind-map [16] gotcha).
 */
export function createReachJourneyController({
  map,
  el,
  loadState,
  reducedMotion,
}: {
  map: maplibregl.Map;
  el: HTMLElement;
  loadState: LoadState;
  reducedMotion: MediaQueryList;
}) {
  // The drawn journey's bounds [[minLng,minLat],[maxLng,maxLat]], for `frame()`.
  let activeBounds: [[number, number], [number, number]] | null = null;
  // Per-leg stop-feature ids, so hovering a popup step highlights its stops.
  let stopIdsByLeg: Record<number, number[]> = {};
  // Generation guard: a clear/replace bumps this so a late stamp poll can't
  // stamp a superseded (or torn-down) draw.
  let gen = 0;
  // Whether a journey is currently drawn. Tracked INDEPENDENTLY of the
  // `data-reach-journey` e2e stamp (which lands one rAF after setData): the
  // click-guard must be armed the instant features exist, or a click in that
  // one-frame window falls through to a new selection (review).
  let active = false;

  function reachSource(): maplibregl.GeoJSONSource | undefined {
    return map.getSource("reach-path") as maplibregl.GeoJSONSource | undefined;
  }

  function coincident(a: [number, number], lat: number, lng: number): boolean {
    return Math.abs(a[1] - lat) < 1e-6 && Math.abs(a[0] - lng) < 1e-6;
  }

  function clear() {
    gen += 1;
    active = false;
    activeBounds = null;
    stopIdsByLeg = {};
    loadState.pendingJourney = null;
    if (loadState.styleLoaded) {
      reachSource()?.setData(EMPTY_FC as GeoJSON.FeatureCollection);
      resetHighlightFilters();
    }
    delete el.dataset.reachJourney;
    delete el.dataset.reachHover;
    delete el.dataset.reachFramed;
  }

  function resetHighlightFilters() {
    if (!map.getLayer("reach-path-line-hl")) return;
    map.setFilter("reach-path-line-hl", ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "legIndex"], -1]]);
    map.setFilter("reach-path-stops-hl", ["all", ["==", ["geometry-type"], "Point"], ["in", ["get", "stopIndex"], ["literal", []]]]);
  }

  /** Draw the journey. Returns whether it actually produced drawable features —
   * the caller uses this to decide whether to declutter (a transit plan whose
   * legs carry no drawable coords must NOT hide the amenities behind an empty
   * map — review). */
  function draw(legs: ReachLeg[]): boolean {
    const legFeatures = journeyLegs(legs);
    const stops = journeyStops(legs);
    const hasGeometry = legFeatures.length > 0 || stops.length > 0;
    active = hasGeometry;

    // Buffer a pre-load draw and replay it once the source exists (a right-click
    // that raced MapLibre's `load`).
    if (!loadState.styleLoaded) {
      loadState.pendingJourney = legs;
      return hasGeometry;
    }
    const drawGen = ++gen;

    // No drawable geometry at all: stamp "none" and draw nothing, rather than
    // leaving the stamp poll to time out invisibly (plan-panel F).
    if (!hasGeometry) {
      reachSource()?.setData(EMPTY_FC as GeoJSON.FeatureCollection);
      resetHighlightFilters();
      stopIdsByLeg = {};
      el.dataset.reachJourney = "none";
      delete el.dataset.reachHover;
      return false;
    }

    const lineFeatures: GeoJSON.Feature[] = legFeatures.map((l) => ({
      type: "Feature",
      properties: { kind: "leg", legIndex: l.index, isWalk: l.isWalk },
      geometry: { type: "LineString", coordinates: l.coords },
    }));
    const stopFeatures: GeoJSON.Feature[] = stops.map((s, i) => ({
      type: "Feature",
      properties: { kind: "stop", stopKind: s.kind, stopIndex: i, name: s.name },
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
    }));

    // Map each leg index to the stop ids at its endpoints, so highlight(k) can
    // ring the board/alight of the hovered step.
    stopIdsByLeg = {};
    legs.forEach((leg, index) => {
      const ids: number[] = [];
      stops.forEach((s, i) => {
        if (leg.from && coincident([s.lng, s.lat], leg.from.lat, leg.from.lng)) ids.push(i);
        else if (leg.to && coincident([s.lng, s.lat], leg.to.lat, leg.to.lng)) ids.push(i);
      });
      if (ids.length) stopIdsByLeg[index] = ids;
    });

    // Bounds over every drawn coordinate (leg lines + stops), for `frame()`.
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    const grow = (lng: number, lat: number) => {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    };
    for (const l of legFeatures) for (const [lng, lat] of l.coords) grow(lng, lat);
    for (const s of stops) grow(s.lng, s.lat);
    activeBounds = Number.isFinite(minLng)
      ? [
          [minLng, minLat],
          [maxLng, maxLat],
        ]
      : null;

    resetHighlightFilters();
    reachSource()?.setData({ type: "FeatureCollection", features: [...lineFeatures, ...stopFeatures] });
    delete el.dataset.reachHover;
    delete el.dataset.reachFramed;

    // Stamp once the source actually holds queryable features (e2e contract:
    // "the journey is on the map"). Self-terminates if a clear/replace bumped gen.
    runRoutePathStampPoll({
      hasFeatures: () => map.querySourceFeatures("reach-path").length > 0,
      now: () => performance.now(),
      schedule: (tick) => requestAnimationFrame(tick),
      cancelled: () => drawGen !== gen,
      onStamp: () => {
        el.dataset.reachJourney = String(legFeatures.length);
      },
    });
    return true;
  }

  /** Highlight the hovered popup step's leg line + its board/alight stops, or
   * clear all highlight when `index` is null. */
  function highlight(index: number | null) {
    if (!map.getLayer("reach-path-line-hl")) return;
    if (index === null) {
      resetHighlightFilters();
      delete el.dataset.reachHover;
      return;
    }
    map.setFilter("reach-path-line-hl", ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "legIndex"], index]]);
    const ids = stopIdsByLeg[index] ?? [];
    map.setFilter("reach-path-stops-hl", ["all", ["==", ["geometry-type"], "Point"], ["in", ["get", "stopIndex"], ["literal", ids]]]);
    el.dataset.reachHover = String(index);
  }

  /** True when a click lands on the drawn journey (a leg line or a stop dot), so
   * the map click handler can skip starting a NEW selection — the same guard the
   * OSM route path uses (plan-panel C). */
  function hitsActiveJourney(point: maplibregl.Point): boolean {
    // `active` (set synchronously in draw) — NOT the e2e stamp, which lags one
    // frame — so the guard is armed the instant features are on the map.
    if (!active) return false;
    const pad = MARKER_PICK_PAD_PX;
    const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
      [point.x - pad, point.y - pad],
      [point.x + pad, point.y + pad],
    ];
    const layers = ["reach-path-transit", "reach-path-walk", "reach-path-stops"].filter((id) => map.getLayer(id));
    return map.queryRenderedFeatures(bbox, { layers }).length > 0;
  }

  /** Fit the camera to the drawn journey so the whole path is visible beside the
   * compact directions popup (task 057). No-op if nothing is drawn.
   *
   * `dock` is the shell's four-edge inset — but MapLibre's `cameraForBounds`
   * ALREADY includes the map's committed `setPadding`, so passing the absolute
   * dock would DOUBLE-COUNT it and, on a phone, make the journey impossible to
   * frame. We pass only bounded ADDITIONAL breathing room
   * (`routeFitBreathingRoom`, the exact pattern route-path uses) and guard the
   * null-camera case rather than hanging. Stamp is race-safe: instant for
   * reduced-motion; else register the settle listener AFTER the camera call (so a
   * prior in-flight animation's moveend can't stamp early) with a wall-clock
   * fallback (so a zero-delta fit that never emits moveend can't strand it). */
  function frame(dock: EdgeInsets, instant = false) {
    if (!active || !activeBounds || !loadState.styleLoaded) return;
    const padding = routeFitBreathingRoom(dock, el.clientWidth, el.clientHeight);
    const camera = map.cameraForBounds(activeBounds, { padding, maxZoom: 15 });
    if (!camera) {
      el.dataset.reachFramed = "false"; // cannot fit (tiny viewport) — don't hang
      return;
    }
    const frameGen = gen;
    const stamp = () => {
      if (frameGen === gen) el.dataset.reachFramed = "true";
    };
    if (instant || reducedMotion.matches) {
      map.easeTo({ ...camera, duration: 0, essential: false });
      stamp();
      return;
    }
    const fallback = setTimeout(stamp, 1200);
    map.once("moveend", () => {
      clearTimeout(fallback);
      stamp();
    });
    map.easeTo({ ...camera, duration: 700, essential: false });
  }

  /** Replay a buffered pre-load draw (called from AppMap's `load`). */
  function flushPending() {
    const pending = loadState.pendingJourney;
    if (pending) {
      loadState.pendingJourney = null;
      draw(pending);
    }
  }

  return {
    draw,
    clear,
    highlight,
    frame,
    hitsActiveJourney,
    flushPending,
    dispose() {
      clear();
    },
  };
}

export type ReachJourneyController = ReturnType<typeof createReachJourneyController>;
