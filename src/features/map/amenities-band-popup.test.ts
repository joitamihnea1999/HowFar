import { describe, expect, it, vi } from "vitest";

import type { AmenityCategoryKey } from "@/features/amenities/amenities";
import type { RingFilter } from "@/features/isochrones/bands";
import { createAmenitiesController, type AmenityUi } from "@/features/map/amenities-controller";
import { createLoadState } from "@/features/map/load-state";

/**
 * Narrowing the ring filter must close a popup whose place is no longer shaded (task 065).
 *
 * Asserted PER PATH rather than generically, because the first version of this feature set
 * the band only on the POI path: a transit-stop popup — the category most likely to sit far
 * out, and the one that matters most in transit mode — stayed open over unshaded map. A
 * single generic test would not have distinguished the paths.
 */

const READY: AmenityUi = { status: "ready", counts: null, countsByBand: null, items: [] };

function harness(opts: { band: number | null; filter: RingFilter }) {
  const closeStopPopup = vi.fn();
  const controller = createAmenitiesController({
    map: { getSource: () => undefined } as never,
    el: { dataset: {} } as unknown as HTMLElement,
    loadState: createLoadState(),
    setAmenity: vi.fn(),
    amenityRef: { current: READY },
    amenityOriginRef: { current: null },
    selectedCategoriesRef: { current: [] as AmenityCategoryKey[] },
    clustersRef: { current: null },
    invalidateClusters: vi.fn(),
    ringFilterRef: { current: opts.filter },
    resetAmenityHover: vi.fn(),
    getPopupCategory: () => null,
    getPopupBand: () => opts.band,
    closeStopPopup,
    closeSpider: vi.fn(),
  });
  return { controller, closeStopPopup };
}

describe("ring filter closes a popup for a place that is no longer shaded", () => {
  it("closes a popup whose band falls outside the visible bands", () => {
    // Filter 15 shades only the inner band, so a popup for a band-45 place describes
    // somewhere the map is no longer claiming to show.
    const { controller, closeStopPopup } = harness({ band: 45, filter: 15 });
    controller.applyAmenitySelection([]);
    expect(closeStopPopup).toHaveBeenCalled();
  });

  it("KEEPS a popup whose band is still shaded — cumulatively", () => {
    // Filter 30 shades bands 15 AND 30 (ring polygons are nested, not annuli), so a
    // band-15 popup must survive. A non-cumulative reading would wrongly close it.
    const { controller, closeStopPopup } = harness({ band: 15, filter: 30 });
    controller.applyAmenitySelection([]);
    expect(closeStopPopup).not.toHaveBeenCalled();
  });

  it("keeps every popup at the widest filter", () => {
    const { controller, closeStopPopup } = harness({ band: 45, filter: "all" });
    controller.applyAmenitySelection([]);
    expect(closeStopPopup).not.toHaveBeenCalled();
  });

  it("does nothing when no popup is open (band null)", () => {
    // Clusters span bands and report null; that must not trigger a close.
    const { controller, closeStopPopup } = harness({ band: null, filter: 15 });
    controller.applyAmenitySelection([]);
    expect(closeStopPopup).not.toHaveBeenCalled();
  });
});
