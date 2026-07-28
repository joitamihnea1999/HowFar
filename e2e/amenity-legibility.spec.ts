import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Amenity legibility (task 061).
 *
 * The owner's report was that amenities crowd into unreadable clumps. The fix is
 * structural — anything closer than the clustering radius is aggregated at EVERY
 * zoom — so the test for it must be structural too: **no two rendered amenity
 * marks may overlap, at any zoom**.
 *
 * Two things make that a real proof rather than a comforting one:
 *
 * - overlap is measured on **rendered footprints**, not centre distance. Centre
 *   distance is the tempting metric and it is wrong: two count-sized donuts can sit
 *   further apart than the clustering radius and still visually intersect.
 * - the fixtures are **adversarial**, not just realistic: a dense field, a clump
 *   plus a just-outside-the-radius neighbour, and a set of exactly-coincident
 *   places. A real-district sample can pass simply by not containing the bad case.
 */

/** The slice of the exposed map handle these assertions use (`window.__hfMap`,
 * exposed for RENDERED-state e2e — see mind map [16]). Declared structurally so
 * the spec needs no maplibre types. */
interface MapHandle {
  getZoom: () => number;
  jumpTo: (opts: { center: [number, number]; zoom: number }) => void;
  zoomTo: (zoom: number, opts?: { duration?: number }) => void;
  isSourceLoaded: (id: string) => boolean;
  areTilesLoaded: () => boolean;
  getContainer: () => HTMLElement;
  project: (c: [number, number]) => { x: number; y: number };
  unproject: (p: [number, number]) => { lng: number; lat: number };
  querySourceFeatures: (
    id: string,
    opts: { filter: unknown[] },
  ) => { geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> | null }[];
  queryRenderedFeatures: (opts: { layers: string[] }) => {
    geometry: { type: string; coordinates: unknown };
    properties: Record<string, unknown> | null;
  }[];
  hasImage: (id: string) => boolean;
}
declare global {
  interface Window {
    __hfMap?: MapHandle;
  }
}

const ORIGIN = { lat: 44.4268, lng: 26.1025 };
const CATS = ["groceries", "pharmacies", "parks", "schools", "transit"] as const;

// Must mirror src/features/amenities/amenity-cluster.ts.
const PIN_RADIUS_STOPS: [number, number][] = [
  [11, 4],
  [13, 6],
  [15, 8.5],
  [17, 11],
  [19, 13],
];
const MAP_MAX_ZOOM = 22;
// Mirrors src/features/amenities/amenity-cluster.ts: MapLibre paints
// `circle-stroke-width` OUTSIDE the radius, so it is part of what the user sees. The
// invariant used a bare radius before and could pass on pairs overlapping by ~2px.
const PIN_STROKE_PX = 1.75;
const PIN_HOVER_SCALE = 1.4;
const PIN_HOVER_STROKE_PX = 2.5;
// Mirrors src/features/amenities/amenity-spider.ts.
const SPIDER_MAX_LEAVES = 12;
const SPIDER_LEAF_RADIUS_PX = 9;
const SPIDER_LEAF_STROKE_PX = 2;

function ring(minutes: number, d: number) {
  return {
    minutes,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [ORIGIN.lng - d, ORIGIN.lat - d],
          [ORIGIN.lng + d, ORIGIN.lat - d],
          [ORIGIN.lng + d, ORIGIN.lat + d],
          [ORIGIN.lng - d, ORIGIN.lat + d],
          [ORIGIN.lng - d, ORIGIN.lat - d],
        ],
      ],
    },
  };
}
const WALK = { origin: ORIGIN, rings: [ring(15, 0.02), ring(30, 0.03), ring(45, 0.04)] };

interface Fixture {
  lat: number;
  lng: number;
  name: string;
  category: string;
  osmType?: string;
  osmId?: number;
  distanceMeters?: number;
}

