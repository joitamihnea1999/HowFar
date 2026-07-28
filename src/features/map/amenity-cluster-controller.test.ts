import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit coverage for the donut controller's reconcile pass (found in review).
 *
 * Why this file exists. The pure geometry (`amenity-cluster.ts`) was well tested
 * and the rendered result was covered by `e2e/amenity-legibility.spec.ts`, but the
 * layer BETWEEN them — reading the source, choosing a tile generation, feeding
 * unclustered pins into the collision pass, diffing the absorbed set, keying and
 * reusing marker entries — had none. That gap was not theoretical: the review
 * proved that deleting the pin-participation wiring (the the absorbed-pin case fix) left every
 * existing test green, including the adversarial e2e fixture written for it. The
 * first test below is the one that goes red.
 *
 * The suite runs in the `node` environment with hand-rolled DOM and `Marker`
 * fakes rather than pulling in a DOM library: the controller's DOM surface is
 * small and fully enumerable (create element, set attributes, append, listen), and
 * a new dependency for one test file is a worse trade than 40 lines of fake.
 */

/** Minimal stand-in for the element nodes `buildDonutElement` constructs. */
interface FakeNode {
  tag: string;
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  style: { cssText: string };
  className: string;
  type: string;
  textContent: string;
  children: FakeNode[];
  listeners: Record<string, ((event: unknown) => void)[]>;
  setAttribute: (name: string, value: string) => void;
  appendChild: (child: FakeNode) => void;
  addEventListener: (name: string, fn: (event: unknown) => void) => void;
}

function makeNode(tag: string): FakeNode {
  const node: FakeNode = {
    tag,
    attrs: {},
    dataset: {},
    style: { cssText: "" },
    className: "",
    type: "",
    textContent: "",
    children: [],
    listeners: {},
    setAttribute: (name, value) => void (node.attrs[name] = value),
    appendChild: (child) => void node.children.push(child),
    addEventListener: (name, fn) => void (node.listeners[name] ??= []).push(fn),
  };
  return node;
}

/** Every marker the controller ever created, in creation order. */
const markers: { element: FakeNode; lngLat: [number, number]; removed: boolean }[] = [];

class FakeMarker {
  element: FakeNode;
  record: (typeof markers)[number];
  constructor({ element }: { element: FakeNode }) {
    this.element = element;
    this.record = { element, lngLat: [0, 0], removed: false };
    markers.push(this.record);
  }
  setLngLat(lngLat: [number, number]) {
    this.record.lngLat = lngLat;
    return this;
  }
  addTo() {
    return this;
  }
  remove() {
    this.record.removed = true;
    return this;
  }
}

vi.mock("maplibre-gl", () => ({ default: { Marker: FakeMarker } }));

const { createAmenityClusterController } = await import("./amenity-cluster-controller");
const { createAmenityClusterController: _ctor, MIN_MARK_TAP_RADIUS_PX } = await import(
  "./amenity-cluster-controller");
void _ctor;
const { clusterFootprintRadius, pinFootprintRadius } = await import(
  "@/features/amenities/amenity-cluster");

/** Pending animation frames, flushed explicitly so reconcile timing is exact. */
let frames: (() => void)[] = [];
function flush() {
  const pending = frames;
  frames = [];
  for (const fn of pending) fn();
}

/** Tile coords nested under one base area, so a fixture's default tiles at different
 * zooms describe the SAME ground — which is what the generation tests are about. */
function nestedTile(z: number): { _z: number; _x: number; _y: number } {
  const base = { z: 14, x: 8, y: 10 };
  const shift = base.z - z;
  return shift >= 0
    ? { _z: z, _x: base.x >> shift, _y: base.y >> shift }
    : { _z: z, _x: base.x << -shift, _y: base.y << -shift };
}

type SourceFeature = {
  id?: number;
  _z?: number;
  _x?: number;
  _y?: number;
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: [number, number] };
};

/** A cluster feature as `querySourceFeatures` reports it. */
function cluster(
  id: number,
  x: number,
  y: number,
  counts: Record<string, number>,
  tileZ = 14,
): SourceFeature {
  const total = Object.values(counts).reduce((n, c) => n + c, 0);
  return {
    ...nestedTile(tileZ),
    properties: { cluster_id: id, point_count: total, ...counts },
    geometry: { type: "Point", coordinates: [x, y] },
  };
}

