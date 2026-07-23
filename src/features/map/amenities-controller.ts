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
}) {
  let abort: AbortController | null = null;
  let gen = 0;
  let key: string | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  // `counts` are the server's TRUE clipped totals (may exceed the rendered
  // marker count when a category was capped) — the chips show these, not a
  // recount of the capped markers. Features are written once for the full
  // payload; category tiles drive MapLibre `setFilter` (markers + glyphs) AND
  // the browser list via the same selection array.
  function applyAmenityLayerFilter(categories: AmenityCategoryKey[]) {
    if (!loadState.styleLoaded || !map.getLayer("amenity-markers")) return;
    const filter = amenityMapCategoryFilter(categories) as maplibregl.FilterSpecification | null;
    map.setFilter("amenity-markers", filter);
    if (map.getLayer("amenity-glyphs")) map.setFilter("amenity-glyphs", filter);
  }

  function renderAmenities(items: Amenity[], counts: AmenityCounts) {
    // Buffer until the style (and the amenities source) exist — an amenity
    // response can land before `load`, exactly like the isochrone.
    if (!loadState.styleLoaded) {
      loadState.pendingAmenities = { items, counts };
      setAmenity({ status: "ready", counts, items });
      return;
    }
    const categories = selectedCategoriesRef.current;
    const visibleItems = filterAmenityItems(items, categories);
    resetAmenityHover(); // generated ids are about to be reassigned
    (map.getSource("amenities") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      // Full set — visibility is layer filter, not data rebuild.
      features: buildAmenityFeatures(items) as GeoJSON.Feature[],
    });
    applyAmenityLayerFilter(categories);
    el.dataset.amenityCount = String(visibleItems.length);
    setAmenity({ status: "ready", counts, items });
  }

  function applyAmenitySelection(categories: AmenityCategoryKey[]) {
    if (amenityRef.current.status !== "ready") return;
    const visibleItems = filterAmenityItems(amenityRef.current.items, categories);
    if (loadState.styleLoaded) {
      // Filters do not reassign generateId the way setData does, but a hidden
      // category must still drop hover + popup affordances.
      applyAmenityLayerFilter(categories);
      resetAmenityHover();
    }
    el.dataset.amenityCount = String(visibleItems.length);
    const popupCategory = getPopupCategory();
    if (popupCategory && !categories.includes(popupCategory)) closeStopPopup();
  }

  // Drop amenity markers/counts and supersede any in-flight fetch or pending
  // retry. Called only on a genuinely-new selection — NOT on a mode toggle
  // (which must persist).
  function clearAmenities() {
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
    delete el.dataset.amenityCount;
    setAmenity({ status: "idle", counts: null, items: [] });
  }

  // One amenity fetch attempt. On a transient failure the first attempt schedules
  // ONE delayed retry, staying in "loading" so the user never sees an error that
  // would self-heal. Any failure that DOES surface clears the origin key — an
  // error must never pin the key, or the panel's Retry button and a mode-toggle
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
    renderAmenities,
    applyAmenitySelection,
    clearAmenities,
    fetchAmenities,
    maybeFetchAmenities,
    dispose() {
      abort?.abort();
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}

export type AmenitiesController = ReturnType<typeof createAmenitiesController>;