/** A dense field plus the two adversarial shapes clustering has to survive. */
function adversarialAmenities(): Fixture[] {
  const out: Fixture[] = [];
  let n = 0;
  // (1) Dense field — reproduces the reported screenshot conditions.
  for (const c of CATS) {
    for (let i = 0; i < 24; i++) {
      const t = i / 24;
      out.push({
        lat: ORIGIN.lat - 0.009 + t * 0.018 + ((n % 4) - 1.5) * 0.0005,
        lng: ORIGIN.lng - 0.011 + Math.sin(t * 5) * 0.008 + ((n % 3) - 1) * 0.0007,
        name: `${c} ${i}`,
        category: c,
        osmType: "node",
        osmId: 2000 + n,
        distanceMeters: 90 + i * 25,
      });
      n++;
    }
  }
  // (2) EXACTLY coincident trio: cannot be separated by zooming at any zoom, so
  // it must remain one aggregate and stay readable only through its leaves list.
  ["groceries", "pharmacies", "schools"].forEach((c, i) =>
    out.push({
      lat: ORIGIN.lat + 0.0022,
      lng: ORIGIN.lng - 0.0020,
      name: `Mall unit ${i + 1}`,
      category: c,
      osmType: "node",
      osmId: 4000 + i,
      distanceMeters: 260 + i,
    }),
  );
  // (3) A clump with a NEAR neighbour just outside the clustering radius — the
  // configuration where a naive radius choice lets a donut and a pin collide.
  for (let i = 0; i < 4; i++) {
    out.push({
      lat: ORIGIN.lat - 0.0035 + i * 0.00004,
      lng: ORIGIN.lng + 0.0040 + i * 0.00004,
      name: `Tight ${i + 1}`,
      category: "transit",
      osmType: "node",
      osmId: 5000 + i,
      distanceMeters: 400 + i,
    });
  }
  out.push({
    lat: ORIGIN.lat - 0.0035,
    lng: ORIGIN.lng + 0.0046,
    name: "Near neighbour",
    category: "parks",
    osmType: "node",
    osmId: 5100,
    distanceMeters: 430,
  });
  // (4) CENTROID-DRIFT case (found in review): a seed plus members spread widely to ONE
  // side drags the cluster centroid off the seed and toward a lone pin placed just
  // beyond the clustering radius. That pin is legally unclustered (it is far from the
  // SEED) yet ends up within a few px of the donut — the overlap that donut-vs-donut
  // merging alone could never see.
  for (let i = 0; i < 6; i++) {
    out.push({
      lat: ORIGIN.lat + 0.0060,
      lng: ORIGIN.lng - 0.0060 + i * 0.00028,
      name: `Drift member ${i + 1}`,
      category: "groceries",
      osmType: "node",
      osmId: 7000 + i,
      distanceMeters: 700 + i,
    });
  }
  out.push({
    lat: ORIGIN.lat + 0.0060,
    lng: ORIGIN.lng - 0.0060 + 0.00215,
    name: "Drift-adjacent pin",
    category: "schools",
    osmType: "node",
    osmId: 7100,
    distanceMeters: 760,
  });
  return out;
}

const AMENITIES = {
  origin: ORIGIN,
  walkMinutes: 15,
  // Deliberately ABOVE the returned marker count so the truncation note is exercised.
  counts: { groceries: 400, pharmacies: 41, parks: 30, schools: 31, transit: 32 },
  amenities: adversarialAmenities(),
};

async function stub(page: Page, amenities: unknown = AMENITIES) {
  await page.route("**/api/geocode**", (r) =>
    r.fulfill({ json: { ...ORIGIN, label: "Piața Unirii, București" } }),
  );
  await page.route("**/api/suggest**", (r) => r.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (r) => r.fulfill({ json: WALK }));
  await page.route("**/api/amenities**", (r) => r.fulfill({ json: amenities }));
}

async function loadAndSearch(page: Page): Promise<Locator> {
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-amenity-count", /\d/);
  await expect(map).toHaveAttribute("data-camera-settled", "true", { timeout: 10_000 });
  return map;
}

function pinRadius(zoom: number): number {
  const [z0, r0] = PIN_RADIUS_STOPS[0];
  const last = PIN_RADIUS_STOPS[PIN_RADIUS_STOPS.length - 1];
  if (zoom <= z0) return r0;
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < PIN_RADIUS_STOPS.length; i++) {
    const [z1, r1] = PIN_RADIUS_STOPS[i];
    const [zp, rp] = PIN_RADIUS_STOPS[i - 1];
    if (zoom <= z1) return rp + ((zoom - zp) / (z1 - zp)) * (r1 - rp);
  }
  return last[1];
}

/** Jump to a zoom and wait for the source to finish re-clustering at it. */
async function jumpTo(page: Page, zoom: number, center = [ORIGIN.lng, ORIGIN.lat]) {
  await page.evaluate(
    ([z, lng, lat]) => {
      const m = window.__hfMap;
      m?.jumpTo({ center: [lng as number, lat as number], zoom: z as number });
    },
    [zoom, center[0], center[1]],
  );
  // Reading before the new zoom's tiles land would measure the PREVIOUS
  // clustering — a subtle way to make this whole suite meaningless.
  // NOT swallowed: a review pointed out that catching this let the whole invariant pass
  // while measuring the PREVIOUS zoom's marks — the failure mode this wait exists to
  // prevent. If the source never settles, that is a real result and must fail loudly.
  await page.waitForFunction(
    () => {
      const m = window.__hfMap;
      return Boolean(m?.isSourceLoaded("amenities") && m?.areTilesLoaded());
    },
    null,
    { timeout: 20_000 },
  );
  // Donuts are DOM markers reconciled on an animation frame, so tiles being loaded
  // is necessary but not sufficient: mid-reconcile the previous zoom's marks can
  // still be present, which would read as an overlap that never actually rendered.
  // Wait for the mark set to be STABLE across consecutive frames instead of
  // guessing with a fixed sleep (which is also what makes this robust under the
  // CPU contention of a parallel run).
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __hfStable?: { sig: string; hits: number } };
      const m = window.__hfMap;
      if (!m) return false;
      let pins = 0;
      try {
        pins = m.queryRenderedFeatures({ layers: ["amenity-markers"] }).length;
      } catch {
        pins = 0;
      }
      const donuts = Array.from(document.querySelectorAll<HTMLElement>(".hf-amenity-cluster"))
        .map((el) => `${el.dataset.clusterTotal}@${el.style.transform}`)
        .sort()
        .join("|");
      const sig = `${m.getZoom().toFixed(3)}:${pins}:${donuts}`;
      const prev = w.__hfStable;
      w.__hfStable = prev && prev.sig === sig ? { sig, hits: prev.hits + 1 } : { sig, hits: 0 };
      return (w.__hfStable?.hits ?? 0) >= 3;
    },
    null,
    { timeout: 20_000 },
  );
}

