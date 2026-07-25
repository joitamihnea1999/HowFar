import { expect, test, type Page } from "@playwright/test";

// Car travel mode (task 053). Car uses the ORS driving-car profile at 10/20/30-min
// bands (owner decision — they fit the Bucharest map, unlike 15/30/45). Car has
// NO pace and NO departure-time controls, and its right-click reach is answered
// fully client-side to a drive BAND (no /api/reach call — that route is
// transit-only). Providers are stubbed by EXACT path.

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
// Car response carries the 10/20/30 LABELS (from the provider's normalize). The
// half-widths approximate real driving scale: the outer (30-min) ring ~0.32°
// exceeds the Bucharest maxBounds (~0.6°×0.5°), so this fixture also exercises
// the off-map clipping the plan panel flagged (C-B/F5) — not a viewport-tiny mock.
// The `car` meta block mirrors the real /api/car payload (task 058) so the
// honesty-note slot label + right-click carMeta threading are exercised e2e.
const CAR_META = { basis: "estimate", slotId: "am-peak", slotLabel: "weekday morning rush" };
const CAR = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(10, 0.28), polyRing(20, 0.3), polyRing(30, 0.32)], car: CAR_META };
// Empty rings ⇒ point-in-ring is always null ⇒ "Beyond your driving reach".
const emptyRing = (minutes: number) => ({ minutes, geometry: { type: "MultiPolygon", coordinates: [] } });
const CAR_EMPTY = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [emptyRing(10), emptyRing(20), emptyRing(30)], car: CAR_META };
const WALK = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(15, 0.28), polyRing(30, 0.3), polyRing(45, 0.32)] };

async function setup(page: Page, carBody: unknown = CAR) {
  const reachCalls: string[] = [];
  const carCalls: string[] = [];
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: { origin: { lat: 44.4268, lng: 26.1025 }, walkMinutes: 15, amenities: [] } }),
  );
  await page.route("**/api/geocode**", (route) =>
    route.fulfill({ json: { lat: 44.4268, lng: 26.1025, label: "Piața Unirii, București" } }),
  );
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK }));
  await page.route("**/api/car**", (route) => {
    carCalls.push(route.request().url());
    route.fulfill({ json: carBody });
  });
  await page.route("**/api/reach**", (route) => {
    reachCalls.push(route.request().url());
    route.fulfill({ json: { reachable: false } });
  });
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  return { map, reachCalls, carCalls };
}

