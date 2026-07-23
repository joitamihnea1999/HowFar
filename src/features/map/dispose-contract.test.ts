import { afterEach, describe, expect, it, vi } from "vitest";

import { initialComboboxState, type ComboboxState } from "@/features/search/combobox";
import { createSearchSuggestController } from "@/features/search/search-suggest-controller";
import { createAmenitiesController } from "@/features/map/amenities-controller";
import { createHoverController } from "@/features/map/hover-controller";
import { createLoadState } from "@/features/map/load-state";
import { createRoutePathController } from "@/features/map/route-path-controller";

/**
 * Verification path for the dispose contract (plan panel round-2 grok#3/#4,
 * opus#3): a disposed controller must leave NO async work that can fire against
 * a torn-down map. The full reverse-order + map.remove()-last sequencing is
 * enforced structurally in AppMap's two-phase effect cleanup; these tests pin
 * the per-controller "post-dispose no-op" for the ones that own a timer / abort
 * / animation frame, which is where a real late-write leak would originate.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("search-suggest-controller dispose", () => {
  const fetchableState: ComboboxState = { ...initialComboboxState, query: "cafeteria", generation: 7 };

  it("aborts the in-flight suggest fetch on dispose (no late reducer dispatch)", () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, opts: { signal: AbortSignal }) => {
      capturedSignal = opts.signal;
      return new Promise<Response>(() => {}); // never resolves — simulates in-flight
    });
    vi.stubGlobal("fetch", fetchMock);

    const dispatchCombo = vi.fn(() => fetchableState);
    const controller = createSearchSuggestController({
      comboRef: { current: fetchableState },
      dispatchCombo,
      debounceMs: 250,
    });

    controller.schedule(fetchableState);
    vi.advanceTimersByTime(250); // fire the debounced runSuggest → issues the fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    controller.dispose();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("cancels the pending debounce timer on dispose (no fetch after unmount)", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const controller = createSearchSuggestController({
      comboRef: { current: fetchableState },
      dispatchCombo: vi.fn(() => fetchableState),
      debounceMs: 250,
    });

    controller.schedule(fetchableState); // arm the timer…
    controller.dispose(); // …then dispose before it fires
    vi.advanceTimersByTime(1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("amenities-controller dispose", () => {
  it("aborts the in-flight amenity fetch on dispose", () => {
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_url: string, opts: { signal: AbortSignal }) => {
      capturedSignal = opts.signal;
      return new Promise<Response>(() => {});
    });
    const controller = createAmenitiesController({
      map: { getSource: () => undefined } as never,
      el: { dataset: {} } as unknown as HTMLElement,
      loadState: createLoadState(),
      setAmenity: vi.fn(),
      amenityRef: { current: { status: "idle", counts: null, items: [] } },
      amenityOriginRef: { current: null },
      selectedCategoriesRef: { current: [] },
      resetAmenityHover: vi.fn(),
      getPopupCategory: () => null,
      closeStopPopup: vi.fn(),
    });
    controller.fetchAmenities({ lat: 44.4, lng: 26.1 }, 0, "normal");
    expect(capturedSignal?.aborted).toBe(false);
    controller.dispose();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("route-path-controller dispose", () => {
  it("aborts the in-flight route-path fetch on dispose", () => {
    vi.useFakeTimers(); // toggleRoutePath arms a 9s client-deadline timer
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_url: string, opts: { signal: AbortSignal }) => {
      capturedSignal = opts.signal;
      return new Promise<Response>(() => {});
    });
    const controller = createRoutePathController({
      map: { getSource: () => undefined } as never,
      el: { dataset: {} } as unknown as HTMLElement,
      loadState: createLoadState(), // styleLoaded false → clearRoutePath skips setData
      reducedMotion: { matches: true } as MediaQueryList,
      applyCameraPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    });
    const button = { classList: { add() {}, remove() {} } } as unknown as HTMLButtonElement;
    controller.toggleRoutePath(1776396, button, [26.1, 44.4]);
    expect(capturedSignal?.aborted).toBe(false);
    controller.dispose();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("hover-controller dispose", () => {
  it("cancels a queued hover animation frame (no pick work after dispose)", () => {
    let queued: FrameRequestCallback | null = null;
    let queuedId = 0;
    const cancelled: number[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queued = cb;
      return ++queuedId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => cancelled.push(id));

    const queryRenderedFeatures = vi.fn(() => []);
    const fakeMap = { queryRenderedFeatures } as unknown as Parameters<
      typeof createHoverController
    >[0]["map"];

    const hover = createHoverController({
      map: fakeMap,
      el: { dataset: {} } as unknown as HTMLElement,
      loadState: createLoadState(),
    });

    hover.scheduleAmenityHover({ x: 10, y: 10 } as never); // arms one rAF
    expect(queued).not.toBeNull();

    hover.dispose(); // must cancel the queued frame
    expect(cancelled).toContain(queuedId);

    // Even if a stale frame somehow fired after dispose, the map is never queried
    // (styleLoaded is false here anyway) — the pick work must not run.
    expect(queryRenderedFeatures).not.toHaveBeenCalled();
  });
});