/** Every visible mark, in container pixels, with its rendered radius. */
async function visibleMarks(page: Page) {
  const raw = await page.evaluate(() => {
    const m = window.__hfMap;
    if (!m) return null;
    const box = m.getContainer().getBoundingClientRect();
    const inView = (x: number, y: number) => x >= 0 && y >= 0 && x <= box.width && y <= box.height;

    const pins: { name: string; x: number; y: number }[] = [];
    const seen = new Set<string>();
    let features: ReturnType<MapHandle["queryRenderedFeatures"]> = [];
    try {
      features = m.queryRenderedFeatures({ layers: ["amenity-markers"] });
    } catch {
      features = [];
    }
    for (const f of features) {
      if (f.geometry.type !== "Point") continue;
      const coords = f.geometry.coordinates as [number, number];
      // A feature is returned once per tile it appears in; dedupe by position.
      const key = `${coords[0]},${coords[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p = m.project(coords);
      if (!inView(p.x, p.y)) continue;
      pins.push({ name: String(f.properties?.name ?? "pin"), x: p.x, y: p.y });
    }

    const donuts: { name: string; x: number; y: number; r: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".hf-amenity-cluster"))) {
      const b = el.getBoundingClientRect();
      const x = b.x + b.width / 2 - box.x;
      const y = b.y + b.height / 2 - box.y;
      if (!inView(x, y)) continue;
      donuts.push({ name: `cluster(${el.dataset.clusterTotal})`, x, y, r: b.width / 2 });
    }

    // Fanned leaves (task 061 W20) are marks too, so the no-overlap invariant has to
    // measure them; leaving them out would let a fan reintroduce the crowding it
    // exists to resolve without any test noticing.
    const leaves: { name: string; x: number; y: number }[] = [];
    let leafFeatures: ReturnType<MapHandle["queryRenderedFeatures"]> = [];
    try {
      leafFeatures = m.queryRenderedFeatures({ layers: ["amenity-spider-markers"] });
    } catch {
      leafFeatures = [];
    }
    const seenLeaf = new Set<string>();
    for (const f of leafFeatures) {
      if (f.geometry.type !== "Point") continue;
      const coords = f.geometry.coordinates as [number, number];
      const key = `${coords[0]},${coords[1]}`;
      if (seenLeaf.has(key)) continue;
      seenLeaf.add(key);
      const p = m.project(coords);
      if (!inView(p.x, p.y)) continue;
      leaves.push({ name: `leaf(${String(f.properties?.name ?? "")})`, x: p.x, y: p.y });
    }
    return { zoom: m.getZoom(), pins, donuts, leaves };
  });
  if (!raw) throw new Error("map handle unavailable");
  // The REAL rendered footprint: radius + the outline painted outside it.
  const r = pinRadius(raw.zoom) + PIN_STROKE_PX;
  const leafR = SPIDER_LEAF_RADIUS_PX + SPIDER_LEAF_STROKE_PX;
  return {
    zoom: raw.zoom,
    marks: [
      ...raw.pins.map((p) => ({ ...p, r })),
      ...raw.donuts,
      ...raw.leaves.map((l) => ({ ...l, r: leafR })),
    ],
    pinCount: raw.pins.length,
    donutCount: raw.donuts.length,
    leafCount: raw.leaves.length,
    /** Footprints as they would be at their largest — a hovered pin. Collision
     * RESERVES this, so the rendered set must be clear at this size too. */
    hoverMarks: [
      ...raw.pins.map((p) => ({
        ...p,
        r: pinRadius(raw.zoom) * PIN_HOVER_SCALE + PIN_HOVER_STROKE_PX,
      })),
      ...raw.donuts,
      ...raw.leaves.map((l) => ({ ...l, r: leafR })),
    ],
    /** Sum of every aggregate's declared count plus the individually drawn marks —
     * can never exceed the number of places actually in the source. */
    declaredTotal:
      raw.donuts.reduce((n, d) => n + (Number(/cluster\((\d+)\)/.exec(d.name)?.[1]) || 0), 0) +
      raw.pins.length,
  };
}

function overlappingPairs(marks: { name: string; x: number; y: number; r: number }[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const a = marks[i];
      const b = marks[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) pairs.push(`${a.name} ↔ ${b.name}`);
    }
  }
  return pairs;
}

/**
 * Click the first cluster donut THROUGH the map canvas.
 *
 * Donuts are deliberately `pointer-events: none` (as real buttons they swallowed
 * map gestures — a long-press over one gave no directions), so the map's click
 * handler is what resolves them. Clicking the canvas at the donut's centre is
 * therefore the true user path, and Playwright cannot click the element directly.
 */
async function clickFirstDonut(page: Page) {
  const donut = page.locator(".hf-amenity-cluster").first();
  await expect(donut).toBeAttached();
  const box = await donut.boundingBox();
  const canvas = page.locator(".maplibregl-canvas");
  const canvasBox = await canvas.boundingBox();
  if (!box || !canvasBox) throw new Error("donut or canvas has no box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Sum of every aggregate's declared count plus the individually drawn pins.
 *
 * A deliberately CHEAP probe (no footprint maths, no symbol queries): it is sampled
 * many times per zoom transition to catch a transient miscount, so the full
 * `visibleMarks` pass would make the test time out rather than more rigorous.
 */
async function declaredTotal(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = window.__hfMap;
    if (!m) return 0;
    let sum = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".hf-amenity-cluster"))) {
      sum += Number(el.dataset.clusterTotal) || 0;
    }
    const seen = new Set<string>();
    for (const f of m.queryRenderedFeatures({ layers: ["amenity-markers"] })) {
      if (f.geometry.type !== "Point") continue;
      const c = f.geometry.coordinates as [number, number];
      const key = `${c[0]},${c[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sum += 1;
    }
    return sum;
  });
}

/** Click the donut whose centre count is exactly `total`, through the canvas.
 * Targeted rather than "the first one": in a dense fixture the first donut in DOM
 * order is arbitrary, and a splittable one would ZOOM instead of fanning, making the
 * test assert something it did not mean to. */
async function clickDonutWithTotal(page: Page, total: number) {
  const at = await page.evaluate((want) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(".hf-amenity-cluster")).find(
      (node) => Number(node.dataset.clusterTotal) === want,
    );
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, total);
  if (!at) throw new Error(`no donut showing ${total}`);
  await page.mouse.click(at.x, at.y);
}

test("no two amenity marks overlap at ANY zoom, including the map maximum", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await stub(page);
  await loadAndSearch(page);

  const observed: string[] = [];
  for (const zoom of [11, 12, 13, 14, 15, 16, 17, 18, 20, MAP_MAX_ZOOM]) {
    await jumpTo(page, zoom);
    const { marks, hoverMarks, pinCount, donutCount } = await visibleMarks(page);
    const overlaps = overlappingPairs(marks);
    // Report the offending pair names, so a failure says WHICH marks collided.
    expect(overlaps, `overlaps at z${zoom}`).toEqual([]);
    // …and again at the size a HOVER would grow the pins to. The collision pass
    // reserves that size, so this must hold as well; reserving only the resting
    // footprint previously let a hover regrow a cleared overlap.
    expect(overlappingPairs(hoverMarks), `hovered overlaps at z${zoom}`).toEqual([]);
    observed.push(`z${zoom}: ${pinCount} pins + ${donutCount} donuts`);
  }
  // Non-vacuity: the fixture must actually have produced marks to compare.
  expect(observed.some((line) => !line.includes("0 pins + 0 donuts"))).toBe(true);
  expect(errors).toEqual([]);
});

