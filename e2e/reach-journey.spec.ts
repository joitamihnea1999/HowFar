import { expect, test, type Page } from "@playwright/test";
import { emptyAmenities } from "./amenity-fixtures";

// Visual right-click journey (task 054; unified to public-transport-only in
// task 060), migrated to the phone-first preset client (task 022): a right-click
// in ANY mode auto-switches to Public transport and DRAWS the trip on the map
// (`data-reach-journey`), and ties popup-step hover to on-map highlight
// (`data-reach-hover`); closing / a new selection / a mode change clears the draw.
// A plan with no transit leg is reported as "No public-transport route" (no draw).
// The preset client suppresses amenity markers (deferred to a later pass), so the amenity
// DECLUTTER half of task 054/061 is out of scope here — the journey draw/clear
// behaviour is what this file now proves. Provider calls stubbed by exact path;
// the right-click is a native right-button click → contextmenu.

function polyRing(minutes: number, d: number) {
  return {
    minutes,
    geometry: {
      type: "MultiPolygon",
      coordinates: [[[
        [26.1025 - d, 44.4268 - d],
        [26.1025 + d, 44.4268 - d],
        [26.1025 + d, 44.4268 + d],
        [26.1025 - d, 44.4268 + d],
        [26.1025 - d, 44.4268 - d],
      ]]],
    },
  };
}
// The calibrated preset shapes served on ?model=preset (task 020): walk [10,20] /
// transit [20,40] / car [10,25]. Sizes are exaggerated so a centre right-click is
// deterministically inside the innermost band (the right-click band math).
const WALK = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(10, 0.28), polyRing(20, 0.3)] };
const TRANSIT = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(20, 0.28), polyRing(40, 0.3)], departure: "2026-07-29T05:30:00.000Z" };
const CAR = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(10, 0.28), polyRing(25, 0.3)] };

// A real WALK→BUS→WALK journey with coords + decoded paths (the server surfaces
// these). journeyLegs → 3 lines; journeyStops → board + alight (2 dots).
const PLAN = {
  reachable: true,
  totalMinutes: 57,
  transfers: 1,
  legs: [
    { mode: "WALK", fromName: "START", toName: "Emil Racovita", minutes: 9, from: { lat: 44.4268, lng: 26.1025 }, to: { lat: 44.44, lng: 26.1 }, path: [[26.1025, 44.4268], [26.1, 44.44]] },
    { mode: "BUS", line: "243", headsign: "Bd. Lacul Tei", fromName: "Emil Racovita", toName: "Soseaua Colentina", minutes: 50, from: { lat: 44.44, lng: 26.1 }, to: { lat: 44.46, lng: 26.09 }, path: [[26.1, 44.44], [26.095, 44.45], [26.09, 44.46]] },
    { mode: "WALK", fromName: "Soseaua Colentina", toName: "END", minutes: 5, from: { lat: 44.46, lng: 26.09 }, to: { lat: 44.47, lng: 26.087 }, path: [[26.09, 44.46], [26.087, 44.47]] },
  ],
};
// A direct walk-only plan: /api/reach can return this; it must stay TEXT-ONLY.
const WALK_ONLY_PLAN = {
  reachable: true,
  totalMinutes: 12,
  transfers: 0,
  legs: [{ mode: "WALK", fromName: "START", toName: "END", minutes: 12, from: { lat: 44.4268, lng: 26.1025 }, to: { lat: 44.43, lng: 26.1 }, path: [[26.1025, 44.4268], [26.1, 44.43]] }],
};
// A DIFFERENT reachable plan (2 legs) used to prove supersede: after a second
// right-click returns this, only THIS journey may be drawn.
const PLAN2 = {
  reachable: true,
  totalMinutes: 22,
  transfers: 0,
  legs: [
    { mode: "WALK", fromName: "START", toName: "Piata Romana", minutes: 4, from: { lat: 44.4268, lng: 26.1025 }, to: { lat: 44.435, lng: 26.105 }, path: [[26.1025, 44.4268], [26.105, 44.435]] },
    { mode: "TRAM", line: "1", headsign: "Nord", fromName: "Piata Romana", toName: "Gara de Nord", minutes: 18, from: { lat: 44.435, lng: 26.105 }, to: { lat: 44.445, lng: 26.07 }, path: [[26.105, 44.435], [26.07, 44.445]] },
  ],
};

