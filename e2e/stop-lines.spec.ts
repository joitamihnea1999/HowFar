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

/** Pixel delta of a lng/lat offset from the origin at zoom 13 (Web-Mercator,
 * the same math MapLibre uses). */
function offsetDelta(dLng: number, dLat: number) {
  const worldSize = 512 * 2 ** 13;
  const mercY = (lat: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return (worldSize / 2) * (1 - Math.log((1 + s) / (1 - s)) / (2 * Math.PI));
  };
  return { dx: (dLng / 360) * worldSize, dy: mercY(ORIGIN.lat + dLat) - mercY(ORIGIN.lat) };
}

/** Where the selected ORIGIN renders in the shared four-edge camera viewport. */
async function originPixel(map: Locator) {
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no box");
  const left = Number((await map.getAttribute("data-camera-pad-left")) ?? "0");
  const right = Number((await map.getAttribute("data-camera-pad-right")) ?? "0");
  const top = Number((await map.getAttribute("data-camera-pad-top")) ?? "0");
  const bottom = Number((await map.getAttribute("data-camera-pad-bottom")) ?? "0");
  return {
    box,
    x: (box.width + left - right) / 2,
    y: (box.height + top - bottom) / 2,
  };
}

/** Map-element pixel of a lng/lat offset from the (padded-centred) origin. */
async function offsetPixel(map: Locator, dLng: number, dLat: number) {
  const o = await originPixel(map);
  const d = offsetDelta(dLng, dLat);
  return { box: o.box, x: o.x + d.dx, y: o.y + d.dy };
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

/** Click the transit marker (rendered ~70px east of the padded centre). */
async function clickStop(page: Page, map: Locator) {
  const p = await offsetPixel(map, STOP_DLNG, 0);
  await map.click({ position: { x: p.x, y: p.y } });
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

// Task 024 REVERSED the pre-024 contract ("only transit is inspectable"): the
// owner asked for EVERY amenity to open its info instead of reselecting.
test("clicking a NON-transit marker opens its info popup WITHOUT starting a selection", async ({ page }) => {
  let reverseCalls = 0;
  await stubBase(page);
  await page.route("**/api/reverse**", (route) => {
    reverseCalls += 1;
    route.fulfill({ json: { lat: GROCERY.lat, lng: GROCERY.lng, label: "Should not happen" } });
  });
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: amenities([{ ...GROCERY, name: "Mega Image", category: "groceries", osmType: "node", osmId: 5 }]) }),
  );
  await page.route("**/api/stop-lines**", (route) => route.fulfill({ json: { name: "", lines: [] } }));

  const map = await loadAndSearch(page);
  // Click ~9px off the marker center — inside the forgiving 12px pad that a
  // 5px circle would have missed (the owner's precise-click complaint).
  const pos = await offsetPixel(map, STOP_DLNG, 0);
  await map.click({ position: { x: pos.x + 9, y: pos.y } });

  const poi = page.locator('[data-testid="poi-popup"]');
  await expect(poi).toBeVisible();
  await expect(poi.getByText("Mega Image")).toBeVisible();
  await expect(poi.getByText("Groceries")).toBeVisible();
  // …and the click did NOT start a selection.
  expect(reverseCalls).toBe(0);
  await expect(map).toHaveAttribute("data-selection", /Piața Unirii/);
});

test("a click in a marker-free gap still starts a normal selection", async ({ page }) => {
  let reverseCalls = 0;
  await stubBase(page);
  await page.route("**/api/reverse**", (route) => {
    reverseCalls += 1;
    route.fulfill({ json: { lat: ORIGIN.lat - 0.006, lng: ORIGIN.lng, label: "A fresh spot" } });
  });
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: amenities([{ ...STOP, name: "East Stop", category: "transit", osmType: "node", osmId: 111 }]) }),
  );

  const map = await loadAndSearch(page);
  // South of centre: well clear of the only marker (east) and any overlay.
  const pos = await offsetPixel(map, 0, -0.006);
  await map.click({ position: { x: pos.x, y: pos.y } });

  await expect.poll(() => reverseCalls).toBeGreaterThan(0);
  await expect(map).toHaveAttribute("data-selection", /fresh spot/i);
});

