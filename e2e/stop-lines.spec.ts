import { expect, test, type Locator, type Page } from "@playwright/test";

// Transit-stop line popup (task 021). A click on a transit marker opens a popup
// listing the lines that serve it — and must NOT start a new isochrone
// selection (no reverse/isochrone request). Providers stubbed by EXACT path.

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
const WALK = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [ring(15, 0.02), ring(30, 0.04), ring(45, 0.06)] };

// The map flies to the origin at zoom 13 after a selection. We put the transit
// marker at a small east offset so it projects ~70px right of the container
// centre — well clear of the origin DOM marker (which would otherwise swallow
// the click, task 021) — and project it with the same Web-Mercator math
// MapLibre uses, so the test clicks the rendered GL circle deterministically.
const ORIGIN = { lat: 44.4268, lng: 26.1025 };
const STOP_DLNG = 0.006; // ≈ 70px east at zoom 13
const STOP = { lat: ORIGIN.lat, lng: ORIGIN.lng + STOP_DLNG };
const GROCERY = { lat: ORIGIN.lat, lng: ORIGIN.lng + STOP_DLNG }; // same slot, non-transit

function amenities(items: { lat: number; lng: number; name: string; category: string; osmType?: string; osmId?: number }[]) {
  return {
    origin: ORIGIN,
    walkMinutes: 15,
    counts: { groceries: 0, pharmacies: 0, parks: 0, schools: 0, transit: 0 },
    amenities: items,
  };
}

/** Pixel (relative to the map element) of a lng/lat offset from the origin,
 * given the container size, at zoom 13 centred on the origin. */
function offsetPixel(box: { width: number; height: number }, dLng: number, dLat: number) {
  const worldSize = 512 * 2 ** 13;
  const mercY = (lat: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return (worldSize / 2) * (1 - Math.log((1 + s) / (1 - s)) / (2 * Math.PI));
  };
  const dx = (dLng / 360) * worldSize;
  const dy = mercY(ORIGIN.lat + dLat) - mercY(ORIGIN.lat);
  return { x: box.width / 2 + dx, y: box.height / 2 + dy };
}

async function stubBase(page: Page) {
  await page.route("**/api/geocode**", (route) =>
    route.fulfill({ json: { ...ORIGIN, label: "Piața Unirii, București" } }),
  );
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK }));
}

async function loadAndSearch(page: Page): Promise<Locator> {
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-amenity-count", /\d/); // markers painted
  await page.waitForTimeout(1600); // let the flyTo settle at zoom 13 before projecting
  return map;
}

/** Click the transit marker (rendered ~70px east of centre). */
async function clickStop(page: Page, map: Locator) {
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no box");
  await map.click({ position: offsetPixel(box, STOP_DLNG, 0) });
}

const popup = (page: Page) => page.locator('[data-testid="stop-popup"]');

test("clicking a transit stop shows its lines WITHOUT starting a selection", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  let reverseCalls = 0;
  let isochroneCalls = 0;
  await stubBase(page);
  await page.route("**/api/reverse**", (route) => {
    reverseCalls += 1;
    route.fulfill({ json: { ...ORIGIN, label: "Should not happen" } });
  });
  await page.unroute("**/api/isochrone**");
  await page.route("**/api/isochrone**", (route) => {
    isochroneCalls += 1;
    route.fulfill({ json: WALK });
  });
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: amenities([{ ...STOP, name: "Piața Romană", category: "transit", osmType: "node", osmId: 444384784 }]) }),
  );
  await page.route("**/api/stop-lines**", (route) =>
    route.fulfill({
      json: {
        name: "Piața Romană",
        lines: [
          // Both direction variants of one ref → two distinct rows.
          { mode: "bus", ref: "331", direction: "Cartier Dămăroaia" },
          { mode: "bus", ref: "331", direction: "Piața Romană" },
          { mode: "subway", ref: "M2", direction: "Pipera" },
        ],
      },
    }),
  );

  const map = await loadAndSearch(page);
  await expect(map).toHaveAttribute("data-selection", /Piața Unirii/);
  const isoAfterSearch = isochroneCalls;

  await clickStop(page, map);

  // The popup opens with the stop's lines…
  await expect(popup(page)).toBeVisible();
  await expect(popup(page)).toHaveAttribute("data-state", "ready");
  // Both direction variants of Bus 331 render as two rows, plus the metro line.
  await expect(popup(page).locator(".hf-stop-popup__ref", { hasText: "Bus 331" })).toHaveCount(2);
  await expect(popup(page).locator(".hf-stop-popup__dir", { hasText: "Cartier Dămăroaia" })).toBeVisible();
  await expect(popup(page).locator(".hf-stop-popup__dir", { hasText: "Piața Romană" })).toBeVisible();
  await expect(popup(page).getByText("Metro M2")).toBeVisible();

  // …and the click did NOT start a selection: no reverse, no extra isochrone,
  // and the selection label is unchanged (the real reselection-suppression proof).
  await expect(map).toHaveAttribute("data-selection", /Piața Unirii/);
  expect(reverseCalls).toBe(0);
  expect(isochroneCalls).toBe(isoAfterSearch);
  expect(errors).toEqual([]);
});

