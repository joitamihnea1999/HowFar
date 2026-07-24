import { expect, test, type Page } from "@playwright/test";

function ring(minutes: number, distance: number) {
  return {
    minutes,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [26.1025 - distance, 44.4268 - distance],
          [26.1025 + distance, 44.4268 - distance],
          [26.1025 + distance, 44.4268 + distance],
          [26.1025 - distance, 44.4268 + distance],
          [26.1025 - distance, 44.4268 - distance],
        ],
      ],
    },
  };
}

const ISOCHRONE = {
  origin: { lat: 44.4268, lng: 26.1025 },
  rings: [ring(15, 0.01), ring(30, 0.02), ring(45, 0.03)],
};

const AMENITIES = {
  counts: { groceries: 12, pharmacies: 8, parks: 5, schools: 7, transit: 14 },
  amenities: [
    { lat: 44.4268, lng: 26.1085, name: "Mega Image Unirii", category: "groceries" },
    { lat: 44.428, lng: 26.101, name: "Farmacia Tei", category: "pharmacies" },
    { lat: 44.426, lng: 26.104, name: "Parcul Unirii", category: "parks" },
    { lat: 44.429, lng: 26.1, name: "Școala Gimnazială 79", category: "schools" },
    {
      lat: 44.425,
      lng: 26.102,
      name: "Piața Unirii 2",
      category: "transit",
      osmType: "node",
      osmId: 582555685,
    },
  ],
};

async function touchSwipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const session = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, radiusX: 3, radiusY: 3, force: 1, id: 1 }];
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.x, from.y) });
  for (let step = 1; step <= 6; step += 1) {
    const progress = step / 6;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: point(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress),
    });
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
}

test("touch journey stays usable through selection, results, inspection, map gestures, and orientation", async ({
  page,
}) => {
  await page.route("**/api/suggest**", (route) =>
    route.fulfill({
      json: {
        suggestions: [
          ...Array.from({ length: 8 }, (_, index) => ({
            label: `Bulevardul Unirii ${index + 1}, București`,
            lat: 44.425 + index * 0.0001,
            lng: 26.1 + index * 0.0001,
          })),
          { label: "Piața Unirii, București", lat: 44.4268, lng: 26.1025 },
        ],
      },
    }),
  );
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: ISOCHRONE }));
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: AMENITIES }));
  await page.route("**/api/reverse**", (route) =>
    route.fulfill({ json: { lat: 44.427, lng: 26.11, label: "Touched map point" } }),
  );
  await page.route("**/api/stop-lines**", (route) =>
    route.fulfill({
      json: {
        name: "Piața Unirii 2",
        lines: [{ mode: "bus", ref: "331", direction: "Cartier Dămăroaia", relationId: 1776396 }],
      },
    }),
  );
  await page.route("**/api/route-path**", (route) =>
    route.fulfill({
      json: {
        segments: [
          [
            [26.102, 44.425],
            [26.118, 44.432],
            [26.13, 44.44],
          ],
        ],
        stops: [
          { lat: 44.425, lng: 26.102, name: "Piața Unirii 2" },
          { lat: 44.44, lng: 26.13, name: "Cartier Dămăroaia" },
        ],
      },
    }),
  );

  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
  await expect(page.getByTestId("first-run")).toBeVisible();

  const search = page.getByRole("combobox");
  await search.tap();
  await search.fill("Unirii");
  const suggestionList = page.getByRole("listbox");
  await expect(page.getByRole("option")).toHaveCount(9);
  const suggestionListBox = await suggestionList.boundingBox();
  if (!suggestionListBox) throw new Error("mobile suggestion list has no box");
  const suggestScrollBefore = await suggestionList.evaluate((element) => element.scrollTop);
  await touchSwipe(
    page,
    { x: suggestionListBox.x + suggestionListBox.width / 2, y: suggestionListBox.y + suggestionListBox.height - 24 },
    { x: suggestionListBox.x + suggestionListBox.width / 2, y: suggestionListBox.y + 28 },
  );
  await expect.poll(() => suggestionList.evaluate((element) => element.scrollTop)).toBeGreaterThan(suggestScrollBefore);
  await expect(suggestionList).toBeVisible();
  await expect(map).not.toHaveAttribute("data-selection", /.*/);
  const suggestion = page.getByRole("option", { name: "Piața Unirii, București" });
  await expect(suggestion).toBeVisible();
  await suggestion.scrollIntoViewIfNeeded();
  await suggestion.tap();
  await expect(map).toHaveAttribute("data-selection", "Piața Unirii, București");
  await expect(map).toHaveAttribute("data-amenity-count", "5");

  const sheet = page.getByTestId("result-sheet");
  const sheetBox = await sheet.boundingBox();
  if (!sheetBox) throw new Error("mobile result sheet has no box");
  const beforeScroll = await sheet.evaluate((element) => element.scrollTop);
  await touchSwipe(
    page,
    { x: sheetBox.x + sheetBox.width / 2, y: sheetBox.y + sheetBox.height - 18 },
    { x: sheetBox.x + sheetBox.width / 2, y: sheetBox.y + 24 },
  );
  await expect.poll(() => sheet.evaluate((element) => element.scrollTop)).toBeGreaterThan(beforeScroll);

  const parksToggle = page.getByRole("button", { name: /Parks & green: .* places/ });
  await parksToggle.scrollIntoViewIfNeeded();
  const parksToggleBox = await parksToggle.boundingBox();
  if (!parksToggleBox) throw new Error("mobile park toggle has no box");
  expect(parksToggleBox.height).toBeGreaterThanOrEqual(44);
  await parksToggle.tap();
  await expect(parksToggle).toHaveAttribute("aria-pressed", "false");
  await expect(map).toHaveAttribute("data-amenity-count", "4");
  await parksToggle.tap();
  // Anchor the re-enable on the toggle's own state before the count: a tap lost
  // under touch-emulation load fails here loudly rather than as a stuck count.
  await expect(parksToggle).toHaveAttribute("aria-pressed", "true");
  await expect(map).toHaveAttribute("data-amenity-count", "5");

  const browse = page.getByTestId("amenity-browser-trigger");
  await browse.scrollIntoViewIfNeeded();
  await browse.tap();
  const place = page.getByRole("button", { name: /Mega Image Unirii/ });
  await place.scrollIntoViewIfNeeded();
  await place.tap();
  await expect(page.locator('[data-testid="poi-popup"]').getByText("Mega Image Unirii")).toBeVisible();
  await page.locator(".maplibregl-popup-close-button").tap();

  await browse.tap();
  await page.getByPlaceholder("Filter places").fill("Piața Unirii 2");
  await page.getByRole("button", { name: /Piața Unirii 2/ }).tap();
  const stop = page.locator('[data-testid="stop-popup"]');
  await expect(stop).toHaveAttribute("data-state", "ready");
  await stop.getByRole("button", { name: /Bus 331/ }).tap();
  await expect(map).toHaveAttribute("data-route-path", "1776396");

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(map).toHaveAttribute("data-camera-pad-top", "168");
  await expect(map).toHaveAttribute("data-camera-pad-left", "12");
  await expect
    .poll(() =>
      map.evaluate((element) => ({
        framed: element.dataset.routeFramed,
        frame: element.dataset.routeFrame,
      })),
    )
    .toMatchObject({ framed: "true" });
  await expect(map).toHaveAttribute("data-route-corridor-height", /7[0-9]|[89][0-9]/);
  const [commandBox, landscapeSheetBox] = await Promise.all([
    page.getByTestId("command-surface").boundingBox(),
    sheet.boundingBox(),
  ]);
  if (!commandBox || !landscapeSheetBox) throw new Error("landscape shell has no boxes");
  expect(landscapeSheetBox.y + landscapeSheetBox.height).toBeLessThanOrEqual(390);
  expect(await sheet.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.locator(".maplibregl-ctrl-compass")).toBeHidden();
  for (const name of ["Zoom in", "Zoom out"]) {
    const control = page.getByRole("button", { name });
    const box = await control.boundingBox();
    if (!box) throw new Error(`${name} control has no box`);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(center.y).toBeGreaterThan(commandBox.y + commandBox.height + 4);
    expect(center.y).toBeLessThan(landscapeSheetBox.y - 4);
    expect(
      await page.evaluate(
        ({ x, y, label }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") === label,
        { ...center, label: name },
      ),
    ).toBe(true);
  }
  if (process.env.HOWFAR_CAPTURE_DIR) {
    await page.screenshot({
      path: `${process.env.HOWFAR_CAPTURE_DIR}/touch-landscape.png`,
      animations: "disabled",
    });
  }

  await page.setViewportSize({ width: 412, height: 839 });
  await page.locator(".maplibregl-popup-close-button").tap();

  const mapBox = await map.boundingBox();
  if (!mapBox) throw new Error("mobile map has no box");
  await touchSwipe(page, { x: mapBox.width * 0.52, y: 430 }, { x: mapBox.width * 0.68, y: 430 });
  await expect(map).toHaveAttribute("data-map-drag", "1");
  await page.touchscreen.tap(mapBox.width - 70, 430);
  await expect(map).toHaveAttribute("data-selection", "Touched map point");

  await expect(page.getByRole("link", { name: "Transitous" })).toBeVisible();
  await expect(page.locator(".maplibregl-ctrl-attrib")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
});

