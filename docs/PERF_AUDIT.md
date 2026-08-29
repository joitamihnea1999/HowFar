# Mobile performance audit — map flow

**Measurement only. No optimization changes were made in this audit** — the fixes are the
follow-up task; the gap list below is that task's work plan.

- **Date:** 2026-08-29
- **Build:** production (`next build`, Turbopack) served with `next start` (NOT `next dev`).
- **Providers:** local self-host stack (Nominatim / Photon / ORS / self-built pmtiles) via
  the `docker/selfhost` overlay; catalogue = **8,774 places** imported from Overpass.
- **Emulated device:** Lighthouse "mobile" preset — Moto G-class, **4× CPU** slowdown +
  **Slow 4G** (simulated). Runtime profile uses the same 4× CPU + 4G via CDP, median of 5
  runs, with **real touch gestures** (one-finger pan + two-finger pinch via CDP touch events).
- **⚠ WebGL renderer:** `SwiftShader` (software rasterization) — this measurement host has no
  GPU, so all WebGL is CPU-rendered. This **inflates GL-bound metrics**, the pan/zoom fps
  above all (and, more mildly, LCP/TBT). It is an additional confound stacked on the 4× CPU
  throttle. **A real Android has a real GPU**, so the on-device numbers will be materially
  better — real-device re-measurement is therefore **mandatory**, not advisory, for pan/zoom.
- **Tooling:** Lighthouse 12.8.2, puppeteer-core 24.43.1, chrome-launcher 1.2.1, Chrome 150.
- **Harness:** `scripts/perf/` (re-runnable; one command re-measures on a real Android — see
  §"Re-measure on a real device"). Raw results: `scripts/perf/results/*.json` (gitignored).

> **[EMU] = emulation-based.** Every number tagged `[EMU]` was taken on a throttled,
> **software-WebGL** desktop emulator and **must be re-measured on a real Android** before it
> is treated as the shipping number. The pan/zoom fps number is the most emulation-sensitive
> — it is hit by BOTH the 4× CPU throttle AND software rasterization, so treat 15 fps as a
> pessimistic floor, not the real-device figure. Bundle-size numbers are device-independent
> and firm; API-latency numbers are not device-emulated (still need real-network RTT added).

---

## Gap list vs owner budgets

