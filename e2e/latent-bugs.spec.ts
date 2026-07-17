import { expect, test, type Page } from "@playwright/test";

// Regression specs for three edge-case bugs in the map selection and search flow.
// Providers STUBBED by EXACT path (never /api/**, which would swallow /api/tiles).

function polyRing(minutes: number, d: number) {
  return {
    minutes,
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [26.1025 - d, 44.4268 - d],
            [26.1025 + d, 44.4268 - d],
            [26.1025 + d, 44.4268 + d],
            [26.1025 - d, 44.4268 + d],
            [26.1025 - d, 44.4268 - d],
          ],
        ],
      ],
    },
  };
}
const WALK = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(15, 0.01), polyRing(30, 0.02), polyRing(45, 0.03)] };
const TRANSIT = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(15, 0.03), polyRing(30, 0.06), polyRing(45, 0.09)] };

async function waitForMap(page: Page) {
  // Every selection now also fetches amenities — stub it so CI never hits live
  // Overpass/ORS (this suite asserts nothing about amenities).
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: { origin: { lat: 44.4268, lng: 26.1025 }, walkMinutes: 15, amenities: [] } }),
  );
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  return map;
}

// B1 — double-toggle mid-flight must not lose the selected origin.
test("toggling Transit then back to Walk before transit resolves keeps the origin and re-renders", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  let geocodeCalls = 0;

  await page.route("**/api/geocode**", (route) => {
    geocodeCalls += 1;
    route.fulfill({ json: { lat: 44.4268, lng: 26.1025, label: "Piața Unirii, București" } });
  });
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK }));
  // Transit is deliberately slow so the second toggle happens mid-flight.
  await page.route("**/api/transit**", async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    route.fulfill({ json: TRANSIT });
  });

  const map = await waitForMap(page);
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-mode", "walk");
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");

  // Toggle to Transit (slow, in-flight) then straight back to Walk.
  await page.getByRole("button", { name: "Transit" }).click();
  await page.getByRole("button", { name: "Walk" }).click();

  // The origin survived: the walk isochrone re-renders from lastSelection with
  // NO re-geocode. (Before the fix, lastSelection was nulled and the map went
  // blank/idle.)
  await expect(map).toHaveAttribute("data-mode", "walk", { timeout: 5000 });
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await expect(map).toHaveAttribute("data-selection", /Piața Unirii/);
  expect(geocodeCalls).toBe(1);
  expect(errors).toEqual([]);
});

// B2 — a malformed reverse-geocode 200 body must not crash the selection.
test("a map click with a malformed reverse-geocode body still renders the isochrone", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK }));
  // 200 OK, valid JSON, but the wrong shape (no `label`) — the harder case:
  // res.json() succeeds, so only shape validation keeps the fallback label.
  await page.route("**/api/reverse**", (route) =>
    route.fulfill({ status: 200, json: { display: "no label field here" } }),
  );

  const map = await waitForMap(page);
  await map.click({ position: { x: 400, y: 320 } });

  // Reach still renders; the click keeps the generic label; no error banner.
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await expect(map).toHaveAttribute("data-selection", "Selected point");
  await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  expect(errors).toEqual([]);
});

// B3 — a suggest network failure must surface the error state, not hang on "Searching…".
test("a suggest network error shows the error state, not a stuck spinner", async ({ page }) => {
  await page.route("**/api/suggest**", (route) => route.abort("failed"));

  await waitForMap(page);
  await page.getByRole("combobox").fill("Unirii");

  await expect(page.getByText(/couldn.?t load suggestions/i)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/searching/i)).toHaveCount(0);
});

// B3-adjacent — a malformed suggest response (valid JSON, no array) must not crash.
test("a malformed suggest response shows the error state instead of crashing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // 200 OK, valid JSON, but no `suggestions` array.
  await page.route("**/api/suggest**", (route) => route.fulfill({ status: 200, json: { oops: true } }));

  await waitForMap(page);
  await page.getByRole("combobox").fill("Unirii");

  await expect(page.getByText(/couldn.?t load suggestions/i)).toBeVisible({ timeout: 5000 });
  expect(errors).toEqual([]); // no ".length of undefined" crash
});