async function selectCar(page: Page, map: ReturnType<Page["getByTestId"]>) {
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await page.getByRole("button", { name: "Car", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "car");
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await expect(map).toHaveAttribute("data-camera-settled", "true", { timeout: 10_000 });
}

async function rightClickCentre(page: Page) {
  const canvas = page.locator(".maplibregl-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas");
  await canvas.click({ button: "right", position: { x: Math.round(box.width / 2), y: Math.round(box.height / 2) } });
}

test("Car mode fetches /api/car (time context, NO pace) and labels the legend 10/20/30", async ({ page }) => {
  const { map, carCalls } = await setup(page);
  await selectCar(page, map);

  // The car request carries the time context (task 058 — car reach is time-aware
  // for traffic realism) but NEVER pace (a walk concept).
  expect(carCalls.length).toBeGreaterThan(0);
  const carUrl = carCalls[carCalls.length - 1]!;
  expect(carUrl).toMatch(/lat=.*&lng=/);
  expect(carUrl).not.toMatch(/pace/);
  expect(carUrl).toContain("preset=crowded"); // default time context (Crowded)

  // Legend reads the CAR labels + the "Driving" mode word (default = inner band).
  const legend = page.getByTestId("ring-legend");
  await expect(legend).toContainText("Driving");
  await expect(legend).toContainText("10 min");
  // Widen to All → the legend shows all three car bands 10/20/30 (not 15/30/45).
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(legend).toContainText("10 min");
  await expect(legend).toContainText("20 min");
  await expect(legend).toContainText("30 min");
  await expect(legend).not.toContainText("45 min");
});

test("Car mode shows NO walking-pace control, but DOES show a driving-time control (task 058)", async ({ page }) => {
  const { map } = await setup(page);
  await selectCar(page, map);
  // Pace is a walk concept — NOT PRESENT (count 0), not merely CSS-hidden (a
  // rendered-then-hidden control would still be a regression, impl F3 + panel
  // grok-3: the two controls are gated independently, never one merged wrapper).
  await expect(page.getByRole("group", { name: "Walking pace" })).toHaveCount(0);
  // Car reach IS time-aware now: a driving-time selector is present, under its
  // OWN label (never the transit one — so pace can't resurrect in car).
  await expect(page.getByRole("group", { name: "Driving time" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Public transport departure time" })).toHaveCount(0);
});

// Rendered lng/lat span of the isochrone source — NOT viewport-clipped
// (querySourceFeatures), so it measures the actual drawn ring size regardless of
// camera fit. Proves the owner's core claim: peak reach is smaller than weekend.
async function isoSourceSpan(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = (window as unknown as { __hfMap?: { querySourceFeatures: (s: string) => { geometry: { type: string; coordinates: unknown } }[] } }).__hfMap;
    if (!m) return -1;
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    const grow = (lng: number, lat: number) => { minLng = Math.min(minLng, lng); minLat = Math.min(minLat, lat); maxLng = Math.max(maxLng, lng); maxLat = Math.max(maxLat, lat); };
    const walk = (c: unknown) => {
      if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") grow(c[0], c[1]);
      else if (Array.isArray(c)) for (const x of c) walk(x);
    };
    for (const f of m.querySourceFeatures("isochrone")) walk(f.geometry.coordinates);
    return Number.isFinite(minLng) ? (maxLng - minLng) * (maxLat - minLat) : -1;
  });
}

test("Car time-of-day actually changes reach: Crowded rings are strictly smaller than Not crowded (owner item 1/3)", async ({ page }) => {
  // Distinct geometry per traffic slot — small at am-peak (Crowded), large at
  // midday (Not crowded) — so this proves the RENDERED reach shrinks at peak, not
  // just that a request fired (panel gpt5.5-3/luna-4/terra-3/grok-1). A regression
  // that ignored time and painted one fixed size would fail the span comparison.
  const carCalls: string[] = [];
  const small = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(10, 0.03), polyRing(20, 0.05), polyRing(30, 0.07)], car: { basis: "estimate", slotId: "am-peak", slotLabel: "weekday morning rush" } };
  const large = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(10, 0.12), polyRing(20, 0.18), polyRing(30, 0.24)], car: { basis: "estimate", slotId: "midday", slotLabel: "weekday midday" } };
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: { origin: { lat: 44.4268, lng: 26.1025 }, walkMinutes: 15, amenities: [] } }));
  await page.route("**/api/geocode**", (route) => route.fulfill({ json: { lat: 44.4268, lng: 26.1025, label: "Piața Unirii" } }));
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK }));
  await page.route("**/api/car**", (route) => {
    const url = route.request().url();
    carCalls.push(url);
    route.fulfill({ json: /preset=quiet/.test(url) ? large : small });
  });
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await selectCar(page, map);

  // Default Crowded → small (am-peak) rings + slot label in the note.
  await expect(page.getByTestId("car-estimate-note")).toContainText("weekday morning rush");
  const peakSpan = await isoSourceSpan(page);
  expect(peakSpan).toBeGreaterThan(0);

  // Switch to Not crowded → larger rings + the note now names midday traffic.
  const before = carCalls.length;
  await page.getByRole("button", { name: "Not crowded", exact: true }).click();
  await expect.poll(() => carCalls.length).toBeGreaterThan(before);
  expect(carCalls[carCalls.length - 1]!).toContain("preset=quiet");
  await expect(page.getByTestId("car-estimate-note")).toContainText("weekday midday");
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  // The rendered reach GREW going Crowded → Not crowded (i.e. peak reach is smaller).
  await expect.poll(() => isoSourceSpan(page)).toBeGreaterThan(peakSpan * 2);
});

test("Car mode shows the driving-estimate honesty note naming the assumed traffic slot", async ({ page }) => {
  const { map } = await setup(page);
  await selectCar(page, map);
  const note = page.getByTestId("car-estimate-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("estimate");
  await expect(note).toContainText("traffic");
  // Slot label from the /api/car `car` block is threaded into the note (task 058) —
  // a dropped meta block would fall back to "typical" and fail this.
  await expect(note).toContainText("weekday morning rush");
});

test("Car right-click reports the drive band client-side with ZERO /api/reach calls", async ({ page }) => {
  const { map, reachCalls } = await setup(page);
  await selectCar(page, map);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-state", "car");
  const popup = page.getByTestId("reach-panel");
  await expect(popup).toContainText("By car");
  await expect(popup).toContainText("drive"); // "...minutes' drive..."
  await expect(popup).toContainText("traffic"); // the estimate caveat is in the popup itself (C-F)
  // Assert the actual DISPLAYED band number: the centre is inside the inner
  // (10-min) car ring, so the popup must say "10 minutes" — proving reachBand
  // reports the car display minute (10/20/30), NOT the positional band id
  // 15/30/45 (impl F2, and empirically refutes the "band-id lie" concern).
  await expect(popup).toContainText("10 minutes");
  // And it must NOT show walk copy — this right-click came after a Walk→Car
  // switch, so a stale walk band would say "On foot" (stash-race fence, impl F5).
  await expect(popup).not.toContainText("On foot");
  // Car reach is fully client-side — the transit planner is NEVER called.
  expect(reachCalls).toHaveLength(0);
});

test("Car right-click outside the drive area answers 'Beyond your driving reach' (no fetch)", async ({ page }) => {
  const { map, reachCalls } = await setup(page, CAR_EMPTY);
  await selectCar(page, map);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-state", "car");
  await expect(page.getByTestId("reach-panel")).toContainText("Beyond your driving reach");
  expect(reachCalls).toHaveLength(0);
});