test("no aggregate ever claims more places than the map actually holds", async ({ page }) => {
  // A truthfulness invariant asserted against the fixture size, so it holds no matter
  // HOW the implementation keeps it: no visible mark may claim more places than exist.
  //
  // HONEST LIMIT — this is a non-regression check, NOT proof of the review fix.
  // F3 is the mid-zoom double count: while a zoom is in flight the source holds the OLD
  // tiling and the NEW one, whose clusters cover the same places under different ids,
  // and merging across them paints ~2x the real total. I checked whether this test
  // catches that by disabling the generation filter and rebuilding: it stayed GREEN.
  // The window is a frame or two and a Playwright `evaluate` round-trip is longer than
  // that, so the sampler cannot reliably land inside it. The partition is proven where
  // it can be observed deterministically instead — `pickClusterGeneration` in
  // amenity-cluster.test.ts, and the controller wiring in
  // amenity-cluster-controller.test.ts ("keeps ONE tile generation…"), which DOES go
  // red when the filter is removed.
  // Deliberate headroom: this spec drives real zoom animations and now waits LOUDLY for
  // source readiness (an earlier version swallowed that timeout, which is what let it pass
  // while measuring stale marks). It takes ~30s uncontended, so the default 60s budget put
  // it on a knife edge whenever the whole suite runs in parallel.
  test.setTimeout(150_000);
  await stub(page);
  await loadAndSearch(page);
  const places = AMENITIES.amenities.length;

  // Sample repeatedly ACROSS zoom transitions, not just at rest: the defect is
  // transient (it lasts until the stale tiles evict), so settling first would hide it.
  for (const zoom of [13.4, 15.5]) {
    await page.evaluate((z) => window.__hfMap?.zoomTo(z, { duration: 300 }), zoom);
    for (let i = 0; i < 5; i++) {
      expect(await declaredTotal(page), `declared total mid-zoom to z${zoom}`).toBeLessThanOrEqual(
        places,
      );
      await page.waitForTimeout(50);
    }
  }
});

