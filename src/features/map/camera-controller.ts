import type maplibregl from "maplibre-gl";

import { cameraPadding } from "@/features/map/camera";
import type { EdgeInsets } from "@/features/map/route-framing";

/**
 * Owns the map's permanent edge padding (task 024/027): the insets that keep a
 * selection centred in the map area the docks don't cover. Split out of `AppMap`
 * as the first leaf controller — it depends only on the map and its container.
 * `cameraPadding` (the pure size→inset math) stays unit-tested in `camera.ts`;
 * this glue commits it to MapLibre and stamps the read-back attributes the e2e
 * suite asserts. No timers/listeners, so `dispose` is a no-op (kept for the
 * uniform factory contract).
 */
export function createCameraController({
  map,
  el,
}: {
  map: maplibregl.Map;
  el: HTMLElement;
}) {
  function applyCameraPadding(hasResults: boolean): EdgeInsets {
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

  return {
    applyCameraPadding,
    dispose() {},
  };
}

export type CameraController = ReturnType<typeof createCameraController>;
