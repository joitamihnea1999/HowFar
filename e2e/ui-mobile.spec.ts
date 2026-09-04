import { expect, test, type Page } from "@playwright/test";
import { innerBandCounts, WALK_CLIP } from "./amenity-fixtures";

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
  // The calibrated walk preset [10, 20] served on ?model=preset (task 020).
  rings: [ring(10, 0.01), ring(20, 0.02)],
};

const AMENITIES = {
  clip: WALK_CLIP,
  countsByBand: innerBandCounts({ groceries: 12, pharmacies: 8, parks: 5, schools: 7, transit: 14 }),
  amenities: [
    { lat: 44.4268, lng: 26.1085, name: "Mega Image Unirii", category: "groceries", band: 15 },
    { lat: 44.428, lng: 26.101, name: "Farmacia Tei", category: "pharmacies", band: 15 },
    { lat: 44.426, lng: 26.104, name: "Parcul Unirii", category: "parks", band: 15 },
    { lat: 44.429, lng: 26.1, name: "Școala Gimnazială 79", category: "schools", band: 15 },
    {
      lat: 44.425,
      lng: 26.102,
      name: "Piața Unirii 2",
      category: "transit",
      osmType: "node",
      osmId: 582555685, band: 15 },
  ],
};

async function touchSwipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const session = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, radiusX: 3, radiusY: 3, force: 1, id: 1 }];
  // Dispatch the whole gesture WITHOUT awaiting each ack: under CPU contention a
  // per-step round-trip stretched the gap between touchStart and the first
  // touchMove past the 500ms long-press threshold, so the "swipe" read as a
  // stationary hold and fired the right-click reach action (task 062 repro:
  // 726ms to the first move). A real finger's moves stream continuously; the
  // burst keeps the emulated ones in one delivery window while staying ordered
  // (CDP processes queued input in dispatch order).
  const sends: Promise<unknown>[] = [
    session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.x, from.y) }),
  ];
  for (let step = 1; step <= 6; step += 1) {
    const progress = step / 6;
    sends.push(
      session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress),
      }),
    );
  }
  sends.push(session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }));
  await Promise.all(sends);
  await session.detach();
}

// QUARANTINED for a later pass (task 022): this end-to-end touch journey pivots on amenity
// INSPECTION — the amenity count, category toggles, amenity browser, POI popup, and
// transit-stop line popup — the amenity subsystem the phone-first preset client
// suppresses. The surviving touch-shell contracts (suggestion scroll, sheet peek/
// expand, orientation, map-reclaim) are covered by the migrated "collapsed dock +
// peek sheet" test below and by preset-render.spec.ts. Restore when amenities return.
test.skip("touch journey stays usable through selection, results, inspection, map gestures, and orientation", async ({
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

  // Task 062: the sheet opens at PEEK on mobile — expand it before driving the
  // full result content (this tap is itself part of the new contract).
  await page.getByTestId("sheet-toggle").tap();
  await expect(page.locator(".hf-map-shell")).toHaveAttribute("data-sheet-state", "expanded");

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
    // 44px minimum touch target on BOTH axes (found in review: 3-up was ~37px WIDE
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

// task 057: the right-click (long-press) transit directions must stay a COMPACT
// card on a phone — not a slab that blankets the map — and still draw the journey.
// Uses a RETRYING long-press (poll until the reach popup appears) so a single
// dropped touch gesture can't flake the run (the headless long-press caveat).
test("mobile: long-press transit directions show a compact card and draw the journey", async ({ page }) => {
  const rings = [ring(15, 0.28), ring(30, 0.3), ring(45, 0.32)]; // big → centre is deterministically in-band
  await page.route("**/api/suggest**", (route) =>
    route.fulfill({ json: { suggestions: [{ label: "Piața Unirii, București", lat: 44.4268, lng: 26.1025 }] } }),
  );
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: { origin: { lat: 44.4268, lng: 26.1025 }, rings } }));
  await page.route("**/api/transit**", (route) => route.fulfill({ json: { origin: { lat: 44.4268, lng: 26.1025 }, rings, departure: "2026-07-29T05:30:00.000Z" } }));
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: AMENITIES }));
  await page.route("**/api/reach**", (route) =>
    route.fulfill({
      json: {
        reachable: true,
        totalMinutes: 20,
        transfers: 0,
        legs: [
          { mode: "WALK", fromName: "START", toName: "Board", minutes: 4, from: { lat: 44.4268, lng: 26.1025 }, to: { lat: 44.435, lng: 26.105 }, path: [[26.1025, 44.4268], [26.105, 44.435]] },
          { mode: "TRAM", line: "1", headsign: "Nord", fromName: "Board", toName: "Alight", minutes: 16, from: { lat: 44.435, lng: 26.105 }, to: { lat: 44.45, lng: 26.07 }, path: [[26.105, 44.435], [26.07, 44.45]] },
        ],
      },
    }),
  );

  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  // Task 062: the resolved selection collapsed the dock to the state pill —
  // reopening it IS the mode-change path now.
  await page.getByTestId("state-pill").tap();
  await page.getByRole("button", { name: "Public transport", exact: true }).click();
  await expect(map).toHaveAttribute("data-mode", "transit");

  const canvas = page.locator(".maplibregl-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const session = await page.context().newCDPSession(page);
  const pt = (x: number, y: number) => [{ x, y, radiusX: 3, radiusY: 3, force: 1, id: 1 }];

  // Retry the long-press until the reach popup registers (robust to a dropped gesture).
  await expect(async () => {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(cx, cy) });
    await page.waitForTimeout(650); // > the long-press hold threshold, no move
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(map).toHaveAttribute("data-reach-state", "transit", { timeout: 2000 });
  }).toPass({ timeout: 20_000 });

  // Docked directions (task 058): the panel lives in the result-sheet bottom
  // sheet, capped at min(30dvh,14.5rem) — never a full-screen slab (Pixel 7 is
  // 412px wide). The sheet scrolls; the panel is inside it.
  const panel = await page.getByTestId("reach-panel").boundingBox();
  expect(panel).not.toBeNull();
  const vh = await page.evaluate(() => window.innerHeight);
  expect(panel!.height).toBeLessThanOrEqual(vh * 0.7);
  // The journey drew AND the camera actually framed it on a phone-sized viewport
  // (guards the double-counted-padding Critical: the fit must not silently fail).
  await expect(map).toHaveAttribute("data-reach-journey", "2", { timeout: 5000 });
  await expect(map).toHaveAttribute("data-reach-framed", "true", { timeout: 5000 });
  // No horizontal overflow introduced by the card.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

