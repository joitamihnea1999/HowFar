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

test("tile route serves the pmtiles archive via byte ranges", async ({ request }) => {
  const response = await request.get("/api/tiles", { headers: { Range: "bytes=0-127" } });
  expect(response.status()).toBe(206);
  expect(response.headers()["content-range"]).toMatch(/^bytes 0-127\/\d+$/);
  const body = await response.body();
  expect(body.length).toBe(128);
  expect(body.subarray(0, 7).toString("ascii")).toBe("PMTiles");

  const overCap = await request.get("/api/tiles", { headers: { Range: "bytes=0-" } });
  expect(overCap.status()).toBe(416); // whole-archive range exceeds the DoS cap
});

test("landing page renders the map shell and finishes loading tiles", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "HowFar" })).toBeVisible();

  const map = page.getByTestId("app-map");
  await expect(map).toBeVisible();

  // MapLibre `load` fired = style parsed + self-hosted pmtiles served via /api/tiles.
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });

  // OSM attribution is a ToS requirement — assert it is really in the DOM.
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("OpenStreetMap");

  // MapLibre reports tile/source failures via console.error — a "loaded" map
  // that errored on sources must fail here, not pass silently.
  expect(consoleErrors).toEqual([]);

  await page.screenshot({ path: "e2e/artifacts/landing.png", fullPage: true });
});

test("auth affordance renders on the landing page without errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto("/");

  // AuthControl renders one of two signed-out states depending on whether OAuth
  // env is configured: a provider button (creds present) or the muted note
  // (none — the CI case). Assert the affordance is present in whichever form so
  // the test is deterministic regardless of local .env; the functional sign-in
  // path stays covered by the /api/auth/providers check above.
  const affordance = page.locator("text=/Sign in with|Sign-in unavailable/");
  await expect(affordance.first()).toBeVisible();

  expect(consoleErrors).toEqual([]);
});
