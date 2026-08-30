import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Amenity } from "@/features/amenities/amenities";

/**
 * Unit coverage for the spiderfy controller (task 061 W20).
 *
 * Deliberately NOT excluded from coverage as "MapLibre glue". A reviewer
 * made that criticism stick for the donut controller, and it applies here for the
 * same reason: this module decides when the fan owns the map, what its leaves' screen
 * positions are after a camera move, and which leaf a click resolved to — decisions
 * whose failure modes (a stale fan, a fan that cannot be clicked, marks that never
 * come back) are exactly the class this task exists to eliminate.
 *
 * Same fake-DOM/`Marker` approach as `amenity-cluster-controller.test.ts`: the
 * `node` environment plus ~40 lines of fake beats adding a DOM dependency.
 */

interface FakeNode {
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

function makeNode(): FakeNode {
  const node: FakeNode = {
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

const markers: { element: FakeNode; lngLat: [number, number]; removed: boolean }[] = [];

class FakeMarker {
  record: (typeof markers)[number];
  constructor({ element }: { element: FakeNode }) {
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

// The controller reaches the MapLibre runtime through the lazy `mapGl()` holder (task 017),
// so install a fake runtime via setMapGl rather than mocking the maplibre-gl module.
const { setMapGl } = await import("./map-runtime");
setMapGl({ Marker: FakeMarker } as unknown as import("./map-runtime").MapGl);

const { createAmenitySpiderController } = await import("./amenity-spider-controller");
const { clusterFootprintRadius } = await import("@/features/amenities/amenity-cluster");
const { SPIDER_LEAF_RADIUS_PX, spiderLegs } = await import("@/features/amenities/amenity-spider");
const { MIN_MARK_TAP_RADIUS_PX } = await import("./amenity-cluster-controller");

let frames: (() => void)[] = [];
function flush() {
  const pending = frames;
  frames = [];
  for (const fn of pending) fn();
}

const HUB: [number, number] = [500, 400];

function place(name: string, category: Amenity["category"] = "groceries"): Amenity {
  return { name, category, lat: 44, lng: 26 };
}

/** Point features written to the spider source, in leaf order. */
type Written = { type: string; features: GeoJSON.Feature[] };

function setup() {
  const listeners: Record<string, (() => void)[]> = {};
  let written: Written | null = null;
  // Simulates a camera. `scale` is what a ZOOM changes: a pure pan is a translation,
  // under which pixel-offset geometry keeps the same coordinates, so only a scale
  // change can show whether the fan is really re-laid out.
  const camera = { scale: 1 };
  const map = {
    // Coordinates ARE screen pixels at scale 1, and unproject is the exact inverse,
    // so a fan's asserted geometry reads directly as pixels.
    project: ([x, y]: [number, number]) => ({ x: x * camera.scale, y: y * camera.scale }),
    unproject: ([x, y]: [number, number]) => ({ lng: x / camera.scale, lat: y / camera.scale }),
    getSource: () => ({ setData: (data: Written) => void (written = data) }),
    on: (name: string, fn: () => void) => void (listeners[name] ??= []).push(fn),
    off: (name: string, fn: () => void) => {
      listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn);
    },
  };
  const el = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
  const onActiveChange = vi.fn();
  const controller = createAmenitySpiderController({ map: map as never, el, onActiveChange });
  return {
    controller,
    el,
    listeners,
    onActiveChange,
    camera,
    /** The last FeatureCollection written to the fan's source. */
    data: () => written as Written | null,
    points: () =>
      ((written as Written | null)?.features ?? []).filter((f) => f.geometry.type === "Point"),
    lines: () =>
      ((written as Written | null)?.features ?? []).filter((f) => f.geometry.type === "LineString"),
    move: () => {
      for (const fn of listeners.move ?? []) fn();
      flush();
    },
  };
}

beforeEach(() => {
  markers.length = 0;
  frames = [];
  vi.stubGlobal("document", {
    createElement: () => makeNode(),
    createElementNS: () => makeNode(),
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

describe("opening a fan", () => {
  it("draws one pin and one leader line per member", () => {
    const { controller, points, lines } = setup();
    controller.open(HUB, [place("Mega"), place("Farmacia", "pharmacies"), place("Parcul", "parks")]);
    expect(points()).toHaveLength(3);
    expect(lines()).toHaveLength(3);
    // A leader line without a pin (or the reverse) would put a place where none is.
    expect(points().map((f) => f.properties?.name)).toEqual(["Mega", "Farmacia", "Parcul"]);
  });

  it("places each pin at the hub plus its computed leg, in screen space", () => {
    const { controller, points } = setup();
    const leaves = [place("A"), place("B"), place("C"), place("D")];
    controller.open(HUB, leaves);
    const legs = spiderLegs(leaves.length, { hubRadius: clusterFootprintRadius(leaves.length) });
    points().forEach((feature, index) => {
      const [x, y] = (feature.geometry as GeoJSON.Point).coordinates;
      expect(x).toBeCloseTo(HUB[0] + legs[index].dx, 6);
      expect(y).toBeCloseTo(HUB[1] + legs[index].dy, 6);
    });
  });

  it("anchors every leader line at the hub and ends it on its own leaf", () => {
    const { controller, points, lines } = setup();
    controller.open(HUB, [place("A"), place("B")]);
    lines().forEach((line, index) => {
      const coords = (line.geometry as GeoJSON.LineString).coordinates;
      expect(coords[0]).toEqual(HUB);
      expect(coords[1]).toEqual((points()[index].geometry as GeoJSON.Point).coordinates);
    });
  });

  it("carries the category colour and a fixed readable radius onto every leaf", () => {
    const { controller, points } = setup();
    controller.open(HUB, [place("Mega"), place("Farmacia", "pharmacies")]);
    for (const feature of points()) {
      expect(feature.properties?.radius).toBe(SPIDER_LEAF_RADIUS_PX);
      expect(String(feature.properties?.color)).toMatch(/^#/);
    }
    // Colours come from the category SSOT, so two categories cannot collide.
    expect(points()[0].properties?.color).not.toBe(points()[1].properties?.color);
  });

  it("draws the hub as the SAME donut, counting its members by category", () => {
    const { controller } = setup();
    controller.open(HUB, [place("A"), place("B"), place("P", "parks")]);
    expect(markers).toHaveLength(1);
    expect(markers[0].element.dataset.clusterTotal).toBe("3");
    expect(markers[0].element.dataset.spiderHub).toBe("1");
    expect(markers[0].lngLat).toEqual(HUB);
    // The hub's job changed, so its label must offer to collapse, not to list.
    expect(markers[0].element.attrs["aria-label"]).toContain("collapse");
    expect(markers[0].element.attrs["aria-label"]).toContain("3 places");
  });

  it("declutters the rest of the map exactly once, and stamps the fan size", () => {
    const { controller, el, onActiveChange } = setup();
    controller.open(HUB, [place("A"), place("B")]);
    expect(onActiveChange).toHaveBeenCalledTimes(1);
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    expect(el.dataset.amenitySpider).toBe("2");
    expect(controller.isOpen()).toBe(true);
  });

  it("replaces an open fan instead of stacking two hubs", () => {
    const { controller, points } = setup();
    controller.open(HUB, [place("A"), place("B")]);
    controller.open([600, 300], [place("C"), place("D"), place("E")]);
    expect(markers.filter((m) => !m.removed)).toHaveLength(1);
    expect(points()).toHaveLength(3);
  });

  it("ignores an empty fan rather than decluttering the map for nothing", () => {
    const { controller, el, onActiveChange } = setup();
    controller.open(HUB, []);
    expect(controller.isOpen()).toBe(false);
    expect(onActiveChange).not.toHaveBeenCalled();
    expect(el.dataset.amenitySpider).toBeUndefined();
    expect(markers).toHaveLength(0);
  });
});

describe("following the camera", () => {
  it("holds the fan's PIXEL geometry across a zoom, which is the whole point of recomputing", () => {
    const { controller, points, lines, listeners, camera } = setup();
    controller.open(HUB, [place("A"), place("B")]);
    const before = (points()[0].geometry as GeoJSON.Point).coordinates.slice();
    const legs = spiderLegs(2, { hubRadius: clusterFootprintRadius(2) });

    // Zoom in. A fan is a PIXEL arrangement: its leaves must stay one leg-length
    // from the hub ON SCREEN, which means their coordinates have to change. Baking
    // them once would make the fan grow with the zoom and drift off its hub.
    camera.scale = 2;
    const mapMove = listeners.move ?? [];
    expect(mapMove).toHaveLength(1);

    // Nothing recomputes until the frame runs: the pass is rAF-coalesced, so a
    // 60fps zoom cannot rebuild the fan several times per frame.
    for (const fn of mapMove) fn();
    expect((points()[0].geometry as GeoJSON.Point).coordinates).toEqual(before);

    flush();
    const after = (points()[0].geometry as GeoJSON.Point).coordinates;
    expect(after).not.toEqual(before); // the place moved in coordinate space…
    // …precisely so that on SCREEN it is still exactly its leg from the hub.
    expect(after[0] * camera.scale).toBeCloseTo(HUB[0] * camera.scale + legs[0].dx, 6);
    expect(after[1] * camera.scale).toBeCloseTo(HUB[1] * camera.scale + legs[0].dy, 6);
    // And the leg still starts at the hub itself.
    expect((lines()[0].geometry as GeoJSON.LineString).coordinates[0]).toEqual(HUB);
  });

  it("coalesces many move events into one recompute", () => {
    const { controller, listeners } = setup();
    controller.open(HUB, [place("A"), place("B")]);
    for (let i = 0; i < 5; i++) for (const fn of listeners.move ?? []) fn();
    expect(frames).toHaveLength(1);
    flush();
  });

  it("does nothing on a move while closed", () => {
    const { controller, move } = setup();
    expect(controller.isOpen()).toBe(false);
    expect(() => move()).not.toThrow();
    expect(frames).toHaveLength(0);
  });
});

describe("resolving clicks", () => {
  it("resolves the hub, honouring the 44px tap contract rather than the drawn ring", () => {
    // A hub is 26-34px drawn; on touch that demanded near-pixel precision, and a miss
    // used to DESTROY the fan (reviewers).
    const { controller } = setup();
    const leaves = [place("A"), place("B"), place("C")];
    controller.open(HUB, leaves);
    const r = clusterFootprintRadius(leaves.length);
    expect(r).toBeLessThan(MIN_MARK_TAP_RADIUS_PX);
    expect(controller.resolveClick({ x: HUB[0], y: HUB[1] }).kind).toBe("hub");
    // Outside the ring but inside the tap target — probed straight DOWN, the
    // max-clearance direction for 3 leaves (top/30°/150°). Probing along +x sat
    // near-equidistant to the 30° leaf and the nearest-centre arbitration
    // (which is the CONTRACT for genuinely ambiguous points) flipped it when
    // task 062 grew the marks — the old pass margin was 0.4px.
    expect(controller.resolveClick({ x: HUB[0], y: HUB[1] + r + 2 }).kind).toBe("hub");
  });

  it("never claims a hit while closed", () => {
    const { controller } = setup();
    expect(controller.resolveClick({ x: HUB[0], y: HUB[1] }).kind).toBe("miss");
  });

  it("resolves the leaf under the pointer", () => {
    const { controller } = setup();
    const leaves = [place("A"), place("B"), place("C"), place("D")];
    controller.open(HUB, leaves);
    const legs = spiderLegs(leaves.length, { hubRadius: clusterFootprintRadius(leaves.length) });

    const onSecond = { x: HUB[0] + legs[1].dx, y: HUB[1] + legs[1].dy };
    const hit = controller.resolveClick(onSecond);
    expect(hit.kind).toBe("leaf");
    expect(hit.kind === "leaf" ? hit.leaf.name : null).toBe("B");
  });

  it("keeps the widened hub and leaf targets from ever overlapping", () => {
    // Why the single-pass arbitration is unambiguous rather than merely tie-broken: the
    // fan's own ring-zero radius (hub footprint + leaf + gap) already exceeds the tap
    // radius, so a widened hub cannot reach a leaf and vice versa. If a future spacing
    // change broke that, the nearest-centre rule below is what keeps it sane — but this
    // assertion is the reason it never has to.
    for (const n of [2, 4, 8, 12]) {
      const hubRadius = clusterFootprintRadius(n);
      const legs = spiderLegs(n, { hubRadius });
      const nearest = Math.min(...legs.map((l) => Math.hypot(l.dx, l.dy)));
      expect(nearest, `ring 0 for n=${n}`).toBeGreaterThan(MIN_MARK_TAP_RADIUS_PX);
    }
  });

  it("gives a point between hub and leaf to whichever centre is nearer", () => {
    const { controller } = setup();
    const leaves = [place("A"), place("B"), place("C"), place("D")];
    controller.open(HUB, leaves);
    const legs = spiderLegs(leaves.length, { hubRadius: clusterFootprintRadius(leaves.length) });
    const leafPoint = { x: HUB[0] + legs[0].dx, y: HUB[1] + legs[0].dy };
    expect(controller.resolveClick(leafPoint).kind).toBe("leaf");
    expect(controller.resolveClick({ x: HUB[0], y: HUB[1] }).kind).toBe("hub");
    // Nudged a few px off the leaf, still the leaf — the widened target at work.
    expect(
      controller.resolveClick({ x: leafPoint.x + SPIDER_LEAF_RADIUS_PX + 4, y: leafPoint.y }).kind,
    ).toBe("leaf");
  });

  it("reports a genuine miss, so the caller can decide what a miss means", () => {
    const { controller } = setup();
    controller.open(HUB, [place("A"), place("B")]);
    expect(controller.resolveClick({ x: HUB[0] + 300, y: HUB[1] + 300 }).kind).toBe("miss");
  });

  it("collapses when the hub's own button is activated (the keyboard path)", () => {
    const { controller, onActiveChange } = setup();
    controller.open(HUB, [place("A"), place("B")]);
    const click = markers[0].element.listeners.click?.[0];
    expect(click).toBeTypeOf("function");
    click?.({ stopPropagation() {}, preventDefault() {} });
    expect(controller.isOpen()).toBe(false);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
  });
});

describe("closing and teardown", () => {
  it("removes the hub, empties the source, and restores the map exactly once", () => {
    const { controller, el, onActiveChange, data } = setup();
    controller.open(HUB, [place("A"), place("B")]);
    controller.close();
    expect(markers[0].removed).toBe(true);
    expect(data()?.features).toEqual([]);
    expect(el.dataset.amenitySpider).toBeUndefined();
    expect(controller.isOpen()).toBe(false);
    expect(onActiveChange).toHaveBeenCalledTimes(2);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
  });

  it("is idempotent: closing a closed fan does not re-announce a restore", () => {
    // An unconditional announcement would re-apply the amenity filter on every
    // unrelated close and fight the directions view for it.
    const { controller, onActiveChange } = setup();
    controller.close();
    controller.close();
    expect(onActiveChange).not.toHaveBeenCalled();
  });

  it("cancels a pending recompute when it closes", () => {
    const { controller, listeners } = setup();
    controller.open(HUB, [place("A"), place("B")]);
    for (const fn of listeners.move ?? []) fn(); // arm a frame
    controller.close();
    expect(() => flush()).not.toThrow(); // the cancelled frame must be inert
    expect(controller.isOpen()).toBe(false);
  });

  it("dispose detaches every camera listener and leaves nothing drawn", () => {
    const { controller, listeners, data } = setup();
    controller.open(HUB, [place("A"), place("B")]);
    expect(listeners.move).toHaveLength(1);
    expect(listeners.resize).toHaveLength(1);

    controller.dispose();
    expect(listeners.move).toHaveLength(0);
    expect(listeners.resize).toHaveLength(0);
    expect(markers.every((m) => m.removed)).toBe(true);
    expect(data()?.features).toEqual([]);

    // And a post-dispose open must not resurrect a fan over a torn-down map.
    controller.open(HUB, [place("A")]);
    flush();
    expect(markers.filter((m) => !m.removed)).toHaveLength(0);
  });
});

describe("defensive paths", () => {
  it("falls back to a neutral colour for a category it does not know", () => {
    // Guards against a future category reaching the map before its colour does: a
    // fanned leaf with `color: undefined` would paint as a MapLibre error, not a pin.
    const { controller, points } = setup();
    controller.open(HUB, [{ name: "Mystery", category: "spaceports", lat: 44, lng: 26 } as never]);
    expect(String(points()[0].properties?.color)).toMatch(/^#/);
  });

  it("a frame already in flight when dispose lands writes nothing", () => {
    // cancelAnimationFrame cannot recall a callback the browser already dequeued, so
    // the recompute itself has to check.
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { controller, listeners, data } = setup();
    controller.open(HUB, [place("A"), place("B")]);
    for (const fn of listeners.move ?? []) fn(); // arm a frame
    controller.dispose();
    expect(() => flush()).not.toThrow();
    expect(data()?.features).toEqual([]);
  });
});
