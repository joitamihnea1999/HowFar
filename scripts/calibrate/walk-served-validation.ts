/**
 * SERVED walk-range validation (dev-only, network) — the phone-first preset.
 *
 * The walk calibration was FIT at the 80 m/min measurement anchor
 * (`reach-calibration.ts`), but the app SERVES the pace-rescaled ranges
 * (`walkPresetRangeS(min, pace)` — normal 10min = 546 s, not the 524 s anchor). The
 * SHIPPED artifact must be measured directly, at the short
 * minute where ORS generosity is largest, on a sample the fit never saw. This does
 * exactly that, WITHOUT re-fitting (it never touches the calibrated constants — a
 * fresh fit could drift them and is out of scope; this only CONFIRMS them):
 *
 *   - requests ORS foot-walking at the EXACT served `normal`-pace ranges
 *     [546,1135,2159] (= walkPresetRangeS(10/20/40, "normal"));
 *   - measures the MOTIS one-to-many street-distance ruler to the boundary, then
 *     divides by the NORMAL PACE speed (5 km/h) — so "minutes" is normal-walk
 *     minutes, the number the label promises (NOT anchor-minutes ÷80);
 *   - uses a FRESH bearing set (offset 15° from the fit's) AND a 4th origin
 *     (Militari, west) the fit/confirm never used — a truly-untouched sample;
 *   - applies the same hardened coverage + pre-declared per-origin bar as the fit
 *     harness (served presets 10/20; 40 is the transit-union helper, recorded).
 *
 * USAGE:  npx tsx --env-file=.env scripts/calibrate/walk-served-validation.ts
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  campaignExitCode,
  coverageShortfalls,
  perOriginFailures,
  type CoverageCell,
  type OriginTargetRate,
} from "@/features/isochrones/calibration-acceptance";
import { PACE_MODEL } from "@/features/isochrones/pace";
import { walkPresetRangeS } from "@/features/isochrones/preset-reach";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const ORS_BASE = "https://api.openrouteservice.org";
const TRANSIT_BASE = "https://api.transitous.org";
const USER_AGENT = "HowFar-reach-calibration/1.0 (contact: mihnea.joita@punct.ro)";
const SPACING_MS = 2100;
const TOL_MIN = 5;
const NORMAL_SPEED = PACE_MODEL.normal.speedMPerMin; // 5 km/h = 83.33 m/min — the served pace

/** 3 fit origins + a 4th UNTOUCHED origin (Militari, west) for a recorded precondition. */
const ORIGINS = [
  { name: "Unirii", lat: 44.4268, lng: 26.1025 },
  { name: "Grozavesti", lat: 44.443, lng: 26.06 },
  { name: "Berceni", lat: 44.383, lng: 26.123 },
  { name: "Militari", lat: 44.4319, lng: 26.0206 }, // fresh 4th origin (west), never in the fit
];
/** Served preset minutes to request (normal pace). 10/20 = served chips; 40 = the
 *  transit-union helper (recorded, not a served walk reach). */
const SERVED_WALK_MIN = [10, 20];
const ALL_MIN = [10, 20, 40];
/** FRESH bearings, offset 15° from the fit harness's 0/30/60… set — a sample the
 *  fit/confirm never measured. */
const BEARINGS = Array.from({ length: 12 }, (_, i) => 15 + (i * 360) / 12);
const MANY_CAP = 128;
const RESIDUAL_TOLERANCE = 0.1;