| # | Budget | Measured | Verdict | Suspected cause | Proposed fix | Effort |
|---|--------|----------|---------|-----------------|--------------|--------|
| 1 | **TTI ≤ 2.5 s** (mid-range, 4G) | **7.72 s** `[EMU]` | ❌ FAIL (~3×) | 470 KB gz JS (mostly MapLibre) parsed + executed on the main thread before the map is interactive; MapLibre is eagerly loaded on first paint | Defer MapLibre off the critical path: `next/dynamic(AppMap, { ssr:false })` behind a lightweight map skeleton, so first interactive doesn't wait on the 327 KB engine chunk | **M** |
| 2 | **Initial JS ≤ 350 KB gz** (incl. MapLibre) | **470.7 KB gz** | ❌ FAIL (+34%) | MapLibre+pmtiles **327 KB gz** (statically imported), react-dom 70 KB, app+vendor 74 KB; **nothing lazy-loaded** | Same root fix as #1. **Caveat:** a naive `next/dynamic` that still renders the map immediately keeps MapLibre in the initial download (this audit counts everything fetched at `networkidle0` as "initial"), so the ~143 KB figure only holds if MapLibre is deferred behind a real boundary (idle/interaction/skeleton-then-hydrate) — the follow-up task must re-measure, not assume | **M** |
| 3 | **Lighthouse mobile ≥ 90** | **67** `[EMU]` | ❌ FAIL | Composite of #1/#2 — TBT **2386 ms** dominates the score (main-thread blocked by JS parse/exec) | Fixing #1/#2 lifts TBT and TTI together; expect the score to move most from the MapLibre-defer alone | **M** (same work as #1) |
| 4 | **Pan/zoom ≥ 55 fps median, no frame > 32 ms** | app-layers **15 fps [15–15]**; bare-basemap rough control **20 fps [20–24]**; worst frame (all runs) **150 ms** `[EMU, SOFTWARE-GL]` (touch pan+pinch, median of 5) | ❌ FAIL — but instrument-confounded, see cause | Two stacked confounds inflate this: **(a) software WebGL (SwiftShader)** — no GPU on the host, so every frame is CPU-rasterized; **(b) 4× CPU throttle**. **Even the bare basemap manages only ~20 fps under software GL — so the dominant cost is MapLibre's baseline raster, not the app layers.** (The 20→15 delta is only a rough indication of app-layer cost — the two gestures are at different camera/zoom/scene, not a controlled layer toggle — so don't over-read it.) Confirmed **not React** (0 commits every run — gesture vs idle commit RATE over matched windows; controllers keep gestures render-free ✓), **not DOM markers** (amenities are a GeoJSON GL layer), and the gesture provably moved the map (`window.__hfMap` center/zoom changed). Idle is a clean 60 fps | **Re-measure on a real device (real GPU) FIRST — with a real GPU even the bare basemap should jump, and this row may PASS outright.** App-layer simplification (rings/labels) is a secondary lever to weigh only if it still fails on-device | **Re-measure (S); app-layer simplification only a minor follow-on** |
| 5 | **API p95 — suggest ≤ 150 ms** | cold **167 ms** / warm 3 ms (n=30) | ❌ FAIL (marginal) | Photon cold tail just over budget (p50 31 ms — fine); warm is a cache hit. **At n=12 this read 393 ms — an undersampled outlier; the honest n=30 p95 is 167 ms.** **Open question:** cold uses partial 3–6 char prefixes (real typing) vs a full warm string — the tail may be prefix-search cost (broader index scan), orthogonal to JVM/cache warmth | Confirm the cause (prefix cost vs warmup) with server-side Photon timing before spending effort; low user impact (p50 fine, only 17 ms over) | **S** |
| 6 | **API p95 — geocode ≤ 300 ms** | cold **316 ms** / warm 2 ms (n=30) | ❌ FAIL (marginal) | Nominatim cold tail just over budget (p50 23 ms — fine). **At n=12 this read 149 ms / PASS — the small sample missed the tail; n=30 reveals a 316 ms p95.** A textbook case of the deeper-sampling lesson | Confirm with more samples / server-side Nominatim timing; low user impact (p50 fine, 16 ms over). Same warmup family as #5 | **S** |
| 7 | **API p95 — isochrone ≤ 800 ms** | cold **185 ms** / warm 2 ms (n=30) | ✅ PASS¹ | — | — | — |
| 8 | **API p95 — amenities ≤ 400 ms** | cold **905 ms** / warm 6 ms (n=30) | ❌ FAIL (2.3×) — robust | **Compound**, not pure PostGIS: on an amenities cache miss the endpoint first makes a cold ORS isochrone call (`clipRingsFor`→`walkingIsochrone`, ~185 ms cold, see #7) and only then runs the PostGIS spatial intersect of the reach polygon against **8,774 places**. So a large chunk (order ~½ s) is PostGIS, but the exact split can't be read by subtracting two independently-sampled p95s (percentiles don't subtract) — it needs server-side span timing | Add server-side spans to attribute ORS vs PostGIS precisely; then on the PostGIS term: `EXPLAIN ANALYZE`, verify the GiST index is used, simplify the reach polygon before the intersect, a `representativePoint` pre-filter, or cache per (mode,pace,cell). The shared cold-isochrone cost also argues for reusing the mode's already-computed rings | **M** |

¹ **PASS = single-request, serial, local-stack latency** — not load-tested. Under real concurrent multi-user load (or with real-network RTT added) these could differ; the follow-up work should not treat them as headroom-proven. All API p95 are nearest-rank over **n=30** (a real tail percentile, not the sample max that n=12 collapsed to). **Marginal caveat:** at n=30 the nearest-rank p95 is the 2nd-largest sample, so the two *narrowly*-failing rows — suggest (167 vs 150, +17 ms) and geocode (316 vs 300, +16 ms) — are borderline and could flip with more samples; confirm with n≥100 before the follow-up spends effort on them. amenities (905 vs 400) and the PASS rows are not borderline.

**Additional measured metrics (context, not owner budgets):**

| Metric | Measured | Note |
|--------|----------|------|
| LCP | 2368 ms `[EMU]` | Borderline (>2.5 s is "poor"); coupled to the JS-blocked main thread — the #1 fix should help |
| CLS | 0.098 `[EMU]` | ✅ under the 0.1 "good" threshold — no fix needed, monitor |
| FCP | 904 ms `[EMU]` | Good |
| Speed Index | 2349 ms `[EMU]` | — |
| API reverse | cold 38 ms / warm 3 ms (n=30) | ✅ (budget 300, treated as geocode sibling) |
| API car | cold 185 ms / warm 2 ms (n=30) | ✅ (budget 800, treated as isochrone sibling) |

---

## The single highest-leverage fix

Gaps **#1, #2, #3** (and much of LCP) are **one root cause**: MapLibre GL (327 KB gz) is on
the initial critical path and blocks the main thread. Deferring it off first-load — behind a
real idle/interaction boundary, not just a `next/dynamic` that renders immediately (see gap
#2's caveat) — should move all three budgets at once and is the recommended first move for
the follow-up task, which must **re-measure** rather than assume the projected numbers. Gaps
**#4** (pan/zoom — re-measure on real GPU first) and **#8** (amenities cold) are independent.

## Detail

### Bundle (initial / critical-path JS, gzipped)
- Total **470.7 KB gz** (raw 1704.7 KB). Budget 350 → **FAIL**.
- MapLibre+pmtiles **327.1 KB gz** — this is the gz size of the ONE chunk that contains
  MapLibre (attributed by signature-grep), i.e. the whole-chunk total, not a per-module figure;
  a small amount of co-bundled app code may ride in it. react-dom **69.6 KB** · app+vendor **74 KB**.
  The ~143 KB "after deferral" projection is therefore approximate (it assumes the whole
  MapLibre chunk moves off the critical path) and must be re-measured.
- **Lazy-loaded: 0 KB.** `d3-contour` is server-only (transit-grid contour math), so it is
  not in the client bundle. `@turf/boolean-point-in-polygon` **IS** pulled into the client via
  the transit reach-band helper (`src/features/map/reach.ts`), but it is tiny (a few KB) and
  folds into `app+vendor`; production minification mangles its name, so a name-grep can't spot
  it — presence is confirmed by the static import chain, not by the bucketer.
- Method: Turbopack (Next 16) prints no per-route sizes, so the ground truth is the JS the
  browser pulls over the wire (`transferSize` == gz), cross-checked against `gzip` of each
  on-disk chunk. They agree.

### Runtime profile (three hot interactions — median of 5 runs, real touch gestures)
- **Address select → ring reveal:** 17 React commits, ~680 ms main-thread long-task.
- **Mode toggle (walk→car):** 3 commits, ~2860 ms long-task (car ring render + amenity re-placement).
- **Pan/zoom (touch pan + pinch, app layers loaded):** 15 fps median [15–15 across runs],
  worst frame **150 ms (max across all 5 runs)**, **0 React commits every run**. The gesture is
  driven as real touch events at a fixed cadence (CDP `Input.dispatchTouchEvent`, decoupled
  from renderer ACK so a slow device doesn't get a slower gesture), exercising MapLibre's
  `Touch*` handlers — the real mobile path, not mouse/wheel. Each gesture is proven to have
  actually moved the map by reading `window.__hfMap` center/zoom before/after (sound; a pixel
  hash could be spoofed by background tile repaint). A run with too few frames or an unmoved
  camera is marked unreliable rather than scoring a false pass.
- **Bare-basemap rough control (no address selected):** 20 fps [20–24]. Even the bare basemap
  is far under 55 fps, so the dominant cost is MapLibre's baseline raster under software GL.
  (This is NOT a clean layer-isolation — the app-layer gesture is at a different camera/zoom
  and over different tiles — so the 20→15 delta indicates app layers aren't dominant, but is
  not a precise app-layer cost.) Fix framing: real GPU first; app-layer simplification secondary.
- **Idle baseline:** 60 fps, 0 commits, 0 ms long-task (window sized to match the gesture).
- **Render-free gesture claim: HOLDS** — pan/zoom's React commit RATE does not exceed idle's
  (0/s vs 0/s, matched-duration windows, every run). The frame-rate gap is MapLibre GL repaint
  under software-GL + CPU throttle, not re-renders.

### API latency (browser → local stack, **n=30** samples/cell, unthrottled)
- Cold = fresh unique ApiCache key per sample (real varied Bucharest inputs) → provider/PostGIS
  round trip. Warm = repeat → ApiCache hit. Budget compared against **cold p95** (first-touch),
  and only on a reliable cell (all 30 samples 2xx; the runner fails closed otherwise).
- **n=30 matters:** at n=12 the nearest-rank "p95" was just the single max sample — it read
  suggest as 393 ms (an outlier) and geocode as 149 ms/PASS (missing the tail). The n=30
  numbers (suggest 167, geocode 316) are true tail percentiles and flip geocode to FAIL.
- **Warm is 2–6 ms across the board** (ApiCache hits) — returning-user latency is a non-issue.
- **Real-device caveat:** these are local/unthrottled; a real phone on 4G adds real network RTT
  **per request** on top. Note the real-device harness path uses `adb reverse` (a USB tunnel),
  which is NOT a cellular link — see the README for how to take a real-network number.
- **amenities worst-case caveat:** the amenities cold number pays a cold ORS isochrone, but in
  the real user flow the isochrone is already computed (mode selected → rings drawn) before the
  amenities call, so a returning-to-that-origin user pays closer to the PostGIS-only portion.
  The 905 ms is the true cold-cold worst case (fresh origin), not the typical in-session cost.
- Transit / reach are **excluded**: not self-hosted (MOTIS/GTFS gate), they hit the public
  network under the overlay, so their latency is not a property of the local stack.

---

## Re-measure on a real device

The harness re-runs unchanged against a real Android over Chrome remote debugging — one
command per metric. See `scripts/perf/README.md` for the full runbook. In short:

```bash
# On the phone: enable USB debugging, open Chrome, then on the host:
adb reverse tcp:3000 tcp:3000          # phone reaches the host's prod server
adb forward tcp:9222 localabstract:chrome_devtools_remote   # host reaches the phone's Chrome
# then, from scripts/perf/ (deps installed once with `npm install`):
PERF_DEVICE=real PERF_URL=http://localhost:3000/ npm run lighthouse
PERF_DEVICE=real npm run profile
PERF_DEVICE=real npm run api          # add real-network RTT context
```

Numbers to re-take on-device (all `[EMU]` rows): **TTI, Lighthouse score, LCP, TBT, CLS,
and pan/zoom fps** (most important — the emulator's 4× CPU throttle likely overstates the
gap). Bundle size is device-independent (firm as measured). API latency should be re-taken
over a real radio to capture network RTT.

## What measurement could not settle (for the follow-up task)
- Whether pan/zoom actually fails on real hardware, or only under the software-GL + 4× CPU
  emulator. **This is the biggest open question** — the 15 fps was measured with software
  rasterization (no GPU on the host), so a real-GPU device could pass outright.
- The amenities query plan — needs `EXPLAIN ANALYZE` on the live PostGIS to name the exact
  PostGIS cost after subtracting the cold-isochrone term (~180 ms).
- The Photon cold-tail cause behind the suggest p95 spike — prefix-search cost vs JVM/cache
  warmup (p50 is fine either way).
- Whether the projected MapLibre-defer bundle/TTI wins hold — depends on a real deferral
  boundary, and must be re-measured, not assumed.
- Load behavior: all API numbers are single-request/serial; concurrent multi-user latency is
  out of scope here.
