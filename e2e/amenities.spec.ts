import { expect, test, type Page } from "@playwright/test";

// Amenities slice (M2 slice 3). Providers STUBBED by EXACT path (never /api/**,
// which would swallow /api/tiles). Amenities are mode-independent: fetched once
// per resolved address and preserved across a Walk↔Transit toggle.

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
const WALK = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [ring(15, 0.01), ring(30, 0.02), ring(45, 0.03)] };
const TRANSIT = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [ring(15, 0.03), ring(30, 0.06), ring(45, 0.09)] };
const AMENITIES = {
  origin: { lat: 44.4268, lng: 26.1025 },
  walkMinutes: 15,
  amenities: [
    { lat: 44.427, lng: 26.103, name: "Mega Image", category: "groceries" },
    { lat: 44.428, lng: 26.101, name: "Catena", category: "pharmacies" },
    { lat: 44.426, lng: 26.104, name: "Parcul Unirii", category: "parks" },
    { lat: 44.429, lng: 26.1, name: "Școala 1", category: "schools" },
    { lat: 44.425, lng: 26.102, name: "Stație RATB", category: "transit" },
  ],
};

async function stubBase(page: Page) {
  await page.route("**/api/geocode**", (route) =>
    route.fulfill({ json: { lat: 44.4268, lng: 26.1025, label: "Piața Unirii, București" } }),
  );
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK }));
  await page.route("**/api/transit**", (route) => route.fulfill({ json: TRANSIT }));
}

async function waitForMap(page: Page) {
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  return map;
}

async function search(page: Page) {
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();
}

test("a selection renders amenity markers + five category counts, preserved across a mode toggle", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  let amenityCalls = 0;
  await stubBase(page);
  await page.route("**/api/amenities**", (route) => {
    amenityCalls += 1;
    route.fulfill({ json: AMENITIES });
  });

  const map = await waitForMap(page);
  await search(page);

  // Isochrone + amenity markers both render.
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await expect(map).toHaveAttribute("data-amenity-count", "5");

  // Five category count chips.
  await expect(page.getByText("Within a 15-min walk")).toBeVisible();
  for (const label of ["Groceries", "Pharmacies", "Parks & green", "Schools", "Transit stops"]) {
    await expect(page.getByText(label)).toBeVisible();
  }

  // Toggle to Transit: rings change, amenities PERSIST with no refetch.
  await page.getByRole("button", { name: "Transit" }).click();
  await expect(map).toHaveAttribute("data-mode", "transit");
  await expect(map).toHaveAttribute("data-amenity-count", "5");
  await expect(page.getByText("Within a 15-min walk")).toBeVisible();
  expect(amenityCalls).toBe(1); // one fetch for the address, not one per mode

  expect(errors).toEqual([]);
});

test("a slow amenity response is not lost when the user toggles mode mid-flight", async ({ page }) => {
  let amenityCalls = 0;
  await stubBase(page);
  await page.route("**/api/amenities**", async (route) => {
    amenityCalls += 1;
    await new Promise((r) => setTimeout(r, 1500));
    route.fulfill({ json: AMENITIES });
  });

  const map = await waitForMap(page);
  await search(page);
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");

  // Toggle before amenities resolve — the origin is unchanged, so the in-flight
  // fetch must survive (a toggle must not invalidate the amenity generation).
  await page.getByRole("button", { name: "Transit" }).click();
  await expect(map).toHaveAttribute("data-mode", "transit");

  // The delayed response lands and paints, with no second request.
  await expect(map).toHaveAttribute("data-amenity-count", "5", { timeout: 5000 });
  expect(amenityCalls).toBe(1);
});

test("an amenities 502 shows an error chip but never destroys the isochrone", async ({ page }) => {
  await stubBase(page);
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ status: 502, json: { error: "Upstream provider error" } }),
  );

  const map = await waitForMap(page);
  await search(page);

  // Isochrone still renders...
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  // ...and the amenities failure is isolated to its own chip.
  await expect(page.getByText(/amenities unavailable/i)).toBeVisible();
  await expect(map).not.toHaveAttribute("data-amenity-count", /.*/);
});

test("a selection that resolves before the map style loads still paints amenity markers", async ({ page }) => {
  // Do NOT wait for data-map-loaded: fire the search immediately so the stubbed
  // (instant) responses can arrive before the style, exercising the pending buffer.
  await stubBase(page);
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: AMENITIES }));

  await page.goto("/");
  const map = page.getByTestId("app-map");
  await search(page);

  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await expect(map).toHaveAttribute("data-amenity-count", "5", { timeout: 10_000 });
});
