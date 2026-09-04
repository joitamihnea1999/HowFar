import { expect, test, type Page } from "@playwright/test";
import { emptyAmenities } from "./amenity-fixtures";

/**
 * Phone-first deterministic read-back oracle. The BINDING proof of the
 * phone-first preset render is NOT a WebGL pixel diff (cross-machine raster flake,
 * rule 13) but the `data-*` stamps the render writes: the served preset contours,
 * the calibrated interior-line minutes (the render-midpoint honesty), the chip →
 * painted-contour mapping (pure client visibility, no refetch), amenity
 * suppression, the first-paint placeholder, and the transit attribution.
 *
 * The client is preset-only, so every stub returns the CALIBRATED preset contours
 * (walk [10,20], transit [20,40], car [10,25]) — the shapes task 020 serves on
 * `?model=preset`. 390×844 (a phone viewport) is set in the project config; this
 * suite asserts semantics, and the owner does the live visual review.
 */

// Pin the exact phone viewport the phone-first design targets (390×844). This spec
// is routed to the mobile project (playwright.config.ts); the viewport override
// makes the size deterministic regardless of the project's device default.
test.use({ viewport: { width: 390, height: 844 } });

const ORIGIN = { lat: 44.4268, lng: 26.1025 };

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

const WALK_PRESET = { origin: ORIGIN, rings: [ring(10, 0.01), ring(20, 0.02)] };
const TRANSIT_PRESET = { origin: ORIGIN, rings: [ring(20, 0.03), ring(40, 0.06)] };
const CAR_PRESET = {
  origin: ORIGIN,
  rings: [ring(10, 0.2), ring(25, 0.35)],
  car: { basis: "estimate", slotId: "am-peak", slotLabel: "weekday morning rush" },
};

async function baseStubs(page: Page) {
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/geocode**", (route) =>
    route.fulfill({ json: { ...ORIGIN, label: "Piața Unirii, București" } }),
  );
}

async function waitForMap(page: Page) {
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  return map;
}

async function selectAddress(page: Page) {
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();
}

// On the phone viewport the shell collapses the command dock to a one-line state
// pill once a selection resolves, hiding the mode+preset bar. Re-expand it so the
// chip/mode controls are interactable; a no-op on a viewport where the dock stays
// open (or before the first selection).
async function openControls(page: Page) {
  const pill = page.getByTestId("state-pill");
  if (await pill.isVisible().catch(() => false)) await pill.click();
  await expect(page.getByTestId("mode-preset-bar")).toBeVisible();
}

test("walk preset: default chip 10 draws only the 10-min contour, the 20 chip adds the calibrated 10-min interior line — no refetch", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  await baseStubs(page);
  let isoCalls = 0;
  let amenityCalls = 0;
  await page.route("**/api/isochrone**", (route) => {
    isoCalls += 1;
    // The client MUST send the preset model.
    expect(route.request().url()).toContain("model=preset");
    route.fulfill({ json: WALK_PRESET });
  });
  await page.route("**/api/amenities**", (route) => {
    amenityCalls += 1;
    route.fulfill({ json: emptyAmenities(ORIGIN) });
  });

  const map = await waitForMap(page);
  await selectAddress(page);

  // Default is Walk · 10: the outer contour is 10, no interior line.
  await expect(map).toHaveAttribute("data-mode", "walk");
  await expect(map).toHaveAttribute("data-selected-preset", "10");
  await expect(map).toHaveAttribute("data-preset-contours", "10");
  await expect(map).toHaveAttribute("data-interior-lines", "");
  await expect(map).toHaveAttribute("data-isochrone-rings", "2");

  // Select the 20-min chip: the outer contour becomes 20 and the calibrated
  // 10-min interior line appears — the render-midpoint honesty.
  await openControls(page);
  await page.getByTestId("preset-chip-20").click();
  await expect(map).toHaveAttribute("data-selected-preset", "20");
  await expect(map).toHaveAttribute("data-preset-contours", "10,20");
  await expect(map).toHaveAttribute("data-interior-lines", "10");

  // The chip is pure client-side visibility: the route returned BOTH contours,
  // so the chip change must NOT trigger a second isochrone flight.
  expect(isoCalls).toBe(1);
  // Amenities are DEFERRED in preset mode (owner decision): ZERO fetches.
  expect(amenityCalls).toBe(0);
  expect(errors).toEqual([]);
});

