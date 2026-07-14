import { expect, test } from "@playwright/test";

// Prod-shaped smoke: requires `npm run build` beforehand and the MySQL
// container up + migrated (docker compose up -d db; prisma migrate deploy).

test("liveness and readiness report a connected database", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ ok: true, db: true });

  const ready = await request.get("/api/ready");
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toEqual({ ready: true });
});

test("auth endpoint serves without OAuth credentials configured", async ({ request }) => {
  const providers = await request.get("/api/auth/providers");
  expect(providers.status()).toBe(200);
});

test("landing page renders the map shell and finishes loading tiles", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "HowFar" })).toBeVisible();

  const map = page.getByTestId("app-map");
  await expect(map).toBeVisible();

  // MapLibre `load` fired = style parsed + self-hosted pmtiles served via /api/tiles.
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });

  // OSM attribution is a ToS requirement — assert it is really in the DOM.
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("OpenStreetMap");

  await page.screenshot({ path: "e2e/artifacts/landing.png", fullPage: true });
});