test("an amenity sitting exactly on the searched origin is still clickable (origin pin is pointer-transparent)", async ({
  page,
}) => {
  await stubBase(page);
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({
      json: amenities([{ ...ORIGIN, name: "Origin Stop", category: "transit", osmType: "node", osmId: 33 }]),
    }),
  );
  await page.route("**/api/stop-lines**", (route) =>
    route.fulfill({ json: { name: "Origin Stop", lines: [{ mode: "bus", ref: "104", direction: "Somewhere" }] } }),
  );

  const map = await loadAndSearch(page);
  // The origin's padded-centre pixel = the origin DOM marker's spot; before
  // task 024 the pin swallowed this click (parked limitation from task 021).
  const o = await originPixel(map);
  await map.click({ position: { x: o.x, y: o.y } });

  await expect(popup(page)).toBeVisible();
  await expect(popup(page).getByText("Bus 104")).toBeVisible();
});

test("a transit stop with no OSM identity falls back to the info popup (never silence)", async ({ page }) => {
  await stubBase(page);
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: amenities([{ ...STOP, name: "Ghost Stop", category: "transit" }]) }),
  );

  const map = await loadAndSearch(page);
  await clickStop(page, map);

  const poi = page.locator('[data-testid="poi-popup"]');
  await expect(poi).toBeVisible();
  await expect(poi.getByText("Ghost Stop")).toBeVisible();
  await expect(poi.getByText("Transit stops")).toBeVisible();
});

test("hovering near a marker arms the hover state; leaving clears it", async ({ page }) => {
  await stubBase(page);
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: amenities([{ ...STOP, name: "East Stop", category: "transit", osmType: "node", osmId: 111 }]) }),
  );

  const map = await loadAndSearch(page);
  const pos = await offsetPixel(map, STOP_DLNG, 0);

  // ~8px off the marker center: within the pick pad → hover arms.
  await page.mouse.move(pos.box.x + pos.x + 8, pos.box.y + pos.y);
  await expect(map).toHaveAttribute("data-amenity-hover", /\d/);

  // Far south: outside the pad → hover clears.
  await page.mouse.move(pos.box.x + pos.box.width / 2, pos.box.y + pos.box.height - 40);
  await expect(map).not.toHaveAttribute("data-amenity-hover", /.*/);
});

// --- Route paths (task 024): a line row draws its full path + stops ---------

const ROUTE_PATH = {
  segments: [
    [
      [26.1085, 44.4268],
      [26.12, 44.43],
      [26.13, 44.44],
    ],
  ],
  stops: [
    { lat: 44.4268, lng: 26.1085, name: "Piața Romană" },
    { lat: 44.44, lng: 26.13, name: "Cartier Dămăroaia" },
  ],
};

async function stubRouteScene(page: Page) {
  await stubBase(page);
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({
      json: amenities([{ ...STOP, name: "Piața Romană", category: "transit", osmType: "node", osmId: 444384784 }]),
    }),
  );
  await page.route("**/api/stop-lines**", (route) =>
    route.fulfill({
      json: {
        name: "Piața Romană",
        lines: [
          { mode: "bus", ref: "331", direction: "Cartier Dămăroaia", relationId: 1776396 },
          { mode: "bus", ref: "104" }, // no relationId → informational row, no button
        ],
      },
    }),
  );
}

test("clicking a line row draws its path; re-click and popup-close both clear it", async ({ page }) => {
  await stubRouteScene(page);
  await page.route("**/api/route-path**", (route) => route.fulfill({ json: ROUTE_PATH }));

  const map = await loadAndSearch(page);
  await clickStop(page, map);
  await expect(popup(page)).toHaveAttribute("data-state", "ready");

  // The id-carrying row is a button; the id-less row is not.
  const row = popup(page).getByRole("button", { name: /Bus 331/ });
  await expect(row).toBeVisible();
  await expect(popup(page).getByRole("button", { name: /Bus 104/ })).toHaveCount(0);

  await row.click();
  await expect(map).toHaveAttribute("data-route-path", "1776396");

  // Re-click the active row → path off (popup stays).
  await row.click();
  await expect(map).not.toHaveAttribute("data-route-path", /.*/);
  await expect(popup(page)).toBeVisible();

  // Draw again, then close the popup with its × → path clears with it.
  await row.click();
  await expect(map).toHaveAttribute("data-route-path", "1776396");
  await page.locator(".maplibregl-popup-close-button").click();
  await expect(popup(page)).toHaveCount(0);
  await expect(map).not.toHaveAttribute("data-route-path", /.*/);
});

