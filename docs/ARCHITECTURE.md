# Architecture

HowFar is a single Next.js (App Router) app: the map UI, the API routes and the
data-provider clients live in one repo and deploy as one Railway app service backed
by PostgreSQL/PostGIS, plus one short-lived weekly importer using the same code. Two rules shape everything:

1. **No external data call from the browser, ever.** Every provider request
   runs server-side, is rate-limited per host, and is cached in PostgreSQL where appropriate — the
   browser talks to `/api/*` for all data. The only secret is the
   OpenRouteService key. (Sole exception today: the basemap's font glyphs and
   sprite are keyless static files fetched from `protomaps.github.io`;
   self-hosting them is a planned polish item — see `docs/PROVIDERS.md`.)
2. **The core flow must survive degradation.** A dead cache degrades to
   uncached (slower, still correct); a dead provider degrades to a clear 502;
   a dead database keeps `/api/health` alive while `/api/ready` reports 503.

## Request flow

```
address text ──► /api/suggest ──► Photon      (type-ahead)
     │
     ▼
/api/geocode ──► Nominatim                    (search submit)
map click   ──► /api/reverse ──► Nominatim    (label only — the click IS the origin)
     │
     ▼
/api/isochrone ──► OpenRouteService           (walking rings, 15/30/45 min)
/api/transit  ──► Transitous one-to-all ──► transit-grid (rings built in-process)
/api/amenities ──► ORS walk ring ∥ active PostGIS snapshot ──► spatial intersection
     │
     ▼
AppMap renders {origin, rings[]} + amenity markers — staged rings, color + category glyphs,
                                                     synchronized map/list inspection
```

Each provider route follows the same skeleton: parse/validate input
(`lib/api-util.ts`) → geofence to the launch area (`lib/bounds.ts`, 422
outside) → call the provider client → map errors (`errorResponse`, which logs
the cause and returns a generic 502/500).

## Module map

Source is organised feature-first: each folder under `src/features/` is one
product concern, holding its client logic at the feature root and its
server-only modules (provider clients and anything touching secrets, Prisma or
node builtins) in a `server/` subfolder. `src/lib/` keeps only shared platform
plumbing.

**Import rule:** client components and client-side modules may import feature
*root* modules and the client-safe lib pair (`bounds`, `timeout`) — never
anything under a `server/` folder or the rest of `lib/` (db, env, api-cache,
api-util, health, provider-http, byte-range), which exist for API routes and
server code only.

| Path | Role |
| --- | --- |
| `src/app/api/*/route.ts` | Thin HTTP glue: status codes only, no business logic |
| `src/app/api/tiles/route.ts` | Serves the self-hosted PMTiles basemap with HTTP Range semantics |
| `src/features/map/AppMap.tsx` | Thin client shell: holds render state, creates the controllers below in dependency order, wires the map event handlers, renders the shell + JSX. No business logic of its own |
| `src/features/map/{camera,hover,ring-reveal,route-path,popup,amenities,select-flow}-controller.ts`, `selection-render.ts` | Single-responsibility controllers, each `create*(...) → { …methods, dispose }`. One shared `load-state.ts` cell carries style-load readiness + the pre-`load` replay buffers; teardown disposes them in reverse create order, then removes the map last. Imperative MapLibre/network glue — verified by the e2e suite |
| `src/features/map/{route-framing,load-state}.ts` | Pure/near-pure helpers pulled out of the controllers: route-fit corridor math, framing read-backs, the stamp-retry decision (unit-tested); the shared load-state cell |
| `src/features/search/search-suggest-controller.ts` | Autocomplete debounce timer + fetch/abort glue driving the combobox reducer |
| `src/features/map/selection-flow.ts` | Selection state machine (token staleness, mode snapshot, failure mapping); owns the `Mode`/`Ring`/`Origin` types |
| `src/features/map/map-setup.ts` | Pure basemap style + source/layer specs, including route and non-color amenity encoding (unit-tested) |
| `src/features/map/camera.ts` | Shared four-edge camera padding (pure size→inset math; the camera-controller commits it to MapLibre) |
| `src/features/map/{SearchForm,SuggestList,ModeToggle,RingSelector,SelectionCard,EmptyState,AttributionBadge}.tsx` | Focused presentation leaves for the responsive command/result shell |
| `src/features/map/AmenityPanel.tsx` | Count summary plus bounded, filterable keyboard/touch place browser; delegates map inspection back to `AppMap` |
| `src/features/search/combobox.ts` | Autocomplete state machine (generation staleness, keyboard nav) |
| `src/features/search/server/{nominatim,photon}.ts` | Geocode/reverse + type-ahead provider clients |
| `src/features/isochrones/isochrone-view.ts` | Pure ring view-model: per-mode ramps, GeoJSON features, legend |
| `src/features/isochrones/server/{ors,transit}.ts` | Walking + transit reachability provider clients |
| `src/features/isochrones/server/transit-grid.ts` | Pure geometry: reachability grid + marching-squares contours |
| `src/features/amenities/amenities.ts` | Shared category config/classifier for importer, API DTOs and UI |
| `src/features/amenities/amenity-selection.ts` | Versioned selectable-category state and category+text filtering |
| `src/features/amenities/amenities-flow.ts` | Client fetch-decision logic (origin keying and retry behavior) |
| `src/features/amenities/server/merge-transit-stops.ts` | Read-time fuse of coincident transit-stop markers (one physical place tagged as several OSM nodes) into one marker carrying its members; conservative, distance+mode+name calibrated |
| `src/features/amenities/server/catalogue-{import,normalize,store,query,status,export}.ts` | Weekly ingestion/quality, immutable publication, spatial runtime reads and operational/ODbL surfaces |
| `src/features/amenities/server/bulk-overpass.ts` | Weekly-only bounded sequential Overpass snapshot transport |
| `src/features/amenities/server/overpass-client.ts` | Interactive stop-line/route-path Overpass transport; not amenity discovery |
| `src/features/auth/auth-view.ts` | Pure auth decision: what the sign-in/out control renders |
| `src/features/auth/server/auth-config.ts` | Which OAuth providers are configured (reads env — server-only) |
| `src/features/auth/server/AuthControl.tsx` | Server component: session-aware sign-in/out |
| `src/lib/provider-http.ts` | Shared provider plumbing: per-host rate limiter, abortable timeout, `ProviderError`, cache-key helpers |
| `src/lib/api-cache.ts` | PostgreSQL-backed external-provider cache; strict accessors + best-effort `*Safe` variants |
| `src/lib/api-util.ts` | Route helpers: param parsing, geofence guard, error→status mapping |
| `src/lib/{env,db,health,timeout,bounds,byte-range}.ts` | Env validation, Prisma pool, DB probe, deadline helper, launch bbox, Range parsing |
| `src/auth.ts` | Auth.js wiring only — decisions live in `features/auth` |
| `e2e/` | Playwright specs against the production build, including desktop Chromium and a real-touch Pixel project (see Testing) |

