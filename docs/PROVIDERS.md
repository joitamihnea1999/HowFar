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

> **⚠ Superseded for the commercial target (2026-08, owner pivot).** The provider
> picks and the "non-commercial / cached / Bucharest-only" acceptability
> reasoning below reflect the original **portfolio** project. Under the paid,
> self-hosted, multi-city direction (self-host the OSM/MOTIS stack; each city's
> GTFS licence is a per-city go/no-go), Transitous ("not for commercial") and
> Open-Meteo's free tier are no longer usable as-is. This document has NOT yet
> been re-argued for that target — a dedicated commercial-provider-docs pass owns
> that. Until then, treat the acceptability verdicts here as the legacy
> public-default rationale, not the commercial plan.

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
- **Walk** (`foot-walking`): 15/30/45-min bands, calibrated (below). **Car** (`driving-car`, tasks
  053/058): **10/20/30-min** bands. The 10/20/30 bands were chosen because a 45-min drive from
  central Bucharest is ~3.5× the tiled map extent; 10/20/30 fits the map (a 3-origin probe put 10 &
  20-min rings fully in-map, 30-min 80–98% in-map). **Task 058 makes car reach TIME-AWARE**: the
  nominal free-flow ORS seconds are DIVIDED by a per-time-of-day congestion factor before the
  request, so the painted band reflects real Bucharest drive time (see "Car traffic realism" below).
  The 2026-07-24 re-audit that found the ranges "already accurate → no calibration factor" was
  **FREE-FLOW-ONLY** (its rulers — public OSRM + ORS-Matrix — are themselves free-flow); it is
  accurate for free-flow but silent on congestion, and is **superseded for car** by the traffic-
  factor work. The UI still labels car reach an estimate (typical congestion, not live traffic).

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
  the owner reviewed this and **decided to skip the courtesy hello** (accepted risk; the use
  stays non-commercial, cached, Bucharest-only, low-volume). See "Action items arising".