/** An unclustered place as `querySourceFeatures` reports it. */
function pin(id: number, x: number, y: number, category = "groceries", tileZ = 14): SourceFeature {
  return {
    id,
    ...nestedTile(tileZ),
    properties: { category, name: `place ${id}` },
    geometry: { type: "Point", coordinates: [x, y] },
  };
}

function setup({
  clusters = [] as SourceFeature[],
  pins = [] as SourceFeature[],
  zoom = 15,
} = {}) {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const source = { id: "amenities" };
  // Mirrors MapLibre: false while the worker is re-indexing after a `setData`.
  const state = { sourceLoaded: true };
  const map = {
    isSourceLoaded: () => state.sourceLoaded,
    getZoom: () => zoom,
    getCenter: () => ({ lng: 26, lat: 44 }),
    getBearing: () => 0,
    getPitch: () => 0,
    getPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    getSource: (id: string) => (id === "amenities" ? source : undefined),
    // Coordinates ARE screen pixels in this harness, so fixture geometry reads
    // directly as the layout under test.
    project: ([x, y]: [number, number]) => ({ x, y }),
    querySourceFeatures: (_id: string, params: { filter: unknown[] }) =>
      JSON.stringify(params.filter).includes('"!"') ? pins : clusters,
    on: (name: string, fn: (e: unknown) => void) => void (listeners[name] ??= []).push(fn),
    off: (name: string, fn: (e: unknown) => void) => {
      listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn);
    },
  };
  const el = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
  const onClusterClick = vi.fn();
  const onAbsorbedChange = vi.fn();
  const controller = createAmenityClusterController({
    map: map as never,
    el,
    loadState: { styleLoaded: true } as never,
    onClusterClick,
    onAbsorbedChange,
  });
  /** Run one reconcile pass at an unchanged camera and unchanged data. */
  const tick = () => {
    controller.refresh();
    flush();
  };
  /** Announce new source data, the way a `setData` does, then reconcile. Change
   * detection deliberately skips a pass when neither the camera nor the data moved,
   * so a fixture that mutates its features must say so — exactly as MapLibre does. */
  const tickData = () => {
    for (const fn of listeners.sourcedata ?? []) fn({ sourceId: "amenities" });
    flush();
  };
  return { controller, map, el, listeners, onClusterClick, onAbsorbedChange, tick, tickData, state };
}

beforeEach(() => {
  markers.length = 0;
  frames = [];
  vi.stubGlobal("document", {
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
  });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames[id - 1] = () => {};
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("unclustered pins take part in the collision pass (the absorbed-pin case wiring)", () => {
  // Supercluster keeps a pin clear of a cluster's SEED, not of its centroid, and a
  // centroid is a weighted average that can drift toward that pin — so a donut and
  // a lone pin could overlap heavily while every donut-vs-donut pair was legal.
  // Remove the `singles` loop from `reconcile` and this describe block goes red;
  // nothing else in the repo does.
  it("absorbs a pin whose footprint intersects a donut, and reports the merged total", () => {
    const gap = 15; // px between the two centres
    const { controller, el, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 3 })],
      pins: [pin(42, 100, 100 + gap, "parks")],
    });
    // Precondition: these two really do intersect at the sizes the pass reserves.
    expect(clusterFootprintRadius(3) + pinFootprintRadius(15, true)).toBeGreaterThan(gap);

    tick();

    expect(controller.absorbedPinIds()).toEqual([42]);
    expect(controller.count()).toBe(1);
    expect(el.dataset.amenityClusters).toBe("1");
    // The mark must tell the truth about what it swallowed: 3 + 1.
    expect(markers[0].element.dataset.clusterTotal).toBe("4");
    expect(markers[0].element.attrs["aria-label"]).toContain("4 places here");
    expect(markers[0].element.attrs["aria-label"]).toContain("parks");
  });

  it("leaves a distant pin alone, so a lone place stays a cheap WebGL pin", () => {
    const { controller, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 3 })],
      pins: [pin(42, 400, 400)],
    });
    tick();
    expect(controller.absorbedPinIds()).toEqual([]);
    expect(controller.count()).toBe(1);
    expect(markers[0].element.dataset.clusterTotal).toBe("3");
  });

  it("draws a donut for two pins that collide with each other but no cluster", () => {
    const { controller, tick } = setup({
      clusters: [],
      pins: [pin(7, 100, 100), pin(8, 100, 108, "parks")],
    });
    tick();
    expect(controller.count()).toBe(1);
    expect(controller.absorbedPinIds()).toEqual([7, 8]);
    // Pin-only marks must still be openable — they are hidden from the pin layer,
    // so a mark that carried no ids at all was an unreachable place (an earlier pass).
    const picked = controller.pickAt({ x: 100, y: 104 });
    expect(picked?.ids).toEqual([]);
    expect(picked?.pinIds).toEqual([7, 8]);
  });

  it("announces the absorbed set only when it actually changes", () => {
    const { controller, onAbsorbedChange, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 3 })],
      pins: [pin(42, 100, 115)],
    });
    tick();
    expect(onAbsorbedChange).toHaveBeenCalledTimes(1);
    // A second pass over identical data must not churn the layer filter.
    controller.refresh();
    flush();
    expect(onAbsorbedChange).toHaveBeenCalledTimes(1);
    expect(controller.absorbedPinIds()).toEqual([42]);
  });
});

