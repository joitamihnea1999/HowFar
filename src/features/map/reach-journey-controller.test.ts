import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReachLeg } from "@/features/isochrones/server/transit-plan";
import { createLoadState } from "@/features/map/load-state";
import { createReachJourneyController } from "@/features/map/reach-journey-controller";

// The controller is imperative MapLibre glue (coverage-excluded), but its
// click-guard (`hitsActiveJourney`) and draw/declutter contract (`draw` returns
// whether it drew) are correctness-bearing logic the impl panel flagged as
// untested — so we exercise them against a stub map + fake element, no real
// MapLibre. The pure journey model is separately tested in reach.test.ts.

type FakeLayer = string;
function fakeMap(opts: { rendered?: unknown[] } = {}) {
  const source = { setData: vi.fn() };
  const layers = new Set<FakeLayer>([
    "reach-path-line-hl",
    "reach-path-stops-hl",
    "reach-path-transit",
    "reach-path-walk",
    "reach-path-stops",
    "reach-path-destination",
  ]);
  return {
    setData: source.setData,
    queryRendered: vi.fn(() => opts.rendered ?? []),
    map: {
      getSource: () => source,
      getLayer: (id: string) => (layers.has(id) ? {} : undefined),
      // Non-empty so the stamp poll stamps on its first tick.
      // A drawn journey leg feature (carries kind so the journey-only stamp
      // predicate matches — the destination pin has kind:"destination" instead).
      querySourceFeatures: () => [{ properties: { kind: "leg", legIndex: 0 } }],
      queryRenderedFeatures: () => opts.rendered ?? [],
      setFilter: vi.fn(),
    },
  };
}

const P = (lat: number, lng: number) => ({ lat, lng });
const TRANSIT_LEGS: ReachLeg[] = [
  { mode: "WALK", fromName: "START", toName: "Board", minutes: 5, from: P(44.42, 26.1), to: P(44.43, 26.1), path: [[26.1, 44.42], [26.1, 44.43]] },
  { mode: "BUS", fromName: "Board", toName: "Alight", minutes: 12, from: P(44.43, 26.1), to: P(44.45, 26.09), path: [[26.1, 44.43], [26.09, 44.45]] },
];

beforeEach(() => {
  // The stamp poll uses rAF + performance.now; run the scheduled tick synchronously.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => vi.unstubAllGlobals());

function make(rendered?: unknown[]) {
  const el = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
  const loadState = createLoadState();
  loadState.styleLoaded = true;
  const fm = fakeMap({ rendered });
  const reducedMotion = { matches: false } as MediaQueryList;
  const ctrl = createReachJourneyController({ map: fm.map as never, el, loadState, reducedMotion });
  return { ctrl, el, fm };
}

describe("reach-journey-controller", () => {
  it("draw() returns true and stamps the leg count for a journey with geometry", () => {
    const { ctrl, el } = make();
    expect(ctrl.draw(TRANSIT_LEGS)).toBe(true);
    expect(el.dataset.reachJourney).toBe("2"); // 2 leg lines
  });

  it("draw() returns false and stamps 'none' when there is no drawable geometry", () => {
    const { ctrl, el } = make();
    expect(ctrl.draw([{ mode: "WALK", fromName: "a", toName: "b", minutes: 1 }])).toBe(false);
    expect(el.dataset.reachJourney).toBe("none");
  });

  it("hitsActiveJourney is armed as soon as draw ran (independent of the e2e stamp) and only when a feature is under the click", () => {
    const point = { x: 100, y: 100 } as never;
    // A click lands on the journey (queryRenderedFeatures returns a feature).
    const hit = make([{}]);
    expect(hit.ctrl.hitsActiveJourney(point)).toBe(false); // nothing drawn yet
    hit.ctrl.draw(TRANSIT_LEGS);
    expect(hit.ctrl.hitsActiveJourney(point)).toBe(true);
    hit.ctrl.clear();
    expect(hit.ctrl.hitsActiveJourney(point)).toBe(false); // cleared → inactive

    // Drawn, but the click misses every feature → not a journey hit.
    const miss = make([]);
    miss.ctrl.draw(TRANSIT_LEGS);
    expect(miss.ctrl.hitsActiveJourney(point)).toBe(false);
  });

  it("a no-geometry draw does not arm the click-guard", () => {
    const { ctrl } = make([{}]);
    ctrl.draw([{ mode: "WALK", fromName: "a", toName: "b", minutes: 1 }]);
    expect(ctrl.hitsActiveJourney({ x: 1, y: 1 } as never)).toBe(false);
  });

  it("setDestination writes a kind:'destination' pin and stamps data-reach-pin (task 058)", () => {
    const { ctrl, el, fm } = make();
    ctrl.setDestination([26.12, 44.44]);
    expect(el.dataset.reachPin).toBe("true");
    const fc = fm.setData.mock.calls.at(-1)![0] as GeoJSON.FeatureCollection;
    const pins = fc.features.filter((f) => (f.properties as { kind?: string })?.kind === "destination");
    expect(pins).toHaveLength(1);
    expect(pins[0].geometry).toEqual({ type: "Point", coordinates: [26.12, 44.44] });
  });

  it("a pin arms the click-guard independently of a journey (walk/car reach has no journey)", () => {
    const point = { x: 100, y: 100 } as never;
    const { ctrl } = make([{}]);
    ctrl.setDestination([26.12, 44.44]); // pin only, no draw
    expect(ctrl.hitsActiveJourney(point)).toBe(true); // pinActive guards the click
    ctrl.clear();
    expect(ctrl.hitsActiveJourney(point)).toBe(false);
  });

  it("draw + pin coexist in one atomic source write, and clear drops both", () => {
    const { ctrl, el, fm } = make();
    ctrl.setDestination([26.12, 44.44]);
    ctrl.draw(TRANSIT_LEGS);
    const fc = fm.setData.mock.calls.at(-1)![0] as GeoJSON.FeatureCollection;
    const kinds = fc.features.map((f) => (f.properties as { kind?: string })?.kind);
    expect(kinds).toContain("destination");
    expect(kinds).toContain("leg");
    expect(kinds).toContain("stop");
    ctrl.clear();
    expect(el.dataset.reachPin).toBeUndefined();
    expect(el.dataset.reachJourney).toBeUndefined();
  });
});
