import { expect, test, type Page } from "@playwright/test";
import { innerBandCounts, WALK_CLIP } from "./amenity-fixtures";

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
        clip: WALK_CLIP,
        countsByBand: innerBandCounts({ groceries: 0, pharmacies: 0, parks: 0, schools: 0, transit: 0 }),
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
  // First-run ring comprehension: the card states what the shaded area MEANS,
  // with the minutes of the band actually shown.
  await expect(page.getByTestId("ring-explainer")).toContainText(
    "everything you can walk to within 15 minutes",
  );
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

// ── Task 065: amenity visibility follows the SHADING ─────────────────────────
//
// The clip is now the whole reach area of the current mode, and each place carries
// the ring band it sits in. Because a ring layer paints the WHOLE reach polygon for
// its band (not an annulus), band visibility is CUMULATIVE: selecting 30 shades the
// 30-minute area including the inner 15 zone, so inner markers must STAY. Filtering
// amenities to the single selected band — the obvious-looking implementation — would
// hide them exactly when the user widens the rings.
//
// Assertions read RENDERED source features off `window.__hfMap`, not a stamp the app
// wrote about itself.

const BANDED_ORIGIN = { lat: 44.4268, lng: 26.1025 };
/** One grocery per band, each far enough out to be unambiguous. */
const BANDED_AMENITIES = [
  { lat: 44.4278, lng: 26.1025, name: "Inner Shop", category: "groceries", band: 15, distanceMeters: 110 },
  { lat: 44.4448, lng: 26.1025, name: "Mid Shop", category: "groceries", band: 30, distanceMeters: 2000 },
  { lat: 44.4568, lng: 26.1025, name: "Outer Shop", category: "groceries", band: 45, distanceMeters: 3300 },
];

async function stubBandedAmenities(page: Page) {
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({
      json: {
        origin: BANDED_ORIGIN,
        clip: { mode: "walk", band: 45, minutes: 45 },
        // Pre-cap totals per band: one grocery in each.
        countsByBand: {
          15: { groceries: 1, pharmacies: 0, parks: 0, schools: 0, transit: 0 },
          30: { groceries: 1, pharmacies: 0, parks: 0, schools: 0, transit: 0 },
          45: { groceries: 1, pharmacies: 0, parks: 0, schools: 0, transit: 0 },
        },
        amenities: BANDED_AMENITIES,
      },
    }),
  );
}

/** Names of the places actually written into the clustered amenity source. */
async function renderedAmenityNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    // `__hfMap` is exposed for RENDERED-state assertions; typed
    // loosely here so this spec needs no maplibre types and no global augmentation
    // that would clash with the one in amenity-legibility.spec.ts.
    const m = (window as unknown as {
      __hfMap?: {
        querySourceFeatures: (
          id: string,
          opts: { filter: unknown[] },
        ) => { properties: Record<string, unknown> | null }[];
      };
    }).__hfMap;
    if (!m) return [];
    // DEDUPED: `querySourceFeatures` yields a feature once per tile that contains it
    // (and across retained tile generations mid-zoom), so a place near a seam comes
    // back twice. Deduping by name keeps this an assertion about WHICH places are in
    // the source, not about tiling.
    const names = m
      .querySourceFeatures("amenities", { filter: ["!", ["has", "point_count"]] })
      .map((f) => (f.properties?.name as string) ?? "")
      .filter(Boolean);
    return [...new Set(names)].sort();
  });
}

test("amenity markers follow the shaded bands, and widening the rings KEEPS the inner ones", async ({
  page,
}) => {
  await stubBase(page);
  await stubBandedAmenities(page);
  const map = await loadAndSearch(page);

  // Default filter is the inner band: only the inner place is drawn, and the chip
  // reports 1 — not the 3 that exist in the whole clip.
  await expect(map).toHaveAttribute("data-ring-filter", "15");
  await expect(async () => {
    expect(await renderedAmenityNames(page)).toEqual(["Inner Shop"]);
  }).toPass({ timeout: 15_000 });
  await expect(page.getByLabel(/^Groceries: 1 places/)).toBeVisible();

  // Widen to 30 → the 30-minute area INCLUDES the inner zone, so BOTH show. This is
  // the assertion that fails if band filtering is not cumulative.
  await page.getByRole("button", { name: "30 min" }).click();
  await expect(async () => {
    expect(await renderedAmenityNames(page)).toEqual(["Inner Shop", "Mid Shop"]);
  }).toPass({ timeout: 15_000 });
  await expect(page.getByLabel(/^Groceries: 2 places/)).toBeVisible();

  // All → every band, chip reports the full clip total.
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(async () => {
    expect(await renderedAmenityNames(page)).toEqual(["Inner Shop", "Mid Shop", "Outer Shop"]);
  }).toPass({ timeout: 15_000 });
  await expect(page.getByLabel(/^Groceries: 3 places/)).toBeVisible();

  // Narrow back to 15 → the outer markers go AND the chip shrinks with them, so the
  // count can never claim places outside the shading.
  await page.getByRole("button", { name: "15 min" }).click();
  await expect(async () => {
    expect(await renderedAmenityNames(page)).toEqual(["Inner Shop"]);
  }).toPass({ timeout: 15_000 });
  await expect(page.getByLabel(/^Groceries: 1 places/)).toBeVisible();
});