describe("reading the clustered source", () => {
  it("dedupes a cluster reported once per tile it spans", () => {
    const { controller, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 4 }), cluster(1, 100, 100, { groceries: 4 })],
    });
    tick();
    expect(controller.count()).toBe(1);
    expect(markers[0].element.dataset.clusterTotal).toBe("4");
  });

  it("keeps ONE tile generation, so a mid-zoom double report cannot double the count", () => {
    // The same 8 places, reported by the retained z13 tiles AND the incoming z14
    // tiles. Merging across them paints "16 places" where there are 8 (F3).
    const { tick } = setup({
      zoom: 14,
      clusters: [
        cluster(1, 100, 100, { groceries: 8 }, 13),
        cluster(2, 104, 100, { groceries: 5 }, 14),
        cluster(3, 108, 100, { groceries: 3 }, 14),
      ],
    });
    tick();
    const total = markers
      .filter((m) => !m.removed)
      .reduce((n, m) => n + Number(m.element.dataset.clusterTotal), 0);
    expect(total).toBe(8);
  });

  it("skips a cluster with no usable counts rather than drawing an empty ring", () => {
    const { controller, tick } = setup({
      clusters: [
        { _z: 14, properties: { cluster_id: 1, point_count: 0 }, geometry: { type: "Point", coordinates: [100, 100] } },
      ],
    });
    tick();
    expect(controller.count()).toBe(0);
  });

  it("survives a source query that throws mid-teardown", () => {
    const { controller, map } = setup({ clusters: [cluster(1, 100, 100, { groceries: 4 })] });
    map.querySourceFeatures = () => {
      throw new Error("source removed");
    };
    expect(() => {
      controller.refresh();
      flush();
    }).not.toThrow();
    expect(controller.count()).toBe(0);
  });
});

describe("marker entry reuse", () => {
  it("moves an unchanged group instead of rebuilding its marker", () => {
    const clusters = [cluster(1, 100, 100, { groceries: 4 })];
    const { tick, tickData } = setup({ clusters });
    tick();
    expect(markers).toHaveLength(1);

    // Same cluster, new position (a pan). The entry must be reused: rebuilding
    // every frame would drop focus and thrash the DOM during an animation.
    clusters[0].geometry.coordinates = [140, 100];
    tickData();
    expect(markers).toHaveLength(1);
    expect(markers[0].removed).toBe(false);
    expect(markers[0].lngLat).toEqual([140, 100]);
  });

  it("rebuilds when the group's membership changes, so a mark is never mislabelled", () => {
    const clusters = [cluster(1, 100, 100, { groceries: 4 })];
    const { tick, tickData } = setup({ clusters });
    tick();
    clusters[0] = cluster(1, 100, 100, { groceries: 9 });
    tickData();
    expect(markers).toHaveLength(2);
    expect(markers[0].removed).toBe(true);
    expect(markers[1].element.dataset.clusterTotal).toBe("9");
  });

  it("gives two pin-only groups distinct identities", () => {
    // Both carry an empty supercluster id list, so keying on ids alone collided
    // them onto one entry and the second group vanished (an earlier pass).
    const { controller, tick } = setup({
      clusters: [],
      pins: [pin(1, 100, 100), pin(2, 100, 108), pin(3, 400, 400), pin(4, 400, 408)],
    });
    tick();
    expect(controller.count()).toBe(2);
    expect(controller.absorbedPinIds()).toEqual([1, 2, 3, 4]);
  });
});

