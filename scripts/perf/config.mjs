// Shared configuration for the HowFar mobile performance harness.
//
// Everything device- or target-specific lives here so the individual runners stay
// declarative. Overridable by env so the SAME scripts re-run against a real Android
// (see README "Re-measure on a real device"): set PERF_URL / PERF_CDP_PORT / PERF_DEVICE.

export const TARGET_URL = process.env.PERF_URL ?? "http://localhost:3000/";
export const ORIGIN = new URL(TARGET_URL).origin;

// "emulated" = Chrome device emulation on this dev box (CPU + network throttled to a
// mid-range phone on 4G). "real" = drive a real Android over its remote-debugging port
// (adb-forwarded); no emulation applied because the device IS the device.
export const DEVICE = process.env.PERF_DEVICE ?? "emulated";
export const IS_REAL_DEVICE = DEVICE === "real";

// When measuring a real device we ATTACH to the Chrome already running on it, reached at
// this port after `adb forward tcp:9222 localabstract:chrome_devtools_remote`.
export const CDP_PORT = Number(process.env.PERF_CDP_PORT ?? 9222);

// Number of repeats for any metric we report as a median (Lighthouse, interaction traces).
// Perf numbers are noisy; a single shot is not evidence. Median of N.
export const RUNS = Number(process.env.PERF_RUNS ?? 5);

// Mid-range-phone emulation. These are Lighthouse's own "mobile" preset numbers (Moto
// G-class): 4x CPU slowdown + a throttled 4G link. We reuse the exact same constants for
// the puppeteer-driven runtime profile so Lighthouse and the interaction traces describe
// the SAME simulated device. Source: lighthouse/core/config/constants.js (mobileSlow4G).
export const CPU_SLOWDOWN = Number(process.env.PERF_CPU_SLOWDOWN ?? 4);
export const NETWORK_4G = {
  // Lighthouse "Slow 4G" (a.k.a. mobileSlow4G devtools throttling).
  downloadThroughputBps: Math.floor((1.6 * 1024 * 1024) / 8), // ~1.6 Mbit/s
  uploadThroughputBps: Math.floor((0.75 * 1024 * 1024) / 8), // ~750 Kbit/s
  latencyMs: 150,
};

// Viewport for the emulated phone (Moto G Power-ish, matches Lighthouse mobile).
export const MOBILE_VIEWPORT = { width: 412, height: 823, deviceScaleFactor: 1.75, mobile: true };

// A real, in-launch-area Bucharest address used for the "address select" interaction and
// as the origin for API-latency probes. Piata Unirii — dead centre, always geocodes.
export const TEST_ADDRESS = "Piata Unirii Bucuresti";
export const TEST_ORIGIN = { lat: 44.4268, lng: 26.1025 };

// Self-hosted endpoints whose latency we measure from the browser. Transit + reach are
// deliberately EXCLUDED: they are NOT self-hosted (MOTIS/GTFS gate) and hit the public
// network under the overlay, so their latency is not a property of the local stack.
// `cold` jitters the origin so each sample is a fresh ApiCache key (provider round-trip);
// `warm` repeats the identical URL (ApiCache hit). Budgets are the owner's p95 targets.
// Real, varied Bucharest inputs so each COLD sample is a distinct ApiCache key AND a valid
// query that exercises the real provider path (not a 404 on gibberish). We cycle a fixed
// list + a small coord jitter, so cold is representative first-touch latency, not error-path.
const COLD_STREETS = [
  "Bulevardul Magheru", "Calea Victoriei", "Strada Lipscani", "Bulevardul Unirii",
  "Calea Dorobanti", "Strada Batistei", "Bulevardul Dacia", "Strada Franceza",
  "Calea Mosilor", "Bulevardul Carol I", "Strada Doamnei", "Calea Grivitei",
  "Strada Academiei", "Bulevardul Kogalniceanu", "Piata Romana", "Piata Victoriei",
];
const COLD_SUGGEST = ["Magh", "Victor", "Dorob", "Unir", "Lips", "Bati", "Franc", "Mosil", "Grivi", "Acade", "Roma", "Carol"];

export function endpointProbes({ lat, lng } = TEST_ORIGIN) {
  const j = (n) => (n + (Math.random() - 0.5) * 0.02).toFixed(6); // ~±1km jitter for cold keys
  let si = 0;
  let gi = 0;
  return [
    { key: "suggest", budgetMs: 150, warm: `/api/suggest?q=Piata+Unirii`, cold: () => `/api/suggest?q=${encodeURIComponent(COLD_SUGGEST[si++ % COLD_SUGGEST.length])}` },
    { key: "geocode", budgetMs: 300, warm: `/api/geocode?q=${encodeURIComponent(TEST_ADDRESS)}`, cold: () => `/api/geocode?q=${encodeURIComponent(COLD_STREETS[gi++ % COLD_STREETS.length] + " Bucuresti")}` },
    { key: "reverse", budgetMs: 300, warm: `/api/reverse?lat=${lat}&lng=${lng}`, cold: () => `/api/reverse?lat=${j(lat)}&lng=${j(lng)}` },
    { key: "isochrone", budgetMs: 800, warm: `/api/isochrone?lat=${lat}&lng=${lng}&pace=normal`, cold: () => `/api/isochrone?lat=${j(lat)}&lng=${j(lng)}&pace=normal` },
    { key: "car", budgetMs: 800, warm: `/api/car?lat=${lat}&lng=${lng}`, cold: () => `/api/car?lat=${j(lat)}&lng=${j(lng)}` },
    { key: "amenities", budgetMs: 400, warm: `/api/amenities?lat=${lat}&lng=${lng}&pace=normal&mode=walk`, cold: () => `/api/amenities?lat=${j(lat)}&lng=${j(lng)}&pace=normal&mode=walk` },
  ];
}

// Owner budgets (the gap list is measured against these). Kept here so every runner and
// the report generator read one source of truth.
export const BUDGETS = {
  ttiMs: 2500,
  panZoomMedianFps: 55,
  panZoomMaxFrameMs: 32,
  initialJsGzKB: 350, // includes MapLibre
  lighthouseMobile: 90,
  api: { suggest: 150, geocode: 300, isochrone: 800, amenities: 400, car: 800, reverse: 300 },
};

export function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function percentile(xs, p) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)];
}
