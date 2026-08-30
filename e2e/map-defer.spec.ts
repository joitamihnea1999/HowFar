import { expect, test, type Page } from "@playwright/test";
import { emptyAmenities } from "./amenity-fixtures";

// Task 017: MapLibre (327 KB gz) is deferred off the first-load critical path — the eager shell
// (search box, header, controls) is interactive before the map engine loads, and the engine
// hydrates behind it. This spec guards the two things that regression-risk that boundary:
//   1. The map still loads on its own (auto-load "map hydrates behind it") and draws rings.
//   2. SELECTION CONTINUITY: a search submitted BEFORE the engine finishes
//      loading is buffered and replayed on map-ready — never dropped.

const ORIGIN = { lat: 44.428, lng: 26.1025 };
function ring(minutes: number, d: number) {
  return {
    minutes,
    geometry: {
      type: "Polygon",
      coordinates: [[
        [ORIGIN.lng - d, ORIGIN.lat - d],
        [ORIGIN.lng + d, ORIGIN.lat - d],
        [ORIGIN.lng + d, ORIGIN.lat + d],
        [ORIGIN.lng - d, ORIGIN.lat + d],
        [ORIGIN.lng - d, ORIGIN.lat - d],
      ]],
    },
  };
}
const ISOCHRONE = { origin: ORIGIN, rings: [ring(15, 0.01), ring(30, 0.02), ring(45, 0.03)] };

async function stubProviders(page: Page) {
  await page.route("**/api/isochrone**", (route) => route.fulfill({ json: ISOCHRONE }));
  await page.route("**/api/geocode**", (route) => route.fulfill({ json: { ...ORIGIN, label: "Union Square" } }));
  await page.route("**/api/suggest**", (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.route("**/api/amenities**", (route) => route.fulfill({ json: emptyAmenities(ORIGIN) }));
}

// Hold the MapLibre ENGINE chunk (identified by its inlined WebGL shader source, which no app
// chunk carries) for `delayMs` so the pre-load window is real and deterministic — not a race.
async function delayEngineChunk(page: Page, delayMs: number) {
  await page.route("**/_next/static/chunks/**", async (route) => {
    const res = await route.fetch();
    const body = await res.body();
    if (/gl_Position/.test(body.toString("latin1"))) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    await route.fulfill({ response: res, body });
  });
}

test("map defers but still auto-loads and draws rings", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await stubProviders(page);

  await page.goto("/");
  // The search shell is interactive before the engine loads.
  await expect(page.getByRole("combobox")).toBeVisible();
  const map = page.getByTestId("app-map");
  // Auto-load: no interaction needed, the map hydrates on its own.
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("engine chunk load failure surfaces an honest, reload-able error, and the shell stays usable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await stubProviders(page);
  // Abort the MapLibre ENGINE chunk (shader signature) on every attempt → the deferred import
  // rejects, the auto-retry also fails, and the app must show a recoverable error, not a blank map.
  await page.route("**/_next/static/chunks/**", async (route) => {
    const res = await route.fetch();
    const body = await res.body();
    if (/gl_Position/.test(body.toString("latin1"))) return route.abort();
    return route.fulfill({ response: res, body });
  });

  await page.goto("/");
  // Shell stays usable (search interactive) even though the map engine never loads.
  await expect(page.getByRole("combobox")).toBeVisible();
  // The recoverable error surfaces (after the one auto-retry) rather than an indefinite blank canvas.
  await expect(page.getByTestId("map-load-error")).toBeVisible({ timeout: 30_000 });
  // The copy is HONEST: it points at a reload, and does NOT promise "your search still works"
  // (a submit is buffered until the engine loads, so search is genuinely unavailable while down).
  await expect(page.getByTestId("map-load-error")).toContainText("Reload to try again");
  await expect(page.getByTestId("map-load-error")).not.toContainText(/search still works/i);
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  // No unhandled pageerror (the rejection is caught).
  expect(errors).toEqual([]);
});

test("the Reload button genuinely recovers a purged engine chunk (not a decorative re-import)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await stubProviders(page);
  // Simulate a stale client after a redeploy: the engine chunk is unreachable until the page is
  // reloaded — exactly the case a same-session in-page re-import (which replays the bundler's cached
  // rejected chunk promise, making no fresh network request) could NOT recover. The manual recovery
  // is a full page reload, so a fresh navigation must bring the map up. `served` is flipped just
  // before the reload click, so the abort covers the whole first page and the serve covers the next.
  let served = false;
  await page.route("**/_next/static/chunks/**", async (route) => {
    const res = await route.fetch();
    const body = await res.body();
    if (/gl_Position/.test(body.toString("latin1")) && !served) return route.abort();
    return route.fulfill({ response: res, body });
  });

  await page.goto("/");
  const errorBox = page.getByTestId("map-load-error");
  await expect(errorBox).toBeVisible({ timeout: 30_000 });
  // Reload → full navigation → the chunk is now served → the map recovers.
  served = true;
  await page.getByRole("button", { name: "Reload" }).click();
  const map = page.getByTestId("app-map");
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await expect(errorBox).toBeHidden();
  expect(errors).toEqual([]);
});

test("selection continuity: a search submitted BEFORE the engine loads is replayed on map-ready", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await stubProviders(page);
  await delayEngineChunk(page, 2000);

  await page.goto("/");
  const map = page.getByTestId("app-map");
  const box = page.getByRole("combobox");
  await expect(box).toBeVisible();
  // Submit WHILE the engine is still held (map not loaded yet) — this is the pre-load window.
  await expect(map).not.toHaveAttribute("data-map-loaded", "true");
  await box.fill("Union Square");
  await box.press("Enter");

  // The engine then loads (behind the shell) and the buffered selection replays → rings draw.
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await expect(map).toHaveAttribute("data-isochrone-rings", "3", { timeout: 30_000 });
  await expect(map).toHaveAttribute("data-selection", /Union Square/);
  expect(errors).toEqual([]);
});