test("Car mode toggle: three options meet the 44px target and don't overflow or occlude zoom controls (task 053, C-I)", async ({
  page,
}) => {
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });

  const toggle = page.getByRole("group", { name: "Travel mode" });
  await expect(toggle).toBeVisible();

  const viewportWidth = page.viewportSize()!.width;
  for (const name of ["Walk", "Public transport", "Car"]) {
    const btn = page.getByRole("button", { name, exact: true });
    await expect(btn).toBeVisible();
    const box = await btn.boundingBox();
    if (!box) throw new Error(`no box for ${name}`);
    // 44px minimum touch target on BOTH axes (impl panel: 3-up was ~37px WIDE
    // at 375px), and no horizontal overflow past the viewport.
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 1);
  }
  // The label must not clip — its full text must fit inside the button box
  // (scrollWidth ≤ clientWidth for the label span), at the narrowest phone width.
  await page.setViewportSize({ width: 375, height: 812 });
  for (const name of ["Walk", "Public transport", "Car"]) {
    const btn = page.getByRole("button", { name, exact: true });
    const box = await btn.boundingBox();
    if (!box) throw new Error(`no box for ${name} at 375px`);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  // The command dock must not sit on top of the bottom-right zoom controls.
  const zoomIn = page.locator(".maplibregl-ctrl-zoom-in");
  await expect(zoomIn).toBeVisible();
  const zb = await zoomIn.boundingBox();
  const tb = await toggle.boundingBox();
  if (!zb || !tb) throw new Error("missing zoom/toggle box");
  const overlap = !(tb.x + tb.width <= zb.x || zb.x + zb.width <= tb.x || tb.y + tb.height <= zb.y || zb.y + zb.height <= tb.y);
  expect(overlap).toBe(false);

  // No horizontal page overflow at portrait mobile width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
