import type maplibregl from "maplibre-gl";

import {
  buildAmenityFeatures,
  countByCategory,
  type Amenity,
  type AmenityCategoryKey,
  type AmenityCounts,
} from "@/features/amenities/amenities";
import { amenityMapCategoryFilter, filterAmenityItems } from "@/features/amenities/amenity-selection";
import {
  AMENITY_RETRY_DELAY_MS,
  classifyAmenityFailure,
  isNewAmenityOrigin,
  originKey,
} from "@/features/amenities/amenities-flow";
import { type Pace } from "@/features/isochrones/pace";
import type { LoadState } from "@/features/map/load-state";
import { EMPTY_FC } from "@/features/map/map-setup";
import type { Origin } from "@/features/map/selection-flow";

/** Amenity-fetch identity: address (rounded origin) + pace, since the counting
 * radius (the ORS 15-min walk ring) is pace-dependent. A pace change ⇒ new key
 * ⇒ refetch; a mode-toggle / time-only change keeps the key ⇒ markers persist. */
function amenityKey(origin: Origin, pace: Pace): string {
  return `${originKey(origin.lat, origin.lng)}:${pace}`;
}

/** Amenities are a property of the resolved address, independent of the travel
 * mode — so they live outside the selection state machine, in their own UI slice. */
export type AmenityUi = {
  status: "idle" | "loading" | "ready" | "error";
  counts: AmenityCounts | null;
  items: Amenity[];
};

/**
 * The amenities UI slice (task 023/024/042): fetch (with one auto-retry on a
 * transient failure), render markers as a single GeoJSON write, filter map +
 * browser by category via MapLibre `setFilter` on markers+glyphs (the list
 * shares the same selection array — no per-tile data rebuild), and clear on a
 * genuinely-new selection. Keyed by rounded origin so a Walk↔Transit toggle
 * persists the markers with no refetch; a generation guards stale responses. The
 * retry-vs-surface decision is the pure `classifyAmenityFailure`. `dispose`
 * aborts the in-flight fetch and clears the pending retry timer.
 */
/** The slice of the cluster-donut controller this controller drives. Kept as a
 * local structural type (not an import of the controller module) so the two can
 * be wired in either order and neither has to know the other's construction. */
export interface AmenityClusterVisibility {
  setVisible: (visible: boolean) => void;
  clearAbsorbed: () => void;
  clear: () => void;
  refresh: () => void;
  /** Suspends donut hit-testing until the marks are rebuilt from the new indexing. */
  invalidateMarks: () => void;
  /** Pins absorbed into a donut (the absorbed-pin case) — hidden here so no place is drawn twice. */
  absorbedPinIds: () => number[];
}