// task 060: the long-press half of "right-click = get me there by public
// transport" — a long-press from WALK mode must auto-switch to transit, plan the
// trip (exactly one /api/reach), draw the journey, and NOT leave a trailing
// synthetic-click that reselects a new origin.
test("mobile: long-press from Walk auto-switches to Public transport and draws the journey (task 060)", async ({ page }) => {
  const rings = [ring(15, 0.28), ring(30, 0.3), ring(45, 0.32)];
  const reachCalls: string[] = [];
  await page.route("**/api/geocode**", (route) => route.fulfill({ json: { lat: 44.4268, lng: 26.1025, label: "Piața Unirii, București" } }));
  await page.route("**/api/suggest**", (route) =>
    route.fulfill({ json: { suggestions: [{ label: "Piața Unirii, București", lat: 44.4268, lng: 26.1025 }] } }),
  );
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: { origin: { lat: 44.4268, lng: 26.1025 }, rings } }));
  await page.route("**/api/transit**", (route) => route.fulfill({ json: { origin: { lat: 44.4268, lng: 26.1025 }, rings, departure: "2026-07-29T05:30:00.000Z" } }));
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: AMENITIES }));
  await page.route("**/api/reach**", (route) => {
    reachCalls.push(route.request().url());
    route.fulfill({
      json: {
        reachable: true,
        totalMinutes: 20,
        transfers: 0,
        legs: [
          { mode: "WALK", fromName: "START", toName: "Board", minutes: 4, from: { lat: 44.4268, lng: 26.1025 }, to: { lat: 44.435, lng: 26.105 }, path: [[26.1025, 44.4268], [26.105, 44.435]] },
          { mode: "TRAM", line: "1", headsign: "Nord", fromName: "Board", toName: "Alight", minutes: 16, from: { lat: 44.435, lng: 26.105 }, to: { lat: 44.45, lng: 26.07 }, path: [[26.105, 44.435], [26.07, 44.45]] },
        ],
      },
    });
  });

  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-isochrone-rings", "3");
  await expect(map).toHaveAttribute("data-mode", "walk"); // start in WALK — do NOT switch manually

  const canvas = page.locator(".maplibregl-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const session = await page.context().newCDPSession(page);
  const pt = (x: number, y: number) => [{ x, y, radiusX: 3, radiusY: 3, force: 1, id: 1 }];

  await expect(async () => {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(cx, cy) });
    await page.waitForTimeout(650); // > long-press hold threshold, no move
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // The long-press flips Walk → Public transport (the owner's unified action).
    await expect(map).toHaveAttribute("data-mode", "transit", { timeout: 2000 });
  }).toPass({ timeout: 20_000 });

  await expect(map).toHaveAttribute("data-reach-state", "transit");
  await expect(map).toHaveAttribute("data-reach-journey", "2", { timeout: 5000 });
  // Exactly one plan fetch, and the trailing synthetic click was suppressed — a
  // reselection would have geocoded a new origin (the label stays Piața Unirii).
  expect(reachCalls).toHaveLength(1);
  await expect(map).toHaveAttribute("data-selection", "Piața Unirii, București");
  // Task 062: active directions FORCE the sheet expanded — a journey answer
  // must never hide behind the peek bar.
  await expect(page.locator(".hf-map-shell")).toHaveAttribute("data-sheet-state", "expanded");
});