// Rendered map state (NOT the code's own data-* stamps) — the true check the
// review required: what MapLibre actually painted. Counts DISTINCT
// legs/stops (deduped by the unique legIndex/stopIndex props) because
// queryRenderedFeatures/querySourceFeatures return a feature once per tile it
// touches — a raw length double-counts. Wrapped in expect.poll by callers so a
// tile re-render after setData can settle.
async function reachRenderedCounts(page: Page) {
  // querySourceFeatures (NOT queryRenderedFeatures) so the count is not clipped
  // to the viewport — a journey leg can extend off-screen. It returns a feature
  // once per tile it touches, so we dedupe by the unique legIndex/stopIndex.
  return page.evaluate(() => {
    type F = { geometry: { type: string }; properties: Record<string, number | string> };
    const m = (window as unknown as { __hfMap?: { querySourceFeatures: (s: string) => F[] } }).__hfMap;
    if (!m) return { lines: -1, stops: -1 };
    const lineIdx = new Set<number>();
    const stopIdx = new Set<number>();
    for (const f of m.querySourceFeatures("reach-path")) {
      // The reach-path source also carries the kind:"destination" pin (task 058)
      // — exclude it; count only journey legs (kind:"leg") + used stops
      // (kind:"stop"), deduped by their unique index.
      if (f.geometry.type === "LineString" && f.properties.kind === "leg") lineIdx.add(f.properties.legIndex as number);
      else if (f.geometry.type === "Point" && f.properties.kind === "stop") stopIdx.add(f.properties.stopIndex as number);
    }
    return { lines: lineIdx.size, stops: stopIdx.size };
  });
}
// The drawn journey's screen-space bbox (project every reach-path coord). Used to
// prove the directions popup does not blanket the whole path (task 057 P1).
async function journeyScreenBBox(page: Page) {
  return page.evaluate(() => {
    const m = (window as unknown as { __hfMap?: { querySourceFeatures: (s: string) => { geometry: { type: string; coordinates: unknown } }[]; project: (c: [number, number]) => { x: number; y: number } } }).__hfMap;
    if (!m) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (c: [number, number]) => { const p = m.project(c); minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
    for (const f of m.querySourceFeatures("reach-path")) {
      const g = f.geometry;
      if (g.type === "LineString") for (const c of g.coordinates as [number, number][]) add(c);
      else if (g.type === "Point") add(g.coordinates as [number, number]);
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  });
}

// True when every given [lng,lat] projects INSIDE the map viewport. We pass the
// KNOWN journey extremes (PLAN's origin + far endpoint) rather than reading
// querySourceFeatures — the latter only returns loaded tiles, so a clipped far
// leg could go unchecked and pass vacuously (found in review). project()
// works on any coord regardless of tiling, so this is tile-independent.
async function coordsInView(page: Page, coords: [number, number][]) {
  return page.evaluate((cs) => {
    const m = (window as unknown as {
      __hfMap?: { project: (c: [number, number]) => { x: number; y: number }; getContainer: () => HTMLElement };
    }).__hfMap;
    if (!m) return false;
    const el = m.getContainer();
    const W = el.clientWidth, H = el.clientHeight;
    return cs.every((c) => {
      const p = m.project(c);
      return p.x >= -2 && p.y >= -2 && p.x <= W + 2 && p.y <= H + 2;
    });
  }, coords);
}
// PLAN's farthest-apart coords (origin ↔ final alight) — if BOTH are framed, the
// whole trip between them is in view.
const PLAN_EXTENT: [number, number][] = [[26.1025, 44.4268], [26.087, 44.47]];

async function setup(page: Page) {
  const reachCalls: string[] = [];
  // Preset mode fetches no amenities; keep a defensive empty stub so a stray call
  // never reaches the network (it should never fire in preset mode).
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: emptyAmenities({ lat: 44.4268, lng: 26.1025 }) }),
  );
  await page.route("**/api/geocode**", (route) =>
    route.fulfill({ json: { lat: 44.4268, lng: 26.1025, label: "Piața Unirii, București" } }),
  );
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK }));
  await page.route("**/api/transit**", (route) => route.fulfill({ json: TRANSIT }));
  await page.route("**/api/car**", (route) => route.fulfill({ json: CAR }));
  await page.route("**/api/reach**", (route) => {
    reachCalls.push(route.request().url());
    route.fulfill({ json: PLAN });
  });
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  return { map, reachCalls };
}

async function search(page: Page, map: ReturnType<Page["getByTestId"]>) {
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-isochrone-rings", "2");
}