test("transit preset: default 20, the 40 chip adds the calibrated 20-min interior line, and the Transitous credit is present", async ({
  page,
}) => {
  await baseStubs(page);
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK_PRESET }));
  await page.route("**/api/transit**", (route) => {
    expect(route.request().url()).toContain("model=preset");
    route.fulfill({ json: TRANSIT_PRESET });
  });
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: emptyAmenities(ORIGIN) }));

  const map = await waitForMap(page);
  await selectAddress(page);
  await expect(map).toHaveAttribute("data-mode", "walk");

  await openControls(page);
  await page.getByRole("button", { name: "Public transport", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "transit");
  await expect(map).toHaveAttribute("data-selected-preset", "20");
  await expect(map).toHaveAttribute("data-preset-contours", "20");
  await expect(map).toHaveAttribute("data-interior-lines", "");

  // Transitous provider credit is present on the transit state (phone-first design).
  await expect(page.getByRole("link", { name: "Transitous" })).toBeVisible();

  await page.getByTestId("preset-chip-40").click();
  await expect(map).toHaveAttribute("data-selected-preset", "40");
  await expect(map).toHaveAttribute("data-preset-contours", "20,40");
  await expect(map).toHaveAttribute("data-interior-lines", "20");
});

test("car preset: 10/25 contours, and NO Transitous credit on a non-transit state", async ({ page }) => {
  await baseStubs(page);
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK_PRESET }));
  await page.route("**/api/car**", (route) => {
    expect(route.request().url()).toContain("model=preset");
    route.fulfill({ json: CAR_PRESET });
  });
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: emptyAmenities(ORIGIN) }));

  const map = await waitForMap(page);
  await selectAddress(page);
  await expect(map).toHaveAttribute("data-mode", "walk");
  await openControls(page);
  await page.getByRole("button", { name: "Car", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "car");
  await expect(map).toHaveAttribute("data-selected-preset", "10");
  await expect(map).toHaveAttribute("data-preset-contours", "10");

  await page.getByTestId("preset-chip-25").click();
  await expect(map).toHaveAttribute("data-preset-contours", "10,25");
  await expect(map).toHaveAttribute("data-interior-lines", "10");

  // Transit credit must NOT appear on a car state (it would imply transit data).
  await expect(page.getByRole("link", { name: "Transitous" })).toHaveCount(0);
});

test("first paint shows a realistic map placeholder, never a dark void", async ({ page }) => {
  await baseStubs(page);
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK_PRESET }));
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: emptyAmenities(ORIGIN) }));

  // The placeholder is in the DOM from first paint (an inline SVG map texture),
  // covered + hidden once MapLibre mounts — the "no dark void" contract.
  const placeholder = page.getByTestId("map-placeholder");
  await expect(placeholder).toBeAttached();
  const map = await waitForMap(page);
  // After the live map loads, the placeholder is marked covered.
  await expect(placeholder).toHaveAttribute("data-map-placeholder", "covered");
  await expect(map).toHaveAttribute("data-map-loaded", "true");
});

test("degraded reach: a failed isochrone shows the error inline and keeps the map alive (no takeover, no void)", async ({
  page,
}) => {
  await baseStubs(page);
  await page.route("**/api/isochrone**", (route) => route.fulfill({ status: 502, json: { error: "upstream" } }));
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: emptyAmenities(ORIGIN) }));

  const map = await waitForMap(page);
  await selectAddress(page);

  // The failure surfaces as an inline message; the map container stays present
  // and loaded (the reach failed, the app did not).
  await expect(page.getByText(/Could not compute walking reach/i)).toBeVisible();
  await expect(map).toHaveAttribute("data-map-loaded", "true");
  // No reach was drawn — the preset stamps stay unset.
  await expect(map).not.toHaveAttribute("data-selected-preset", /.*/);
});