describe("hit-testing", () => {
  it("resolves the donut under a point and refuses points outside its footprint", () => {
    const { controller, tick } = setup({ clusters: [cluster(1, 100, 100, { groceries: 6 })] });
    tick();
    expect(controller.pickAt({ x: 100, y: 100 })?.ids).toEqual([1]);
    expect(controller.pickAt({ x: 300, y: 300 })).toBeNull();
  });

  it("stays inert until a reconcile has actually SEEN the new data", () => {
    // The distinction review caught. `setData` re-indexes on a worker, measured at
    // 35-41ms (W2), while the recovery frame runs in ~16ms — so the frame that
    // `invalidateMarks` schedules for itself can reconcile the OLD tiles. Clearing the
    // guard there rebuilt the same marks with stale ids and reopened the exact
    // wrong-list race the flag exists to close. Recovery must therefore require the
    // data epoch to have advanced, not merely a frame to have passed.
    const { controller, el, tick, tickData } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 6 })],
    });
    tick();
    expect(controller.pickAt({ x: 100, y: 100 })).not.toBeNull();

    controller.invalidateMarks();
    expect(controller.pickAt({ x: 100, y: 100 })).toBeNull();
    expect(el.dataset.amenityClustersStale).toBe("1");

    // The self-scheduled frame runs BEFORE any `sourcedata` — the pre-recluster pass.
    flush();
    expect(controller.pickAt({ x: 100, y: 100 }), "still inert: no new data yet").toBeNull();
    expect(el.dataset.amenityClustersStale).toBe("1");

    // …and again, to be sure it is not merely a one-frame delay.
    controller.refresh();
    flush();
    expect(controller.pickAt({ x: 100, y: 100 })).toBeNull();

    // Only the reconcile driven by the amenities `sourcedata` restores clicks.
    tickData();
    expect(controller.pickAt({ x: 100, y: 100 })).not.toBeNull();
    expect(el.dataset.amenityClustersStale).toBeUndefined();
  });

  it("stays inert while the source itself reports that it is still loading", () => {
    // Belt and braces beside the epoch check: an epoch bump from an unrelated
    // sourcedata must not release the guard while the source is mid-reindex.
    const { controller, tick, tickData, state } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 6 })],
    });
    tick();
    controller.invalidateMarks();
    state.sourceLoaded = false;
    tickData();
    expect(controller.pickAt({ x: 100, y: 100 })).toBeNull();

    state.sourceLoaded = true;
    controller.refresh();
    flush();
    expect(controller.pickAt({ x: 100, y: 100 })).not.toBeNull();
  });

  it("does not fire the click callback while the marks are stale", () => {
    const { controller, onClusterClick, tick, tickData } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 6 })],
    });
    tick();
    const click = markers[0].element.listeners.click?.[0];
    controller.invalidateMarks();
    click?.({ stopPropagation() {}, preventDefault() {} });
    expect(onClusterClick).not.toHaveBeenCalled();

    // A frame alone does not restore it — only data actually arriving does.
    flush();
    markers[markers.length - 1].element.listeners.click?.[0]?.({
      stopPropagation() {},
      preventDefault() {},
    });
    expect(onClusterClick).not.toHaveBeenCalled();

    tickData();
    markers[markers.length - 1].element.listeners.click?.[0]?.({
      stopPropagation() {},
      preventDefault() {},
    });
    expect(onClusterClick).toHaveBeenCalledTimes(1);
  });

  it("refuses picks while decluttered, so a hidden donut cannot be clicked", () => {
    const { controller, tick } = setup({ clusters: [cluster(1, 100, 100, { groceries: 6 })] });
    tick();
    controller.setVisible(false);
    expect(controller.pickAt({ x: 100, y: 100 })).toBeNull();
    expect(controller.count()).toBe(0);
  });
});

