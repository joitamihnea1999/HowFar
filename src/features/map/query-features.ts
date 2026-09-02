import type maplibregl from "maplibre-gl";

/**
 * `map.queryRenderedFeatures` can throw `feature index out of bounds` when it is
 * called while a GeoJSON source is mid-`setData` swap — the render feature index
 * and the source data momentarily disagree, and MapLibre indexes past the end.
 * EVERY hit-test caller races that swap (amenity hover/pick, the drawn route
 * path, the drawn reach journey), so they all go through this guard: a throw
 * means "nothing under the point right now", never a crash.
 *
 * Task 018 — the owner saw repeated `Uncaught Error: feature index out of bounds`
 * from the hover pick (`hover-controller.ts`) racing the amenity-source swap; the
 * click path (`pickAmenitiesAt`) already caught it, but the sibling hit-tests did
 * not. This is the single shared guard so the whole class stays fixed.
 */
export function safeQueryRenderedFeatures(
  map: maplibregl.Map,
  geometry: [maplibregl.PointLike, maplibregl.PointLike],
  options: { layers?: string[] },
): maplibregl.MapGeoJSONFeature[] {
  try {
    return map.queryRenderedFeatures(geometry, options);
  } catch {
    return [];
  }
}

/**
 * Fail-CLOSED variant for a CLICK GUARD — "is a feature under the point, so this
 * click should be SWALLOWED (skip starting a new selection)?" On a source-swap
 * throw, return `true`: an indeterminate result must NOT let the click fall
 * through and reset the user's selection (task 018 — returning `[]` here would
 * be fail-open and silently drop the selection). Distinct from
 * `safeQueryRenderedFeatures`, whose `[]`-on-throw is correct for hover/pick
 * (nothing highlighted), but wrong as a guard predicate.
 */
export function hitTestHasFeature(
  map: maplibregl.Map,
  geometry: [maplibregl.PointLike, maplibregl.PointLike],
  options: { layers?: string[] },
): boolean {
  try {
    return map.queryRenderedFeatures(geometry, options).length > 0;
  } catch {
    return true;
  }
}

/**
 * Click-GUARD hit-test — "is the drawn route/journey under the point, so this
 * click should be swallowed?" — that fails CLOSED two ways: (1) filters the
 * layer ids through `getLayer`, and if NONE resolve yet (a mid-style-reload
 * race) returns `true` — MapLibre returns `[]` for unknown ids WITHOUT throwing,
 * so an indeterminate "no layers" state must still swallow the click rather than
 * fall through to a selection reset; (2) delegates to `hitTestHasFeature`, which
 * returns `true` on a source-swap throw. One shape shared by the route-path and
 * reach-journey guards (task 018 G5/H5, rule 5).
 */
export function activeGuardHasFeature(
  map: maplibregl.Map,
  geometry: [maplibregl.PointLike, maplibregl.PointLike],
  layerIds: string[],
): boolean {
  const layers = layerIds.filter((id) => map.getLayer(id));
  if (layers.length === 0) return true;
  return hitTestHasFeature(map, geometry, { layers });
}

/**
 * `map.querySourceFeatures` throws the SAME `feature index out of bounds` mid a
 * source `setData` swap as `queryRenderedFeatures` does. The rAF stamp polls
 * (`route-path` / `reach-path`) call it every frame on the very source they just
 * swapped, so an unguarded throw is an Uncaught Error in a rAF callback (the
 * owner's reported symptom) that also strands the poll. Returns `[]` on a throw —
 * the caller re-polls next frame once the swap settles (task 018).
 */
export function safeQuerySourceFeatures(
  map: maplibregl.Map,
  sourceId: string,
  params?: Parameters<maplibregl.Map["querySourceFeatures"]>[1],
): ReturnType<maplibregl.Map["querySourceFeatures"]> {
  try {
    return map.querySourceFeatures(sourceId, params);
  } catch {
    return [];
  }
}