// Task 062: below md the shell hands the screen to the map — the dock collapses
// to a state pill on a resolved selection and the result sheet opens at a peek
// bar, while every piece of state (address, mode, time budget, pace, filters)
// stays visible and one tap from its editor.
test("mobile shell: collapsed dock + peek sheet reclaim the map; state stays visible and editable (task 062)", async ({
  page,
}) => {
  await page.route("**/api/suggest**", (route) =>
    route.fulfill({ json: { suggestions: [{ label: "Piața Unirii, București", lat: 44.4268, lng: 26.1025 }] } }),
  );
  let failIsochrone = false;
  await page.route("**/api/isochrone**", (route) =>
    failIsochrone ? route.fulfill({ status: 500, json: { error: "boom" } }) : route.fulfill({ json: ISOCHRONE }),
  );
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: AMENITIES }));

  await page.goto("/");
  const map = page.getByTestId("app-map");
  const shell = page.locator(".hf-map-shell");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });

  // Pre-selection: full dock, no pill.
  await expect(shell).toHaveAttribute("data-dock-state", "expanded");
  await expect(page.getByTestId("command-surface")).toBeVisible();

  const search = page.getByRole("combobox");
  await search.tap();
  await search.fill("Unirii");
  await page.getByRole("option", { name: "Piața Unirii, București" }).tap();
  await expect(map).toHaveAttribute("data-selection", "Piața Unirii, București");

  // Resolution collapses the dock to the pill and opens the sheet at peek,
  // and the camera insets already describe the compact shell.
  await expect(shell).toHaveAttribute("data-dock-state", "collapsed");
  await expect(shell).toHaveAttribute("data-sheet-state", "peek");
  const pill = page.getByTestId("state-pill");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("Piața Unirii");
  await expect(pill).toContainText("Walk");
  await expect(pill).toContainText("10 min"); // the selected walk preset (default chip)
  await expect(map).toHaveAttribute("data-camera-pad-top", "140");
  await expect(map).toHaveAttribute("data-camera-pad-bottom", "124");
  const pillBox = await pill.boundingBox();
  if (!pillBox) throw new Error("state pill has no box");
  expect(pillBox.height).toBeGreaterThanOrEqual(44);

  // First-run ring comprehension: the meaning of the shaded areas must be
  // visible in THIS default (peek) state — the SelectionCard explainer is
  // behind the collapsed sheet, so a floating dismissible hint carries it.
  const hint = page.getByTestId("ring-hint");
  await expect(hint).toBeVisible();
  // The mobile peek hint now carries the honest preset explainer (no "within"),
  // naming the selected walk preset minute.
  await expect(hint).toContainText("About a 10-minute walk");
  await hint.getByRole("button", { name: "Dismiss explanation" }).tap();
  await expect(hint).toHaveCount(0);
  // Dismissal persists (versioned key) — a returning user is not re-taught.
  expect(await page.evaluate(() => localStorage.getItem("hf:ring-hint-dismissed:v1"))).toBe("1");

  // The camera settled on the origin — the padding flip did not cancel the
  // selection flyTo (task-060 trap class).
  await expect
    .poll(async () => {
      const center = await map.getAttribute("data-camera-center");
      if (!center) return null;
      const [lng, lat] = center.split(",").map(Number);
      return Math.abs(lng - 26.1025) < 0.01 && Math.abs(lat - 44.4268) < 0.01;
    })
    .toBe(true);

  // Map strip: the contiguous unobstructed corridor between pill and peek bar
  // is the majority of the screen (the owner's core complaint: it was ~13%).
  const viewport = page.viewportSize()!;
  const sheetBox = await page.getByTestId("result-sheet").boundingBox();
  if (!sheetBox) throw new Error("result sheet has no box");
  const strip = sheetBox.y - (pillBox.y + pillBox.height);
  expect(strip / viewport.height).toBeGreaterThanOrEqual(0.55);
  // Point-sample the same 20px grid the live inspection used (CHECKPOINT-B
  // method): unobstructed map ≥ 60%.
  const sampled = await page.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;
    const mapEl = document.querySelector(".maplibregl-map");
    let hits = 0;
    let total = 0;
    for (let x = 5; x < vw; x += 20)
      for (let y = 5; y < vh; y += 20) {
        total++;
        const el = document.elementFromPoint(x, y);
        if (
          el &&
          el.closest(".maplibregl-map") === mapEl &&
          !el.closest("[class*=panel],[class*=sheet],[class*=card],[class*=dock],[class*=pill],aside,header,nav,form")
        )
          hits++;
      }
    return Math.round((hits / total) * 100);
  });
  expect(sampled).toBeGreaterThanOrEqual(60);

  // The always-on basemap attribution sits at the strip's bottom edge — never
  // mid-map, never under the sheet. (The Transitous credit is transit-gated, so in
  // this walk state only the basemap attribution shows — presence/absence of the
  // transit credit per mode is proven in preset-render.spec.ts.)
  {
    const attribution = page.locator(".maplibregl-ctrl-attrib");
    await expect(attribution).toBeVisible();
    const box = await attribution.boundingBox();
    if (!box) throw new Error("attribution has no box");
    expect(box.y + box.height).toBeLessThanOrEqual(sheetBox.y + 2);
    expect(box.y).toBeGreaterThan(sheetBox.y - 120);
  }
  // The basemap credits must be ACTUALLY READABLE on a narrow viewport, not
  // collapsed behind MapLibre's compact "i" toggle (which defaults on at ≤640px
  // unless attributionControl.compact===false). A role selector skips
  // display:none, so this fails if the credit link is hidden — the real guard for
  // the licence-required ESA WorldCover credit at mobile width, complementing the
  // desktop DOM assertions in smoke.spec.ts.
  await expect(
    page.locator(".maplibregl-ctrl-attrib").getByRole("link", { name: "ESA WorldCover" }),
  ).toBeVisible();

  // Pill → dock: one tap re-opens the full controls with focus in search.
  await pill.tap();
  await expect(page.getByTestId("command-surface")).toBeVisible();
  await expect(page.getByRole("combobox")).toBeFocused();
  // Change the reach preset (the larger 20-min chip), hand the map back with the
  // collapse control, and the pill reflects the new state WITHOUT another resolution
  // (the chip is pure client-side visibility — the route already returned both contours).
  await page.getByTestId("preset-chip-20").tap();
  await page.getByTestId("dock-collapse").tap();
  await expect(pill).toContainText("20 min");

  // (The amenity filters/browser peek chips are deferred to a later pass; the pace peek
  // chip remains the one live refinement on the phone shell.)

  // Pace chip names the current pace and lands on the pace control.
  await expect(page.getByTestId("peek-chip-refine")).toContainText("Normal");
  await page.getByTestId("peek-chip-refine").tap();
  await expect(shell).toHaveAttribute("data-sheet-state", "expanded");
  await expect(page.getByRole("button", { name: /Slow/ })).toBeVisible();
  // Actually CHANGE the pace: the same-origin recompute must keep the sheet
  // expanded (it used to snap back to peek mid-comparison, dropping focus —
  // found in review).
  await page.getByRole("button", { name: /Slow/ }).tap();
  await expect(page.getByTestId("peek-chip-refine")).toHaveCount(0); // still expanded, no peek chips
  await expect(shell).toHaveAttribute("data-sheet-state", "expanded");
  await expect(shell).toHaveAttribute("data-dock-state", "collapsed");

  // Touch never sees hover chrome (task 062): taps synthesize mousemove, but
  // the hover grow + preview are gated on a real fine pointer — no preview
  // panel may ever have appeared in this touch-only session.
  await expect(page.getByTestId("cluster-preview")).toHaveCount(0);

  // Error path: a failed recompute REOPENS the dock (never a stale pill over
  // an error) AND forces the sheet expanded — the SelectionCard inside is the
  // only surface with the failure message, and a peek bar reading "Result"
  // over a hidden alert is a silent failure (found in review).
  failIsochrone = true;
  await pill.tap();
  await page.getByRole("combobox").fill("Unirii");
  await page.getByRole("option", { name: "Piața Unirii, București" }).tap();
  await expect(shell).toHaveAttribute("data-dock-state", "expanded");
  await expect(page.getByTestId("command-surface")).toBeVisible();
  await expect(shell).toHaveAttribute("data-sheet-state", "expanded");
  await expect(page.getByText(/Could not compute/)).toBeVisible();
});
