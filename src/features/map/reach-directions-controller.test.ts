import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReachDirectionsController, type ReachView } from "@/features/map/reach-directions-controller";

// A minimal fake journey controller recording the calls the directions
// controller drives (draw/declutter/frame/pin/highlight/clear).
function fakeJourney() {
  return {
    draw: vi.fn(() => true),
    clear: vi.fn(),
    setDestination: vi.fn(),
    highlight: vi.fn(),
    frame: vi.fn(),
    hitsActiveJourney: vi.fn(() => false),
    flushPending: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeController(overrides?: { drawReturns?: boolean }) {
  // A plain stand-in for the map container: the controller only reads/writes
  // `el.dataset.reachState`, so this avoids needing a jsdom environment.
  const el = { dataset: {} as Record<string, string | undefined> };
  const journey = fakeJourney();
  if (overrides?.drawReturns !== undefined) journey.draw.mockReturnValue(overrides.drawReturns);
  const reachDeclutter = { set: vi.fn() };
  const applyCameraPadding = vi.fn(() => ({ top: 0, right: 0, bottom: 0, left: 0 }));
  const closeStopPopup = vi.fn();
  const views: (ReachView | null)[] = [];
  const controller = createReachDirectionsController({
    el: el as never,
    journey: journey as never,
    reachDeclutter,
    applyCameraPadding,
    closeStopPopup,
  });
  controller.subscribe((v) => views.push(v));
  return { el, journey, reachDeclutter, applyCameraPadding, closeStopPopup, controller, views };
}

const reachablePlan = {
  reachable: true,
  totalMinutes: 25,
  transfers: 1,
  legs: [
    { mode: "WALK", line: "", headsign: "", fromName: "START", toName: "Stop A", minutes: 5 },
    { mode: "BUS", line: "123", headsign: "North", fromName: "Stop A", toName: "Stop B", minutes: 20 },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("reach-directions-controller — synchronous views + destination pin", () => {
  it("hint: no destination pin, hint view + stamp, isActive flips true→false on close", () => {
    const { controller, journey, el, views } = makeController();
    expect(controller.isActive()).toBe(false);
    controller.open({ kind: "hint", coords: [26.1, 44.4] });
    expect(journey.setDestination).toHaveBeenCalledWith(null);
    expect(views.at(-1)?.state).toBe("hint");
    expect(el.dataset.reachState).toBe("hint");
    expect(controller.isActive()).toBe(true);
    controller.close();
    expect(controller.isActive()).toBe(false);
  });

  it("walk: drops a destination pin and shows the band copy", () => {
    const { controller, journey, views } = makeController();
    controller.open({ kind: "walk", coords: [26.1, 44.4], band: 15 });
    expect(journey.setDestination).toHaveBeenCalledWith([26.1, 44.4]);
    expect(views.at(-1)?.state).toBe("walk");
    expect(views.at(-1)?.title).toBe("On foot");
  });

  it("car: names the assumed traffic slot from carMeta", () => {
    const { controller, views } = makeController();
    controller.open({ kind: "car", coords: [26.1, 44.4], band: 20, carMeta: { basis: "estimate", slotId: "am-peak", slotLabel: "weekday morning rush" } });
    expect(views.at(-1)?.state).toBe("car");
    expect(views.at(-1)?.detail).toContain("weekday morning rush");
  });

  it("transit-unreachable: 'Beyond your reach', NO fetch", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { controller, views } = makeController();
    controller.open({ kind: "transit-unreachable", coords: [26.1, 44.4] });
    expect(views.at(-1)?.state).toBe("none");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("reach-directions-controller — mutual exclusivity", () => {
  it("open() always closes the stop/POI popup first (arbiter)", () => {
    const { controller, closeStopPopup } = makeController();
    controller.open({ kind: "walk", coords: [26.1, 44.4], band: 15 });
    expect(closeStopPopup).toHaveBeenCalledTimes(1);
    controller.open({ kind: "hint", coords: [26.1, 44.4] });
    expect(closeStopPopup).toHaveBeenCalledTimes(2);
  });

  it("open() self-invalidates the prior journey even when closeStopPopup is a no-op (panel opus-1/grok-5)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(reachablePlan) })) as never);
    const { controller, journey } = makeController({ drawReturns: true });
    controller.open({ kind: "transit", coords: [26.1, 44.4], band: 30, url: "/api/reach?x=1" });
    await vi.waitFor(() => expect(journey.draw).toHaveBeenCalled());
    journey.clear.mockClear();
    // The injected closeStopPopup is a bare no-op spy (does NOT call close()), so
    // the only thing that can tear down the previous drawn journey is open()'s
    // own invalidation — proves it no longer relies on the arbiter side-effect.
    controller.open({ kind: "walk", coords: [26.2, 44.5], band: 15 });
    expect(journey.clear).toHaveBeenCalled();
  });

  it("close() tears down journey + declutter + view, does NOT touch the popup", () => {
    const { controller, journey, reachDeclutter, closeStopPopup, el, views } = makeController();
    controller.open({ kind: "walk", coords: [26.1, 44.4], band: 15 });
    closeStopPopup.mockClear();
    controller.close();
    expect(journey.clear).toHaveBeenCalled();
    expect(reachDeclutter.set).toHaveBeenLastCalledWith(false);
    expect(views.at(-1)).toBeNull();
    expect(el.dataset.reachState).toBeUndefined();
    expect(closeStopPopup).not.toHaveBeenCalled();
    expect(controller.isActive()).toBe(false);
  });
});

describe("reach-directions-controller — transit fetch", () => {
  it("draws + declutters + frames a reachable public-transport journey", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(reachablePlan) }));
    vi.stubGlobal("fetch", fetchSpy as never);
    const { controller, journey, reachDeclutter, views } = makeController({ drawReturns: true });

    controller.open({ kind: "transit", coords: [26.1, 44.4], band: 30, url: "/api/reach?x=1" });
    expect(views.at(-1)?.state).toBe("loading"); // synchronous loading first
    await vi.waitFor(() => expect(views.at(-1)?.state).toBe("transit"));

    expect(journey.draw).toHaveBeenCalledWith(reachablePlan.legs);
    expect(reachDeclutter.set).toHaveBeenCalledWith(true);
    expect(journey.frame).toHaveBeenCalledTimes(1);
    const v = views.at(-1)!;
    expect(v.title).toBe("By public transport");
    expect(v.steps).toHaveLength(2);
  });

  it("a bike/walk-only direct plan stays text-only — NO draw, NO declutter", async () => {
    const walkOnly = { reachable: true, totalMinutes: 12, transfers: 0, legs: [{ mode: "WALK", line: "", headsign: "", fromName: "START", toName: "END", minutes: 12 }] };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(walkOnly) })) as never);
    const { controller, journey, reachDeclutter, views } = makeController();
    controller.open({ kind: "transit", coords: [26.1, 44.4], band: 30, url: "/api/reach?x=1" });
    await vi.waitFor(() => expect(views.at(-1)?.state).toBe("transit"));
    expect(journey.draw).not.toHaveBeenCalled();
    expect(reachDeclutter.set).not.toHaveBeenCalledWith(true);
    expect(views.at(-1)?.title).toBe("On foot");
  });

  it("a late json resolving after the deadline fired cannot draw (gen guard)", async () => {
    vi.useFakeTimers();
    let resolveJson!: (v: unknown) => void;
    const jsonPromise = new Promise((r) => (resolveJson = r));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => jsonPromise })) as never);
    const { controller, journey, views } = makeController({ drawReturns: true });

    controller.open({ kind: "transit", coords: [26.1, 44.4], band: 30, url: "/api/reach?x=1" });
    await vi.advanceTimersByTimeAsync(12001); // deadline fires → error view, gen bumped
    expect(views.at(-1)?.state).toBe("error");
    resolveJson(reachablePlan); // late body arrives
    await vi.advanceTimersByTimeAsync(0);
    expect(journey.draw).not.toHaveBeenCalled(); // gen guard blocked it
  });

  it("422 → outside", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 422, json: () => Promise.resolve({}) })) as never);
    const { controller, views } = makeController();
    controller.open({ kind: "transit", coords: [26.1, 44.4], band: 30, url: "/api/reach?x=1" });
    await vi.waitFor(() => expect(views.at(-1)?.state).toBe("outside"));
  });

  it("a non-ok (500) → error", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })) as never);
    const { controller, views } = makeController();
    controller.open({ kind: "transit", coords: [26.1, 44.4], band: 30, url: "/api/reach?x=1" });
    await vi.waitFor(() => expect(views.at(-1)?.state).toBe("error"));
  });

  it("reachable:false → none", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ reachable: false }) })) as never);
    const { controller, views } = makeController();
    controller.open({ kind: "transit", coords: [26.1, 44.4], band: 30, url: "/api/reach?x=1" });
    await vi.waitFor(() => expect(views.at(-1)?.state).toBe("none"));
  });

  it("a transit plan whose legs produced NO drawable coords: no declutter, no frame, band-honesty when over band", async () => {
    const overBand = { ...reachablePlan, totalMinutes: 40 }; // > band 30 → 'a little beyond'
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(overBand) })) as never);
    const { controller, journey, reachDeclutter, views } = makeController({ drawReturns: false });
    controller.open({ kind: "transit", coords: [26.1, 44.4], band: 30, url: "/api/reach?x=1" });
    await vi.waitFor(() => expect(views.at(-1)?.state).toBe("transit"));
    expect(journey.draw).toHaveBeenCalled();
    expect(reachDeclutter.set).not.toHaveBeenCalledWith(true); // draw returned false
    expect(journey.frame).not.toHaveBeenCalled();
    expect(views.at(-1)?.detail).toContain("a little beyond");
  });

  it("a bike-direct fallback (no transit leg, not walk-only) is titled 'Directions', text-only", async () => {
    const bikeDirect = { reachable: true, totalMinutes: 14, transfers: 0, legs: [{ mode: "BIKE", line: "", headsign: "", fromName: "START", toName: "END", minutes: 14 }] };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(bikeDirect) })) as never);
    const { controller, journey, views } = makeController();
    controller.open({ kind: "transit", coords: [26.1, 44.4], band: 30, url: "/api/reach?x=1" });
    await vi.waitFor(() => expect(views.at(-1)?.state).toBe("transit"));
    expect(views.at(-1)?.title).toBe("Directions"); // not "On foot", not "By public transport"
    expect(journey.draw).not.toHaveBeenCalled();
  });

  it("highlight / reframe delegate to the journey; walk-band answer sets NO declutter", () => {
    const { controller, journey } = makeController();
    controller.open({ kind: "walk", coords: [26.1, 44.4], band: 15 });
    controller.highlight(2);
    expect(journey.highlight).toHaveBeenCalledWith(2);
    controller.reframe();
    expect(journey.frame).toHaveBeenLastCalledWith(expect.anything(), true);
  });

  it("car band=null answer shows the 'beyond' copy", () => {
    const { controller, views } = makeController();
    controller.open({ kind: "car", coords: [26.1, 44.4], band: null, carMeta: null });
    expect(views.at(-1)?.title).toBe("Beyond your driving reach");
  });
});
