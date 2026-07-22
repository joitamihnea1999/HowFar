import { defineConfig, devices } from "@playwright/test";

const PORT = 3799;

// Prod-shaped e2e: `npm run build` must have run first (CI does this as a
// separate step; locally: npm run build && npm run test:e2e). The PostGIS
// container from docker-compose must be up for the db-backed assertions.
export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/artifacts",
  timeout: 60_000,
  // Browser e2e on shared CI runners is timing-sensitive under CPU contention:
  // a single load-flake among 60+ tests would otherwise red the whole run and
  // force "that red is fine" reruns. Retry on CI (a genuine regression still
  // fails all 3 attempts → still red); keep 0 locally so real failures surface
  // immediately in dev. Flaky-but-passed specs are reported (see `reporter`) and
  // their trace kept (`on-first-retry`), so they stay visible for source-fixing.
  retries: process.env.CI ? 2 : 0,
  // A stray `.only()` must never silently green a subset of the suite in CI.
  forbidOnly: !!process.env.CI,
  // On CI: durable HTML report (uploaded even on green — see ci.yml) so retried
  // flakes stay enumerable, a machine-readable JSON for cross-run flaky diffing,
  // plus inline GitHub annotations. Plain list locally.
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["json", { outputFile: "playwright-report/results.json" }], ["github"]]
    : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Keep the FAILING attempt's trace and prune clean passes. With retries, a
    // flake's failing first attempt is retained while the passing retry is
    // dropped — exactly the trace needed to source-fix it. (`on-first-retry`
    // would instead trace the passing retry, missing the failure.)
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /ui-mobile\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      testMatch: /ui-mobile\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: `npm run start -- --port ${PORT}`,
    // Gate on readiness (db warm), not liveness: the first query pays Prisma
    // engine init + pool spin-up and may exceed the health probe's 2s bound.
    url: `http://localhost:${PORT}/api/ready`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
