# Architecture

HowFar is a single Next.js (App Router) app: the map UI, the API routes and the
data-provider clients live in one repo and deploy as one Railway service backed
by MySQL. Two rules shape everything:

1. **No external data call from the browser, ever.** Every provider request
   runs server-side, is rate-limited per host, and is cached in MySQL — the
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
     │
     ▼
AppMap renders {origin, rings[]} — one GeoJSON source, per-feature colors
```

Each provider route follows the same skeleton: parse/validate input
(`lib/api-util.ts`) → geofence to the launch area (`lib/bounds.ts`, 422
outside) → call the provider client → map errors (`errorResponse`, which logs
the cause and returns a generic 502/500).

## Module map

| Path | Role |
| --- | --- |
| `src/app/api/*/route.ts` | Thin HTTP glue: status codes only, no business logic |
| `src/app/api/tiles/route.ts` | Serves the self-hosted PMTiles basemap with HTTP Range semantics |
| `src/lib/providers/http.ts` | Shared plumbing: per-host rate limiter, abortable timeout, `ProviderError`, cache-key helpers |
| `src/lib/providers/{nominatim,ors,photon,transit}.ts` | One client per provider (see the template below) |
| `src/lib/providers/transit-grid.ts` | Pure geometry: reachability grid + marching-squares contours |
| `src/lib/api-cache.ts` | MySQL-backed cache; strict accessors + best-effort `*Safe` variants |
| `src/lib/{env,db,health,timeout,bounds,byte-range}.ts` | Env validation, Prisma pool, DB probe, deadline helper, launch bbox, Range parsing |
| `src/lib/{auth-view,auth-config}.ts` | Pure auth decisions (what to render / which providers are configured) |
| `src/auth.ts` | Auth.js wiring only — decisions live in the two lib modules above |
| `src/components/AppMap.tsx` | MapLibre client component: search box, mode toggle, ring rendering |
| `e2e/` | Playwright specs against the production build (see Testing) |

## The provider-client template

All four clients share one shape — read `src/lib/providers/ors.ts` once and
the rest follow:

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

Copy this for every new data source (amenities, air quality, …):

- [ ] `src/lib/providers/<name>.ts` following the five points above; cache key
      `"<domain>:<discriminator>"` (hash free-text with `sha256Hex`, round
      coordinates with `roundCoord` so key, request and rendered origin agree).
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
- [ ] ToS: identifying `User-Agent` (`USER_AGENT` in `providers/http.ts`),
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
  MySQL and the real tile archive; provider routes are stubbed per-endpoint.
  This suite owns the rendering/wiring glue that unit tests exclude.
- **Coverage**: `npm run test:coverage` includes *all* of `src/` — a file with
  no tests reports 0% instead of disappearing; deliberate exclusions are
  listed with reasons in `vitest.config.ts`. Thresholds gate CI.
- Local loop: `npm run check` (lint + typecheck + unit, sub-minute);
  `npm run check:ci` adds the production build.

## Load-bearing invariants

- Coordinates: ORS wants `[lng, lat]`; Nominatim returns lat/lon as *strings*;
  Photon and Nominatim use different bbox parameter orders. Each quirk is
  commented at its call site.
- Isochrone rings are always exactly 15/30/45 minutes, ascending; transit ring
  nesting (15 ⊆ 30 ⊆ 45) is guaranteed by construction (thresholds of one
  monotonic field — see `transit-grid.ts` for why it is a grid, not a union).
- Transit departure time is pinned to a representative weekday morning so
  reachability is comparable and cacheable (`representativeDeparture`).
- Negative geocode results are cached under a sentinel so repeat misses cost
  zero upstream calls.
- The tile route caps Range slices (DoS guard) and never buffers the whole
  archive; the map, geofence and tile extract share one bbox (`lib/bounds.ts`,
  `scripts/fetch-tiles.sh` — keep them in sync).
