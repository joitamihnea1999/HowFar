import { expect, test, type Page } from "@playwright/test";

// Ring display filter (task 024): the 15/30/45/All control flips per-minute
// layer visibility — all three rings stay FETCHED (data-isochrone-rings=3),
// only the displayed band changes. Default is the 15-min band (owner-picked).
// Providers stubbed by EXACT path (never /api/**, which would swallow tiles).

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

async function stubBase(page: Page) {
  await page.route("**/api/geocode**", (route) =>
    route.fulfill({ json: { lat: 44.4268, lng: 26.1025, label: "Piața Unirii, București" } }),
  );
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK }));
  await page.route("**/api/transit**", (route) => route.fulfill({ json: TRANSIT }));
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({
      json: {
        origin: { lat: 44.4268, lng: 26.1025 },
        walkMinutes: 15,
        counts: { groceries: 0, pharmacies: 0, parks: 0, schools: 0, transit: 0 },
        amenities: [],
      },
    }),
  );
}

async function loadAndSearch(page: Page) {
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  return map;
}

const legend = (page: Page) => page.getByTestId("ring-legend");

test("defaults to the 15-min band: all rings fetched, one band displayed, legend matches", async ({
  page,
}) => {
  await stubBase(page);
  const map = await loadAndSearch(page);

  await expect(map).toHaveAttribute("data-ring-filter", "15");
  // data-visible-rings is read back from the LAYERS, so this fails if the
  // visibility toggles ever stop being applied (not just echoed).
  await expect(map).toHaveAttribute("data-visible-rings", "15");
  await expect(map).toHaveAttribute("data-isochrone-rings", "3"); // fetched, not displayed
  await expect(legend(page).getByText("15 min")).toBeVisible();
  await expect(legend(page).getByText("30 min")).toHaveCount(0);
  await expect(legend(page).getByText("45 min")).toHaveCount(0);
});

test("selecting a band or All updates the layers' filter and the legend", async ({ page }) => {
  await stubBase(page);
  const map = await loadAndSearch(page);

  await page.getByRole("button", { name: "45 min" }).click();
  await expect(map).toHaveAttribute("data-ring-filter", "45");
  await expect(map).toHaveAttribute("data-visible-rings", "45");
  await expect(legend(page).getByText("45 min")).toBeVisible();
  await expect(legend(page).getByText("15 min")).toHaveCount(0);

  // Exact: the new category controls add "Show all"/"Hide all", which a
  // substring "All" match would also select.
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(map).toHaveAttribute("data-ring-filter", "all");
  await expect(map).toHaveAttribute("data-visible-rings", "15,30,45");
  for (const label of ["15 min", "30 min", "45 min"]) {
    await expect(legend(page).getByText(label)).toBeVisible();
  }
});

test("the filter persists across a mode toggle AND a new selection (view preference)", async ({
  page,
}) => {
  await stubBase(page);
  const map = await loadAndSearch(page);

  await page.getByRole("button", { name: "30 min" }).click();
  await expect(map).toHaveAttribute("data-ring-filter", "30");
  await expect(map).toHaveAttribute("data-visible-rings", "30");

  // Mode toggle recomputes the same origin — the filter must survive.
  await page.getByRole("button", { name: "Public transport", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "transit");
  await expect(map).toHaveAttribute("data-ring-filter", "30");
  await expect(map).toHaveAttribute("data-visible-rings", "30");
  await expect(legend(page).getByText("30 min")).toBeVisible();

  // A genuinely-new selection keeps it too.
  await page.getByRole("combobox").fill("Alt loc");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await expect(map).toHaveAttribute("data-ring-filter", "30");
});
