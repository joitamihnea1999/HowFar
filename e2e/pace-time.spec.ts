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
    // Slow reaches fewer groceries than Normal, so the rendered count changes —
    // proving a pace change actually re-fetches + re-renders (not just re-labels).
    const n = pace === "slow" ? 1 : 4;
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

test("defaults: exactly two paces (Slow, Normal), Normal active, BOTH meanings visible; walk request is pace=normal with NO leaked time params", async ({ page }) => {
  const cap = await stubBase(page);
  await loadAndSearch(page);
  // Exactly two pace buttons — Slow + Normal, no Brisk.
  const paceGroup = page.getByRole("group", { name: "Walking pace" });
  await expect(paceGroup.getByRole("button")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Normal/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Brisk/ })).toHaveCount(0);
  // Each option shows its short meaning WITHOUT being selected (owner ask / panel E).
  await expect(page.getByTestId("pace-blurb-slow")).toContainText("4 km/h");
  await expect(page.getByTestId("pace-blurb-normal")).toContainText("average adult");
  // Normal is the honest baseline → no "estimated reach" qualifier.
  await expect(page.getByTestId("pace-hint")).not.toContainText("estimated reach");
  expect(cap.iso.some((u) => /pace=normal/.test(u))).toBe(true);
  // Walk mode must never carry transit-only departure params (regression guard).
  expect(cap.iso.every((u) => !/[?&](preset|weekday|time)=/.test(u))).toBe(true);
});

test("changing pace to Slow sends &pace=slow, shows the estimate qualifier, and re-renders amenities (count shrinks)", async ({ page }) => {
  const cap = await stubBase(page);
  const map = await loadAndSearch(page);
  await page.getByRole("button", { name: /Slow/ }).click();
  await expect(page.getByTestId("pace-hint")).toContainText("estimated reach"); // non-normal honesty cue (walk too)
  await expect(map).toHaveAttribute("data-amenity-count", "1"); // shrank — pace refetched
  expect(cap.iso.some((u) => /pace=slow/.test(u))).toBe(true);
  expect(cap.amenities.some((u) => /pace=slow/.test(u))).toBe(true);
});

test("pace control is Walk-only; switching to Public transport hides it and requests Normal even after Slow (task 052)", async ({ page }) => {
  const cap = await stubBase(page);
  const map = await loadAndSearch(page);
  // Walk: the pace control is present.
  await expect(page.getByRole("group", { name: "Walking pace" })).toBeVisible();
  // Pick Slow in Walk → amenity count shrinks to 1 (pace refetched).
  await page.getByRole("button", { name: /Slow/ }).click();
  await expect(map).toHaveAttribute("data-amenity-count", "1");

  // Switch to Public transport: the pace control is GONE (pace is walk-only)…
  await page.getByTestId("command-surface").getByRole("button", { name: "Public transport", exact: true }).click();
  await expect(page.getByRole("group", { name: "Walking pace" })).toHaveCount(0);
  // …and the transit-era amenity refetch used Normal, not the remembered Slow —
  // the count returns to 4 (the P4 regression guard: effective pace, not sel.pace).
  await expect(map).toHaveAttribute("data-amenity-count", "4");
  expect(cap.amenities[cap.amenities.length - 1]).toContain("pace=normal");
  expect(cap.transit.every((u) => /pace=normal/.test(u))).toBe(true);
  expect(cap.transit.some((u) => /pace=slow/.test(u))).toBe(false);
});

test("time control: two options (Crowded default, Not crowded), no Custom editor; picking Not crowded sends &preset=quiet", async ({ page }) => {
  const cap = await stubBase(page);
  await loadAndSearch(page);
  // Walk mode: no time control.
  await expect(page.getByRole("group", { name: "Public transport departure time" })).toHaveCount(0);
  // Switch to transit.
  await page.getByTestId("command-surface").getByRole("button", { name: "Public transport", exact: true }).click();
  const timeGroup = page.getByRole("group", { name: "Public transport departure time" });
  await expect(timeGroup).toBeVisible();
  // Exactly two options, no Custom editor (removed for a least-necessary UI).
  await expect(timeGroup.getByRole("button")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Custom…" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Crowded", exact: true })).toHaveAttribute("aria-pressed", "true");
  // Peak-honesty copy (task 058 D1): metro is road-traffic-immune, surface times are timetable-nominal.
  await expect(page.getByTestId("transit-departure-note")).toContainText("affected by road traffic");

  await page.getByRole("button", { name: "Not crowded", exact: true }).click();
  await expect(page.getByRole("button", { name: "Not crowded", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(cap.transit.some((u) => /preset=quiet/.test(u))).toBe(true);
});

test("keyboard: pace is reachable and operable with the keyboard", async ({ page }) => {
  await stubBase(page);
  const map = await loadAndSearch(page);
  const slow = page.getByRole("button", { name: /Slow/ });
  await slow.focus();
  await expect(slow).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(slow).toHaveAttribute("aria-pressed", "true");
  await expect(map).toHaveAttribute("data-amenity-count", "1");
});