describe("declutter and teardown", () => {
  it("removes every marker when hidden and restores them when shown", () => {
    const { controller, tick } = setup({ clusters: [cluster(1, 100, 100, { groceries: 6 })] });
    tick();
    controller.setVisible(false);
    expect(markers.every((m) => m.removed)).toBe(true);

    controller.setVisible(true);
    flush();
    expect(controller.count()).toBe(1);
  });

  it("frees an absorbed pin when it clears, so no place stays invisibly hidden", () => {
    const { controller, onAbsorbedChange, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 3 })],
      pins: [pin(42, 100, 115)],
    });
    tick();
    expect(controller.absorbedPinIds()).toEqual([42]);
    controller.clear();
    expect(controller.absorbedPinIds()).toEqual([]);
    // The amenities controller must be told, or the pin layer keeps filtering it out.
    expect(onAbsorbedChange).toHaveBeenCalledTimes(2);
  });

  it("dispose cancels the pending frame and detaches every map listener", () => {
    // The leak class `dispose-contract.test.ts` exists to catch: this controller
    // owns a rAF plus `render`/`sourcedata` subscriptions, and a post-dispose event
    // must not repaint markers over a torn-down map.
    const { controller, listeners, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 6 })],
    });
    tick();
    expect(listeners.render).toHaveLength(1);
    expect(listeners.sourcedata).toHaveLength(1);

    controller.refresh(); // arm a frame…
    controller.dispose(); // …then dispose before it runs
    expect(listeners.render).toHaveLength(0);
    expect(listeners.sourcedata).toHaveLength(0);
    expect(markers.every((m) => m.removed)).toBe(true);

    const before = markers.length;
    flush();
    expect(markers).toHaveLength(before);
    // And a later refresh cannot resurrect anything either.
    controller.refresh();
    flush();
    expect(markers).toHaveLength(before);
  });
});