export function createAmenitiesController({
  map,
  el,
  loadState,
  setAmenity,
  amenityRef,
  amenityOriginRef,
  selectedCategoriesRef,
  resetAmenityHover,
  getPopupCategory,
  closeStopPopup,
  invalidateClusters,
  closeSpider,
  clustersRef,
}: {
  map: maplibregl.Map;
  el: HTMLElement;
  loadState: LoadState;
  setAmenity: (next: AmenityUi) => void;
  amenityRef: { current: AmenityUi };
  amenityOriginRef: { current: Origin | null };
  selectedCategoriesRef: { current: AmenityCategoryKey[] };
  resetAmenityHover: () => void;
  getPopupCategory: () => AmenityCategoryKey | null;
  closeStopPopup: () => void;
  /** Bumps the popup controller's cluster generation + closes an open cluster list
   * whenever the source is re-indexed (the absorbed-pin case). */
  invalidateClusters: () => void;
  /** Collapses an open spiderfy fan. Same reason as `invalidateClusters`: the fan's
   * leaves were resolved from the previous indexing, and a category toggle can even
   * leave it showing a category the user just hid. */
  closeSpider: () => void;
  /** Holder for the donut controller. A holder (not a direct reference) because
   * the donut controller needs this controller's source to exist first, so the
   * two are constructed in sequence and wired afterwards — the same pattern
   * AppMap already uses for the reach-view declutter holder. */
  clustersRef: { current: AmenityClusterVisibility | null };
}) {
  let abort: AbortController | null = null;
  let gen = 0;
  let key: string | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // While a right-click journey is drawn, amenity markers are decluttered
  // (hidden) so the trip is legible (task 054). This is PERSISTENT state consulted
  // INSIDE the single filter chokepoint (`applyAmenityLayerFilter`), not a one-shot
  // `setFilter` — otherwise a late amenity fetch (`renderAmenities`) or a
  // category-tile toggle (`applyAmenitySelection`) would repaint markers over the
  // journey (found in review). A filter matching no feature hides them all.
  let reachView = false;
  // A spiderfied fan (task 061 W20) hides every OTHER amenity mark for the same
  // reason: the fan's positions are provably separated from each other and from
  // their hub, but nothing can promise separation from an unrelated donut nearby,
  // so leaving the rest painted would break the task's no-overlap invariant exactly
  // when the user is trying to tell two places apart. Same chokepoint, same
  // persistence discipline as `reachView` — a late fetch must not repaint over a fan.
  let spiderView = false;
  /** Are amenity marks currently suppressed, by either surface? */
  const decluttered = () => reachView || spiderView;

  /** Every amenity layer, and which half of the clustered source it draws. A
   * clustered source serves clusters AND individual points from one source, so
   * each layer's BASE filter must be preserved when visibility is composed on
   * top — dropping it would paint cluster centroids as if they were places. */
  const AMENITY_LAYERS: { id: string; base: unknown }[] = [
    { id: "amenity-markers", base: ["!", ["has", "point_count"]] },
    { id: "amenity-icons", base: ["!", ["has", "point_count"]] },
    { id: "amenity-labels", base: ["!", ["has", "point_count"]] },
  ];
  const HIDE_ALL = ["boolean", false] as unknown as maplibregl.FilterSpecification;

  // `counts` are the server's TRUE clipped totals (may exceed the rendered
  // marker count when a category was capped) — the chips show these, not a
  // recount of the capped markers.
  //
  // Task 061 changed the mechanism here in two ways review caught:
  //
  // 1. Category selection is applied by RECLUSTERING (`setData` with the visible
  //    subset — see `applyAmenitySelection`), not by `setFilter`. A cluster's
  //    `point_count` and `clusterProperties` are frozen when the data is indexed,
  //    so filtering the layer would leave hidden categories counted inside the
  //    donut totals — the aggregate would lie.
  // 2. Cluster donuts are DOM markers with no layer to filter, so hiding them is
  //    an explicit call on their controller, not a `setFilter`.
  //
  // Both still flow through this ONE chokepoint, so a late fetch or a category
  // toggle can never repaint marks over a drawn journey.
  function applyAmenityLayerFilter(categories: AmenityCategoryKey[]) {
    if (!loadState.styleLoaded || !map.getLayer("amenity-markers")) return;
    // reachView wins over the category selection: composing here means EVERY
    // filter application (fetch render, category toggle, selection) keeps marks
    // hidden while a journey is shown, and the selection is restored the moment
    // reachView clears.
    const categoryFilter = amenityMapCategoryFilter(categories);
    // A pin absorbed into a donut must NOT also paint as a pin (found in review) —
    // it is already represented, and drawing both is the double-mark this task exists
    // to prevent. Only the single-feature layers can carry absorbed pins.
    const absorbed = clustersRef.current?.absorbedPinIds() ?? [];
    const notAbsorbed =
      absorbed.length > 0
        ? ([["!", ["in", ["id"], ["literal", absorbed]]]] as unknown[])
        : [];
    for (const { id, base } of AMENITY_LAYERS) {
      if (!map.getLayer(id)) continue;
      const parts: unknown[] = [base];
      if (categoryFilter !== null) parts.push(categoryFilter);
      parts.push(...notAbsorbed);
      const composed = decluttered()
        ? HIDE_ALL
        : parts.length === 1
          ? (base as maplibregl.FilterSpecification)
          : (["all", ...parts] as unknown as maplibregl.FilterSpecification);
      map.setFilter(id, composed);
    }
    // DOM donuts live outside the filter system entirely — without this the
    // journey would be covered by cluster markers even though every WebGL layer
    // was correctly hidden.
    clustersRef.current?.setVisible(!decluttered());
    // Faithful read-back of the ACTUAL applied visibility (set here, at the
    // single chokepoint) — distinct from `data-amenity-count`, which is the
    // filtered LIST length and would not change when reach-view hides marks
    // (review #4). e2e asserts declutter on/off against this.
    el.dataset.amenityDeclutter = decluttered() ? "on" : "off";
  }

  // Enter/leave declutter for the right-click journey. Re-applies the filter from
  // the LIVE selected-categories ref (not a snapshot taken at enter) so a category
  // toggle made while the journey was open is honoured on restore (found in review).
  function setReachView(on: boolean) {
    if (reachView === on) return;
    reachView = on;
    applyAmenityLayerFilter(selectedCategoriesRef.current);
    resetAmenityHover(); // hidden markers must not keep a hover/pick affordance
  }

  // Enter/leave declutter for an open spiderfy fan. Tracked SEPARATELY from
  // `reachView` rather than sharing one flag: the two surfaces are opened and closed
  // by different controllers, and a shared boolean would let whichever closed second
  // repaint the marks while the other was still showing.
  function setSpiderView(on: boolean) {
    if (spiderView === on) return;
    spiderView = on;
    applyAmenityLayerFilter(selectedCategoriesRef.current);
    resetAmenityHover();
  }

  /**
   * Write the VISIBLE subset into the clustered source.
   *
   * Task 061 reverses task 042's "full data once, then `setFilter`" optimisation
   * for the category selection, deliberately and with a measurement. A cluster's
   * `point_count` / `clusterProperties` are computed when the data is indexed, so
   * a layer filter cannot re-aggregate them: hiding "Groceries" via `setFilter`
   * would still leave groceries counted inside every donut total and painted as an
   * arc. Reclustering the visible subset is the only way the aggregate stays
   * truthful. Measured worst case at the real cap (750 features): ~41 ms to
   * `sourcedata`, no dropped frames.
   *
   * Hover feature-state must be dropped FIRST: `setData` re-indexes the source and
   * feature ids are payload indices, so a surviving hover id would highlight a
   * different place.
   */
  function writeVisibleAmenities(items: Amenity[], categories: AmenityCategoryKey[]): Amenity[] {
    const visibleItems = filterAmenityItems(items, categories);
    // FIRST, so the filter application at the end of this function is the final word
    // on visibility (closing the fan re-applies it too).
    closeSpider();
    resetAmenityHover(); // ids are about to be reassigned by the re-index
    // …and wipe the WHOLE source's feature-state, not only the id we know about. Feature
    // ids are payload indices, so a `setData` reuses them for a DIFFERENT set of places;
    // clearing just the current hover leaves any other state attached to an index that
    // now means another POI (found in review). Cheap, and it removes the whole class.
    try {
      (map as unknown as { removeFeatureState: (t: { source: string }) => void }).removeFeatureState({
        source: "amenities",
      });
    } catch {
      // Older MapLibre builds without the source-wide form: `resetAmenityHover` above
      // already covers the only state this app sets.
    }
    // The absorbed-pin set refers to ids from the PREVIOUS indexing, so it must go
    // before the filter is rebuilt below — otherwise a pin that is no longer absorbed
    // stays hidden for the frame between setData and the next reconcile.
    clustersRef.current?.clearAbsorbed();
    // `setData` re-indexes cluster ids on the worker, so every donut currently on
    // screen is about to be describing the wrong places. Hit-testing is suspended
    // SYNCHRONOUSLY here — `invalidateClusters()` below only invalidates work that has
    // already started, and the reconcile that rebuilds the marks is a frame away
    // (found in review). Without this a click in that window opens a stale list.
    clustersRef.current?.invalidateMarks();
    (map.getSource("amenities") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: buildAmenityFeatures(visibleItems) as GeoJSON.Feature[],
    });
    applyAmenityLayerFilter(categories);
    // "Hide all" (or a cleared set) has no marks to rebuild, so leaving the old donuts
    // painted-but-inert until the next reconcile is pure lag with nothing to gain — drop
    // them now (found in review). A non-empty write keeps them visible on purpose: the
    // staleness guard makes them inert, and blanking on every category toggle would flicker.
    if (visibleItems.length === 0) clustersRef.current?.clear();
    // A recluster re-indexes cluster ids, so any in-flight leaf lookup and any open
    // cluster list are now stale (found in review).
    invalidateClusters();
    // The donut set is derived from the source, so a recluster must trigger a
    // reconcile rather than waiting for the next camera move.
    clustersRef.current?.refresh();
    return visibleItems;
  }

  function renderAmenities(items: Amenity[], counts: AmenityCounts) {
    // Buffer until the style (and the amenities source) exist — an amenity
    // response can land before `load`, exactly like the isochrone.
    if (!loadState.styleLoaded) {
      loadState.pendingAmenities = { items, counts };
      setAmenity({ status: "ready", counts, items });
      return;
    }
    const visibleItems = writeVisibleAmenities(items, selectedCategoriesRef.current);
    el.dataset.amenityCount = String(visibleItems.length);
    setAmenity({ status: "ready", counts, items });
  }

  function applyAmenitySelection(categories: AmenityCategoryKey[]) {
    if (amenityRef.current.status !== "ready") return;
    let visibleItems = filterAmenityItems(amenityRef.current.items, categories);
    if (loadState.styleLoaded) {
      // Recluster, not just re-filter — see writeVisibleAmenities. This also
      // drops hover + popup affordances for a now-hidden category.
      visibleItems = writeVisibleAmenities(amenityRef.current.items, categories);
    }
    el.dataset.amenityCount = String(visibleItems.length);
    const popupCategory = getPopupCategory();
    if (popupCategory && !categories.includes(popupCategory)) closeStopPopup();
  }

  // Drop amenity markers/counts and supersede any in-flight fetch or pending
  // retry. Called only on a genuinely-new selection — NOT on a mode toggle
  // (which must persist).
  function clearAmenities() {
    closeSpider();
    abort?.abort();
    if (retryTimer) clearTimeout(retryTimer);
    gen += 1;
    key = null;
    amenityOriginRef.current = null;
    loadState.pendingAmenities = null;
    resetAmenityHover();
    (map.getSource("amenities") as maplibregl.GeoJSONSource | undefined)?.setData(
      EMPTY_FC as GeoJSON.FeatureCollection,
    );
    // DOM donuts are not cleared by emptying the source — they must be removed
    // explicitly or they linger over a map with no selection.
    clustersRef.current?.clear();
    invalidateClusters();
    delete el.dataset.amenityCount;
    setAmenity({ status: "idle", counts: null, items: [] });
  }

  // One amenity fetch attempt. On a transient failure the first attempt schedules
  // ONE delayed retry, staying in "loading" so the user never sees an error that
  // would self-heal. Any failure that DOES surface clears the origin key — an
  // error must never pin the key, or the review's Retry button and a mode-toggle
  // recompute would be swallowed by the isNewAmenityOrigin guard.
  function fetchAmenities(origin: Origin, attempt: number, pace: Pace) {
    key = amenityKey(origin, pace);
    amenityOriginRef.current = origin;
    const reqGen = (gen += 1);
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    setAmenity({ status: "loading", counts: null, items: [] });

    const failWith = (httpStatus: number | null) => {
      if (classifyAmenityFailure(httpStatus, attempt) === "retry") {
        retryTimer = setTimeout(() => {
          if (reqGen !== gen) return; // superseded meanwhile
          fetchAmenities(origin, attempt + 1, pace);
        }, AMENITY_RETRY_DELAY_MS);
        return;
      }
      // A surfaced error clears the origin key so Retry / a toggle recompute can
      // refetch the same origin (an error must never pin the key).
      key = null;
      setAmenity({ status: "error", counts: null, items: [] });
    };

    fetch(`/api/amenities?lat=${origin.lat}&lng=${origin.lng}&pace=${pace}`, { signal: controller.signal })
      .then(async (res) => {
        if (reqGen !== gen) return;
        if (!res.ok) return void failWith(res.status);
        const data = (await res.json()) as { amenities?: unknown; counts?: AmenityCounts };
        if (reqGen !== gen) return;
        // A valid-but-wrong-shape body (no array) is an error, not "no
        // amenities" — and deterministic, so it reports the real (non-5xx)
        // status and is never auto-retried.
        if (!Array.isArray(data.amenities)) return void failWith(res.status);
        const items = data.amenities as Amenity[];
        renderAmenities(items, data.counts ?? countByCategory(items));
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError" || reqGen !== gen) return;
        failWith(null);
      });
  }

  // Fetch amenities for a resolved origin at the active pace, in parallel with
  // the isochrone. A mode-toggle or time-only change resolves the SAME
  // origin+pace ⇒ no refetch (markers persist). A PACE change resolves the same
  // origin but a NEW pace-scoped key ⇒ refetch (the walk-ring radius changed, so
  // counts must). A failure cleared the key, so the same origin+pace refetches.
  function maybeFetchAmenities(origin: Origin, pace: Pace) {
    const nextKey = amenityKey(origin, pace);
    if (!isNewAmenityOrigin(key, nextKey)) return;
    fetchAmenities(origin, 0, pace);
  }

  return {
    /** Re-apply the layer filter (used when the absorbed-pin set changes). */
    reapplyFilter: () => applyAmenityLayerFilter(selectedCategoriesRef.current),
    renderAmenities,
    applyAmenitySelection,
    clearAmenities,
    fetchAmenities,
    maybeFetchAmenities,
    setReachView,
    setSpiderView,
    dispose() {
      abort?.abort();
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}

export type AmenitiesController = ReturnType<typeof createAmenitiesController>;
