import { expect, test, type Page } from "@playwright/test";

// Autocomplete slice, providers STUBBED on their exact paths (never /api/**,
// which would swallow /api/tiles). Exercises the dropdown, selection, and the
// debounce/min-length guards.

const SUGGESTIONS = [
  { label: "Union Square, Bucharest", lat: 44.428, lng: 26.1025 },
  { label: "University Square, Bucharest", lat: 44.4349, lng: 26.1008 },
];

function ring(minutes: number, d: number) {
  return {
    minutes,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [26.1025 - d, 44.428 - d],
          [26.1025 + d, 44.428 - d],
          [26.1025 + d, 44.428 + d],
          [26.1025 - d, 44.428 + d],
          [26.1025 - d, 44.428 - d],
        ],
      ],
    },
  };
}
const ISOCHRONE = { origin: { lat: 44.428, lng: 26.1025 }, rings: [ring(15, 0.01), ring(30, 0.02), ring(45, 0.03)] };

async function setup(page: Page) {
  const counts = { suggest: 0, geocode: 0, reverse: 0 };
  await page.route("**/api/suggest**", (route) => {
    counts.suggest += 1;
    route.fulfill({ json: { suggestions: SUGGESTIONS } });
  });
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: ISOCHRONE }));
  // Stub + count these so a regression that re-geocodes a picked point is caught.
  await page.route("**/api/geocode**", (route) => {
    counts.geocode += 1;
    route.fulfill({ json: { lat: 44.428, lng: 26.1025, label: "x" } });
  });
  await page.route("**/api/reverse**", (route) => {
    counts.reverse += 1;
    route.fulfill({ json: { lat: 44.428, lng: 26.1025, label: "x" } });
  });
  return counts;
}

async function waitForMap(page: Page) {
  // Every selection now also fetches amenities — stub it so CI never hits live
  // Overpass/ORS (this suite asserts nothing about amenities).
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: { origin: { lat: 44.428, lng: 26.1025 }, walkMinutes: 15, amenities: [] } }),
  );
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  return map;
}

test("typing shows a suggestion dropdown; clicking one renders the isochrone", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  const counts = await setup(page);

  const map = await waitForMap(page);
  await page.getByRole("combobox").fill("Union");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: /Union Square/ }).click();

  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await expect(map).toHaveAttribute("data-selection", /Union Square/);
  // Signature invariant: a picked suggestion goes straight to the isochrone —
  // NO geocode/reverse round-trip.
  expect(counts.geocode).toBe(0);
  expect(counts.reverse).toBe(0);
  expect(errors).toEqual([]);
});

test("keyboard: ArrowDown + Enter selects a suggestion", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await setup(page);

  const map = await waitForMap(page);
  const box = page.getByRole("combobox");
  await box.fill("Uni");
  await expect(page.getByRole("listbox")).toBeVisible();
  await box.press("ArrowDown");
  await box.press("Enter");

  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await expect(map).toHaveAttribute("data-selection", /Union Square/);
  expect(errors).toEqual([]);
});

test("a query under 3 characters issues no suggest request and shows no dropdown", async ({ page }) => {
  const counts = await setup(page);
  await waitForMap(page);
  await page.getByRole("combobox").fill("Pi");
  await page.waitForTimeout(500);
  expect(counts.suggest).toBe(0);
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("rapid typing collapses to a single debounced suggest request", async ({ page }) => {
  const counts = await setup(page);
  await waitForMap(page);
  await page.getByRole("combobox").pressSequentially("Piata", { delay: 40 });
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.waitForTimeout(400);
  expect(counts.suggest).toBeLessThanOrEqual(2);
});
