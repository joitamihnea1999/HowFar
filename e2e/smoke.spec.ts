import { expect, test } from "@playwright/test";

// Prod-shaped smoke: requires `npm run build` beforehand and the PostGIS
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
  expect(response.headers()["etag"]).toMatch(/^".+"$/); // cache validator present
  const body = await response.body();
  expect(body.length).toBe(128);
  expect(body.subarray(0, 7).toString("ascii")).toBe("PMTiles");

  const overCap = await request.get("/api/tiles", { headers: { Range: "bytes=0-" } });
  expect(overCap.status()).toBe(416); // whole-archive range exceeds the DoS cap
});

test("tile route answers HEAD and rejects malformed ranges", async ({ request }) => {
  const head = await request.fetch("/api/tiles", { method: "HEAD" });
  expect(head.status()).toBe(200);
  expect(head.headers()["accept-ranges"]).toBe("bytes");
  expect(Number(head.headers()["content-length"])).toBeGreaterThan(0);

  const malformed = await request.get("/api/tiles", { headers: { Range: "bytes=abc" } });
  expect(malformed.status()).toBe(416);
  expect(malformed.headers()["content-range"]).toMatch(/^bytes \*\/\d+$/); // RFC 9110 unsatisfied-range form
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

  // Attribution is a licence requirement — assert the credits are really in the
  // rendered DOM, not just the style object. OSM (ODbL); ESA WorldCover landcover
  // credited with its licence name + link and a "modified" indication (CC BY 4.0,
  // distributed via Daylight — the tiles bundle it); Natural Earth (public-domain,
  // shown by owner decision). A unit test on the style object alone would stay
  // green if the attribution control were removed or the credits regressed.
  const attrib = page.locator(".maplibregl-ctrl-attrib");
  // The "modified" indication must sit ON the ESA credit, contiguously between
  // ESA WorldCover / CC BY 4.0 and Daylight — not just anywhere in the control
  // (which a rewrite could satisfy while stripping it off the ESA credit).
  await expect(attrib).toContainText(/ESA WorldCover.*CC BY 4\.0.*modified.*Daylight/);
  // Each credit must be a real link with the right name↔href pairing, not plain
  // text — the DOM-level counterpart of the unit test regexes. The class is every
  // credit anchor, so Daylight and Natural Earth are pinned too.
  await expect(attrib.getByRole("link", { name: "OpenStreetMap" })).toHaveAttribute(
    "href",
    "https://www.openstreetmap.org/copyright",
  );
  await expect(attrib.getByRole("link", { name: "ESA WorldCover" })).toHaveAttribute(
    "href",
    "https://esa-worldcover.org/en/data-access",
  );
  await expect(attrib.getByRole("link", { name: /CC BY 4\.0/ })).toHaveAttribute(
    "href",
    "https://creativecommons.org/licenses/by/4.0/",
  );
  await expect(attrib.getByRole("link", { name: "Daylight" })).toHaveAttribute(
    "href",
    "https://daylightmap.org",
  );
  await expect(attrib.getByRole("link", { name: "Natural Earth" })).toHaveAttribute(
    "href",
    "https://www.naturalearthdata.com",
  );

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
