import { expect, test, type Page } from "@playwright/test";
import { emptyAmenities } from "./amenity-fixtures";

// Car travel mode (task 053), migrated to the phone-first preset client (task 022).
// The client sends `&model=preset`, so /api/car answers the CALIBRATED car preset
// [10, 25] (task 020) — not the retired 10/20/30 bands. Car has NO pace and NO
// per-minute ring-filter; its time-of-day control (Crowded / Not crowded) still
// reshapes the reach for traffic realism. Providers are stubbed by EXACT path so
// the real self-hosted basemap tiles still load. The reach is drawn as the preset
// shells + contour lines (`preset-reach-fill`/`-line` sources), and the read-back
// oracle is the `data-preset-*` stamps — the same contract preset-render.spec proves.

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
// Car response carries the calibrated [10, 25] preset. The outer (25-min) ring
// ~0.32° exceeds the Bucharest maxBounds (~0.6°×0.5°), so this fixture also
// exercises the off-map clipping flagged in review (C-B/F5) — not a
// viewport-tiny mock. The `car` meta block mirrors the real /api/car payload
// (task 058) so the honesty-note slot label + right-click carMeta threading are
// exercised e2e.
const CAR_META = { basis: "estimate", slotId: "am-peak", slotLabel: "weekday morning rush" };
const CAR = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(10, 0.3), polyRing(25, 0.32)], car: CAR_META };
const WALK = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(10, 0.28), polyRing(20, 0.3)] };

async function setup(page: Page, carBody: unknown = CAR) {
  const reachCalls: string[] = [];
  const carCalls: string[] = [];
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: emptyAmenities({ lat: 44.4268, lng: 26.1025 }) }),
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
  // Walk preset renders first — two calibrated contours [10, 20].
  await expect(map).toHaveAttribute("data-isochrone-rings", "2");
  await page.getByRole("button", { name: "Car", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "car");
  // Car preset renders its two calibrated contours [10, 25].
  await expect(map).toHaveAttribute("data-isochrone-rings", "2");
  await expect(map).toHaveAttribute("data-camera-settled", "true", { timeout: 10_000 });
}

test("Car mode fetches /api/car with the preset model + time context, NO pace, and draws the [10, 25] preset", async ({ page }) => {
  const { map, carCalls } = await setup(page);
  await selectCar(page, map);

  // The car request carries the preset model AND the time context (task 058 — car
  // reach is time-aware for traffic realism) but NEVER pace (a walk concept).
  expect(carCalls.length).toBeGreaterThan(0);
  const carUrl = carCalls[carCalls.length - 1]!;
  expect(carUrl).toContain("model=preset");
  expect(carUrl).toMatch(/lat=.*&lng=/);
  expect(carUrl).not.toMatch(/pace/);
  expect(carUrl).toContain("preset=crowded"); // default time context (Crowded)

  // The reach draws the calibrated car preset: default chip is the SMALLER (10-min)
  // contour; selecting the 25 chip adds the 10-min interior line (render-midpoint
  // honesty), and neither triggers a refetch (client-side visibility of the served set).
  await expect(map).toHaveAttribute("data-selected-preset", "10");
  await expect(map).toHaveAttribute("data-preset-contours", "10");
  const carCallsBefore = carCalls.length;
  await page.getByTestId("preset-chip-25").click();
  await expect(map).toHaveAttribute("data-preset-contours", "10,25");
  await expect(map).toHaveAttribute("data-interior-lines", "10");
  expect(carCalls.length).toBe(carCallsBefore); // chip change is pure visibility, no refetch
});

