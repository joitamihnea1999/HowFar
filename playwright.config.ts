import { defineConfig, devices } from "@playwright/test";

const PORT = 3799;

// Prod-shaped e2e: `npm run build` must have run first (CI does this as a
// separate step; locally: npm run build && npm run test:e2e). The MySQL
// container from docker-compose must be up for the db-backed assertions.
export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/artifacts",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
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