**Deliberate cross-feature edges** (documented so nobody "fixes" them):
amenities → isochrones (`server/catalogue.ts` calls `server/ors.ts` for the §5
"within the walking isochrone" geometry); isochrones → map (`isochrone-view.ts`
imports the `Mode`/`Ring` types from `selection-flow.ts`, type-only — they stay
with the selection machine until the isochrone contract grows its own types
module); every feature → `lib/`. `features/map` is the **composition root**: it
may import any feature's root modules (and does — combobox, isochrone-view,
amenities, amenities-flow), which makes map↔isochrones look bidirectional; the
cycle is type-only and dissolves when the planned
`features/isochrones/types.ts` lands.

## The provider-client template

The interactive clients (nominatim, photon, ors, transit and stop/route Overpass — plus the tiles
route's Range serving as a degenerate case) share one shape — read
`src/features/isochrones/server/ors.ts` once and the rest follow:

1. A constants block: endpoint, host, `MIN_INTERVAL_MS`, `TIMEOUT_MS`, cache
   TTL. The values live in code, next to the client they throttle.
2. Typed interfaces for the provider's raw response (only the fields we read).
3. A pure `normalize` function that defensively validates every field it
   touches — coordinates coerced to finite numbers, geometry shape checked,
   out-of-area rows dropped. Garbage from a provider must become a 502 here,
   never a client-side MapLibre error.
4. Cache-first flow: `getCachedSafe` → `providerFetch` (rate-limited, timed,
   identifying `User-Agent`) → `normalize` → `setCachedSafe`.
5. Every failure wrapped in `ProviderError` (bad status, timeout, garbled
   body) so routes can map it to 502 — anything else is a genuine 500.

### Adding a provider (checklist)

Copy this for every new data source (air quality, reviews, …):

- [ ] Placement rule: the client lives WITH the feature it serves —
      `src/features/<feature>/server/<name>.ts` (create the feature folder if
      the data source starts a new concern; never a shared providers/ folder).
      Follow the five points above; cache key `"<domain>:<discriminator>"`
      (hash free-text with `sha256Hex`, round coordinates with `roundCoord` so
      key, request and rendered origin agree).
- [ ] Colocated `<name>.test.ts`: happy-path normalize, malformed/garbled body
      → `ProviderError`, non-ok status → `ProviderError`, network failure
      wrapped, cache hit issues zero fetches, provider-specific edge rows
      dropped. Mock `@/lib/api-cache` and `providerFetch` (see any existing
      provider test); use `beforeEach(() => { mock.mockReset(); })` — braces
      matter, a function returned from `beforeEach` runs as a teardown.
- [ ] `src/app/api/<name>/route.ts` using `parseLatLng` / `outOfAreaGuard` /
      `errorResponse(err, "<name>")`, plus a colocated `route.test.ts` pinning
      the full status table below, including the 502 log line.
- [ ] e2e: stub **the exact route** (`page.route("**/api/<name>**", …)`) —
      never a blanket `**/api/**`, which would also intercept the map's tile
      requests and break rendering.
- [ ] ToS: identifying `User-Agent` (`USER_AGENT` in `lib/provider-http.ts`),
      visible attribution in the UI if required, quotas noted in
      `docs/PROVIDERS.md`.

### API status contract

| Status | Meaning | Where |
| --- | --- | --- |
| 400 | missing/blank/non-numeric/out-of-range params | `parseLatLng`, per-route query checks |
| 404 | provider answered, nothing found | route (`null` result) |
| 422 | valid point outside the Bucharest launch area | `outOfAreaGuard` |
| 502 | upstream provider failed (status/timeout/garbage) | `errorResponse` on `ProviderError` |
| 500 | anything else | `errorResponse` fallback |
| 200 + empty | legitimate empty (e.g. suggest under 3 chars) | route |

Errors are logged server-side as `[api:<route>] <name>: <message>` — one line,
no stacks, no upstream payloads. The response body stays generic.

## Testing

- **Unit (Vitest, `src/**/*.test.ts`)**: colocated with the module they pin;
  each test names the invariant it protects. Pure logic is extracted from
  components precisely so it can be tested here (`auth-view`, `auth-config`,
  `transit-grid`). Property-based tests (fast-check) cover algebraic contracts
  (`byte-range`, `bounds`).
- **e2e (Playwright, `e2e/`)**: runs against the production build with a real
  PostGIS and the real tile archive; provider routes are stubbed per-endpoint.
  This suite owns the rendering/wiring glue that unit tests exclude. Specs
  synchronise on `data-*` read-back stamps the map writes rather than fixed
  sleeps: `data-map-loaded`, `data-amenity-count`, `data-ring-reveal`(→`settled`),
  `data-route-path`/`data-route-framed`, `data-amenity-hover`, and
  `data-camera-settled` (stamped on the selection flyTo's settle `moveend`;
  cleared while a new selection is in flight) — wait for the stamp, then project.
- **Coverage**: `npm run test:coverage` includes *all* of `src/` — a file with
  no tests reports 0% instead of disappearing; deliberate exclusions are
  listed with reasons in `vitest.config.ts`. Thresholds gate CI.
- Local loop: `npm run check` (lint + typecheck + unit, sub-minute);
  `npm run check:ci` adds the production build.

## Load-bearing invariants

- Coordinates: ORS wants `[lng, lat]`; Nominatim returns lat/lon as *strings*;
  Photon and Nominatim use different bbox parameter orders. Each quirk is
  commented at its call site.
- Ring labels mean REAL street minutes at 80 m/min, not provider-nominal
  values: the ORS ranges are calibrated (`ors.ts` CALIBRATED_RANGES_S — the
  response contract matches features to those exact values before relabeling
  to 15/30/45) and transit egress runs at a measured detour-deflated speed
  (`transit-grid.ts` STREET_DETOUR). Methodology + numbers:
  `docs/PROVIDERS.md` "Calibration". Cache keys are versioned (`iso:foot:v2:`,
  `transit:v2:`) so pre-calibration rings can never be served.
- Isochrone rings are always exactly 15/30/45 minutes, ascending; transit ring
  nesting (15 ⊆ 30 ⊆ 45) is guaranteed by construction (thresholds of one
  monotonic field — see `transit-grid.ts`). The ONLY union is the per-threshold
  merge of the street-routed walking ring (`unionRings`) — nesting survives it
  because both families nest AND the merge is guarded: all-or-nothing with a
  superset check, so any per-ring failure rebuilds the whole family with the
  radial origin stamp (a mixed family could exclude the origin from one of its
  own rings); an ORS failure or an over-slow walk fetch (bounded wait) takes
  the same radial path. The transit response never fails because of
  walk-geometry polish.
- Transit departure time is pinned to a representative weekday morning so
  reachability is comparable and cacheable (`representativeDeparture`); the
  response's `departure` field carries that instant so the UI can qualify the
  claim (a weekend/night visitor is seeing weekday-08:30 reach).
- Negative geocode results are cached under a sentinel so repeat misses cost
  zero upstream calls.
- The tile route caps Range slices (DoS guard) and never buffers the whole
  archive; the map, geofence and tile extract share one bbox (`lib/bounds.ts`,
  `scripts/fetch-tiles.sh` — keep them in sync).