test("Car mode shows NO walking-pace control, but DOES show a driving-time control (task 058)", async ({ page }) => {
  const { map } = await setup(page);
  await selectCar(page, map);
  await openRefine(page);
  // Pace is a walk concept — NOT PRESENT (count 0), not merely CSS-hidden (a
  // rendered-then-hidden control would still be a regression, impl F3 + panel
  // grok-3: the two controls are gated independently, never one merged wrapper).
  await expect(page.getByRole("group", { name: "Walking pace" })).toHaveCount(0);
  // Car reach IS time-aware now: a driving-time selector is present, under its
  // OWN label (never the transit one — so pace can't resurrect in car).
  await expect(page.getByRole("group", { name: "Driving time" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Public transport departure time" })).toHaveCount(0);
});

// The phone-first shell collapses refinements (pace / driving-time / departure)
// into the result sheet's "refine" block, reached from the peek "refine" chip.
// Open it before asserting on those controls; a no-op if already expanded.
async function openRefine(page: Page) {
  const pill = page.getByTestId("state-pill");
  if (await pill.isVisible().catch(() => false)) await pill.click();
  const refineChip = page.getByTestId("peek-chip-refine");
  if (await refineChip.isVisible().catch(() => false)) await refineChip.click();
}

// Rendered lng/lat span of the DRAWN preset reach — NOT viewport-clipped
// (querySourceFeatures), so it measures the actual drawn contour size regardless
// of camera fit. Proves the owner's core claim: peak reach is smaller than weekend.
async function presetReachSpan(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = (window as unknown as { __hfMap?: { querySourceFeatures: (s: string) => { geometry: { type: string; coordinates: unknown } }[] } }).__hfMap;
    if (!m) return -1;
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    const grow = (lng: number, lat: number) => { minLng = Math.min(minLng, lng); minLat = Math.min(minLat, lat); maxLng = Math.max(maxLng, lng); maxLat = Math.max(maxLat, lat); };
    const walk = (c: unknown) => {
      if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") grow(c[0], c[1]);
      else if (Array.isArray(c)) for (const x of c) walk(x);
    };
    // The drawn reach lives in the preset line source (edge + interior contours).
    for (const f of m.querySourceFeatures("preset-reach-line")) walk(f.geometry.coordinates);
    return Number.isFinite(minLng) ? (maxLng - minLng) * (maxLat - minLat) : -1;
  });
}

test("Car time-of-day actually changes reach: Crowded rings are strictly smaller than Not crowded (owner item 1/3)", async ({ page }) => {
  // Distinct geometry per traffic slot — small at am-peak (Crowded), large at
  // midday (Not crowded) — so this proves the RENDERED reach shrinks at peak, not
  // just that a request fired (panel gpt5.5-3/luna-4/terra-3/grok-1). A regression
  // that ignored time and painted one fixed size would fail the span comparison.
  const carCalls: string[] = [];
  const small = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(10, 0.03), polyRing(25, 0.05)], car: { basis: "estimate", slotId: "am-peak", slotLabel: "weekday morning rush" } };
  const large = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(10, 0.12), polyRing(25, 0.2)], car: { basis: "estimate", slotId: "midday", slotLabel: "weekday midday" } };
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: emptyAmenities({ lat: 44.4268, lng: 26.1025 }) }));
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
  const peakSpan = await presetReachSpan(page);
  expect(peakSpan).toBeGreaterThan(0);

  // Switch to Not crowded → larger rings + the note now names midday traffic.
  await openRefine(page);
  const before = carCalls.length;
  await page.getByRole("button", { name: "Not crowded", exact: true }).click();
  await expect.poll(() => carCalls.length).toBeGreaterThan(before);
  expect(carCalls[carCalls.length - 1]!).toContain("preset=quiet");
  await expect(page.getByTestId("car-estimate-note")).toContainText("weekday midday");
  await expect(map).toHaveAttribute("data-isochrone-rings", "2");
  // The rendered reach GREW going Crowded → Not crowded (i.e. peak reach is smaller).
  await expect.poll(() => presetReachSpan(page)).toBeGreaterThan(peakSpan * 2);
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

// Task 060: right-click no longer produces a car drive-band answer — in EVERY
// mode it auto-switches to Public transport and draws the journey. That unified
// behavior (incl. from car mode) is covered end-to-end in reach-journey.spec.ts
// ("car-mode right-click AUTO-SWITCHES…"), which has the transit + plan fixtures
// this car-only setup deliberately omits. No car-specific right-click spec remains.
