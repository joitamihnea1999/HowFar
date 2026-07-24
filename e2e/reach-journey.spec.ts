import { expect, test, type Page } from "@playwright/test";

// Visual right-click journey (task 054): a transit-reachable right-click DRAWS
// the trip on the map (`data-reach-journey`), DECLUTTERS the amenity markers
// (`data-amenity-declutter=on`), and ties popup-step hover to on-map highlight
// (`data-reach-hover`); closing / a new selection / a mode change restores the
// markers and clears the draw. Walk + car answers stay text-only (no draw, no
// declutter, and — for walk/car — no /api/reach call). Provider calls stubbed by
// exact path; the right-click is a native right-button click → contextmenu.

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
// Big rings so a centre click is deterministically inside the innermost band.
const bigRings = [polyRing(15, 0.28), polyRing(30, 0.3), polyRing(45, 0.32)];
const WALK = { origin: { lat: 44.4268, lng: 26.1025 }, rings: bigRings };
const TRANSIT = { origin: { lat: 44.4268, lng: 26.1025 }, rings: bigRings, departure: "2026-07-29T05:30:00.000Z" };
const CAR = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(10, 0.28), polyRing(20, 0.3), polyRing(30, 0.32)] };

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
// impl panel required (): what MapLibre actually painted. Counts DISTINCT
// legs/stops (deduped by the unique legIndex/stopIndex props) because
// queryRenderedFeatures/querySourceFeatures return a feature once per tile it
// touches — a raw length double-counts. Wrapped in expect.poll by callers so a
// tile re-render after setData can settle.
async function reachRenderedCounts(page: Page) {
  // querySourceFeatures (NOT queryRenderedFeatures) so the count is not clipped
  // to the viewport — a journey leg can extend off-screen. It returns a feature
  // once per tile it touches, so we dedupe by the unique legIndex/stopIndex.
  return page.evaluate(() => {
    type F = { geometry: { type: string }; properties: Record<string, number> };
    const m = (window as unknown as { __hfMap?: { querySourceFeatures: (s: string) => F[] } }).__hfMap;
    if (!m) return { lines: -1, stops: -1 };
    const lineIdx = new Set<number>();
    const stopIdx = new Set<number>();
    for (const f of m.querySourceFeatures("reach-path")) {
      if (f.geometry.type === "LineString") lineIdx.add(f.properties.legIndex);
      else if (f.geometry.type === "Point") stopIdx.add(f.properties.stopIndex);
    }
    return { lines: lineIdx.size, stops: stopIdx.size };
  });
}
async function renderedAmenityMarkers(page: Page) {
  return page.evaluate(() => {
    const m = (window as unknown as { __hfMap?: { queryRenderedFeatures: (o: unknown) => unknown[] } }).__hfMap;
    return m ? m.queryRenderedFeatures({ layers: ["amenity-markers"] }).length : -1;
  });
}

async function setup(page: Page) {
  const reachCalls: string[] = [];
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({
      json: {
        origin: { lat: 44.4268, lng: 26.1025 },
        walkMinutes: 15,
        counts: { groceries: 1, pharmacies: 1, parks: 0, schools: 0, transit: 0 },
        amenities: [
          { name: "Mega Image", category: "groceries", lat: 44.427, lng: 26.103, osmType: "node", osmId: 1 },
          { name: "Farmacia Tei", category: "pharmacies", lat: 44.4265, lng: 26.1015, osmType: "node", osmId: 2 },
        ],
      },
    }),
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
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await expect(map).toHaveAttribute("data-amenity-count", "2"); // markers present to declutter
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

test("transit right-click DRAWS the journey and declutters the amenities", async ({ page }) => {
  const { map } = await setup(page);
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);

  await expect(map).toHaveAttribute("data-reach-state", "transit");
  // 3 leg lines drawn (WALK + BUS + WALK), stamped once the source holds features.
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });
  await expect(map).toHaveAttribute("data-amenity-declutter", "on");
  await expect(page.getByTestId("reach-popup")).toContainText("By public transport");

  // RENDERED-state truth (not the code's own stamps): the map paints 3 leg lines
  // + the 2 used stops (board + alight), and NO amenity marker while the journey
  // shows — the check the impl panel required.
  await expect.poll(() => reachRenderedCounts(page)).toEqual({ lines: 3, stops: 2 });
  await expect.poll(() => renderedAmenityMarkers(page)).toBe(0);
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