async function toTransit(page: Page, map: ReturnType<Page["getByTestId"]>) {
  await page.getByRole("button", { name: "Public transport", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "transit");
}

async function rightClickCentre(page: Page) {
  await rightClickAt(page, 0.5, 0.5);
}
// Right-click at a fractional position of the canvas (so a second click can land
// on a DIFFERENT point for the supersede test — both still inside the big rings).
// Uses raw mouse dispatch (not locator.click) so a second click near an open
// popup isn't blocked by actionability interception; callers pick a spot clear
// of the chrome overlays.
async function rightClickAt(page: Page, fx: number, fy: number) {
  const canvas = page.locator(".maplibregl-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy, { button: "right" });
}

test("transit right-click DRAWS the journey", async ({ page }) => {
  const { map } = await setup(page);
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);

  await expect(map).toHaveAttribute("data-reach-state", "transit");
  // 3 leg lines drawn (WALK + BUS + WALK), stamped once the source holds features.
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });
  await expect(page.getByTestId("reach-panel")).toContainText("By public transport");

  // RENDERED-state truth (not the code's own stamps): the map paints 3 leg lines
  // + the 2 used stops (board + alight) — the check review required.
  await expect.poll(() => reachRenderedCounts(page)).toEqual({ lines: 3, stops: 2 });

  // task 058: the camera fits the journey (data-reach-framed) and the directions
  // DOCK (result sheet) covers only a MINORITY of the drawn path, so the user can
  // see the way beside it. The dock is a fixed side/bottom panel (not a click-
  // anchored popup), and the frame pads for it, so overlap is bounded low; the
  // Gate G live screenshot is the visual arbiter for strict clearance.
  await expect(map).toHaveAttribute("data-reach-framed", "true", { timeout: 5000 });
  const panel = await page.getByTestId("reach-panel").boundingBox();
  const jb = await journeyScreenBBox(page);
  expect(panel).not.toBeNull();
  expect(jb).not.toBeNull();
  const ix = Math.max(0, Math.min(jb!.maxX, panel!.x + panel!.width) - Math.max(jb!.minX, panel!.x));
  const iy = Math.max(0, Math.min(jb!.maxY, panel!.y + panel!.height) - Math.max(jb!.minY, panel!.y));
  const journeyArea = Math.max(1, (jb!.maxX - jb!.minX) * (jb!.maxY - jb!.minY));
  expect((ix * iy) / journeyArea).toBeLessThan(0.6); // dock covers < 60% of the path's screen extent
});

test("supersede: a second right-click draws ONLY the latest plan", async ({ page }) => {
  const { map } = await setup(page);
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });

  // The next /api/reach returns a different 2-leg plan; right-click a new point
  // in the lower-left corner (clear of the centre-anchored first popup, which
  // would otherwise intercept the click). Still well inside the big rings.
  await page.route("**/api/reach**", (route) => route.fulfill({ json: PLAN2 }));
  await rightClickAt(page, 0.82, 0.55);
  await expect(map).toHaveAttribute("data-reach-journey", "2", { timeout: 5000 });
  // Only the latest journey is on the map — no accumulation from the first draw.
  await expect.poll(() => reachRenderedCounts(page)).toEqual({ lines: 2, stops: 2 });
});

test("starting a new selection mid-journey clears the draw", async ({ page }) => {
  const { map } = await setup(page);
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });

  // A new address selection is a fresh selection → teardownReach via closeStopPopup.
  await page.getByRole("combobox").fill("Another place");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-isochrone-rings", "2");
  await expect(map).not.toHaveAttribute("data-reach-journey", /.*/);
  await expect.poll(() => reachRenderedCounts(page)).toEqual({ lines: 0, stops: 0 });
});

test("hovering a popup step highlights its leg on the map", async ({ page }) => {
  const { map } = await setup(page);
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });

  const steps = page.getByTestId("reach-panel").locator("li[data-step-mode]");
  await expect(steps).toHaveCount(3);
  await steps.nth(1).hover();
  await expect(map).toHaveAttribute("data-reach-hover", "1");
  // Leaving the step clears the highlight.
  await page.getByTestId("reach-panel").getByText("By public transport").hover();
  await expect(map).not.toHaveAttribute("data-reach-hover", /.*/);
});

test("closing the popup clears the drawn journey", async ({ page }) => {
  const { map } = await setup(page);
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });

  await page.getByRole("button", { name: "Back to your area" }).click();
  await expect(map).not.toHaveAttribute("data-reach-journey", /.*/);
  // Rendered truth: reach-path emptied.
  await expect.poll(() => reachRenderedCounts(page)).toEqual({ lines: 0, stops: 0 });
});