test("MapLibre still stamps the tile zoom the generation filter depends on", async ({ page }) => {
  // The mid-zoom double-count fix partitions candidates by `feature._z`, which is
  // MapLibre-private. If an upgrade renames or drops it, `pickClusterGeneration` keeps
  // every candidate — i.e. the ~2x "donut that lies" comes back with no unit test going
  // red, because the unit tests necessarily feed a hand-set `_z` (review,
  // review). This is the assertion that makes that dependency fail LOUD instead.
  await stub(page);
  await loadAndSearch(page);
  await jumpTo(page, 14);

  const stamped = await page.evaluate(() => {
    const m = window.__hfMap;
    if (!m) return null;
    const seen = { total: 0, numericZ: 0, zooms: [] as number[] };
    for (const filter of [["has", "point_count"], ["!", ["has", "point_count"]]]) {
      for (const f of m.querySourceFeatures("amenities", { filter })) {
        seen.total += 1;
        const z = (f as unknown as { _z?: unknown })._z;
        if (typeof z === "number" && Number.isFinite(z)) {
          seen.numericZ += 1;
          if (!seen.zooms.includes(z)) seen.zooms.push(z);
        }
      }
    }
    return seen;
  });
  if (!stamped) throw new Error("map handle unavailable");
  // Non-vacuity first: there must be features to inspect.
  expect(stamped.total).toBeGreaterThan(0);
  expect(stamped.numericZ).toBe(stamped.total);
  // And the value has to be a plausible tile zoom, not some other number.
  for (const z of stamped.zooms) expect(z).toBeGreaterThanOrEqual(0);
  for (const z of stamped.zooms) expect(z).toBeLessThanOrEqual(23);
});

test("keyboard activation of a coincident mark opens an operable list, not a fan", async ({ page }) => {
  // The fan is pointer-only: its leaves are WebGL geometry with no focusable affordance,
  // and opening it REMOVES the donut button the keyboard user was standing on — so for
  // them it is a dead end (reviewers). Keyboard activation is
  // therefore routed to the list, which must itself be operable: focus moves into it and
  // Escape dismisses it.
  await stub(page, coincident(3, TRIO_AT));
  const map = await loadAndSearch(page);
  await jumpTo(page, 17, [TRIO_AT.lng, TRIO_AT.lat]);

  const donut = page.locator(".hf-amenity-cluster").first();
  await expect(donut).toBeAttached();
  await donut.focus();
  await page.keyboard.press("Enter");

  // The LIST, not the fan.
  const popup = page.getByTestId("cluster-popup");
  await expect(popup).toBeVisible();
  await expect(map).not.toHaveAttribute("data-amenity-spider", /\d+/);
  for (const name of ["Mall unit 1", "Mall unit 2", "Mall unit 3"]) {
    await expect(popup.getByText(name, { exact: true })).toBeVisible();
  }
  // Focus is inside the popup — not stranded on a button the recluster may rebuild.
  await expect
    .poll(async () =>
      page.evaluate(() =>
        Boolean(document.activeElement?.closest(".maplibregl-popup")),
      ),
    )
    .toBe(true);
  // …and Escape dismisses it, which it previously did not.
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});

test("a dense area aggregates into counted donuts instead of a crowd of pins", async ({ page }) => {
  await stub(page);
  const map = await loadAndSearch(page);
  await jumpTo(page, 13);

  const { pinCount, donutCount } = await visibleMarks(page);
  // The reported defect: ~130 individual markers fighting for the same pixels.
  // At city zoom the same data must read as a modest number of aggregates.
  expect(donutCount).toBeGreaterThan(0);
  expect(pinCount + donutCount).toBeLessThan(40);
  await expect(map).toHaveAttribute("data-amenity-clusters", /\d+/);
  // Category is still legible on an aggregate: the donut names its breakdown.
  const donut = page.locator(".hf-amenity-cluster").first();
  await expect(donut).toHaveAttribute("aria-label", /places here: .*\d+ /);
});