test("a stop that serves no mapped routes shows an honest empty state (loading clears)", async ({ page }) => {
  await stubBase(page);
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: amenities([{ ...STOP, name: "Lonely Stop", category: "transit", osmType: "node", osmId: 7 }]) }),
  );
  await page.route("**/api/stop-lines**", (route) => route.fulfill({ json: { name: "Lonely Stop", lines: [] } }));

  const map = await loadAndSearch(page);
  await clickStop(page, map);

  await expect(popup(page)).toHaveAttribute("data-state", "empty");
  await expect(popup(page).getByText(/no line data/i)).toBeVisible();
});

test("a stop-lines failure shows an error state, not a stuck spinner", async ({ page }) => {
  await stubBase(page);
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: amenities([{ ...STOP, name: "Broken Stop", category: "transit", osmType: "node", osmId: 9 }]) }),
  );
  await page.route("**/api/stop-lines**", (route) =>
    route.fulfill({ status: 502, json: { error: "Upstream provider error" } }),
  );

  const map = await loadAndSearch(page);
  await clickStop(page, map);

  await expect(popup(page)).toHaveAttribute("data-state", "error");
  await expect(popup(page).getByText(/unavailable/i)).toBeVisible();
});

test("clicking a NON-transit marker still starts a selection (only transit is inspectable)", async ({ page }) => {
  let reverseCalls = 0;
  await stubBase(page);
  await page.route("**/api/reverse**", (route) => {
    reverseCalls += 1;
    route.fulfill({ json: { lat: GROCERY.lat, lng: GROCERY.lng, label: "A grocery spot" } });
  });
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: amenities([{ ...GROCERY, name: "Mega Image", category: "groceries", osmType: "node", osmId: 5 }]) }),
  );
  await page.route("**/api/stop-lines**", (route) => route.fulfill({ json: { name: "", lines: [] } }));

  const map = await loadAndSearch(page);
  await clickStop(page, map); // clicks the grocery marker's slot

  // No popup; the click fell through to a normal map-click selection (reverse hit).
  await expect(popup(page)).toHaveCount(0);
  await expect.poll(() => reverseCalls).toBeGreaterThan(0);
  await expect(map).toHaveAttribute("data-selection", /grocery spot/i);
});

test("a slow first stop's response never paints under a second stop's popup (stale-guard)", async ({ page }) => {
  await stubBase(page);
  // Two transit stops: one east, one SOUTH of centre (north would land under the
  // top search/selection overlay, which intercepts the click).
  const SOUTH = { lat: ORIGIN.lat - 0.006, lng: ORIGIN.lng };
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({
      json: amenities([
        { ...STOP, name: "East Stop", category: "transit", osmType: "node", osmId: 111 },
        { ...SOUTH, name: "South Stop", category: "transit", osmType: "node", osmId: 222 },
      ]),
    }),
  );
  // The first stop (id=111) responds SLOWLY; the second (222) instantly. Without
  // the generation guard, 111's late "East Dest" would repaint over 222's popup.
  await page.route("**/api/stop-lines**", async (route) => {
    const id = new URL(route.request().url()).searchParams.get("id");
    if (id === "111") await new Promise((r) => setTimeout(r, 1500));
    const dir = id === "111" ? "East Dest" : "South Dest";
    route.fulfill({ json: { name: "", lines: [{ mode: "bus", ref: id === "111" ? "1" : "2", direction: dir }] } });
  });

  const map = await loadAndSearch(page);
  const box = await map.boundingBox();
  if (!box) throw new Error("no box");

  // Click East (slow) then IMMEDIATELY South (fast) — do not wait for East.
  await map.click({ position: offsetPixel(box, STOP_DLNG, 0) });
  await map.click({ position: offsetPixel(box, 0, -0.006) });

  await expect(popup(page).getByText("South Dest")).toBeVisible();
  // Let East's delayed response arrive…
  await page.waitForTimeout(1800);
  await expect(popup(page).getByText("South Dest")).toBeVisible(); // …South still shown
  await expect(popup(page).getByText("East Dest")).toHaveCount(0); // …East never painted (stale dropped)
});