test("starting a new selection mid-journey clears the draw and restores markers", async ({ page }) => {
  const { map } = await setup(page);
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });
  expect(await renderedAmenityMarkers(page)).toBe(0);

  // A new address selection is a fresh selection → teardownReach via closeStopPopup.
  await page.getByRole("combobox").fill("Another place");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await expect(map).not.toHaveAttribute("data-reach-journey", /.*/);
  await expect(map).toHaveAttribute("data-amenity-declutter", "off");
  await expect.poll(() => reachRenderedCounts(page)).toEqual({ lines: 0, stops: 0 });
  await expect.poll(() => renderedAmenityMarkers(page)).toBeGreaterThan(0); // markers back
});

test("hovering a popup step highlights its leg on the map", async ({ page }) => {
  const { map } = await setup(page);
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });

  const steps = page.locator(".hf-reach-popup__step");
  await expect(steps).toHaveCount(3);
  await steps.nth(1).hover();
  await expect(map).toHaveAttribute("data-reach-hover", "1");
  // Leaving the step clears the highlight.
  await page.getByTestId("reach-popup").getByText("By public transport").hover();
  await expect(map).not.toHaveAttribute("data-reach-hover", /.*/);
});

test("closing the popup clears the drawn journey and restores the amenities", async ({ page }) => {
  const { map } = await setup(page);
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });
  await expect(map).toHaveAttribute("data-amenity-declutter", "on");

  await page.locator(".maplibregl-popup-close-button").click();
  await expect(map).not.toHaveAttribute("data-reach-journey", /.*/);
  await expect(map).toHaveAttribute("data-amenity-declutter", "off");
  // Rendered truth: reach-path emptied and the amenity markers are back.
  await expect.poll(() => reachRenderedCounts(page)).toEqual({ lines: 0, stops: 0 });
  await expect.poll(() => renderedAmenityMarkers(page)).toBeGreaterThan(0);
});

test("switching mode mid-journey restores the amenities and clears the draw", async ({ page }) => {
  const { map } = await setup(page);
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-journey", "3", { timeout: 5000 });

  await page.getByRole("button", { name: "Walk", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "walk");
  await expect(map).not.toHaveAttribute("data-reach-journey", /.*/);
  await expect(map).toHaveAttribute("data-amenity-declutter", "off");
});

test("walk mode right-click draws NOTHING and makes no /api/reach call", async ({ page }) => {
  const { map, reachCalls } = await setup(page);
  await search(page, map);
  await rightClickCentre(page); // still in walk mode
  await expect(map).toHaveAttribute("data-reach-state", "walk");
  await expect(map).not.toHaveAttribute("data-reach-journey", /.*/);
  await expect(map).not.toHaveAttribute("data-amenity-declutter", "on");
  expect(reachCalls).toHaveLength(0);
});

test("car mode right-click draws NOTHING and makes no /api/reach call", async ({ page }) => {
  const { map, reachCalls } = await setup(page);
  await search(page, map);
  await page.getByRole("button", { name: "Car", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "car");
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-state", "car");
  await expect(map).not.toHaveAttribute("data-reach-journey", /.*/);
  await expect(map).not.toHaveAttribute("data-amenity-declutter", "on");
  expect(reachCalls).toHaveLength(0);
});

test("a walk-only transit fallback stays text-only (no draw, no declutter)", async ({ page }) => {
  const { map } = await setup(page);
  // Override /api/reach to return a direct walk-only plan for this test.
  await page.route("**/api/reach**", (route) => route.fulfill({ json: WALK_ONLY_PLAN }));
  await search(page, map);
  await toTransit(page, map);
  await rightClickCentre(page);

  await expect(page.getByTestId("reach-popup")).toContainText("On foot");
  await expect(map).not.toHaveAttribute("data-reach-journey", /.*/);
  await expect(map).not.toHaveAttribute("data-amenity-declutter", "on");
});
