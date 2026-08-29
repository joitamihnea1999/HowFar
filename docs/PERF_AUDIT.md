# Mobile performance audit — map flow

**Measurement only. No optimization changes were made in this audit** — the fixes are the
follow-up task; the gap list below is that task's work plan.

- **Date:** 2026-08-29
- **Build:** production (`next build`, Turbopack) served with `next start` (NOT `next dev`).
- **Providers:** local self-host stack (Nominatim / Photon / ORS / self-built pmtiles) via
  the `docker/selfhost` overlay; catalogue = **8,774 places** imported from Overpass.
- **Emulated device:** Lighthouse "mobile" preset — Moto G-class, **4× CPU** slowdown +
  **Slow 4G** (simulated). Runtime profile uses the same 4× CPU + 4G via CDP.
- **Tooling:** Lighthouse 12.8.2, puppeteer-core 24.43.1, chrome-launcher 1.2.1, Chrome 150.
- **Harness:** `scripts/perf/` (re-runnable; one command re-measures on a real Android — see
  §"Re-measure on a real device"). Raw results: `scripts/perf/results/*.json`.

> **[EMU] = emulation-based.** Every number tagged `[EMU]` was taken on a throttled
> desktop emulator and **must be re-measured on a real Android** before it is treated as the
> shipping number. The pan/zoom fps number is the most emulation-sensitive (the 4× CPU
> throttle dominates it); the bundle-size and API-latency numbers are not device-emulated and
> are firm (API latency still needs real-network RTT added — see its note).

---

## Gap list vs owner budgets

| # | Budget | Measured | Verdict | Suspected cause | Proposed fix | Effort |
|---|--------|----------|---------|-----------------|--------------|--------|
| 1 | **TTI ≤ 2.5 s** (mid-range, 4G) | **7.72 s** `[EMU]` | ❌ FAIL (~3×) | 470 KB gz JS (mostly MapLibre) parsed + executed on the main thread before the map is interactive; MapLibre is eagerly loaded on first paint | Defer MapLibre off the critical path: `next/dynamic(AppMap, { ssr:false })` behind a lightweight map skeleton, so first interactive doesn't wait on the 327 KB engine chunk | **M** |
| 2 | **Initial JS ≤ 350 KB gz** (incl. MapLibre) | **470.7 KB gz** | ❌ FAIL (+34%) | MapLibre+pmtiles **327 KB gz** (statically imported), react-dom 70 KB, app+vendor 74 KB; **nothing lazy-loaded** | Same root fix as #1 (lazy MapLibre → initial ≈ 143 KB gz). Optionally route-split the amenity/reach controllers | **M** |
| 3 | **Lighthouse mobile ≥ 90** | **67** `[EMU]` | ❌ FAIL | Composite of #1/#2 — TBT **2386 ms** dominates the score (main-thread blocked by JS parse/exec) | Fixing #1/#2 lifts TBT and TTI together; expect the score to move most from the MapLibre-defer alone | **M** (same work as #1) |
| 4 | **Pan/zoom ≥ 55 fps median, no frame > 32 ms** | **20 fps median, worst 83 ms** `[EMU]` | ❌ FAIL | MapLibre **GL scene repaint** (ring fill/line + amenity symbol/label layers) under the 4× CPU throttle. **Not React** (0 commits during the gesture — the controller architecture keeps gestures render-free ✓) and **not DOM markers** (amenities are a GeoJSON GL layer). Idle is a clean 60 fps | **Re-measure on a real device FIRST** — the 4× throttle likely explains most of the gap. If it still fails on-device: reduce per-frame GL work (simplify ring geometry / label density, `symbol-sort-key`, cap amenity symbols by zoom) | **Re-measure (S), then L if needed** |
| 5 | **API p95 — suggest ≤ 150 ms** | cold **393 ms** / warm 4 ms | ❌ FAIL (tail) | Photon cold-query **tail** spikes (p50 is 52 ms — fine); warm is a cache hit | Investigate Photon cold tail (JVM/query warmup); consider a tiny server-side prefetch/warm on first keystroke. Low user impact (p50 fine) | **S/M** |
| 6 | **API p95 — geocode ≤ 300 ms** | cold **149 ms** / warm 2 ms | ✅ PASS | — | — | — |
| 7 | **API p95 — isochrone ≤ 800 ms** | cold **183 ms** / warm 3 ms | ✅ PASS | — | — | — |
| 8 | **API p95 — amenities ≤ 400 ms** | cold **865 ms** / warm 6 ms | ❌ FAIL (2.2×) | PostGIS spatial intersect of the reach polygon against **8,774 places**, cold (p50 already 795 ms) | `EXPLAIN ANALYZE` the query; verify the GiST index is used; consider simplifying the reach polygon before the intersect, a `representativePoint` pre-filter, or caching per (mode,pace,cell) | **M** |

