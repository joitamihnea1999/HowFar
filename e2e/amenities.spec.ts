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
  // Parks count (200) deliberately exceeds the rendered markers (5) — the chip
  // must show the TRUE server count, not a recount of the capped markers.
  counts: { groceries: 62, pharmacies: 35, parks: 200, schools: 38, transit: 91 },
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
  // Count fidelity: the chip shows the TRUE server count (200), not the number
  // of rendered markers (5, from data-amenity-count).
  await expect(map).toHaveAttribute("data-amenity-count", "5");
  await expect(page.getByText("200")).toBeVisible();

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

test("a later amenities failure clears the prior count and shows an error, keeping the isochrone", async ({
  page,
}) => {
  await stubBase(page);
  let calls = 0;
  await page.route("**/api/amenities**", (route) => {
    calls += 1;
    return calls === 1
      ? route.fulfill({ json: AMENITIES })
      : route.fulfill({ status: 502, json: { error: "Upstream provider error" } });
  });

  const map = await waitForMap(page);
  await search(page);
  await expect(map).toHaveAttribute("data-amenity-count", "5"); // first selection: markers + count

  // A fresh selection whose amenities 502: the stale count is cleared (non-vacuous
  // — it was "5") and an error shows, while the isochrone still renders.
  await search(page);
  await expect(page.getByText(/amenities unavailable/i)).toBeVisible();
  await expect(map).not.toHaveAttribute("data-amenity-count", /.*/);
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
});

test("a failed isochrone leaves no orphan amenity markers", async ({ page }) => {
  await stubBase(page);
  await page.route("**/api/isochrone**", (route) =>
    route.fulfill({ status: 502, json: { error: "Upstream provider error" } }),
  );
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: AMENITIES })); // would succeed

  const map = await waitForMap(page);
  await search(page);

  // The reach failed, so amenities must not paint markers/counts with nothing to
  // anchor them: the panel stays hidden and no rings render.
  await expect(map).not.toHaveAttribute("data-amenity-count", /.*/);
  await expect(page.getByText("Within a 15-min walk")).not.toBeVisible();
  await expect(map).not.toHaveAttribute("data-isochrone-rings", /.*/);
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

test("a failed mode-toggle recompute clears amenities instead of leaving orphan markers", async ({ page }) => {
  await stubBase(page);
  // Walk succeeds; the transit recompute fails (last-registered route wins).
  await page.route("**/api/transit**", (route) =>
    route.fulfill({ status: 502, json: { error: "Upstream provider error" } }),
  );
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: AMENITIES }));

  const map = await waitForMap(page);
  await search(page);
  await expect(map).toHaveAttribute("data-amenity-count", "5"); // walk: rings + amenities painted

  // Toggle to Transit: the recompute 502s. The walk rings were already dropped
  // when the recompute started, so keeping the amenities would paint markers
  // anchored to nothing — they must clear along with the panel.
  await page.getByRole("button", { name: "Transit" }).click();
  await expect(page.getByText(/could not compute transit reach/i)).toBeVisible();
  await expect(map).not.toHaveAttribute("data-isochrone-rings", /.*/);
  await expect(map).not.toHaveAttribute("data-amenity-count", /.*/);
  await expect(page.getByText("Within a 15-min walk")).not.toBeVisible();
});
