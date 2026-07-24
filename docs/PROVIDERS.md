# Provider verification & decisions (M0)

All facts below were verified against live sources on **2026-07-14** (per brief §7: "Verify each
provider's current free-tier quotas and terms early … do not assume specific numbers").
Quotes are from the linked pages as fetched that day. Re-verify before major traffic changes.

## Needs (what a single uncached report consumes)

| Need | Endpoint shape | Est. calls / fresh address |
| --- | --- | --- |
| Geocode address → coords (+ disambiguation) | search | 1 |
| Walking isochrones 15/30/45 min | one request, 3 intervals | 1 |
| Transit reachability 45 min (15/30 derived from per-stop durations) | one-to-all | 1 |
| Amenities in area (5 core categories) | Local PostGIS catalogue query | 0 |
| Air quality + climate summary | forecast + air-quality | 2 |
| **Total** | | **5** |

Runtime provider responses are cached in PostgreSQL with expiry (brief §10), so repeat addresses
cost 0 external calls. Amenities use a shared weekly city snapshot rather than per-address cache
entries. Go/no-go bar: ≥100 fresh addresses/day headroom on every provider. **All picks clear it.**

---

## Verified evidence

### Geocoding — Nominatim (OSM Foundation) ✅ PICKED
- Policy: <https://operations.osmfoundation.org/policies/nominatim/>
- "Maximum of 1 request per second"; long-running/regular scripts limited to 4 req/min.
- Valid **HTTP Referer or User-Agent** identifying the app is required; **results must be cached**
  on our side (we do — PostgreSQL); attribution required.
- No key. Apps whose *primary* function is geocoding must self-host — HowFar is not that.
- Verdict: fine for our volume (1 call per fresh address, server-side, queued ≤1 rps).
- Photon (photon.komoot.io) — keyless, "reasonable limit" policy, throttling for extensive
  use, no SLA (<https://photon.komoot.io/>). **Adopted in M2 as the autocomplete source**
  (Nominatim's ToS forbids per-keystroke search): bbox-constrained to Bucharest, debounced
  client-side, min 3 chars, cached. Nominatim still does submit-time geocoding + reverse.

### Walking + car isochrones — OpenRouteService ✅ PICKED
- Restrictions: <https://openrouteservice.org/restrictions/> — isochrones: "Locations: 5",
  "Intervals: 10", "Range time (Foot profiles): 20 h". Profiles = foot / cycling / driving.
- **No public-transport profile exists** — confirmed on the restrictions page; transit must come
  from elsewhere (below).
- Free "Standard" plan quotas (via <https://account.heigit.org/info/plans>, corroborated by
  <https://apispine.com/openrouteserviceorg/pricing>): "Isochrones V2 (2500 / 40)" — i.e. ~2,500
  isochrone requests/day @ 40/min. Page is JS-rendered; **re-read exact numbers at key signup**
  (even the historical 500/day floor is 5× our bar). Walk + car share this one daily budget; a
  car selection is one extra POST (same key, same rate limiter) — still ≫ the ≥100 addresses/day bar.
- Free API key required — server-side only. One request covers all three intervals via `range`.
- **Walk** (`foot-walking`): 15/30/45-min bands, calibrated (below). **Car** (`driving-car`, task
  053): **10/20/30-min** bands. Car ranges are **nominal free-flow** ORS driving times — NOT
  calibrated and with **no live traffic** on the free tier — so the UI labels car reach an estimate
  (SelectionCard note + right-click popup caveat). The 10/20/30 bands were chosen because a
  45-min drive from central Bucharest is ~3.5× the tiled map extent; 10/20/30 fits the map (a
  3-origin probe put 10 & 20-min rings fully in-map, 30-min 80–98% in-map). Calibrating car to real
  drive times is parked (no free car "ruler"; ORS driving Matrix distance is the candidate ruler).

### Transit isochrones — Transitous (MOTIS) ✅ PICKED — **verified live**
- API: `https://api.transitous.org/api/v6/one-to-all?one=<lat>,<lon>&maxTravelTime=<min>`
  (MOTIS OpenAPI: <https://github.com/motis-project/motis/blob/master/openapi.yaml>).
- **Live probe 2026-07-14**: Piața Unirii (44.4268, 26.1025), maxTravelTime=30 → HTTP 200,
  **1,436 reachable stops** with per-stop `arrival`/`duration`, 463 KB in 2.9 s. Bucharest
  coverage confirmed (Transitous `feeds/ro.json` includes Bucuresti-Ilfov mobility-database
  feeds mdb-2098 + GTFS-RT, plus national railway).
- We build the isochrone polygons ourselves server-side. *Implementation note (M2):* the
  classic buffer-each-stop-and-union construction was prototyped and abandoned — unioning
  thousands of overlapping walk discs took ~65 s on a real 2,509-stop payload. Shipped
  instead: rasterize a reachability field over the launch bbox and extract the 15/30/45-min
  contours with marching squares (~40 ms, and ring nesting is guaranteed by construction).
  See `src/features/isochrones/server/transit-grid.ts`.
- Usage policy (<https://transitous.org/api/>): free, community-run; "not intended for commercial
  or for-profit purposes" (HowFar: non-commercial portfolio, no ads/subscriptions ✅); open-source
  clients must publish source (repo will be public ✅); send identifying `User-Agent` with contact
  ✅ (already done in probe); attribution: link <https://transitous.org/sources/> + OSM ✅;
  **"contact before … difficult to calculate requests (such as routing, isochrones)"** →
  **ACTION: send Transitous a short hello** (Matrix/email, see their site) describing
  HowFar's cached, Bucharest-only, low-volume use.
- Fallback if Transitous asks us to stop: TravelTime (docs.traveltime.com) — after 2-week trial,
  "a limit of 5 hits per minute applies"; isochrone detail capped at Medium on free; Romania
  transit coverage listed only behind account login — **unverified**. Kept as plan B, not the pick.

### Rejected for isochrones — Geoapify ❌
- Pricing (<https://www.geoapify.com/pricing/>): free plan 3,000 credits/day **but "Isochrones up
  to 15 min"** — cannot serve the required 30/45-min thresholds on the free tier. Transit mode
  also not confirmed in the Isoline API docs.

### Calibration of the reachability rings (2026-07-17) — how "15 minutes" is kept honest

Both isochrone constructions are **calibrated against street-network measurements**, and the
methodology below is re-runnable whenever providers or the city data change.

- **Ruler:** MOTIS `one-to-many` (`mode=WALK`, `withDistance=true`) returns street-routed
  **distance**, making measurements independent of any speed assumption; minutes are then
  distances at the product's documented walking speed (80 m/min ≈ 4.8 km/h). Distance-based
  measurement is the ruler everywhere (durations depend on the router's own speed constant).
- **Walking rings (ORS):** ORS foot-walking boundaries are systematically generous — boundary
  audits at three diverse origins (Unirii central / Grozăvești river-barrier / Berceni periphery)
  put the nominal 900/1800/2700 s boundaries at 1.265/1.164/1.123 × their labels. ~4% of that is
  ORS's faster speed constant (~5 km/h vs our 4.8), the rest boundary/hull generosity; the fix is
  cause-agnostic: request ranges fitted in two passes (the factor grows as ranges shrink) —
  final `[827, 1674, 2528]` s — then re-audited: the corrected boundaries sit at ≈ nominal
  (15-ring median exactly 15.0 min; residuals within ±10%). See `ors.ts` CALIBRATED_RANGES_S.
- **Transit egress:** crow-fly understates Bucharest street distance by a measured median
  **1.402×** (143 routed-vs-straight pairs, 6 origins; p25 1.29, p75 1.54, p90 1.82 — worst at
  river/rail barriers). Stop-egress stamps run at 80/1.402 m/min. This is a **calibrated
  approximation** — anisotropy (a river beside the stop) is documented, not modeled.
- **Origin walk component:** street-routed and boundary-calibrated (the ORS ring geometry with
  the corrected ranges, ±10% residuals) — the transit rings union it in per threshold and skip
  the radial origin stamp. The merge is all-or-nothing with a superset guard; any failure
  rebuilds the whole family with the radial stamp (never a mixed family).
- **Validation (shipped rings vs `one-to-many-intermodal` ground truth, 252 points, 3 origins):**
  over-claiming (painted ≤T but really >T+5 min) fell from up to **75%** (15-min threshold at the
  barrier origin) to **0-6%** everywhere, with **zero** under-claiming beyond the symmetric
  ±5-minute tolerance band, before or after (sub-5-minute deviations are inside the band by
  definition and not counted either way).
- **Fair use accounting:** calibration was a bounded one-off development campaign (~35
  `one-to-many`/intermodal calls total, all ≤128 locations, ≥2 s spacing, identifying
  User-Agent with contact email). Runtime traffic is unchanged: 1 `one-to-all` + ≤1 coalesced
  ORS call per fresh address, everything PostgreSQL-cached. **The Transitous courtesy contact is
  still an open owner action** (see Action items) — no further calibration campaigns before it
  lands. For later travel modes (bike/car), `one-to-many` supports `mode=BIKE|CAR` — same
  instrument, same budget discipline.

### Amenities / POIs — weekly OSM catalogue in PostGIS ✅ PICKED
- Commons/fair use (<https://dev.overpass-api.de/overpass-doc/en/preface/commons.html>, wiki):
  guideline ≈ "10,000 requests per day and … download volume below about 1 GB per day".
- Mirror: <https://overpass.kumi.systems/> — "free and unlimited access … trusts its users to
  share resources fairly" → configured fallback host.
- No key. One bounded, sequential-host, full-Bucharest `out geom` request runs weekly at
  Sunday 03:00 UTC, validates and atomically publishes into the isolated `osm_catalogue` schema.
  Runtime map selections perform no amenity Overpass request: ORS supplies the 15-minute ring and
  PostGIS intersects it with the active point/polygon dataset. The last good snapshot survives
  fetch, validation, or publication failure; `/api/catalogue-status` becomes 503 after 10 days.
- The importer excludes lifecycle/private park features and unnamed generic gardens, then
  conservatively deduplicates contained and overlapping representations. Full polygon geometry is
  retained so parks crossing a walking ring appear even when their centroid is outside.
- OpenStreetMap attribution and ODbL apply. `/api/catalogue-export` offers the active Derived
  Database as paginated GeoJSON and strictly excludes public-schema auth/cache data.
- **Transit stop lines/direction (task 021):** a click on a transit-stop marker looks up the lines
  serving it from OSM `type=route` relations, on-demand and cached (30d full / 1d empty). **Two-stage,
  direct-first** (probed live 2026-07-17, refined after code review): stage 1 asks for the routes
  the stop is a DIRECT member of (`<seed>(id);(rel(bn|bw|br)[type=route];)`) — correct and
  per-platform accurate for bus/tram stops. Only if that is empty (a metro/rail *station* node, which
  is not a direct route member) does stage 2 expand via the station's `public_transport=stop_area` to
  the platform/`stop_position` member nodes and take THEIR routes. Direct-first is essential: a single
  always-expand query over-reaches at interchanges (verified live — a Piața Unirii bus stop with 1
  real route gained 8 unrelated sibling-platform tram routes under the area hop). Direction is the
  `to` (destination) headsign, never `from`. Uses the separate interactive endpoint race, passing
  `treatEmptyAsFailure:false` — a stop with no mapped routes legitimately returns `[]`, and the race
  prefers a non-empty host so a fast degraded mirror's `[]` can't cache a false "no lines". The
  `/api/stop-lines` route rejects out-of-Bucharest coordinates (keeps casual off-area traffic off the
  community servers) but the real fair-use bound is the per-host rate limiter + single-flight + TTL'd
  cache, not the geo-guard (which doesn't bind id→coords).

### Air quality + climate — Open-Meteo ✅ PICKED
- Terms/pricing (<https://open-meteo.com/en/terms>, <https://open-meteo.com/en/pricing>): free
  for **non-commercial** use, "less than 10,000 API calls per day, 5,000 per hour and 600 per
  minute", no key, **CC-BY 4.0 attribution required**.
- Air Quality API (<https://open-meteo.com/en/docs/air-quality-api>): hourly pollutants + European
  AQI, same free terms — one provider covers both air and climate. ✅
- Secondary (parked, optional later): OpenAQ v3 — free API key, 60 req/min
  (<https://docs.openaq.org/using-the-api/rate-limits>) — for *measured* station values if we
  ever want them alongside Open-Meteo's model values.

### Map tiles — Protomaps, self-hosted ✅ PICKED (MapTiler rejected)
- MapTiler free (<https://www.maptiler.com/cloud/pricing/>): 100,000 requests/month,
  non-commercial + R&D only, maps **suspended** for the rest of the month at the cap, and the tile
  key is used from the browser (their account even auto-creates a domain-unrestricted key if all
  keys are restricted). The brief's hard constraint is "External API keys stay server-side; keys
  never exposed client-side" — a browser tile key violates it. ❌
- Protomaps (<https://docs.protomaps.com/basemaps/downloads>, <https://docs.protomaps.com/pmtiles/cli>):
  daily planet builds (~120 GB) at maps.protomaps.com/builds; `pmtiles extract <build-url>
  out.pmtiles --bbox=…` pulls a Bucharest-region extract efficiently over HTTP (tens of MB).
  Served by our own app (single static file + HTTP Range route) → **keyless, quota-less, zero
  client credentials**, full styling control (custom dark theme for the "visually striking"
  goal). Not "heavy geo infra": no extra server, just a file. Basemap style from
  `@protomaps/basemaps`.
  *Known gap (parked for M4):* font glyphs + sprite are still fetched by the browser from
  `protomaps.github.io/basemaps-assets` — keyless static files, so the constraint's key-safety
  intent holds, but the strict "all external calls happen server-side" reading does not yet;
  self-hosting them in `public/` is the M4 polish item (also removes a third-party availability
  dependency).

### Hosting — Railway (fixed by brief) — cost note
- Pricing (<https://docs.railway.com/pricing/plans>): Trial = one-time $5 credit, services
  **pause** when it's spent or after 30 days → not suitable for a permanent CV link.
  **Hobby = $5/month including $5 of usage** — the realistic tier for app + PostGIS; the weekly
  importer is a short-lived cron service and consumes compute only while it runs.

---

## Decisions (answers to brief §12)

| §12 question | Decision |
| --- | --- |
| Free-tier quotas verified? | Yes — table above, evidence dated 2026-07-14 |
| Geocoder | **Nominatim** (server-side, PostgreSQL-cached, ≤1 rps, UA set); Photon adopted at M2 for autocomplete |
| Map tiles | **Self-hosted Protomaps** Bucharest extract (keyless; constraint-clean) |
| Air quality | **Open-Meteo** (also climate); OpenAQ parked as optional add-on |
| v1 travel modes | **Walking (ORS) + public transport (Transitous one-to-all)** — confirmed feasible |
| Product name + domain | Name settled: **HowFar** (2026-07-14). Domain: to choose/purchase |
| Compare mode | v2 (per brief §6 "Later") |

## Env-var surface created by these picks

| Var | Needed | Secret? |
| --- | --- | --- |
| `ORS_API_KEY` | walking isochrones | yes — server only |
| (none) | Nominatim, Overpass, Open-Meteo, Transitous, tiles | keyless (UA/Referer set in code) |

## Action items arising

| # | Item | Status (2026-07-21) |
| --- | --- | --- |
| 1 | Transitous courtesy hello before heavy isochrone use | **Owner skipped** (accepted risk; still non-commercial, cached, Bucharest-only) |
| 2 | ORS free account → `ORS_API_KEY` (server-side) | **Done** — live in prod |
| 3 | Railway Hobby plan ($5/mo) when trial ends | **Open** (trial pause ~2026-08-14 informational) |
| 4 | Keep the GitHub repo public (Transitous open-source-client + portfolio) | **Done** — public at github.com/joitamihnea1999/HowFar |
