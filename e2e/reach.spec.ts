import { expect, test, type Page } from "@playwright/test";

// Right-click "how do I get there?" (task 052 D). Provider calls stubbed by EXACT
// path. Walk reach is answered client-side (point-in-ring on the drawn rings);
// transit reach fetches a MOTIS trip plan from /api/reach (mocked here). The
// right-click is a native right-button click on the map canvas → contextmenu.

function polyRing(minutes: number, d: number) {
  return {
    minutes,
    geometry: {
      type: "MultiPolygon",
      coordinates: [[[
        [26.1025 - d, 44.4268 - d],
        [26.1025 + d, 44.4268 - d],
        [26.1025 + d, 44.4268 + d],
        [26.1025 - d, 44.4268 + d],
        [26.1025 - d, 44.4268 - d],
      ]]],
    },
  };
}
// Large rings so a click anywhere on the fitted viewport is deterministically
// inside the innermost (15-min) band — the point-in-ring result must not depend
// on exact camera projection (mock geometry, not realistic distances).
const WALK = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [polyRing(15, 0.28), polyRing(30, 0.3), polyRing(45, 0.32)] };
const TRANSIT = {
  origin: { lat: 44.4268, lng: 26.1025 },
  rings: [polyRing(15, 0.28), polyRing(30, 0.3), polyRing(45, 0.32)],
  departure: "2026-07-29T05:30:00.000Z",
};
// Empty rings ⇒ point-in-ring is always null ⇒ transit right-click is
// "unreachable" with no /api/reach call (the T1 gate).
const emptyRing = (minutes: number) => ({ minutes, geometry: { type: "MultiPolygon", coordinates: [] } });
const TRANSIT_EMPTY = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [emptyRing(15), emptyRing(30), emptyRing(45)], departure: "2026-07-29T05:30:00.000Z" };
const PLAN = {
  reachable: true,
  totalMinutes: 57,
  transfers: 1,
  legs: [
    { mode: "WALK", fromName: "START", toName: "Emil Racovita", minutes: 9 },
    { mode: "BUS", line: "243", headsign: "Bd. Lacul Tei", fromName: "Emil Racovita", toName: "Soseaua Colentina", minutes: 50 },
    { mode: "WALK", fromName: "Soseaua Colentina", toName: "END", minutes: 5 },
  ],
};

async function setup(page: Page) {
  const reachCalls: string[] = [];
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: { origin: { lat: 44.4268, lng: 26.1025 }, walkMinutes: 15, amenities: [] } }),
  );
  await page.route("**/api/geocode**", (route) =>
    route.fulfill({ json: { lat: 44.4268, lng: 26.1025, label: "Piața Unirii, București" } }),
  );
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK }));
  await page.route("**/api/transit**", (route) => route.fulfill({ json: TRANSIT }));
  await page.route("**/api/reach**", (route) => {
    reachCalls.push(route.request().url());
    route.fulfill({ json: PLAN });
  });
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  return { map, reachCalls };
}

async function search(page: Page, map: ReturnType<Page["getByTestId"]>) {
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
}

// Native right-click near the centre of the map canvas (over the origin/rings).
async function rightClickCentre(page: Page) {
  const canvas = page.locator(".maplibregl-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas");
  await canvas.click({ button: "right", position: { x: Math.round(box.width / 2), y: Math.round(box.height / 2) } });
}

test("right-click with no selection shows the hint", async ({ page }) => {
  const { map } = await setup(page);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-state", "hint");
  await expect(page.getByTestId("reach-popup")).toContainText("Pick a starting point");
});

test("walk mode: right-click answers client-side with no /api/reach call", async ({ page }) => {
  const { map, reachCalls } = await setup(page);
  await search(page, map);
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-state", "walk");
  const popup = page.getByTestId("reach-popup");
  await expect(popup).toBeVisible();
  await expect(popup).toContainText("On foot"); // inside the (large) walk ring → deterministic band
  expect(reachCalls).toHaveLength(0); // walk is fully client-side
});

test("public-transport mode: right-click shows the planned trip with a specific line", async ({ page }) => {
  const { map, reachCalls } = await setup(page);
  await search(page, map);
  await page.getByRole("button", { name: "Public transport", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "transit");

  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-state", "transit");
  const popup = page.getByTestId("reach-popup");
  await expect(popup).toContainText("By public transport");
  await expect(popup).toContainText("~57 min · 1 transfer");
  await expect(popup).toContainText("Bus 243 → Bd. Lacul Tei");
  await expect(popup).toContainText("Walk 9 min");
  // The trip was fetched with both endpoints AND the selection's resolved
  // departure ISO (so the plan matches the painted rings' time — P5).
  expect(reachCalls.length).toBeGreaterThan(0);
  expect(reachCalls[0]).toMatch(/fromLat=.*&fromLng=.*&toLat=.*&toLng=/);
  expect(decodeURIComponent(reachCalls[0])).toContain("departure=2026-07-29T05:30");
});

test("public-transport mode: a point outside the rings is unreachable with NO /api/reach call (T1 gate)", async ({ page }) => {
  const reachCalls: string[] = [];
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: { origin: { lat: 44.4268, lng: 26.1025 }, walkMinutes: 15, amenities: [] } }),
  );
  await page.route("**/api/geocode**", (route) => route.fulfill({ json: { lat: 44.4268, lng: 26.1025, label: "Piața Unirii" } }));
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK }));
  await page.route("**/api/transit**", (route) => route.fulfill({ json: TRANSIT_EMPTY })); // no reachable area
  await page.route("**/api/reach**", (route) => {
    reachCalls.push(route.request().url());
    route.fulfill({ json: PLAN });
  });
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await search(page, map);
  await page.getByRole("button", { name: "Public transport", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "transit");

  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-state", "none");
  await expect(page.getByTestId("reach-popup")).toContainText("Beyond your reach");
  expect(reachCalls).toHaveLength(0); // outside the painted reach → never hits the planner
});

test("public-transport mode: no route found is reported", async ({ page }) => {
  await page.route("**/api/amenities**", (route) =>
    route.fulfill({ json: { origin: { lat: 44.4268, lng: 26.1025 }, walkMinutes: 15, amenities: [] } }),
  );
  await page.route("**/api/geocode**", (route) =>
    route.fulfill({ json: { lat: 44.4268, lng: 26.1025, label: "Piața Unirii" } }),
  );
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: WALK }));
  await page.route("**/api/transit**", (route) => route.fulfill({ json: TRANSIT }));
  await page.route("**/api/reach**", (route) => route.fulfill({ json: { reachable: false } }));
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await search(page, map);
  await page.getByRole("button", { name: "Public transport", exact: true }).click();
  await rightClickCentre(page);
  await expect(map).toHaveAttribute("data-reach-state", "none");
  await expect(page.getByTestId("reach-popup")).toContainText("No public-transport route");
});
