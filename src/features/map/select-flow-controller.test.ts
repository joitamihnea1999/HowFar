import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSelectFlowController } from "@/features/map/select-flow-controller";
import {
  initialSelectionState,
  selectionReducer,
  type Mode,
  type SelectionState,
} from "@/features/map/selection-flow";

/**
 * Unit coverage for the selection orchestrator — pure over injected callbacks +
 * fetch (no MapLibre), so its moved must-not-regress invariants are tested
 * directly rather than only via e2e: mode frozen at entry (plan round-2 grok#5),
 * reverse-422-fatal → no rings/amenities, isochrone-fail → clearAmenities,
 * and stale-token drops.
 */

type FetchImpl = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
let fetchImpl: FetchImpl;
const fetchedUrls: string[] = [];

function res(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function makeHarness(startMode: Mode = "walk") {
  const selRef = { current: { ...initialSelectionState, mode: startMode } as SelectionState };
  const dispatched: Array<{ type: string; stage?: string }> = [];
  const dispatchSel = (action: Parameters<typeof selectionReducer>[1]) => {
    dispatched.push(action as { type: string; stage?: string });
    selRef.current = selectionReducer(selRef.current, action);
    return selRef.current;
  };
  const clearSelection = vi.fn();
  const clearAmenities = vi.fn();
  const maybeFetchAmenities = vi.fn();
  const renderSelection = vi.fn();
  const pendingInputRef = { current: null };
  const controller = createSelectFlowController({
    dispatchSel,
    selRef,
    pendingInputRef,
    abortRef: { current: null },
    clearSelection,
    clearAmenities,
    maybeFetchAmenities,
    renderSelection,
  });
  return { controller, selRef, dispatched, clearSelection, clearAmenities, maybeFetchAmenities, renderSelection };
}

beforeEach(() => {
  fetchedUrls.length = 0;
  fetchImpl = (url) => {
    fetchedUrls.push(url);
    return res(200, { origin: { lat: 44.4, lng: 26.1 }, rings: [] });
  };
  vi.stubGlobal("fetch", (url: string) => fetchImpl(url));
});

afterEach(() => vi.restoreAllMocks());

describe("select() — mode frozen at entry", () => {
  it("uses the entry mode for the endpoint AND renderSelection even if selRef.mode mutates mid-flight", async () => {
    const h = makeHarness("walk");
    let resolveIso: () => void = () => {};
    fetchImpl = (url) => {
      fetchedUrls.push(url);
      return new Promise((r) => {
        resolveIso = () => r({ ok: true, status: 200, json: async () => ({ origin: { lat: 44.4, lng: 26.1 }, rings: [] }) });
      });
    };

    const run = h.controller.select({ kind: "point", lat: 44.4, lng: 26.1, label: "X" });
    // Mutate the live mode WITHOUT bumping the token (not a real dispatch) — the
    // captured `const mode` must be immune.
    h.selRef.current = { ...h.selRef.current, mode: "transit" };
    resolveIso();
    await run;

    expect(fetchedUrls.some((u) => u.startsWith("/api/isochrone"))).toBe(true); // walk endpoint
    expect(fetchedUrls.some((u) => u.startsWith("/api/transit"))).toBe(false);
    expect(h.renderSelection).toHaveBeenCalledTimes(1);
    expect(h.renderSelection.mock.calls[0][3]).toBe("walk"); // 4th arg = mode
  });

  it("a fresh select reads the current mode at its own entry", async () => {
    const h = makeHarness("transit");
    await h.controller.select({ kind: "point", lat: 44.4, lng: 26.1, label: "X" });
    expect(fetchedUrls.some((u) => u.startsWith("/api/transit"))).toBe(true);
    expect(h.renderSelection.mock.calls[0][3]).toBe("transit");
  });
});

describe("select() — invariants", () => {
  it("reverse 422 is fatal: no rings, no amenities (click path)", async () => {
    const h = makeHarness();
    fetchImpl = (url) => {
      fetchedUrls.push(url);
      if (url.startsWith("/api/reverse")) return res(422, {});
      return res(200, { origin: { lat: 44.4, lng: 26.1 }, rings: [] });
    };
    await h.controller.select({ kind: "click", lat: 44.4, lng: 26.1 });
    expect(h.renderSelection).not.toHaveBeenCalled();
    expect(h.maybeFetchAmenities).not.toHaveBeenCalled();
    expect(h.clearAmenities).toHaveBeenCalled();
    expect(h.dispatched.some((a) => a.type === "failed" && a.stage === "reverse")).toBe(true);
  });

  it("a failed isochrone clears amenities and never renders rings", async () => {
    const h = makeHarness();
    fetchImpl = (url) => {
      fetchedUrls.push(url);
      return res(500, {});
    };
    await h.controller.select({ kind: "point", lat: 44.4, lng: 26.1, label: "X" });
    expect(h.renderSelection).not.toHaveBeenCalled();
    expect(h.clearAmenities).toHaveBeenCalled();
    expect(h.dispatched.some((a) => a.type === "failed" && a.stage === "isochrone")).toBe(true);
  });

  it("search path: geocode → isochrone → render + amenities in parallel", async () => {
    const h = makeHarness();
    fetchImpl = (url) => {
      fetchedUrls.push(url);
      if (url.startsWith("/api/geocode")) return res(200, { lat: 44.5, lng: 26.2, label: "Str. Foo" });
      return res(200, { origin: { lat: 44.5, lng: 26.2 }, rings: [] });
    };
    await h.controller.select({ kind: "search", query: "foo" });
    expect(h.maybeFetchAmenities).toHaveBeenCalledTimes(1);
    expect(h.renderSelection).toHaveBeenCalledTimes(1);
    expect(h.renderSelection.mock.calls[0][1]).toBe("Str. Foo"); // 2nd arg = label
  });

  it("search path: a failed geocode reports failed(geocode) and never renders", async () => {
    const h = makeHarness();
    fetchImpl = (url) => {
      fetchedUrls.push(url);
      return res(500, {});
    };
    await h.controller.select({ kind: "search", query: "foo" });
    expect(h.renderSelection).not.toHaveBeenCalled();
    expect(h.dispatched.some((a) => a.type === "failed" && a.stage === "geocode")).toBe(true);
  });

  it("click path: a non-fatal reverse supplies the human label and fetches amenities", async () => {
    const h = makeHarness();
    fetchImpl = (url) => {
      fetchedUrls.push(url);
      if (url.startsWith("/api/reverse")) return res(200, { label: "Piața Unirii" });
      return res(200, { origin: { lat: 44.4, lng: 26.1 }, rings: [] });
    };
    await h.controller.select({ kind: "click", lat: 44.4, lng: 26.1 });
    expect(h.maybeFetchAmenities).toHaveBeenCalledTimes(1);
    expect(h.renderSelection).toHaveBeenCalledTimes(1);
    expect(h.renderSelection.mock.calls[0][1]).toBe("Piața Unirii");
  });

  it("click path: a non-fatal but failed reverse (500) keeps the fallback and still paints rings", async () => {
    const h = makeHarness();
    fetchImpl = (url) => {
      fetchedUrls.push(url);
      if (url.startsWith("/api/reverse")) return res(500, {}); // not ok, not 422 → not fatal
      return res(200, { origin: { lat: 44.4, lng: 26.1 }, rings: [] });
    };
    await h.controller.select({ kind: "click", lat: 44.4, lng: 26.1 });
    expect(h.renderSelection).toHaveBeenCalledTimes(1);
    expect(h.renderSelection.mock.calls[0][1]).toBe("Selected point");
    expect(h.maybeFetchAmenities).toHaveBeenCalledTimes(1);
  });

  it("click path: a reverse with a blank label keeps the 'Selected point' fallback", async () => {
    const h = makeHarness();
    fetchImpl = (url) => {
      fetchedUrls.push(url);
      if (url.startsWith("/api/reverse")) return res(200, { label: "   " }); // blank → ignored
      return res(200, { origin: { lat: 44.4, lng: 26.1 }, rings: [] });
    };
    await h.controller.select({ kind: "click", lat: 44.4, lng: 26.1 });
    expect(h.renderSelection.mock.calls[0][1]).toBe("Selected point");
  });

  it("click path: a malformed reverse body still renders with the fallback label", async () => {
    const h = makeHarness();
    fetchImpl = (url) => {
      fetchedUrls.push(url);
      if (url.startsWith("/api/reverse")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } });
      }
      return res(200, { origin: { lat: 44.4, lng: 26.1 }, rings: [] });
    };
    await h.controller.select({ kind: "click", lat: 44.4, lng: 26.1 });
    expect(h.renderSelection).toHaveBeenCalledTimes(1);
    expect(h.renderSelection.mock.calls[0][1]).toBe("Selected point");
  });

  it("a thrown fetch (network crash) clears amenities and dispatches crash", async () => {
    const h = makeHarness();
    fetchImpl = () => Promise.reject(new TypeError("network down"));
    await h.controller.select({ kind: "point", lat: 44.4, lng: 26.1, label: "X" });
    expect(h.renderSelection).not.toHaveBeenCalled();
    expect(h.clearAmenities).toHaveBeenCalled();
    expect(h.dispatched.some((a) => a.type === "crash")).toBe(true);
  });

  it("drops a superseded run: a newer selection bumped the token mid-flight", async () => {
    const h = makeHarness();
    let resolveIso: () => void = () => {};
    fetchImpl = () =>
      new Promise((r) => {
        resolveIso = () => r({ ok: true, status: 200, json: async () => ({ origin: { lat: 44.4, lng: 26.1 }, rings: [] }) });
      });
    const run = h.controller.select({ kind: "point", lat: 44.4, lng: 26.1, label: "X" });
    // A new selection starts (bumps the token) while the first is awaiting.
    h.selRef.current = selectionReducer(h.selRef.current, { type: "start", mode: "walk" });
    resolveIso();
    await run;
    expect(h.renderSelection).not.toHaveBeenCalled(); // stale run must not paint
  });
});
