import { expect, test, type Page } from "@playwright/test";
import { emptyAmenities } from "./amenity-fixtures";

// Pace + time-context selectors (task 051), migrated to the phone-first preset
// client (task 022). Providers are stubbed by EXACT path. The mock cannot prove
// the server ring→count coupling (that lives in unit + integration tests + the G6
// live calibration); what e2e proves is that the controls SEND the right params
// and the UI shows the honesty copy. The preset client suppresses amenity markers
// (deferred to a later pass), so the pace/time re-render is proven by the REQUEST it
// drives (a new reach flight carrying the changed param), not by an amenity count.
// Waits are on data-* stamps + captured URLs, never sleeps.

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
// Walk answers the calibrated preset [10, 20] (task 020), not the retired 15/30/45.
const WALK = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [ring(10, 0.01), ring(20, 0.02)] };

// Captured outgoing request URLs, so we can assert the exact query the controls send.
interface Captured {
  iso: string[];
  transit: string[];
}

async function stubBase(page: Page): Promise<Captured> {
  const cap: Captured = { iso: [], transit: [] };
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
  // Preset mode fetches no amenities; keep a defensive empty stub so a stray call
  // never reaches the network (it should never fire — see the count assertions).
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: emptyAmenities({ lat: 44.4268, lng: 26.1025 }) }));
  return cap;
}

async function loadAndSearch(page: Page) {
  await page.goto("/");
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await page.getByRole("combobox").fill("Piata Unirii");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(map).toHaveAttribute("data-isochrone-rings", "2");
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
  // The SPEEDS are pinned on both options (task 064: 3 and 5 km/h). Normal had
  // no km/h assertion before, so a wrong Normal speed rendered green.
  await expect(page.getByTestId("pace-blurb-slow")).toContainText("3 km/h");
  await expect(page.getByTestId("pace-blurb-normal")).toContainText("average adult");
  await expect(page.getByTestId("pace-blurb-normal")).toContainText("5 km/h");
  // Normal is the honest baseline → no "estimated reach" qualifier.
  await expect(page.getByTestId("pace-hint")).not.toContainText("estimated reach");
  expect(cap.iso.some((u) => /pace=normal/.test(u))).toBe(true);
  // Walk mode must never carry transit-only departure params (regression guard).
  expect(cap.iso.every((u) => !/[?&](preset|weekday|time)=/.test(u))).toBe(true);
});

test("changing pace to Slow sends &pace=slow (a new reach flight) and shows the estimate qualifier", async ({ page }) => {
  const cap = await stubBase(page);
  await loadAndSearch(page);
  const isoBefore = cap.iso.length;
  await page.getByRole("button", { name: /Slow/ }).click();
  await expect(page.getByTestId("pace-hint")).toContainText("estimated reach"); // non-normal honesty cue (walk too)
  // The pace change drives a fresh reach flight carrying pace=slow — the re-render
  // proof now that amenity markers (the old count proof) are deferred to a later pass.
  await expect.poll(() => cap.iso.length).toBeGreaterThan(isoBefore);
  expect(cap.iso.some((u) => /pace=slow/.test(u))).toBe(true);
});

test("pace control is Walk-only; switching to Public transport hides it and requests Normal even after Slow (task 052)", async ({ page }) => {
  const cap = await stubBase(page);
  await loadAndSearch(page);
  // Walk: the pace control is present.
  await expect(page.getByRole("group", { name: "Walking pace" })).toBeVisible();
  // Pick Slow in Walk → a fresh reach flight carries pace=slow.
  await page.getByRole("button", { name: /Slow/ }).click();
  await expect.poll(() => cap.iso.some((u) => /pace=slow/.test(u))).toBe(true);

  // Switch to Public transport: the pace control is GONE (pace is walk-only)…
  await page.getByRole("button", { name: "Public transport", exact: true }).click();
  await expect(page.getByRole("group", { name: "Walking pace" })).toHaveCount(0);
  // …and the transit reach used Normal, not the remembered Slow — the P4 regression
  // guard (effective pace, not sel.pace): every transit request is pace=normal.
  await expect.poll(() => cap.transit.length).toBeGreaterThan(0);
  expect(cap.transit.every((u) => /pace=normal/.test(u))).toBe(true);
  expect(cap.transit.some((u) => /pace=slow/.test(u))).toBe(false);
});

test("time control: two options (Crowded default, Not crowded), no Custom editor; picking Not crowded sends &preset=quiet", async ({ page }) => {
  const cap = await stubBase(page);
  await loadAndSearch(page);
  // Walk mode: no time control.
  await expect(page.getByRole("group", { name: "Public transport departure time" })).toHaveCount(0);
  // Switch to transit.
  await page.getByRole("button", { name: "Public transport", exact: true }).click();
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
  const cap = await stubBase(page);
  await loadAndSearch(page);
  const slow = page.getByRole("button", { name: /Slow/ });
  await slow.focus();
  await expect(slow).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(slow).toHaveAttribute("aria-pressed", "true");
  // Operable ⇒ it drove a fresh reach flight carrying pace=slow.
  await expect.poll(() => cap.iso.some((u) => /pace=slow/.test(u))).toBe(true);
});