const R_EARTH = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;
function destPoint(lat: number, lng: number, bearingDeg: number, distM: number): [number, number] {
  const b = toRad(bearingDeg);
  const dLat = (distM * Math.cos(b)) / R_EARTH;
  const dLng = (distM * Math.sin(b)) / (R_EARTH * Math.cos(toRad(lat)));
  return [lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI];
}
function pointInRing(pt: [number, number], ring: number[][]): boolean {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!, xj = ring[j]![0]!, yj = ring[j]![1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** point ∈ one polygon = inside its exterior ring AND outside every hole. */
function pointInPolygon(pt: [number, number], poly: number[][][]): boolean {
  if (!pointInRing(pt, poly[0]!)) return false;
  for (let h = 1; h < poly.length; h++) if (pointInRing(pt, poly[h]!)) return false;
  return true;
}
/** point ∈ the WHOLE reach geometry — every MultiPolygon component + holes, not
 *  just the origin-containing shell. A ray must see a detached lobe across a river. */
function pointInGeometry(pt: [number, number], geom: { type: string; coordinates: unknown }): boolean {
  if (geom.type === "Polygon") return pointInPolygon(pt, geom.coordinates as number[][][]);
  for (const poly of geom.coordinates as number[][][][]) if (pointInPolygon(pt, poly)) return true;
  return false;
}
/** Farthest-inside point along a bearing (up to MAX), sampling the WHOLE geometry —
 *  it does NOT break at the first exit crossing (a notch then an outer lobe past a
 *  barrier is exactly the geometry we must catch), so the returned point is the
 *  OUTERMOST reachable one, which is where an over-claim actually lives. `truncated`
 *  = the ray was still inside at MAX (the boundary is beyond the probe — a coverage
 *  gap, never a silently-shortened boundary). */
function boundaryPointAtBearing(
  lat: number,
  lng: number,
  geom: { type: string; coordinates: unknown },
  b: number,
): { pt: [number, number]; truncated: boolean } | null {
  const STEP = 20, MAX = 8000;
  let last: [number, number] | null = null;
  let truncated = false;
  for (let d = STEP; d <= MAX; d += STEP) {
    const p = destPoint(lat, lng, b, d);
    if (pointInGeometry(p, geom)) {
      last = p;
      if (d + STEP > MAX) truncated = true; // still inside at the probe limit
    }
  }
  return last ? { pt: last, truncated } : null;
}
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

let lastCallAt = 0;
async function paced() {
  const wait = SPACING_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}
function orsKey(): string {
  if (process.env.ORS_API_KEY) return process.env.ORS_API_KEY;
  const env = readFileSync(join(REPO, ".env"), "utf8");
  return env.match(/^ORS_API_KEY=(.*)$/m)![1]!.trim().replace(/^["']|["']$/g, "");
}
const KEY = orsKey();

async function orsWalk(lat: number, lng: number, rangesS: number[]) {
  await paced();
  const res = await fetch(`${ORS_BASE}/v2/isochrones/foot-walking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: KEY, "User-Agent": USER_AGENT },
    body: JSON.stringify({ locations: [[lng, lat]], range: rangesS }),
  });
  if (!res.ok) throw new Error(`ORS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { features?: { properties?: { value?: number }; geometry?: { type: string; coordinates: unknown } }[] };
  const out = new Map<number, { type: string; coordinates: unknown }>();
  for (const f of body.features ?? []) if (typeof f.properties?.value === "number" && f.geometry) out.set(f.properties.value, f.geometry);
  return out;
}
async function rulerDistances(origin: [number, number], targets: [number, number][]): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (let i = 0; i < targets.length; i += MANY_CAP) {
    const chunk = targets.slice(i, i + MANY_CAP);
    await paced();
    const many = chunk.map(([lng, lat]) => `${lat};${lng}`).join(",");
    const url =
      `${TRANSIT_BASE}/api/v1/one-to-many?one=${origin[1]};${origin[0]}&many=${many}` +
      `&mode=WALK&max=7200&maxMatchingDistance=250&arriveBy=false&withDistance=true`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`one-to-many ${res.status}`);
    const rows = (await res.json()) as ({ distance?: number } | null)[];
    for (let k = 0; k < chunk.length; k++) {
      const d = rows[k]?.distance;
      out.push(typeof d === "number" && d > 0 ? d : null);
    }
  }
  return out;
}

function claimRate(streetMins: number[], target: number): OriginTargetRate {
  const n = streetMins.length;
  const over = streetMins.filter((m) => m > target + TOL_MIN).length;
  const maxOverMin = streetMins.reduce((m, s) => Math.max(m, s - target), 0);
  return { n, medMin: median(streetMins), overRate: n ? over / n : 0, maxOverMin };
}

async function main(): Promise<number> {
  const receiptDir = join(HERE, "receipts");
  mkdirSync(receiptDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const logPath = join(receiptDir, `walk-served-${stamp}.log`);
  const log = (s: string) => { process.stdout.write(s + "\n"); appendFileSync(logPath, s + "\n"); };
  log(`# SERVED walk-range validation (normal pace) — ${new Date().toISOString()}`);
  const ranges = ALL_MIN.map((m) => walkPresetRangeS(m, "normal"));
  log(`# served normal ranges: ${ALL_MIN.map((m, i) => `${m}min=${ranges[i]}s`).join(" ")}  (÷ ${NORMAL_SPEED.toFixed(2)} m/min normal speed)`);
  log(`# fresh bearings (offset 15°): ${BEARINGS.map((b) => b.toFixed(0)).join(",")}  origins incl. untouched 4th (Militari)`);

  const receipt: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    method: "ORS foot-walking at the SERVED normal-pace ranges; MOTIS one-to-many withDistance street distance ÷ normal pace speed (5 km/h); fresh bearings + 4th untouched origin",
    servedRangesS: Object.fromEntries(ALL_MIN.map((m, i) => [m, ranges[i]])),
    normalSpeedMPerMin: NORMAL_SPEED,
    origins: ORIGINS,
    bearings: BEARINGS,
    perOrigin: {},
  };

  const coverageCells: CoverageCell[] = [];
  const perOriginRates: Record<number, Record<string, OriginTargetRate>> = {};
  for (const m of ALL_MIN) perOriginRates[m] = {};

  for (const origin of ORIGINS) {
    log(`\n## ${origin.name} (${origin.lat},${origin.lng})`);
    const geoms = await orsWalk(origin.lat, origin.lng, ranges);
    const flat: { minute: number; pt: [number, number] }[] = [];
    for (let i = 0; i < ALL_MIN.length; i++) {
      const geom = geoms.get(ranges[i]!);
      if (!geom) { log(`  range ${ranges[i]}s (${ALL_MIN[i]}min): NO geometry`); continue; }
      for (const b of BEARINGS) {
        const bp = boundaryPointAtBearing(origin.lat, origin.lng, geom, b);
        // A truncated ray (still inside at MAX) is NOT a boundary sample — drop it so
        // the coverage check flags the missing cell instead of measuring a short point.
        if (bp && !bp.truncated) flat.push({ minute: ALL_MIN[i]!, pt: bp.pt });
      }
    }
    const dists = await rulerDistances([origin.lng, origin.lat], flat.map((f) => f.pt));
    const byMinute: Record<number, number[]> = {};
    for (const m of ALL_MIN) byMinute[m] = [];
    flat.forEach((f, i) => { const d = dists[i]; if (d != null) byMinute[f.minute]!.push(d / NORMAL_SPEED); });
    const perMin: Record<string, unknown> = {};
    for (const m of ALL_MIN) {
      const r = claimRate(byMinute[m]!, m);
      perOriginRates[m]![origin.name] = r;
      coverageCells.push({ origin: origin.name, target: m, n: r.n });
      perMin[m] = r;
      log(`  ${m}min (${walkPresetRangeS(m, "normal")}s): median ${r.medMin.toFixed(1)} normal-min  over(>T+${TOL_MIN}) ${(r.overRate * 100).toFixed(0)}%  maxOver +${r.maxOverMin.toFixed(1)}  (n=${r.n})`);
    }
    (receipt.perOrigin as Record<string, unknown>)[origin.name] = perMin;
  }

  // Coverage: every (origin, minute) cell must carry all BEARINGS samples.
  const coverageGaps = coverageShortfalls(coverageCells, BEARINGS.length);
  for (const g of coverageGaps) log(`  ✗ COVERAGE ${g}`);
  // Pre-declared bar for the SERVED chips (10,20): median ±10%, over-claim ≤10%,
  // magnitude ceiling +8min (a served walk reach must not overstate by more than
  // ~8 real-walk min at any origin — barrier tails included). 40 recorded only.
  const bar = { medTolerance: RESIDUAL_TOLERANCE, overRateBar: 0.1, maxOverMinCeil: 8 };
  let servedFailures = 0;
  for (const m of SERVED_WALK_MIN) {
    for (const f of perOriginFailures(m, perOriginRates[m]!, bar)) {
      servedFailures++;
      log(`  ✗ SERVED ${m}min @ ${f.origin}: ${f.reason}`);
    }
  }
  const coverageOk = coverageGaps.length === 0;
  receipt.perOriginBar = bar;
  receipt.coverageGaps = coverageGaps;
  receipt.servedWalkFailures = servedFailures;
  receipt.walk40Recorded = perOriginRates[40];

  const receiptPath = join(receiptDir, `walk-served-${stamp}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  const exit = campaignExitCode(coverageOk, servedFailures);
  log(`\n${exit === 0 ? "PASS" : "FAILED"} — coverage ${coverageOk ? "complete" : `INCOMPLETE (${coverageGaps.length})`}, served-walk per-origin failures ${servedFailures} — receipt: ${receiptPath}`);
  return exit;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
