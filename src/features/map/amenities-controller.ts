import type maplibregl from "maplibre-gl";

import {
  buildAmenityFeatures,
  type Amenity,
  type AmenityCategoryKey,
  countsForBands,
  type AmenityCounts,
  type AmenityCountsByBand,
} from "@/features/amenities/amenities";
import {
  ALL_AMENITY_CATEGORY_KEYS,
  amenityMapCategoryFilter,
  filterAmenityItems,
} from "@/features/amenities/amenity-selection";
import {
  AMENITY_RETRY_DELAY_MS,
  classifyAmenityFailure,
  isNewAmenityOrigin,
  amenityFetchKey,
} from "@/features/amenities/amenities-flow";
import { type Pace } from "@/features/isochrones/pace";
import { type TimeContext } from "@/features/isochrones/time-context";
import { amenityBandsForFilter, LEGEND_BANDS, type RingFilter } from "@/features/isochrones/bands";
import { type Mode } from "@/features/map/selection-flow";
import type { LoadState } from "@/features/map/load-state";
import { EMPTY_FC } from "@/features/map/map-setup";
import type { Origin } from "@/features/map/selection-flow";

/** Amenity-fetch identity — see `amenityFetchKey`. Task 065: the clip follows the
 * MODE and its time context, so those are part of the identity too. A mode, pace or
 * crowded/quiet change ⇒ new key ⇒ CLEAR + REFETCH. Only a ring-filter change is local
 * (all three bands arrive in one response). The trailing half of this comment used to
 * say "a mode-toggle / time-only change keeps the key ⇒ markers persist" — the retired
 * pre-065 rule, left behind when the first half was corrected. */
function amenityKey(origin: Origin, pace: Pace, mode: Mode, timeContext: TimeContext): string {
  return amenityFetchKey({ origin, mode, pace, timeContext });
}

/** The amenity UI slice. Amenities live outside the selection state machine, but they
 * are NOT independent of the travel mode any more (task 065): the clip is the current
 * mode's reach area at the current departure context, so the fetch identity includes
 * both — see `amenityFetchKey`. */
export type AmenityUi = {
  status: "idle" | "loading" | "ready" | "error";
  /** Per-category totals for the bands currently SHADED — already band-scoped, so
   * the chips can render it directly and can never claim places outside the visible
   * rings (task 065). Derived from `countsByBand`; recomputed on a ring-filter change. */
  counts: AmenityCounts | null;
  /** The server's raw pre-cap totals per (category, band) — the source `counts` is
   * derived from, kept so a ring-filter change needs no refetch. */
  countsByBand: AmenityCountsByBand | null;
  items: Amenity[];
};

/**
 * The amenities UI slice (tasks 023/024/042/061/065): fetch (with one auto-retry on a
 * transient failure), render markers as a single GeoJSON write, filter map + browser by
 * category AND by visible ring band through the RECLUSTER path (`writeVisibleAmenities`,
 * not `setFilter` — cluster totals freeze at index time, so a layer filter would leave
 * hidden places inside donut counts), and clear on a genuinely-new selection or any
 * key-changing recompute. Keyed by origin + mode + effective pace + departure context
 * (`amenityFetchKey`), so a Walk↔Transit or crowded↔quiet toggle REFETCHES — task 065
 * made the clip mode-dependent, retiring the old "keyed by rounded origin, a toggle
 * persists the markers with no refetch" rule. A generation guards stale responses. The
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

/** Does this payload carry a usable per-(category, band) count block? */
function isCountsByBand(value: unknown): value is AmenityCountsByBand {
  if (!value || typeof value !== "object") return false;
  const byBand = value as Record<string, unknown>;
  return LEGEND_BANDS.every((band) => {
    const inBand = byBand[String(band)];
    if (!inBand || typeof inBand !== "object") return false;
    return ALL_AMENITY_CATEGORY_KEYS.every(
      (key: string) => typeof (inBand as Record<string, unknown>)[key] === "number",
    );
  });
}