**Additional measured metrics (context, not owner budgets):**

| Metric | Measured | Note |
|--------|----------|------|
| LCP | 2368 ms `[EMU]` | Borderline (>2.5 s is "poor"); coupled to the JS-blocked main thread — the #1 fix should help |
| CLS | 0.098 `[EMU]` | ✅ under the 0.1 "good" threshold — no fix needed, monitor |
| FCP | 904 ms `[EMU]` | Good |
| Speed Index | 2349 ms `[EMU]` | — |
| API reverse | cold 48 ms / warm 3 ms | ✅ (budget 300, treated as geocode sibling) |
| API car | cold 188 ms / warm 2 ms | ✅ (budget 800, treated as isochrone sibling) |

---

## The single highest-leverage fix

Gaps **#1, #2, #3** (and much of LCP) are **one root cause**: MapLibre GL (327 KB gz) is on
the initial critical path and blocks the main thread. Deferring it off first-load — a dynamic
import of the map with a skeleton — is expected to move all three budgets at once and is the
recommended first move for the follow-up task. Gaps **#4** (pan/zoom) and **#8** (amenities
cold) are independent and each needs its own investigation.

## Detail

### Bundle (initial / critical-path JS, gzipped)
- Total **470.7 KB gz** (raw 1704.7 KB). Budget 350 → **FAIL**.
- MapLibre+pmtiles **327.1 KB gz** (one 1.20 MB-raw chunk) · react-dom **69.6 KB** · app+vendor **74 KB**.
- **Lazy-loaded: 0 KB.** turf & d3-contour are **absent** from the client bundle (isochrone
  geometry is computed server-side in `server/` modules) — correct, no client cost.
- Method: Turbopack (Next 16) prints no per-route sizes, so the ground truth is the JS the
  browser pulls over the wire (`transferSize` == gz), cross-checked against `gzip` of each
  on-disk chunk. They agree.

### Runtime profile (three hot interactions)
- **Address select → ring reveal:** 17 React commits, 517 ms main-thread long-task.
- **Mode toggle (walk→car):** 3 commits, 3018 ms long-task (car ring render + amenity re-placement).
- **Pan/zoom:** 20 fps median, worst frame 83 ms, 44/84 frames > 32 ms, **0 React commits**.
- **Idle baseline:** 60 fps, 0 commits, 0 ms long-task.
- **Render-free gesture claim: HOLDS** — pan/zoom adds no React commits over idle (0 == 0).
  The frame-rate gap is MapLibre GL repaint under the CPU throttle, not re-renders.

### API latency (browser → local stack, 12 samples/cell, unthrottled)
- Cold = fresh ApiCache key (real varied Bucharest inputs) → provider/PostGIS round trip.
  Warm = repeat → ApiCache hit. Budget compared against **cold p95** (first-touch).
- **Warm is 2–6 ms across the board** (ApiCache hits) — returning-user latency is a non-issue.
- **Real-device caveat:** these are local/unthrottled; a real phone on 4G adds ~50–150 ms
  network RTT **per request** on top — which alone would push suggest/geocode/reverse near
  their budgets. Re-measure on-device.
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
- Whether pan/zoom actually fails on real hardware, or only under the 4× emulator throttle.
- The amenities query plan — needs `EXPLAIN ANALYZE` on the live PostGIS to name the exact cost.
- The Photon cold-tail cause behind the suggest p95 spike (p50 is fine).