describe("defensive paths", () => {
  // Every branch below is a real frame the controller sees in production — a source
  // mid-teardown, a feature MapLibre reports without the property we expect, an event
  // for someone else's source. They are cheap to get wrong and invisible when wrong,
  // so they are pinned rather than left to the e2e.
  it("waits for the style before touching the source", () => {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const el = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    const controller = createAmenityClusterController({
      map: {
        getZoom: () => 15,
        getCenter: () => ({ lng: 26, lat: 44 }),
        getBearing: () => 0,
        getPitch: () => 0,
        getPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
        getSource: () => ({ id: "amenities" }),
        project: () => ({ x: 0, y: 0 }),
        querySourceFeatures: () => {
          throw new Error("must not query before the style exists");
        },
        on: (name: string, fn: (e: unknown) => void) => void (listeners[name] ??= []).push(fn),
        off: () => {},
      } as never,
      el,
      loadState: { styleLoaded: false } as never,
      onClusterClick: vi.fn(),
      onAbsorbedChange: vi.fn(),
    });
    expect(() => {
      controller.refresh();
      flush();
    }).not.toThrow();
    expect(controller.count()).toBe(0);
  });

  it("does nothing when the amenities source is absent", () => {
    const el = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    const controller = createAmenityClusterController({
      map: {
        getZoom: () => 15,
        getCenter: () => ({ lng: 26, lat: 44 }),
        getBearing: () => 0,
        getPitch: () => 0,
        getPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
        getSource: () => undefined,
        project: () => ({ x: 0, y: 0 }),
        querySourceFeatures: () => [],
        on: () => {},
        off: () => {},
      } as never,
      el,
      loadState: { styleLoaded: true } as never,
      onClusterClick: vi.fn(),
      onAbsorbedChange: vi.fn(),
    });
    controller.refresh();
    flush();
    expect(controller.count()).toBe(0);
  });

  it("skips clusters MapLibre reports without usable properties or point geometry", () => {
    const { controller, tick } = setup({
      clusters: [
        { _z: 14, properties: null as never, geometry: { type: "Point", coordinates: [10, 10] } },
        cluster(2, 40, 40, { groceries: 3 }),
        {
          _z: 14,
          properties: { cluster_id: 3, point_count: 4, groceries: 4 },
          geometry: { type: "LineString", coordinates: [80, 80] },
        },
        { _z: 14, properties: { cluster_id: Number.NaN, point_count: 5, groceries: 5 }, geometry: { type: "Point", coordinates: [200, 200] } },
      ],
    });
    tick();
    // Only the well-formed one survives.
    expect(controller.count()).toBe(1);
  });

  it("skips pins without an id, a category, or point geometry, and dedupes repeats", () => {
    const { controller, tick } = setup({
      clusters: [],
      pins: [
        pin(1, 100, 100),
        pin(1, 100, 100), // same id from a second tile
        { id: 2, _z: 14, properties: {}, geometry: { type: "Point", coordinates: [100, 108] } },
        { id: Number.NaN, _z: 14, properties: { category: "parks" }, geometry: { type: "Point", coordinates: [100, 112] } },
        { id: 4, _z: 14, properties: { category: "parks" }, geometry: { type: "LineString", coordinates: [100, 116] } },
      ] as never,
    });
    tick();
    // One usable pin, colliding with nothing → no donut at all.
    expect(controller.count()).toBe(0);
    expect(controller.absorbedPinIds()).toEqual([]);
  });

  it("still partitions when MapLibre stops stamping the tile provenance", () => {
    // `_z` is an internal field, so the controller reads it defensively: with it
    // missing, every candidate is kept (the pre-existing behaviour) rather than the
    // display silently emptying.
    const { controller, tick } = setup({
      clusters: [
        { properties: { cluster_id: 1, point_count: 4, groceries: 4 }, geometry: { type: "Point", coordinates: [100, 100] } },
        { properties: { cluster_id: 2, point_count: 4, groceries: 4 }, geometry: { type: "Point", coordinates: [400, 400] } },
      ] as never,
    });
    tick();
    expect(controller.count()).toBe(2);
  });

  it("labels a one-member and a three-figure mark correctly", () => {
    const { tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 1 }), cluster(2, 400, 400, { groceries: 150 })],
    });
    tick();
    const one = markers.find((m) => m.element.dataset.clusterTotal === "1");
    const many = markers.find((m) => m.element.dataset.clusterTotal === "150");
    expect(one?.element.attrs["aria-label"]).toContain("1 place here");
    expect(one?.element.attrs["aria-label"]).not.toContain("1 places");
    // A three-digit count needs the smaller glyph to stay inside the ring.
    const text = many?.element.children[0]?.children.at(-1);
    expect(text?.attrs["font-size"]).toBe("9");
  });

  it("orders coincident PIN candidates deterministically", () => {
    // Two pins at the identical position: the merge order tie-break has to be defined
    // for candidates that carry no cluster ids, or the sort comparator returns NaN and
    // the arrangement is left to the engine.
    const { controller, tick } = setup({
      clusters: [],
      pins: [pin(9, 100, 100), pin(8, 100, 100, "parks")],
    });
    tick();
    expect(controller.count()).toBe(1);
    expect(controller.absorbedPinIds()).toEqual([8, 9]);
  });

  it("drops a donut whose group left the source entirely", () => {
    const clusters = [cluster(1, 100, 100, { groceries: 4 })];
    const { controller, tick, tickData } = setup({ clusters });
    tick();
    expect(controller.count()).toBe(1);
    clusters.length = 0;
    tickData();
    expect(controller.count()).toBe(0);
    expect(markers[0].removed).toBe(true);
  });

  it("ignores sourcedata for a different source", () => {
    const { controller, listeners, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 4 })],
    });
    tick();
    frames = [];
    for (const fn of listeners.sourcedata ?? []) fn({ sourceId: "isochrone" });
    expect(frames).toHaveLength(0);
    expect(controller.count()).toBe(1);
  });

  it("no-ops on a redundant visibility set and an empty absorbed clear", () => {
    const { controller, onAbsorbedChange, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 4 })],
    });
    tick();
    controller.setVisible(true); // already visible
    expect(controller.count()).toBe(1);
    controller.clearAbsorbed(); // nothing absorbed
    expect(onAbsorbedChange).not.toHaveBeenCalled();
  });

  it("frees the absorbed set on demand without waiting for a reconcile", () => {
    // Called from the amenities controller BEFORE a recluster rebuilds the layer
    // filter: the old ids refer to the previous indexing, so a pin that is no longer
    // absorbed must not stay hidden for the intervening frame.
    const { controller, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 3 })],
      pins: [pin(42, 100, 115)],
    });
    tick();
    expect(controller.absorbedPinIds()).toEqual([42]);
    controller.clearAbsorbed();
    expect(controller.absorbedPinIds()).toEqual([]);
  });

  it("does no reconcile work at all while decluttered", () => {
    const { controller, listeners, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 4 })],
    });
    tick();
    controller.setVisible(false);
    // A render tick while hidden must stay a no-op rather than repainting donuts over
    // a drawn journey or an open fan.
    for (const fn of listeners.render ?? []) fn({});
    flush();
    expect(controller.count()).toBe(0);
  });

  it("disposes cleanly with no frame pending", () => {
    const { controller, tick } = setup({ clusters: [cluster(1, 100, 100, { groceries: 4 })] });
    tick();
    expect(frames).toHaveLength(0);
    expect(() => controller.dispose()).not.toThrow();
  });

  it("a frame already in flight when dispose lands paints nothing", () => {
    // cancelAnimationFrame cannot recall a callback the browser has already dequeued,
    // so the reconcile itself has to check. Simulated by a cancel that does nothing.
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { controller, tick } = setup({ clusters: [cluster(1, 100, 100, { groceries: 4 })] });
    tick();
    const before = markers.length;
    controller.refresh(); // arm a frame
    controller.dispose();
    flush(); // the "already dequeued" callback runs
    expect(markers).toHaveLength(before);
    expect(markers.every((m) => m.removed)).toBe(true);
  });
});

