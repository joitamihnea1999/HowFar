import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // Playwright specs live in e2e/ and must never be collected by Vitest.
    exclude: ["e2e/**", "node_modules/**"],
    coverage: {
      // Force ALL of src into the report: an untested file must show as 0%,
      // not silently disappear because no test happened to import it.
      include: ["src/**"],
      exclude: [
        "src/generated/**", // prisma codegen
        "src/**/*.test.{ts,tsx}",
        // Rendering/wiring glue, covered by the Playwright e2e suite instead;
        // its pure decision logic lives in src/lib (auth-view, auth-config,
        // bounds, providers) where it IS measured. Keep this list tight —
        // anything with branching logic belongs in lib, not here.
        "src/components/AppMap.tsx", // MapLibre glue (e2e: smoke/isochrone/autocomplete/transit)
        "src/components/AuthControl.tsx", // RSC + server actions (e2e: smoke auth affordance)
        "src/app/page.tsx",
        "src/app/layout.tsx",
        "src/app/api/auth/**", // 3-line Auth.js handler re-export
        "src/auth.ts", // NextAuth wiring; decisions extracted to lib/auth-config
        // Range parsing (the logic) is unit+property tested in lib/byte-range;
        // the fs-serving glue is exercised end-to-end by smoke.spec.ts
        // (206 slice, ETag, HEAD, malformed→416, over-cap→416, PMTiles magic).
        "src/app/api/tiles/route.ts",
      ],
      // Floors, deliberately just under the measured baseline (see package
      // scripts): the gate catches erosion; invariant-named tests do the real
      // quality work, the percentage is only the backstop.
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
  },
});
