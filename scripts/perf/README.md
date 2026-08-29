# Mobile performance harness

Re-runnable measurement scripts for the HowFar map flow. **Measurement only — these scripts
never change app behavior.** They are isolated from the app: `scripts/perf/` has its own
`package.json` and its own (gitignored) `node_modules`, so installing them does **not** touch
the app's dependency tree or lockfile. The findings live in [`../../docs/PERF_AUDIT.md`](../../docs/PERF_AUDIT.md).

## One-time setup

```bash
cd scripts/perf
npm install           # lighthouse, puppeteer-core, chrome-launcher (isolated from the app)
```

Requires a Chrome/Chromium on the host (`google-chrome`) and, for real-device runs, `adb`.

## Serve the target (production build + self-host stack)

Perf numbers must be taken on the **production** build, not `next dev`. From the app root:

```bash
npm run build                       # once, after any code change
bash scripts/perf/serve-prod.sh     # brings up the self-host stack + `next start` on :3000
```

`serve-prod.sh` reuses the same provider overlay as `npm run dev:selfhost`, waits for the
engines to be healthy, then serves the optimized build. The amenity catalogue must be
imported (`/api/ready` → 200); if not, run `npm run amenities:refresh` first (with `.env`
loaded, e.g. `set -a; source .env; set +a; npm run amenities:refresh`).

## Run the measurements (emulated mid-range phone)

From `scripts/perf/`:

```bash
npm run lighthouse    # Lighthouse mobile (Moto G-class, Slow 4G): score, TTI, LCP, TBT, CLS
npm run bundle        # initial JS gz breakdown (MapLibre vs react vs app), critical vs lazy
npm run profile       # runtime profile of the 3 hot interactions + render-free check
npm run api           # API latency (cold/warm p50/p95) vs budgets
npm run all           # all of the above, then a combined summary
```

Each writes JSON to `results/` and prints a summary with pass/fail vs the owner budgets.

### Knobs (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PERF_URL` | `http://localhost:3000/` | target |
| `PERF_RUNS` | `5` | Lighthouse / trace repeats (median reported) |
| `PERF_API_SAMPLES` | `12` | samples per cold/warm cell |
| `PERF_DEVICE` | `emulated` | `emulated` (throttle here) or `real` (attach to a device) |
| `PERF_CDP_PORT` | `9222` | remote-debug port for real-device attach |
| `PERF_CPU_SLOWDOWN` | `4` | CPU throttle multiplier (emulated) |

## Re-measure on a real Android

The same scripts run against a real phone over Chrome remote debugging — no emulation is
applied (the device is the device). This is the authoritative re-measurement for every
`[EMU]` number in the audit.

1. On the phone: enable **Developer options → USB debugging**, connect USB, open Chrome.
2. On the host:
   ```bash
   adb devices                                                  # confirm the phone is listed
   adb reverse tcp:3000 tcp:3000                                # phone → host prod server
   adb forward tcp:9222 localabstract:chrome_devtools_remote    # host → phone Chrome
   ```
3. Run any measurement with `PERF_DEVICE=real` (and point `PERF_URL` at the reversed port):
   ```bash
   PERF_DEVICE=real PERF_URL=http://localhost:3000/ npm run lighthouse
   PERF_DEVICE=real npm run profile
   PERF_DEVICE=real npm run api
   ```

Re-take **TTI, Lighthouse score, LCP, TBT, CLS, and especially pan/zoom fps** — the emulator
runs on the CPU-throttled host with **software WebGL (SwiftShader)**, so it overstates the
paint/pan-zoom gap; a real device has a real GPU. Bundle size is device-independent.

> **⚠ `adb reverse` is a USB tunnel, not a cellular link.** With `adb reverse tcp:3000`, the
> phone reaches the host's server over USB — so the **rendering/CPU/GPU** numbers are real
> (this is the point), but the **API-latency** numbers over this path carry USB/local
> transport, NOT real 4G RTT. For a real-network API figure, put the phone on wifi/cellular
> and point `PERF_URL` at the host's routable IP (or apply device-side network shaping), and
> treat the adb-reverse API run as local-transport-only.

## Notes / gotchas

- `results/` and `node_modules/` are gitignored — only the scripts + this README are committed.
- Don't `pkill -f "headless=new"` — the pattern matches your own shell.
- Warm API numbers are ApiCache hits (~milliseconds); the meaningful budget comparison is
  the cold (first-touch) p95.
