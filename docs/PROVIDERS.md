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
| Amenities in area (5 core categories) | Overpass QL (merged queries) | 1–2 |
| Air quality + climate summary | forecast + air-quality | 2 |
| **Total** | | **6–7** |

Every response is cached in MySQL with expiry (brief §10), so repeat addresses cost 0 external
calls. Go/no-go bar: ≥100 fresh addresses/day headroom on every provider. **All picks clear it.**

---

## Verified evidence

### Geocoding — Nominatim (OSM Foundation) ✅ PICKED
- Policy: <https://operations.osmfoundation.org/policies/nominatim/>
- "Maximum of 1 request per second"; long-running/regular scripts limited to 4 req/min.
- Valid **HTTP Referer or User-Agent** identifying the app is required; **results must be cached**
  on our side (we do — MySQL); attribution required.
- No key. Apps whose *primary* function is geocoding must self-host — HowFar is not that.
- Verdict: fine for our volume (1 call per fresh address, server-side, queued ≤1 rps).
- Photon (photon.komoot.io) — keyless, "reasonable limit" policy, throttling for extensive
  use, no SLA (<https://photon.komoot.io/>). **Adopted in M2 as the autocomplete source**
  (Nominatim's ToS forbids per-keystroke search): bbox-constrained to Bucharest, debounced
  client-side, min 3 chars, cached. Nominatim still does submit-time geocoding + reverse.

### Walking (later bike/car) isochrones — OpenRouteService ✅ PICKED
- Restrictions: <https://openrouteservice.org/restrictions/> — isochrones: "Locations: 5",
  "Intervals: 10", "Range time (Foot profiles): 20 h". Profiles = foot / cycling / driving.
- **No public-transport profile exists** — confirmed on the restrictions page; transit must come
  from elsewhere (below).
- Free "Standard" plan quotas (via <https://account.heigit.org/info/plans>, corroborated by
  <https://apispine.com/openrouteserviceorg/pricing>): "Isochrones V2 (2500 / 40)" — i.e. ~2,500
  isochrone requests/day @ 40/min. Page is JS-rendered; **re-read exact numbers at key signup**
  (even the historical 500/day floor is 5× our bar).
- Free API key required — server-side only. One request covers 15/30/45 via `range` intervals.

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

### Amenities / POIs — Overpass API ✅ PICKED
- Commons/fair use (<https://dev.overpass-api.de/overpass-doc/en/preface/commons.html>, wiki):
  guideline ≈ "10,000 requests per day and … download volume below about 1 GB per day".
- Mirror: <https://overpass.kumi.systems/> — "free and unlimited access … trusts its users to
  share resources fairly" → configured fallback host.
- No key; server-side; 1–2 merged category queries per fresh address, cached. Orders of magnitude
  inside the guideline.

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
  **Hobby = $5/month including $5 of usage** — the realistic tier for app + MySQL, persistent.

---

## Decisions (answers to brief §12)

| §12 question | Decision |
| --- | --- |
| Free-tier quotas verified? | Yes — table above, evidence dated 2026-07-14 |
| Geocoder | **Nominatim** (server-side, MySQL-cached, ≤1 rps, UA set); Photon adopted at M2 for autocomplete |
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

1. Say hello to Transitous (courtesy contact before isochrone use) — non-commercial, cached,
   Bucharest-only, ~tens of one-to-all calls/day worst case.
2. Create a free OpenRouteService account → `ORS_API_KEY` (server-side env var); confirm the
   Standard-plan isochrone quota shown at signup.
3. Railway Hobby plan ($5/mo) when deploying.
4. Keep the GitHub repo public (Transitous open-source-client condition + portfolio anyway).