describe("absorbed pins carry their own data (found in review)", () => {
  // Resolving an absorbed pin used to mean a SECOND `querySourceFeatures` at click
  // time. If that query missed an id — viewport edge, mid-recluster, source race — the
  // popup got zero leaves and returned with no UI at all: the mark that hid those pins
  // became a dead click, i.e. "on screen but unreachable", the defect this task exists
  // to remove. The mark now carries what it swallowed.
  it("hands the pick a snapshot of every pin it absorbed", () => {
    const { controller, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 3 })],
      pins: [pin(42, 100, 115, "parks")],
    });
    tick();

    const picked = controller.pickAt({ x: 100, y: 100 });
    expect(picked?.pinIds).toEqual([42]);
    expect(picked?.pins).toHaveLength(1);
    expect(picked?.pins[0].id).toBe(42);
    expect(picked?.pins[0].properties?.name).toBe("place 42");
    expect(picked?.pins[0].properties?.category).toBe("parks");
    // Real coordinates, so the list can route to the place and not to (0,0).
    expect(picked?.pins[0].geometry.coordinates).toEqual([100, 115]);
  });

  it("hands the same snapshot to the keyboard path", () => {
    const { onClusterClick, tick } = setup({
      clusters: [],
      pins: [pin(7, 100, 100), pin(8, 100, 108, "parks")],
    });
    tick();
    markers[0].element.listeners.click?.[0]?.({ stopPropagation() {}, preventDefault() {} });
    expect(onClusterClick).toHaveBeenCalledTimes(1);
    const [, , , pinIds, pins] = onClusterClick.mock.calls[0];
    expect(pinIds).toEqual([7, 8]);
    expect((pins as { id: number }[]).map((p) => p.id)).toEqual([7, 8]);
  });

  it("copies the properties rather than holding the live feature", () => {
    // The snapshot must survive the source being re-indexed underneath it.
    const pins = [pin(42, 100, 115)];
    const { controller, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 3 })],
      pins,
    });
    tick();
    const picked = controller.pickAt({ x: 100, y: 100 });
    (pins[0].properties as Record<string, unknown>).name = "MUTATED";
    expect(picked?.pins[0].properties?.name).toBe("place 42");
  });
});

