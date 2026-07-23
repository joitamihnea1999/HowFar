import { expect, test, type Page } from "@playwright/test";

// Pace + time-context selectors (task 051). Providers are stubbed by EXACT path.
// The mock cannot prove the server ring→count coupling (that lives in unit +
// integration tests + the G6 live calibration); what e2e proves is that the
// controls SEND the right params, the UI re-renders per pace-varying fixtures,
// and the transit honesty copy shows. Waits are on data-* stamps, never sleeps.

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

// Captured outgoing request URLs, so we can assert the exact query the controls send.
interface Captured {
  iso: string[];
  transit: string[];
  amenities: string[];
}

async function stubBase(page: Page): Promise<Captured> {
  const cap: Captured = { iso: [], transit: [], amenities: [] };
  await page.route("**/api/geocode**", (route) =>
    route.fulfill({ json: { lat: 44.4268, lng: 26.1025, label: "Piața Unirii, București" } }),
  );
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/isochrone**", (route) => {
    cap.iso.push(route.request().url());
    route.fulfill({ json: WALK });
  });
  await page.route("**/api/transit**", (route) => {
    cap.transit.push(route.request().url());
    // Echo the resolved departure so the honesty note renders.
    route.fulfill({ json: { ...WALK, departure: "2026-07-29T05:30:00.000Z" } });
  });
  await page.route("**/api/amenities**", (route) => {
    const url = route.request().url();
    cap.amenities.push(url);
    // Pace-varying fixture: a brisker pace "reaches" more groceries, so the
    // rendered count (data-amenity-count = #items) changes — proving a pace
    // change actually re-fetches + re-renders (not just re-labels).
    const pace = new URL(url).searchParams.get("pace") ?? "normal";
    const n = pace === "brisk" ? 9 : pace === "relaxed" ? 1 : 4;
    const amenities = Array.from({ length: n }, (_, i) => ({
      id: `g${i}`,
      lat: 44.4268 + i * 0.0002,
      lng: 26.1025 + i * 0.0002,
      name: `Shop ${i}`,
      category: "groceries",
      osmType: "node",
      osmId: 1000 + i,
      distanceMeters: 100 + i,
    }));
    route.fulfill({
      json: {
        origin: { lat: 44.4268, lng: 26.1025 },
        walkMinutes: 15,
        counts: { groceries: n, pharmacies: 0, parks: 0, schools: 0, transit: 0 },
        amenities,
      },
    });
  });
  return cap;
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

test("defaults: Normal pace active, hint shown; walk request is pace=normal with NO leaked time params", async ({ page }) => {
  const cap = await stubBase(page);
  await loadAndSearch(page);
  await expect(page.getByRole("button", { name: /Normal/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pace-hint")).toContainText("average adult");
  expect(cap.iso.some((u) => /pace=normal/.test(u))).toBe(true);
  // Walk mode must never carry transit-only departure params (regression guard):
  // this is what keeps the default request server-compatible with pre-051.
  expect(cap.iso.every((u) => !/[?&](preset|weekday|time)=/.test(u))).toBe(true);
});

test("changing pace sends &pace and re-renders amenities (Relaxed→Brisk count grows)", async ({ page }) => {
  const cap = await stubBase(page);
  const map = await loadAndSearch(page);
  await page.getByRole("button", { name: /Relaxed/ }).click();
  await expect(page.getByTestId("pace-hint")).toContainText("stroller");
  await expect(map).toHaveAttribute("data-amenity-count", "1");
  expect(cap.iso.some((u) => /pace=relaxed/.test(u))).toBe(true);
  expect(cap.amenities.some((u) => /pace=relaxed/.test(u))).toBe(true);

  await page.getByRole("button", { name: /Brisk/ }).click();
  await expect(page.getByTestId("pace-hint")).toContainText("purpose");
  await expect(page.getByTestId("pace-hint")).toContainText("estimated reach"); // non-normal honesty cue (walk too)
  await expect(map).toHaveAttribute("data-amenity-count", "9"); // grew — pace refetched
  expect(cap.iso.some((u) => /pace=brisk/.test(u))).toBe(true);
});

test("time control is absent in Walk, present in Transit; preset sends &preset and shows the honesty note", async ({ page }) => {
  const cap = await stubBase(page);
  await loadAndSearch(page);
  // Walk mode: no time control.
  await expect(page.getByRole("group", { name: "Transit departure time" })).toHaveCount(0);
  // Switch to transit.
  await page.getByTestId("command-surface").getByRole("button", { name: "Transit", exact: true }).click();
  await expect(page.getByRole("group", { name: "Transit departure time" })).toBeVisible();
  await expect(page.getByTestId("transit-departure-note")).toContainText("live delays and road traffic");

  await page.getByRole("button", { name: "Evening" }).click();
  await expect(page.getByRole("button", { name: "Evening" })).toHaveAttribute("aria-pressed", "true");
  expect(cap.transit.some((u) => /preset=evening/.test(u))).toBe(true);
});

test("Custom: inline editor (no Apply button), reveals with no request, commits on each field change", async ({ page }) => {
  const cap = await stubBase(page);
  await loadAndSearch(page);
  await page.getByTestId("command-surface").getByRole("button", { name: "Transit", exact: true }).click();
  const before = cap.transit.length;

  // Revealing the inline editor must NOT fire a request on its own.
  await page.getByRole("button", { name: "Custom…" }).click();
  await expect(page.getByLabel("Departure day", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply" })).toHaveCount(0); // no Apply button
  expect(cap.transit.length).toBe(before);

  // Changing a field commits immediately (no Apply, minimal-click).
  await page.getByLabel("Departure day", { exact: true }).selectOption("6"); // Saturday
  await expect.poll(() => cap.transit.some((u) => /weekday=6/.test(u))).toBe(true);
  await page.getByLabel("Departure time", { exact: true }).selectOption("09:30");
  await expect.poll(() => cap.transit.some((u) => /weekday=6/.test(u) && /time=09%3A30/.test(u))).toBe(true);
});

test("keyboard: pace is reachable and operable with the keyboard", async ({ page }) => {
  await stubBase(page);
  const map = await loadAndSearch(page);
  const brisk = page.getByRole("button", { name: /Brisk/ });
  await brisk.focus();
  await expect(brisk).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(brisk).toHaveAttribute("aria-pressed", "true");
  await expect(map).toHaveAttribute("data-amenity-count", "9");
});