export function createAmenitiesController({
  map,
  el,
  loadState,
  setAmenity,
  amenityRef,
  amenityOriginRef,
  selectedCategoriesRef,
  ringFilterRef,
  resetAmenityHover,
  getPopupCategory,
  getPopupBand,
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
  /** The live ring filter. Amenity visibility follows the SHADING: only places in the
   * bands currently painted are drawn and counted (task 065). A ref (not a value) for
   * the same reason as `selectedCategoriesRef` — every filter application must read
   * the current value, so a late fetch cannot repaint against a stale filter. */
  ringFilterRef: { current: RingFilter };
  resetAmenityHover: () => void;
  getPopupCategory: () => AmenityCategoryKey | null;
  /** The band of the place an open POI popup describes, so narrowing the ring filter can
   * close a popup for a place that is no longer shaded (task 065). */
  getPopupBand: () => number | null;
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

  /** The bands whose places are currently shaded — CUMULATIVE, because a ring layer
   * paints the whole reach polygon for its band rather than an annulus (see
   * `amenityBandsForFilter`). Read live, never snapshotted. */
  const visibleBands = () => amenityBandsForFilter(ringFilterRef.current);

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
    const visibleItems = filterAmenityItems(items, categories, "", visibleBands());
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

  /** Per-category totals for the bands currently shaded. */
  function scopedCounts(byBand: AmenityCountsByBand): AmenityCounts {
    return countsForBands(byBand, visibleBands());
  }

  function renderAmenities(items: Amenity[], countsByBand: AmenityCountsByBand) {
    const counts = scopedCounts(countsByBand);
    // Buffer until the style (and the amenities source) exist — an amenity
    // response can land before `load`, exactly like the isochrone.
    if (!loadState.styleLoaded) {
      loadState.pendingAmenities = { items, countsByBand };
      setAmenity({ status: "ready", counts, countsByBand, items });
      return;
    }
    const visibleItems = writeVisibleAmenities(items, selectedCategoriesRef.current);
    el.dataset.amenityCount = String(visibleItems.length);
    setAmenity({ status: "ready", counts, countsByBand, items });
  }

  function applyAmenitySelection(categories: AmenityCategoryKey[]) {
    if (amenityRef.current.status !== "ready") return;
    let visibleItems = filterAmenityItems(amenityRef.current.items, categories, "", visibleBands());
    if (loadState.styleLoaded) {
      // Recluster, not just re-filter — see writeVisibleAmenities. This also
      // drops hover + popup affordances for a now-hidden category.
      visibleItems = writeVisibleAmenities(amenityRef.current.items, categories);
    }
    el.dataset.amenityCount = String(visibleItems.length);
    const popupCategory = getPopupCategory();
    if (popupCategory && !categories.includes(popupCategory)) closeStopPopup();
    closePopupOutsideVisibleBands();
  }

  /**
   * Re-apply amenity visibility after a RING-FILTER change (task 065).
   *
   * Goes through the same recluster chokepoint as a category toggle — never a layer
   * filter — so the donut totals, the chips and `data-amenity-count` all move
   * together. No refetch: every band came in one response.
   */
  /** Close an open POI popup whose place sits in a band that is no longer shaded. Without
   * this, `All → inspect an outer-band place → narrow to 15 min` leaves a popup describing
   * somewhere outside the visible area — the same "shown thing is outside the shading"
   * inconsistency the band filter exists to prevent. */
  function closePopupOutsideVisibleBands() {
    const band = getPopupBand();
    if (band === null) return;
    if (!visibleBands().includes(band as never)) closeStopPopup();
  }

  function applyRingFilterToAmenities() {
    const current = amenityRef.current;
    if (current.status !== "ready" || !current.countsByBand) return;
    const visibleItems = loadState.styleLoaded
      ? writeVisibleAmenities(current.items, selectedCategoriesRef.current)
      : filterAmenityItems(current.items, selectedCategoriesRef.current, "", visibleBands());
    el.dataset.amenityCount = String(visibleItems.length);
    // Chips must shrink with the shading, or they claim places outside the rings.
    setAmenity({ ...current, counts: scopedCounts(current.countsByBand) });
    closePopupOutsideVisibleBands();
  }

  // Drop amenity markers/counts and supersede any in-flight fetch or pending retry.
  // Called on a genuinely-new selection AND on any key-changing recompute — a mode or
  // crowded/quiet change included, since task 065 made the clip mode-dependent so those
  // markers describe an area the user is no longer looking at. (It used to say "NOT on a
  // mode toggle (which must persist)", which is the retired contract.)
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
    setAmenity({ status: "idle", counts: null, countsByBand: null, items: [] });
  }

  // One amenity fetch attempt. On a transient failure the first attempt schedules
  // ONE delayed retry, staying in "loading" so the user never sees an error that
  // would self-heal. Any failure that DOES surface clears the origin key — an
  // error must never pin the key, or the review's Retry button and a mode-toggle
  // recompute would be swallowed by the isNewAmenityOrigin guard.
  function fetchAmenities(
    origin: Origin,
    attempt: number,
    pace: Pace,
    mode: Mode,
    timeContext: TimeContext,
  ) {
    key = amenityKey(origin, pace, mode, timeContext);
    amenityOriginRef.current = origin;
    const reqGen = (gen += 1);
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    setAmenity({ status: "loading", counts: null, countsByBand: null, items: [] });

    const failWith = (httpStatus: number | null) => {
      if (classifyAmenityFailure(httpStatus, attempt) === "retry") {
        retryTimer = setTimeout(() => {
          if (reqGen !== gen) return; // superseded meanwhile
          fetchAmenities(origin, attempt + 1, pace, mode, timeContext);
        }, AMENITY_RETRY_DELAY_MS);
        return;
      }
      // A surfaced error clears the origin key so Retry / a toggle recompute can
      // refetch the same origin (an error must never pin the key).
      key = null;
      setAmenity({ status: "error", counts: null, countsByBand: null, items: [] });
    };

    // `mode` is REQUIRED by the route (task 065): a missing one is a 400, never a
    // silent walk clip. `preset` rides along in every mode so the server resolves the
    // same departure/traffic context the rings were drawn at.
    fetch(
      `/api/amenities?lat=${origin.lat}&lng=${origin.lng}&pace=${pace}&mode=${mode}&preset=${timeContext.preset}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        if (reqGen !== gen) return;
        if (!res.ok) return void failWith(res.status);
        const data = (await res.json()) as {
          amenities?: unknown;
          countsByBand?: unknown;
        };
        if (reqGen !== gen) return;
        // A valid-but-wrong-shape body (no array) is an error, not "no
        // amenities" — and deterministic, so it reports the real (non-5xx)
        // status and is never auto-retried.
        if (!Array.isArray(data.amenities)) return void failWith(res.status);
        // Per-band totals are REQUIRED now, and a missing/malformed block is an error
        // rather than something to paper over. The old code fell back to recounting the
        // returned rows, which would silently turn a stale or wrong-shaped payload into
        // chips that undercount every capped category — precisely the kind of quiet lie
        // this task exists to remove. Deterministic, so it is never auto-retried.
        if (!isCountsByBand(data.countsByBand)) return void failWith(res.status);
        const items = data.amenities as Amenity[];
        // Every row must carry a legal band. Band visibility is what keeps markers inside
        // the shaded area, so a row without one would be drawn under EVERY ring filter —
        // including out beyond the shading, which the server-side clip is careful to
        // prevent. The server always sends it (`band` is
        // required on `CatalogueAmenity`), so a missing one means a stale or malformed
        // payload: deterministic, and reported rather than rendered.
        if (!items.every((a) => LEGEND_BANDS.includes(a.band as never))) {
          return void failWith(res.status);
        }
        renderAmenities(items, data.countsByBand);
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError" || reqGen !== gen) return;
        failWith(null);
      });
  }

  // Fetch amenities for a resolved origin, in parallel with the isochrone.
  //
  // Task 065 inverted the old rule. The clip is the CURRENT mode's reach area at the
  // CURRENT departure context, so a mode toggle or a crowded/quiet change genuinely
  // changes which places are in range and MUST refetch — where previously they were
  // deliberately persisted. A ring-filter change still does not refetch: all three
  // bands come in one response and visibility is applied client-side. A failure
  // cleared the key, so the same selection can refetch.
  function maybeFetchAmenities(
    origin: Origin,
    pace: Pace,
    mode: Mode,
    timeContext: TimeContext,
  ) {
    const nextKey = amenityKey(origin, pace, mode, timeContext);
    if (!isNewAmenityOrigin(key, nextKey)) return;
    // A key-changing fetch replaces a marker set that described a DIFFERENT area, so
    // the old markers must go now rather than linger over the new shading while the
    // request is in flight (and stay forever if it fails).
    clearAmenities();
    fetchAmenities(origin, 0, pace, mode, timeContext);
  }

  return {
    /** Re-apply the layer filter (used when the absorbed-pin set changes). */
    reapplyFilter: () => applyAmenityLayerFilter(selectedCategoriesRef.current),
    renderAmenities,
    applyAmenitySelection,
    applyRingFilterToAmenities,
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
