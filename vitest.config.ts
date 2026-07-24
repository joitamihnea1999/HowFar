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
        // its pure decision logic lives in the owning feature root (combobox,
        // selection-flow, the flows, auth-view) where it IS measured. Keep this
        // list tight — anything with branching logic belongs in a measured
        // feature module, not here.
        "src/features/map/AppMap.tsx", // MapLibre glue (e2e: smoke/isochrone/autocomplete/transit)
        // AppMap split into single-responsibility controllers (task 045). Each is
        // imperative MapLibre/network glue verified by the Playwright e2e suite;
        // their pure decision cores were extracted to MEASURED modules
        // (route-framing, ring-reveal stages, amenity-fetch classification,
        // selection-flow, amenity-selection, marker-pick) — do not add those here.
        "src/features/map/camera-controller.ts",
        "src/features/map/hover-controller.ts",
        "src/features/map/ring-reveal-controller.ts",
        "src/features/map/route-path-controller.ts",
        "src/features/map/reach-journey-controller.ts", // task 054: MapLibre draw/stamp/hover glue; pure model in reach.ts is measured
        "src/features/map/popup-controller.ts",
        "src/features/map/amenities-controller.ts",
        "src/features/map/selection-render.ts",
        // NOTE: select-flow-controller.ts is intentionally NOT excluded — it is
        // pure orchestration over injected callbacks + fetch (no MapLibre), so its
        // moved invariants (mode frozen at entry, reverse-422-fatal, stale-token
        // drops, amenities-never-without-rings) are directly unit-tested.
        "src/features/search/search-suggest-controller.ts",
        // Pure-props presentation leaves extracted from AppMap — no state, no
        // fetch, render-only branching over already-decided values (show/hide
        // decisions live in tested feature modules, e.g. shouldShowSuggestList).
        "src/features/map/SearchForm.tsx",
        "src/features/map/SuggestList.tsx",
        "src/features/map/ModeToggle.tsx",
        "src/features/map/SelectionCard.tsx",
        "src/features/map/AmenityPanel.tsx",
        "src/features/map/AttributionBadge.tsx",
        // task 051: pace + time controls — presentation only; their logic lives
        // in the tested pace.ts / time-context.ts / selection-flow reducer, and
        // their interaction (commit-once custom picker, absent-in-walk, keyboard)
        // is covered by e2e/pace-time.spec.ts.
        "src/features/map/PaceControl.tsx",
        "src/features/map/TimeContextControl.tsx",
        // Transaction/advisory-lock and PostGIS SQL orchestration is exercised
        // against the real extension by the required `npm run test:db` suite.
        // Unit-mocking these files would inflate coverage without executing the
        // database behavior that gives the code meaning; their pure parsing and
        // normalization collaborators remain in unit coverage.
        "src/features/amenities/server/catalogue-import.ts",
        "src/features/amenities/server/catalogue-query.ts",
        "src/features/amenities/server/catalogue-store.ts",
        "src/app/page.tsx",
        "src/app/layout.tsx",
        "src/app/api/auth/**", // 3-line Auth.js handler re-export
        "src/auth.ts", // NextAuth wiring; decisions extracted to features/auth/auth-config
        // Range parsing (the logic) is unit+property tested in lib/byte-range;
        // the fs-serving glue is exercised end-to-end by smoke.spec.ts
        // (206 slice, ETag, HEAD, malformed→416, over-cap→416, PMTiles magic).
        "src/app/api/tiles/route.ts",
      ],
      // Floors set 2-3pp under the measured baseline (97.9/96.0/95.1/97.6 at
      // the time of setting — remeasure with `npm run test:coverage`): tight
      // enough that a dropped test file or an untested new module fails CI,
      // loose enough that a small honest change doesn't. The invariant-named
      // tests do the real quality work; the percentage is only the backstop.
      thresholds: {
        lines: 95,
        branches: 93,
        functions: 92,
        statements: 95,
      },
    },
  },
});
