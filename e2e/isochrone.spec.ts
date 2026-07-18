import { expect, test, type Page } from "@playwright/test";

// Slice-1 interactivity, provider calls STUBBED (CI has no ORS key / can't hit
// Nominatim). We stub ONLY the three provider routes by exact path — never
// `/api/**`, which would swallow `/api/tiles` and break the basemap.

function ring(minutes: number, d: number) {
  return {
    minutes,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [26.1025 - d, 44.4268 - d],
          [26.1025 + d, 44.4268 - d],
          [26.1025 + d, 44.4268 + d],
          [26.1025 - d, 44.4268 + d],
          [26.1025 - d, 44.4268 - d],
        ],
      ],
    },
  };
}
const ISOCHRONE = {
  origin: { lat: 44.4268, lng: 26.1025 },
  rings: [ring(15, 0.01), ring(30, 0.02), ring(45, 0.03)],
};

async function stubIsochrone(page: Page) {
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: ISOCHRONE }));
}

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

test("search renders a marker, 3 isochrone rings, and the address label", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.route("**/api/geocode**", (route) =>
    route.fulfill({ json: { lat: 44.4268, lng: 26.1025, label: "Piața Unirii, București" } }),
  );
  // Typing now also fires /api/suggest (autocomplete) — stub it empty to keep
  // this test hermetic; the "Go" button still exercises the geocode path.
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await stubIsochrone(page);

  const map = await waitForMap(page);
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();

  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await expect(map).toHaveAttribute("data-selection", /Piața Unirii/);
  await expect(page.getByText("Piața Unirii, București")).toBeVisible();
  expect(errors).toEqual([]);
});

test("clicking the map reverse-geocodes and renders the isochrone", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.route("**/api/reverse**", (route) =>
    route.fulfill({ json: { lat: 44.44, lng: 26.09, label: "A clicked spot, București" } }),
  );
  await stubIsochrone(page);

  const map = await waitForMap(page);
  // x clears the left-docked control column (task 024) so this stays a bare-map click.
  await map.click({ position: { x: 760, y: 320 } });

  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await expect(map).toHaveAttribute("data-selection", /clicked spot/i);
  expect(errors).toEqual([]);
});

test("a superseded slow selection never overwrites the newer one", async ({ page }) => {
  let call = 0;
  await page.route("**/api/reverse**", async (route) => {
    call += 1;
    const first = call === 1;
    if (first) await new Promise((r) => setTimeout(r, 700));
    route.fulfill({ json: { lat: 44.44, lng: 26.09, label: first ? "Spot A (slow)" : "Spot B (fast)" } });
  });
  await stubIsochrone(page);

  const map = await waitForMap(page);
  // Click in the LOWER half of the map: click A's 700 ms-delayed reverse can
  // resolve between the two clicks on a slow runner, summoning the amenity panel
  // over an upper click point and stalling click B's actionability. The lower
  // half is clear of the overlay — and x clears the left dock (task 024).
  await map.click({ position: { x: 710, y: 520 } });
  await map.click({ position: { x: 860, y: 560 } });

  // B resolves first (A is delayed + aborted); the map must end on B, not A.
  await expect(map).toHaveAttribute("data-selection", /Spot B/);
  await page.waitForTimeout(900); // let A's slow response arrive…
  await expect(map).toHaveAttribute("data-selection", /Spot B/); // …and be ignored
});