test("switching mode mid-journey clears the draw", async ({ page }) => {
  const { map } = await setup(page);
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });

  await page.getByRole("button", { name: "Walk", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "walk");
  await expect(map).not.toHaveAttribute("data-reach-journey", /.*/);
});

test("walk-mode right-click AUTO-SWITCHES to Public transport and draws the journey (task 060)", async ({ page }) => {
  const { map, reachCalls } = await setup(page);
  await search(page, map); // still in walk mode
  await rightClickCentre(page);
  // The single owner-asked action: flip to Public transport + draw the trip.
  await expect(map).toHaveAttribute("data-mode", "transit");
  await expect(map).toHaveAttribute("data-reach-state", "transit");
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });
  expect(reachCalls).toHaveLength(1); // exactly one plan fetch
  // Rendered truth: the journey is actually drawn AND fully framed in view (the
  // cross-mode flyTo must not clip it).
  await expect.poll(() => reachRenderedCounts(page)).toEqual({ lines: 3, stops: 2 });
  await expect(map).toHaveAttribute("data-camera-settled", "true");
  // Polled (the frame is animated) + tile-independent: the whole trip is framed,
  // not clipped by the cross-mode flyTo (found in review).
  await expect.poll(() => coordsInView(page, PLAN_EXTENT)).toBe(true);
});

test("car-mode right-click AUTO-SWITCHES to Public transport and draws the journey (task 060)", async ({ page }) => {
  const { map, reachCalls } = await setup(page);
  await search(page, map);
  await page.getByRole("button", { name: "Car", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "car");
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-mode", "transit");
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });
  expect(reachCalls).toHaveLength(1);
  await expect.poll(() => reachRenderedCounts(page)).toEqual({ lines: 3, stops: 2 });
  // Car→transit runs the identical flyTo-vs-frame race as walk — assert it too (found in review).
  await expect(map).toHaveAttribute("data-camera-settled", "true");
  await expect.poll(() => coordsInView(page, PLAN_EXTENT)).toBe(true);
});

test("camera race: a transit recompute that lands AFTER the plan does not clip the journey (found in review)", async ({ page }) => {
  const { map } = await setup(page);
  // Delay ONLY /api/transit so the mode-switch recompute resolves well after the
  // /api/reach plan has drawn+framed the journey — the worst-case ordering for the
  // flyTo-vs-frame race. The reframe-after-render guard must keep the path in view.
  await page.unroute("**/api/transit**");
  await page.route("**/api/transit**", async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    await route.fulfill({ json: TRANSIT });
  });
  await search(page, map); // walk
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });
  // Now let the delayed transit recompute land + settle its camera, THEN assert
  // the journey is still fully framed (a regression would fly to the origin last).
  await expect(map).toHaveAttribute("data-mode", "transit");
  await expect(map).toHaveAttribute("data-camera-settled", "true");
  await expect.poll(() => coordsInView(page, PLAN_EXTENT)).toBe(true);
});

test("a walk-only plan → 'No public-transport route' (task 060: no walk-band answer), no draw", async ({ page }) => {
  const { map } = await setup(page);
  // Override /api/reach to return a direct walk-only plan for this test.
  await page.route("**/api/reach**", (route) => route.fulfill({ json: WALK_ONLY_PLAN }));
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);

  await expect(page.getByTestId("reach-panel")).toContainText("No public-transport route");
  await expect(map).not.toHaveAttribute("data-reach-journey", /.*/);
});

// QUARANTINED for a later pass (task 022): the amenity browser + text filter this test
// drives is part of the amenity subsystem the phone-first preset client suppresses.
// Kept VERBATIM so the "filter state survives a directions round-trip" regression
// is restored when the amenity browser returns (a later pass).
test.skip("amenity Browse text filter SURVIVES opening + closing directions", async ({ page }) => {
  const { map } = await setup(page);
  await search(page, map);
  await toTransit(page, map);
  // Open the amenity browser and set a text filter.
  await page.getByTestId("amenity-browser-trigger").click();
  const filter = page.getByPlaceholder("Filter places");
  await filter.fill("Mega");
  await expect(filter).toHaveValue("Mega");
  // Open directions — the dock swap hides the AmenityPanel but keeps it MOUNTED
  // (hidden + inert), so its ephemeral filter state must not be wiped.
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-state", "transit");
  await expect(filter).not.toBeVisible(); // hidden while directions active
  // Back restores the SAME panel with the filter text intact (no remount).
  await page.getByRole("button", { name: "Back to your area" }).click();
  await expect(page.getByPlaceholder("Filter places")).toHaveValue("Mega");
});
