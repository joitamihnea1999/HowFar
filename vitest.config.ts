import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Playwright specs live in e2e/ and must never be collected by Vitest.
    exclude: ["e2e/**", "node_modules/**"],
  },
});
