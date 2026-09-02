import { describe, expect, it, vi } from "vitest";
import type maplibregl from "maplibre-gl";

import { createHoverController } from "@/features/map/hover-controller";
import { createLoadState } from "@/features/map/load-state";

/**
 * The hover pick (`pickAmenity`) hit-tests the amenity source every frame, which
 * races the amenity-source `setData` swap: MapLibre can throw
 * `feature index out of bounds` when the render index and the source data
 * momentarily disagree (task 018 — the owner saw this repeatedly in the console).
 * The pick must degrade to "nothing under the cursor", never crash.
 */
function makeHover(queryImpl: () => maplibregl.MapGeoJSONFeature[]) {
  const loadState = createLoadState();
  loadState.styleLoaded = true;
  const map = {
    getZoom: () => 14,
    queryRenderedFeatures: vi.fn(queryImpl),
    project: () => ({ x: 0, y: 0 }),
    getCanvas: () => ({ style: {} }),
  } as unknown as maplibregl.Map;
  const el = { dataset: {} } as unknown as HTMLElement;
  return createHoverController({ map, el, loadState });
}

describe("hover-controller pickAmenity race guard", () => {
  it("returns null (does not throw) when queryRenderedFeatures throws mid source-swap", () => {
    const hover = makeHover(() => {
      throw new Error("feature index out of bounds");
    });
    expect(hover.pickAmenity({ x: 10, y: 10 } as never)).toBeNull();
  });

  it("returns null when no features are under the point", () => {
    const hover = makeHover(() => []);
    expect(hover.pickAmenity({ x: 10, y: 10 } as never)).toBeNull();
  });
});