test("a new selection clears the drawn path along with the popup", async ({ page }) => {
  await stubRouteScene(page);
  await page.route("**/api/route-path**", (route) => route.fulfill({ json: ROUTE_PATH }));

  const map = await loadAndSearch(page);
  await clickStop(page, map);
  await popup(page).getByRole("button", { name: /Bus 331/ }).click();
  await expect(map).toHaveAttribute("data-route-path", "1776396");

  // A genuinely-new selection (search — position-independent: the path's
  // fitBounds just moved the camera) → popup + path both go.
  await page.route("**/api/geocode**", (route) =>
    route.fulfill({ json: { lat: 44.42, lng: 26.09, label: "Elsewhere, București" } }),
  );
  await page.getByRole("combobox").fill("Elsewhere");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-selection", /Elsewhere/);
  await expect(popup(page)).toHaveCount(0);
  await expect(map).not.toHaveAttribute("data-route-path", /.*/);
});

test("clicking the drawn route is a no-op; clicking bare map away from it clears via a new selection", async ({
  page,
}) => {
  await stubRouteScene(page);
  // A flat horizontal line at the exact vertical center of its own bounds, so
  // after fitBounds it deterministically crosses the padded-viewport center.
  await page.route("**/api/route-path**", (route) =>
    route.fulfill({
      json: {
        segments: [
          [
            [26.1, 44.43],
            [26.14, 44.43],
          ],
        ],
        stops: [
          { lat: 44.425, lng: 26.1, name: "West End" },
          { lat: 44.435, lng: 26.14, name: "East End" },
        ],
      },
    }),
  );
  let reverseCalls = 0;
  await page.route("**/api/reverse**", (route) => {
    reverseCalls += 1;
    route.fulfill({ json: { lat: 44.42, lng: 26.12, label: "A fresh spot" } });
  });

  const map = await loadAndSearch(page);
  await clickStop(page, map);
  await popup(page).getByRole("button", { name: /Bus 331/ }).click();
  await expect(map).toHaveAttribute("data-route-path", "1776396");
  await page.waitForTimeout(1600); // let fitBounds settle before projecting

  const box = await map.boundingBox();
  if (!box) throw new Error("map has no box");
  // fitBounds pads {left: 60+dock, others: 60} and the bounds fit by WIDTH, so
  // the flat line renders at the vertical center of the padded area, spanning
  // its full width. Click near the line's RIGHT end — the stop popup (auto-
  // anchored near the clicked stop, left of center) can't reach out there.
  const lineX = box.width - 60 - 120;
  const lineY = box.height / 2;

  // ON the line → no-op: path + popup + selection all stay.
  await map.click({ position: { x: lineX, y: lineY } });
  await expect(map).toHaveAttribute("data-route-path", "1776396");
  await expect(popup(page)).toBeVisible();
  expect(reverseCalls).toBe(0);

  // Bare map well below the line → a normal selection starts and tears down
  // the popup + path (the map-click clear the owner's flow relies on).
  await map.click({ position: { x: lineX, y: lineY + 250 } });
  await expect(map).toHaveAttribute("data-selection", /fresh spot/i);
  await expect(popup(page)).toHaveCount(0);
  await expect(map).not.toHaveAttribute("data-route-path", /.*/);
});

test("a route-path failure marks the row, never draws, and stays recoverable", async ({ page }) => {
  await stubRouteScene(page);
  let healthy = false;
  await page.route("**/api/route-path**", (route) =>
    healthy
      ? route.fulfill({ json: ROUTE_PATH })
      : route.fulfill({ status: 502, json: { error: "Upstream provider error" } }),
  );

  const map = await loadAndSearch(page);
  await clickStop(page, map);
  const row = popup(page).getByRole("button", { name: /Bus 331/ });

  await row.click();
  await expect(row).toHaveClass(/hf-stop-popup__route--error/);
  await expect(map).not.toHaveAttribute("data-route-path", /.*/);

  // The provider recovers; clicking the row again succeeds.
  healthy = true;
  await row.click();
  await expect(map).toHaveAttribute("data-route-path", "1776396");
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
  const east = await offsetPixel(map, STOP_DLNG, 0);
  const south = await offsetPixel(map, 0, -0.006);

  // Click East (slow) then IMMEDIATELY South (fast) — do not wait for East.
  await map.click({ position: { x: east.x, y: east.y } });
  await map.click({ position: { x: south.x, y: south.y } });

  await expect(popup(page).getByText("South Dest")).toBeVisible();
  // Let East's delayed response arrive…
  await page.waitForTimeout(1800);
  await expect(popup(page).getByText("South Dest")).toBeVisible(); // …South still shown
  await expect(popup(page).getByText("East Dest")).toHaveCount(0); // …East never painted (stale dropped)
});