- **Journey directions (`/api/v1/plan`):** the right-click "how do I get there?" trip uses the
  same engine's point-to-point planner (cached, single-flighted). Each leg carries a
  `legGeometry.points` encoded polyline **at precision 7 (1e7 scale), not the format's usual
  precision 5** — decode with the leg's own `legGeometry.precision`, or the path lands ~100× out
  of range. Legs also carry `from`/`to` `lat`/`lon` (board/alight stops) and `intermediateStops`.
  **Street-leg limits must match the painted rings** (2026-07-29): MOTIS defaults
  `maxPreTransitTime`/`maxPostTransitTime` to **900 s** (15-min max walk to the first / from the
  last stop), while our ring egress model walks up to the whole remaining band — so `/plan`
  answered "no itineraries" for points the map painted reachable (verified live: 6/40 random
  Bucharest points; all revive with a raised post limit). We now send
  `maxPostTransitTime=2700` (the 45-min band) + `pedestrianSpeed=1.389` (the Normal pace) +
  `useRoutedTransfers=true` (the same walking contract the one-to-all rings use); the pre limit
  deliberately stays at the default, matching the rings' own ingress. Values are capped
  server-side by Transitous's `street_routing_max_prepost_transit_seconds` (≥2700 as of
  2026-07-29). Load note: this widens each `/plan` search slightly and a zero-itinerary answer
  is retried once; both stay behind the same `transit`-bucket rate spacing (default 1.5 s, config-driven since task 009; no added concurrency).
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
  distances at a walking speed. Distance-based measurement is the ruler everywhere (durations
  depend on the router's own speed constant).
- **Anchor vs product speed (important).** The ranges below were fitted at an **80 m/min
  calibration anchor**. Since the walking speeds were set to Slow 3 km/h (50 m/min) and Normal
  5 km/h (83.3 m/min), **no pace walks at the anchor** — it is a measurement ruler, nothing more.
  Each pace requests the anchor triple rescaled by `speed / 80` (distance calibration is
  speed-independent), so re-deriving the scale from a pace's own speed would silently move every
  ring. Constants live in `pace.ts` (`CALIBRATION_SPEED_M_PER_MIN`, `CALIBRATED_RANGES_S_AT_80`).
- **Walking rings (ORS):** ORS foot-walking boundaries are systematically generous — boundary
  audits at three diverse origins (Unirii central / Grozăvești river-barrier / Berceni periphery)
  put the nominal 900/1800/2700 s boundaries at 1.265/1.164/1.123 × their labels. Part of that is
  ORS's own faster speed constant, the rest boundary/hull generosity; the fix is
  cause-agnostic: request ranges fitted in two passes (the factor grows as ranges shrink) —
  anchor triple `[827, 1674, 2528]` s at 80 m/min — then re-audited: the corrected boundaries sit
  at ≈ nominal (15-ring median exactly 15.0 min; residuals within ±10%). See `pace.ts`
  CALIBRATED_RANGES_S_AT_80. Per-pace requests: Slow `[517, 1046, 1580]`, Normal
  `[861, 1744, 2633]` (both accepted and echoed exactly by ORS, verified live 2026-07-29).
- **Transit egress:** crow-fly understates Bucharest street distance by a measured median
  **1.402×** (143 routed-vs-straight pairs, 6 origins; p25 1.29, p75 1.54, p90 1.82 — worst at
  river/rail barriers). Stop-egress stamps run at **the selected pace's speed / 1.402** — i.e.
  50/1.402 ≈ 35.7 m/min at Slow and 83.3/1.402 ≈ 59.4 m/min at Normal (egress has been
  pace-scaled since the pace control shipped; there is no fixed egress speed). This is a
  **calibrated approximation** — anisotropy (a river beside the stop) is documented, not modeled.
- **Walking-speed audit at Slow (2026-07-29).** 3 km/h sits 37.5% below the anchor, further than
  any previously validated pace, so the linear rescale was re-measured with the ruler above:
  3 origins × 3 bands, 8 boundary points per ring. All 9 ratios inside ±10%, **overall median
  1.012** (worst cell +3.2%) — the scale holds; no measured triple needed.
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
  ORS call per fresh address, everything PostgreSQL-cached. **The Transitous courtesy contact was
  reviewed and skipped by the owner** (see Action items — accepted risk: still non-commercial,
  cached, Bucharest-only). Calibration therefore continues under **bounded-campaign discipline**
  rather than a freeze: each campaign stays small (the 2026-07-29 walking-speed audit used ~12
  calls), ≤128 locations per call, ≥2 s spacing, identifying User-Agent. For later travel modes
  (bike/car), `one-to-many` supports `mode=BIKE|CAR` — same instrument, same budget discipline.

#### Re-audit of all modes with independent rulers (2026-07-24)

All three modes were re-measured against **independent** routing engines (not ORS-vs-ORS, which
is circular), 3 diverse origins × 3 bands, medians of ~5–10 boundary points per band:

- **Car (`driving-car`):** ruler = public **OSRM `driving`** (separate engine) + an ORS-Matrix
  self-consistency check. Boundary drive-durations landed at ORS-route 0.999–1.091× and OSRM
  0.921–1.035× the labels — the two rulers **straddle 1.0** with no directional bias, i.e. within
  ±5% (free-flow measurement noise). **⚠️ SUPERSEDED for car by task 058:** these rulers are
  **free-flow-only** (OSRM demo + ORS-Matrix don't model live/historical congestion), so "already
  accurate → no factor" is true ONLY for free-flow. Real Bucharest driving is 1.5–2.2× slower at
  peak; car reach is now time-aware (per-slot congestion factor — see "Car traffic realism"). The
  free-flow accuracy result stands as the FLOOR the factor scales.
- **Walk (`foot-walking`):** ruler = **MOTIS `/plan` direct-walk distance** (a real pedestrian
  engine, independent of ORS), converted at the 80 m/min calibration anchor. All 9 (origin×band)
  ratios 0.978–1.049, **median 0.999** — the anchor triple `[827,1674,2528]` sits almost exactly
  at its labelled walking minutes *for the anchor speed*. **Confirmed; no change.** This audit
  validates the ANCHOR, which is why it stays valid after the 2026-07-29 speed change: the ranges
  each pace requests are that same measured triple rescaled (and the rescale itself was
  re-audited at Slow — see "Walking-speed audit at Slow" above).
  *Ruler caveat: the public OSRM demo's `/foot/` profile is NOT pedestrian — it returns car
  speeds (~35 km/h). An early walk pass using it showed a spurious 1.8× (car detours in the dense
  centre) and was discarded. Validate a ruler's profile/units before trusting a ratio.*
- **Transit:** ruler = **MOTIS `/plan` journeys** to the transit-ring boundaries (2 origins × 3
  bands). Ratios 0.833–1.000 (median ~0.91) — the rings are consistently **conservative** (a
  boundary point is reachable in slightly *less* than its labelled minutes; the reach is never
  over-claimed). This is the safe direction and within the ±10% egress calibration above. Note the
  measurement is semi-circular (MOTIS journeys vs a MOTIS-built isochrone), so it is a consistency
  check, not a fully independent one. **No change** (widening the rings would risk over-claiming).

**Verdict (2026-07-24 free-flow re-audit): no FREE-FLOW calibration change to any mode.** Walk is
accurate within ±5%; transit is mildly conservative (safe); car free-flow is accurate within ±5%.
**Car realism update (task 058):** free-flow accuracy is not enough for a "how far can I really
get" promise in a congested city — car reach now scales the free-flow ranges by a per-time-of-day
congestion factor (next section). Walk + transit ring geometry are unchanged (both re-audited
accurate/safe; transit peak honesty is a copy matter, handled in the UI).

### Car traffic realism (task 058) — calibrated congestion factor over ORS free-flow ✅ PICKED

Bucharest is one of Europe's most congested cities (public **TomTom Traffic Index 2025**: 62.5%
congestion, 18.5 km/h average, ~4.6 km per 15 min), so ORS **free-flow** driving times over-claim
reach by roughly 1.5–2.2× at peak. Car reach is therefore made **time-aware**: the nominal free-flow
ranges `[600,1200,1800]s` are **divided by a per-time-of-day congestion factor** so a "20-min" band
paints the area actually reachable in 20 real minutes. Implementation: pure `features/isochrones/
car-traffic.ts` (`carTrafficSlot` → `{slotId,label,factor}`; `scaledCarRangesS`), consumed by
`ors.ts` `drivingIsochrone(lat,lng,slot)` and the `/api/car` route (which parses the same
two-option `preset` time-context as transit — Crowded / Not crowded). The response carries `car:{basis:"estimate",…}`;
the UI labels it typical-congestion, **not live traffic**.

**Provider decision matrix (why a calibrated factor, not a live-traffic API):**
- **TomTom Routing / `calculateReachableRange`** (free 2,500/mo, no card, traffic-aware) — **NOT
  USABLE in production.** Its binding **Portal (Docs) Terms & Conditions §2.2 license the free tier
  for "Evaluation Use only"** ("internal evaluation and testing by you of the Licensed Products"); a
  public live app is not that. Production needs §2.1 (paid License Fees + a Subscription Plan
  accepted by TomTom + a "Permitted Solution", *defined* as requiring Asset Management Functionality
  — HowFar isn't). Also **§11.4** bars caching Results server-side "for the purpose of scaling
  results to serve multiple clients or users"; **§11.6.1** bars building a "secondary or derived
  database/product" from the Results (a baked factor table from `calculateRoute` would be exactly
  that); **§20.2.3** bars combining Licensed content with copyleft/open data — our basemap + amenity
  data are **ODbL** (a Copyleft License per the T&C's own definition). Verified 2026-07-24 against
  the T&C the owner supplied. Technically it works well (a dev-time Evaluation-Use probe showed peak
  reach = 0.275× night area, 100%-nesting polygons), but it cannot ship.
- **Mapbox Isochrone** (`driving-traffic`+`depart_at`) — **DISQUALIFIED**: results "must be displayed
  on a Mapbox map"; HowFar renders MapLibre + self-hosted Protomaps (also card-on-file required).
- **HERE Isoline v8** — traffic-aware, but the no-card plan ended 2025-08-31; Base plan requires a
  card on file (standing billing risk for a boss-only owner). Parked as a documented alternative.
- **Chosen:** ORS free-flow (already used, no new provider) **÷ a congestion factor grounded in the
  PUBLIC TomTom Traffic Index** (published editorial statistics — freely citable, NOT API Results) +
  peak/off-peak traffic literature. Deliberately conservative (under- rather than over-claims).

**Factor table (revision `c1`, embedded in the cache key as `{frev}`):**

| Period (weekday) | Hours | Factor | | Weekend | Factor |
|---|---|---|---|---|---|
| overnight | 23–06 | ×1.05 | | daytime 10–20 | ×1.30 |
| early morning (shoulder) | 06–07 | ×1.40 | | off-peak (else) | ×1.10 |
| **AM peak** | 07–10 | **×2.10** | | | |
| midday | 10–16 | ×1.50 | | | |
| **PM peak** | 16–20 | **×2.20** | | | |
| evening | 20–23 | ×1.25 | | | |

The two user-facing time presets map through `departureFields`: **Crowded** (weekday 08:30) → AM
peak ×2.10; **Not crowded** (weekday 12:30) → midday ×1.50. The full wall-clock factor table above
still resolves *any* instant, but only those two presets are exposed in the UI (a free-form
day/time picker was removed for a least-necessary UI). Factors clamp to [1.0, 4.0]; scaled ranges
are guaranteed strictly ascending/distinct/≥60s.

**Provenance + re-run methodology:** the shipped factors are grounded in the **public TomTom Traffic
Index** (citable published statistics) plus peak/off-peak congestion literature, and are set
deliberately conservative (≥ typical measured congestion, so reach under- rather than over-claims). A
developer MAY sanity-check them against a private, dev-time Routing campaign under TomTom's
Evaluation-Use licence (internal testing only) — but **no TomTom-derived figures are published or
shipped** (this doc keeps only public-source provenance, per the licence analysis above). **If you
change the factors, you MUST bump `CAR_FACTOR_REVISION` in `car-traffic.ts`** — it is part of the
7-day car isochrone cache key (`iso:car:v2:{frev}:est:{slotId}:{coords}`), so without the bump,
prior-geometry rings silently survive the new factors (a unit test asserts a frev change can't hit
prior keys).

**Env:** `TOM_TOM_API_KEY` / `CAR_TRAFFIC_LAYER2` are **not used** by the app (TomTom is out per the
T&C above); a live TomTom layer would require an owner decision on a paid Permitted-Solution license.

### Amenities / POIs — weekly OSM catalogue in PostGIS ✅ PICKED
- Commons/fair use (<https://dev.overpass-api.de/overpass-doc/en/preface/commons.html>, wiki):
  guideline ≈ "10,000 requests per day and … download volume below about 1 GB per day".
- Mirror: <https://overpass.kumi.systems/> — "free and unlimited access … trusts its users to
  share resources fairly" → configured fallback host.
- No key. One bounded, sequential-host, full-Bucharest `out geom` request runs weekly at
  Sunday 03:00 UTC, validates and atomically publishes into the isolated `osm_catalogue` schema.
  Runtime map selections perform no amenity Overpass request: the **reach rings of the selected
  travel mode** bound the query and PostGIS intersects them with the active point/polygon dataset.
  Since the amenity set follows the shaded area rather than a fixed short walk, the ring provider
  is mode-dependent — ORS `foot-walking` for walking, **MOTIS one-to-all for public transport**,
  ORS `driving-car` (traffic-adjusted) for driving — and the same cached ring response the map
  paints is reused, so a selection costs no extra upstream request. **A ring-provider failure
  fails the amenity request** (the UI offers a retry) rather than falling back to a walking ring:
  showing places for the wrong area would be a quieter, worse error than an honest retry. The last good snapshot survives
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
  community servers) but the real fair-use bound is the per-provider (`provider@host`) rate limiter + single-flight + TTL'd
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
  **Attribution obligation (not just OSM):** the Protomaps basemap bundles more than OpenStreetMap —
  **ESA WorldCover landcover under CC BY 4.0** (via Daylight; requires a visible credit + licence
  link + a "modified" indication), Natural Earth (public-domain), and the Mapzen/`tangrams/icons` POI
  sprite (MIT). These are shown by the map's attribution control (`src/features/map/map-setup.ts`) and
  in README; a tile-source or extent change (e.g. P4 all-Romania) must re-check them. The **glyph
  fonts and sprite** hot-linked from `protomaps.github.io/basemaps-assets` (`map-setup.ts` `glyphs`/
  `sprite`) are *referenced, not redistributed* today, so no notice obligation attaches — but the
  planned P5 "self-host the assets" step would make them redistributed, at which point their licences
  (the sprite's Mapzen MIT, and the fonts' own licence — confirm it then) must be carried too. Details
  + parked gaps (raw-archive metadata, exact ESA vintage) in `docs/SELFHOST.md` §Caveats.
  *Known gap (parked for M4):* font glyphs + sprite are still fetched by the browser from
  `protomaps.github.io/basemaps-assets` — keyless static files, so the constraint's key-safety
  intent holds, but the strict "all external calls happen server-side" reading does not yet;
  self-hosting them in `public/` is the M4 polish item (also removes a third-party availability
  dependency).

### Hosting — Railway (RETIRED 2026-08-29; launch target Hetzner VPS, €0 until launch) — cost note

> The Railway preview is retired (trial expired) and there is no live host today. The cost note
> below is kept as historical context; the launch decision is a self-managed Hetzner VPS.

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
| `ORS_API_KEY` | walking/car isochrones — **only when `ORS_BASE_URL` is the public default**; a self-hosted ORS is keyless (task 009) | yes — server only |
| (none) | Nominatim, Overpass, Open-Meteo, Transitous, tiles | keyless (UA/Referer set in code) |

> **Self-host provider knobs (task 009).** Beyond the `*_BASE_URL` / pool /
> extent vars (task 007), each provider's rate-limit spacing is tunable via
> `NOMINATIM_MIN_INTERVAL_MS` / `PHOTON_MIN_INTERVAL_MS` / `ORS_MIN_INTERVAL_MS` /
> `TRANSIT_MIN_INTERVAL_MS` / `OVERPASS_MIN_INTERVAL_MS` (default = each client's
> historical spacing — ToS-derived for Nominatim/ORS, conservative fair-use for
> Photon/Overpass/Transit; `0` disables throttling on a box you own — but a BELOW-default interval
> is rejected at startup, surfacing as an `/api/ready` 503, unless that provider's
> base/pool is off the public host, so a stray edit can't fair-use-ban the live
> deployment; the public-host check is a best-effort allowlist of the known
> defaults — another public mirror is operator responsibility), and `PROVIDER_DATA_REVISION`
> is an optional token folded into the cache namespace — bump it when you rebuild
> a self-hosted ORS/MOTIS graph from a newer OSM extract so stale rings aren't
> served (no auto-purge of the old generation yet — see `.env.example`). All
> default to today's behavior, so an unset environment is byte-identical.

## Action items arising

| # | Item | Status (2026-07-21) |
| --- | --- | --- |
| 1 | Transitous courtesy hello before heavy isochrone use | **Owner skipped** (accepted risk; still non-commercial, cached, Bucharest-only) |
| 2 | ORS free account → `ORS_API_KEY` (server-side) | **Done** (server-side key; no live prod today — deployment retired) |
| 3 | Hosting at launch | **Superseded** — owner ruling 2026-08-29: Hetzner VPS at launch, €0 until then; Railway trial expired/retired |
| 4 | Keep the GitHub repo public (Transitous open-source-client + portfolio) | **Done** — public at github.com/joitamihnea1999/HowFar |