/** A group of `count` places at ONE coordinate — the case zooming can never split. */
function coincident(count: number, at = { lat: ORIGIN.lat + 0.0022, lng: ORIGIN.lng - 0.002 }) {
  return {
    origin: ORIGIN,
    walkMinutes: 15,
    counts: { groceries: count, pharmacies: 0, parks: 0, schools: 0, transit: 0 },
    amenities: Array.from({ length: count }, (_, i) => ({
      ...at,
      name: `Mall unit ${i + 1}`,
      category: (["groceries", "pharmacies", "schools"] as const)[i % 3],
      osmType: "node",
      osmId: 4000 + i,
      distanceMeters: 260 + i,
    })),
  };
}

const TRIO_AT = { lat: ORIGIN.lat + 0.0022, lng: ORIGIN.lng - 0.002 };

test("coincident places stay ONE mark until asked, then FAN OUT into individual marks", async ({ page }) => {
  // The case that motivates the whole resolution ladder: places at an identical
  // coordinate can never be separated by zooming. Aggregated they stay one readable
  // mark; activated, they fan onto leader lines so each is SEEN as itself — which is
  // what Intent asked for and what the leaves list alone did not give.
  await stub(page, coincident(3, TRIO_AT));
  const map = await loadAndSearch(page);

  for (const zoom of [15, 18, MAP_MAX_ZOOM]) {
    await jumpTo(page, zoom, [TRIO_AT.lng, TRIO_AT.lat]);
    const { pinCount, donutCount, marks } = await visibleMarks(page);
    expect(donutCount, `donuts at z${zoom}`).toBe(1);
    expect(pinCount, `pins at z${zoom}`).toBe(0);
    expect(overlappingPairs(marks)).toEqual([]);
  }

  await clickFirstDonut(page);

  // Three individual marks, each with its own name, none overlapping — the fan is
  // held to the same invariant as the map it replaces.
  await expect(map).toHaveAttribute("data-amenity-spider", "3");
  // A source write becomes queryable only once MapLibre has processed the tile, so
  // poll the REAL rendered count rather than sampling once (the same lag the icon
  // assertions below have to poll for).
  await expect.poll(async () => (await visibleMarks(page)).leafCount, { timeout: 15_000 }).toBe(3);
  const fanned = await visibleMarks(page);
  expect(overlappingPairs(fanned.marks), "fan overlaps").toEqual([]);
  const names = await page.evaluate(() =>
    (window.__hfMap?.queryRenderedFeatures({ layers: ["amenity-spider-markers"] }) ?? []).map((f) =>
      String(f.properties?.name ?? ""),
    ),
  );
  expect([...new Set(names)].sort()).toEqual(["Mall unit 1", "Mall unit 2", "Mall unit 3"]);
  // Every leaf is joined to the hub it came from, or a fanned pin is a place floating
  // where no place is.
  const legs = await page.evaluate(
    () => window.__hfMap?.queryRenderedFeatures({ layers: ["amenity-spider-legs"] }).length ?? 0,
  );
  expect(legs).toBeGreaterThan(0);
  // The hub stays, as the same donut, so the user keeps track of what they opened.
  await expect(page.locator('.hf-amenity-cluster[data-spider-hub="1"]')).toBeAttached();

  // A fanned leaf is a real, clickable place — not decoration.
  const leaf = await page.evaluate(() => {
    const m = window.__hfMap;
    const f = (m?.queryRenderedFeatures({ layers: ["amenity-spider-markers"] }) ?? [])[0];
    if (!m || !f || f.geometry.type !== "Point") return null;
    const box = m.getContainer().getBoundingClientRect();
    const p = m.project(f.geometry.coordinates as [number, number]);
    return { x: box.x + p.x, y: box.y + p.y };
  });
  if (!leaf) throw new Error("no fanned leaf to click");
  await page.mouse.click(leaf.x, leaf.y);
  await expect(page.getByTestId("poi-popup")).toBeVisible();
});