describe("pins are partitioned by tile generation too (found in review)", () => {
  it("does not absorb an old-generation pin into a new-generation donut", () => {
    // Mid-zoom the same POI can be a member of a new-tiling cluster while a retained
    // old tile still reports it as an unclustered single. Absorbing that single would
    // inflate the donut that ALREADY counts it — the "donut that lies" again, and
    // `seenPins` cannot see it because it is one id in two different roles.
    const { controller, tick } = setup({
      zoom: 14,
      clusters: [cluster(1, 100, 100, { groceries: 6 }, 14)],
      pins: [pin(42, 100, 115, "groceries", 13)], // stale generation
    });
    tick();
    expect(controller.absorbedPinIds()).toEqual([]);
    expect(markers[0].element.dataset.clusterTotal).toBe("6");
  });

  it("still absorbs a pin from the CURRENT generation", () => {
    const { controller, tick } = setup({
      zoom: 14,
      clusters: [cluster(1, 100, 100, { groceries: 6 }, 14)],
      pins: [pin(42, 100, 115, "groceries", 14)],
    });
    tick();
    expect(controller.absorbedPinIds()).toEqual([42]);
    expect(markers[0].element.dataset.clusterTotal).toBe("7");
  });
});

describe("hit target by pointer kind", () => {
  it("gives a TOUCH tap the full 44px target, larger than the drawn donut", () => {
    // A donut is 26-34px wide and `pointer-events:none`, so its drawn radius alone is
    // well under the target the rest of the UI honours.
    const { controller, tick } = setup({ clusters: [cluster(1, 100, 100, { groceries: 3 })] });
    tick();
    const drawn = clusterFootprintRadius(3);
    expect(drawn).toBeLessThan(MIN_MARK_TAP_RADIUS_PX);
    expect(controller.pickAt({ x: 100 + drawn + 2, y: 100 }, true)).not.toBeNull();
    expect(controller.pickAt({ x: 100 + MIN_MARK_TAP_RADIUS_PX - 1, y: 100 }, true)).not.toBeNull();
    // …and still bounded: it does not claim the whole map.
    expect(controller.pickAt({ x: 100 + MIN_MARK_TAP_RADIUS_PX + 3, y: 100 }, true)).toBeNull();
  });

  it("gives a MOUSE exactly the drawn mark, so bare map stays selectable between donuts", () => {
    // The 44px target is for fingers. Applied to a mouse it blanketed the map: donuts can
    // render TANGENT, so with any pad at all their targets overlap and no point between
    // them is free — clicking bare map to choose a new address became impossible in a
    // dense field (found in review).
    const { controller, tick } = setup({ clusters: [cluster(1, 100, 100, { groceries: 3 })] });
    tick();
    const drawn = clusterFootprintRadius(3);
    expect(controller.pickAt({ x: 100 + drawn - 1, y: 100 })).not.toBeNull(); // on the mark
    expect(controller.pickAt({ x: 100 + drawn + 1, y: 100 })).toBeNull(); // just off it
  });

  it("leaves free map between two ALMOST-touching donuts for a mouse, while touch still hits", () => {
    // Near-tangent is the worst case the invariant permits, so it decides whether
    // click-to-select survives in a dense field. (At EXACTLY tangent the single shared
    // point belongs to both marks and nearest-centre picks one — measure-zero, and not
    // worth contorting the geometry over.)
    const gap = 2 * clusterFootprintRadius(2) + 4;
    const { controller, tick } = setup({
      clusters: [
        cluster(1, 100, 100, { groceries: 2 }),
        cluster(2, 100 + gap, 100, { groceries: 2 }),
      ],
    });
    tick();
    const midpoint = { x: 100 + gap / 2, y: 100 };
    expect(controller.pickAt(midpoint)).toBeNull(); // mouse: bare map, selectable
    expect(controller.pickAt(midpoint, true)).not.toBeNull(); // touch: still reachable
  });

  it("gives an ambiguous tap to the nearest mark", () => {
    const { controller, tick } = setup({
      clusters: [cluster(1, 100, 100, { groceries: 3 }), cluster(2, 140, 100, { groceries: 3 })],
    });
    tick();
    expect(controller.pickAt({ x: 112, y: 100 })?.ids).toEqual([1]);
    expect(controller.pickAt({ x: 128, y: 100 })?.ids).toEqual([2]);
  });
});