test("the fan owns the map while open, and Escape gives everything back", async ({ page }) => {
  // A fan's positions are provably clear of each other and of their hub, but nothing
  // can promise separation from an unrelated donut nearby — so opening one hides the
  // rest. That is also what makes the fan readable in a dense district.
  //
  // Fixture: the coincident trio (which fans) PLUS a scattered field around it, so
  // there genuinely is a "rest" whose disappearance and restoration can be observed.
  const trio = coincident(3, TRIO_AT);
  await stub(page, {
    ...trio,
    counts: { groceries: 3, pharmacies: 0, parks: 6, schools: 0, transit: 0 },
    amenities: [
      ...trio.amenities,
      ...Array.from({ length: 6 }, (_, i) => ({
        lat: TRIO_AT.lat + 0.0016 * Math.cos((i / 6) * Math.PI * 2),
        lng: TRIO_AT.lng + 0.0016 * Math.sin((i / 6) * Math.PI * 2),
        name: `Neighbour ${i + 1}`,
        category: "parks",
        osmType: "node",
        osmId: 8000 + i,
        distanceMeters: 300 + i * 10,
      })),
    ],
  });
  const map = await loadAndSearch(page);
  await jumpTo(page, 17, [TRIO_AT.lng, TRIO_AT.lat]);

  const before = await visibleMarks(page);
  expect(before.pinCount + before.donutCount).toBeGreaterThan(1);

  await clickDonutWithTotal(page, 3);
  await expect(map).toHaveAttribute("data-amenity-spider", /\d+/);
  await expect(map).toHaveAttribute("data-amenity-declutter", "on");
  // The filter and the stamp are applied synchronously, but `queryRenderedFeatures`
  // reflects the last PAINTED frame — so the whole rendered state has to be asserted as
  // one retried predicate (repo gotcha-10), not sampled once after a partial wait.
  await expect(async () => {
    const open = await visibleMarks(page);
    expect(open.leafCount).toBeGreaterThan(1); // the fan is drawn…
    expect(open.donutCount).toBe(1); // …exactly one donut remains: the hub…
    expect(open.pinCount).toBe(0); // …and every other amenity mark is gone.
    expect(overlappingPairs(open.marks)).toEqual([]);
  }).toPass({ timeout: 15_000 });

  await page.keyboard.press("Escape");
  await expect(map).not.toHaveAttribute("data-amenity-spider", /\d+/);
  await expect(map).toHaveAttribute("data-amenity-declutter", "off");
  await expect
    .poll(async () => (await visibleMarks(page)).leafCount, { timeout: 10_000 })
    .toBe(0);
  // The marks the fan replaced are all back.
  await expect
    .poll(async () => {
      const after = await visibleMarks(page);
      return after.pinCount + after.donutCount;
    }, { timeout: 10_000 })
    .toBeGreaterThan(1);
});

test("clicking the hub collapses its own fan", async ({ page }) => {
  await stub(page, coincident(4, TRIO_AT));
  const map = await loadAndSearch(page);
  await jumpTo(page, 17, [TRIO_AT.lng, TRIO_AT.lat]);
  await clickDonutWithTotal(page, 4);
  await expect(map).toHaveAttribute("data-amenity-spider", "4");

  // The hub is the collapse affordance, and it announces that job.
  const hub = page.locator('.hf-amenity-cluster[data-spider-hub="1"]');
  await expect(hub).toHaveAttribute("aria-label", /collapse/i);
  await clickFirstDonut(page); // same screen position — the hub
  await expect(map).not.toHaveAttribute("data-amenity-spider", /\d+/);
});

test("a group too large to fan legibly still resolves through its list", async ({ page }) => {
  // The ladder's floor. A fan of 40 legs would be less readable than the list it
  // replaced, so past SPIDER_MAX_LEAVES the list stays the answer — and it must still
  // name every member.
  const COUNT = SPIDER_MAX_LEAVES + 4;
  await stub(page, coincident(COUNT, TRIO_AT));
  const map = await loadAndSearch(page);
  await jumpTo(page, 18, [TRIO_AT.lng, TRIO_AT.lat]);

  await clickFirstDonut(page);
  await expect(map).not.toHaveAttribute("data-amenity-spider", /\d+/);
  const popup = page.getByTestId("cluster-popup");
  await expect(popup).toBeVisible();
  await expect(popup).toContainText(`${COUNT} places here`);
  for (const name of ["Mall unit 1", `Mall unit ${COUNT}`]) {
    await expect(popup.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(popup).toContainText("260 m");

  // A row opens that place's own detail — the list is a router, not a dead end.
  await popup.getByText("Mall unit 2", { exact: true }).click();
  await expect(page.getByTestId("poi-popup")).toBeVisible();
});

test("a cluster that CAN be split zooms in instead of listing", async ({ page }) => {
  // Needs a donut that is ONE supercluster: in the dense fixture, screen-space
  // agglomeration merges neighbouring donuts, and a merged mark deliberately lists
  // (zooming cannot "unmerge" a collision) — so this uses a fixture with a single
  // tight pair, well clear of anything else, that genuinely splits when zoomed.
  const PAIR = [
    { dlat: 0.0004, dlng: 0.0004 },
    { dlat: 0.00055, dlng: 0.00055 },
  ];
  await stub(page, {
    origin: ORIGIN,
    walkMinutes: 15,
    counts: { groceries: 1, pharmacies: 1, parks: 0, schools: 0, transit: 0 },
    amenities: PAIR.map((p, i) => ({
      lat: ORIGIN.lat + p.dlat,
      lng: ORIGIN.lng + p.dlng,
      name: `Splittable ${i + 1}`,
      category: i === 0 ? "groceries" : "pharmacies",
      osmType: "node",
      osmId: 6000 + i,
      distanceMeters: 150 + i,
    })),
  });
  await loadAndSearch(page);
  await jumpTo(page, 14);

  // Precondition: exactly one donut, and it holds both places.
  const { donutCount } = await visibleMarks(page);
  expect(donutCount).toBe(1);
  const before = await page.evaluate(() => window.__hfMap?.getZoom() ?? 0);

  await clickFirstDonut(page);
  // Splittable ⇒ the camera moves closer rather than opening a list.
  await expect
    .poll(async () => page.evaluate(() => window.__hfMap?.getZoom() ?? 0), { timeout: 10_000 })
    .toBeGreaterThan(before);
  await expect(page.getByTestId("cluster-popup")).toHaveCount(0);
});

test("individual pins carry category icons and show place names when zoomed in", async ({ page }) => {
  await stub(page, {
    origin: ORIGIN,
    walkMinutes: 15,
    counts: { groceries: 1, pharmacies: 1, parks: 1, schools: 1, transit: 1 },
    amenities: [
      ["Mega Image Unirii", "groceries", 0.0012, 0.0009],
      ["Farmacia Catena", "pharmacies", -0.0011, 0.0014],
      ["Parcul Unirii", "parks", 0.0015, -0.0013],
      ["Școala Gimnazială 1", "schools", -0.0014, -0.0011],
      ["Stație Unirii", "transit", 0.0005, 0.0018],
    ].map(([name, category, dlat, dlng], i) => ({
      lat: ORIGIN.lat + (dlat as number),
      lng: ORIGIN.lng + (dlng as number),
      name: name as string,
      category: category as string,
      osmType: "node",
      osmId: 3000 + i,
      distanceMeters: 120 + i * 40,
    })),
  });
  const map = await loadAndSearch(page);

  // Icons replaced the single-letter glyphs, and the stamp only lands once every
  // sprite image is actually registered — so it asserts availability, not intent.
  await expect(map).toHaveAttribute("data-amenity-encoding", "color+icon");

  await jumpTo(page, 17);
  // Symbol layers are queryable only once MapLibre has PLACED their symbols, which
  // can lag the tile load by a frame or two — poll rather than sampling once, or the
  // assertion becomes a race rather than a fact.
  const symbolCounts = async () =>
    page.evaluate(() => {
      const m = window.__hfMap;
      if (!m) return { icons: 0, labels: 0, allImages: false };
      return {
        icons: m.queryRenderedFeatures({ layers: ["amenity-icons"] }).length,
        labels: m.queryRenderedFeatures({ layers: ["amenity-labels"] }).length,
        allImages: ["groceries", "pharmacies", "parks", "schools", "transit"].every((k) =>
          m.hasImage(`amenity-icon-${k}`),
        ),
      };
    });
  await expect.poll(async () => (await symbolCounts()).allImages).toBe(true);
  await expect.poll(async () => (await symbolCounts()).icons, { timeout: 15_000 }).toBeGreaterThan(0);
  // Names are the payoff of collision-managed labels — the map showed none before.
  await expect.poll(async () => (await symbolCounts()).labels, { timeout: 15_000 }).toBeGreaterThan(0);
});

test("hiding a category re-aggregates so donut totals stay truthful", async ({ page }) => {
  // Under clustering, `setFilter` cannot re-count a cluster: hidden categories
  // would remain inside the donut totals. Selecting one category must therefore
  // recluster, and every donut must then be single-category.
  await stub(page);
  const map = await loadAndSearch(page);
  await page.getByRole("button", { name: "Hide all" }).click();
  await expect(map).toHaveAttribute("data-amenity-count", "0");
  await page.getByRole("button", { name: /^Transit stops:/ }).click();
  await expect(map).toHaveAttribute("data-amenity-count", /[1-9]/);
  await jumpTo(page, 13);

  const breakdowns = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".hf-amenity-cluster")).map(
      (el) => el.getAttribute("aria-label") ?? "",
    ),
  );
  expect(breakdowns.length).toBeGreaterThan(0);
  for (const label of breakdowns) {
    expect(label).toMatch(/transit stops/i);
    for (const other of ["groceries", "pharmacies", "parks & green", "schools"]) {
      expect(label.toLowerCase()).not.toContain(other);
    }
  }
});

test("the browser list shows distances, and the cap is admitted WITHOUT opening it", async ({ page }) => {
  await stub(page);
  await loadAndSearch(page);

  // The counts (534) exceed the returned markers, so the cap must be stated where the
  // chips are — not hidden behind "Browse places", which left the default view showing
  // chips claiming hundreds against donuts covering only the capped set.
  await expect(page.getByTestId("amenity-cap-note")).toBeVisible();
  // Deliberately does NOT assert an "N of M" pair: the chip totals count raw places
  // while the map's markers can merge several of them (coincident transit stops), so
  // quoting both numbers side by side compared different units (found in review).
  await expect(page.getByTestId("amenity-cap-note")).toContainText(/every place in range \(\d+\)/);
  await expect(page.getByTestId("amenity-cap-note")).toContainText(/nearest of them/);

  await page.getByRole("button", { name: "Browse places" }).click();
  // Distance was already served but discarded by the client; the list is where it
  // answers the product's actual question.
  await expect(page.getByTestId("amenity-browser")).toContainText(/\d+ m|\d+(\.\d)? km/);
});
