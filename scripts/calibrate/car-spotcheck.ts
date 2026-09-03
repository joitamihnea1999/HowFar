/**
 * CAR preset free-flow spot-check (dev-only, network).
 *
 * The car preset serves nested contours at 10/25 min. `carPresetRangeSetS(25)` =
 * [600, 1500] s NOMINAL FREE-FLOW ranges (minutes×60); the congestion factor is
 * applied DOWNSTREAM in serving (`car-traffic.ts`, unchanged from task 058), which
 * only SHRINKS the served reach below free-flow. So if the nominal free-flow reach
 * is accurate-to-conservative vs an independent ruler, the SERVED reach is at least
 * as conservative. This spot-check verifies exactly that on the shipped free-flow
 * ranges (rule 13 — measure the artifact, don't assert by inheritance from 056/058):
 *
 *   - requests the ORS driving-car isochrone at the shipped free-flow [600,1500] s;
 *   - samples the boundary at 8 bearings per contour;
 *   - queries the public OSRM `driving` ruler (origin → boundary point) — the same
 *     independent car ruler the task-056 audit used — and reports the OSRM-measured
 *     drive minutes at each ORS boundary point.
 *
 * A boundary point that OSRM says takes ~T min (or MORE) to drive to is accurate or
 * conservative; one OSRM says is much CLOSER than T min would be an over-claim.
 *
 * USAGE:  npx tsx --env-file=.env scripts/calibrate/car-spotcheck.ts
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { carPresetRangeSetS, CAR_PRESET_MIN } from "@/features/isochrones/preset-reach";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const ORS_BASE = "https://api.openrouteservice.org";
const OSRM_BASE = "https://router.project-osrm.org";
const USER_AGENT = "HowFar-reach-calibration/1.0 (contact: mihnea.joita@punct.ro)";
const ORS_SPACING_MS = 2100;
const OSRM_SPACING_MS = 1100;

/** ≥3 diverse origins (central + two opposite edges) — the task's declared
 *  instrument bar. A car free-flow spot-check, not the full walk/transit campaign. */
const ORIGINS = [
  { name: "Unirii", lat: 44.4268, lng: 26.1025 },
  { name: "Berceni", lat: 44.383, lng: 26.123 },
  { name: "Militari", lat: 44.4319, lng: 26.0206 }, // west, near the A1 / western rail corridor
];
const CAR_MIN = [...CAR_PRESET_MIN]; // [10, 25]
const RANGES_S = carPresetRangeSetS(25); // [600, 1500] free-flow nominal
const BEARINGS = Array.from({ length: 8 }, (_, i) => (i * 360) / 8);

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
/** point ∈ the WHOLE reach geometry — every MultiPolygon component + holes. */
function pointInGeometry(pt: [number, number], geom: { type: string; coordinates: unknown }): boolean {
  if (geom.type === "Polygon") return pointInPolygon(pt, geom.coordinates as number[][][]);
  for (const poly of geom.coordinates as number[][][][]) if (pointInPolygon(pt, poly)) return true;
  return false;
}
/** Farthest-inside point along a bearing (up to MAX), whole-geometry, no break at
 *  the first exit — the OUTERMOST reachable point is where an over-claim lives.
 *  `truncated` = still inside at MAX (a 25-min free-flow drive on the A1/DN can run
 *  past the probe): reported as a coverage gap, never a silently-shortened boundary. */
function boundaryPointAtBearing(
  lat: number,
  lng: number,
  geom: { type: string; coordinates: unknown },
  b: number,
): { pt: [number, number]; truncated: boolean } | null {
  const STEP = 40, MAX = 60_000;
  let last: [number, number] | null = null;
  let truncated = false;
  for (let d = STEP; d <= MAX; d += STEP) {
    const p = destPoint(lat, lng, b, d);
    if (pointInGeometry(p, geom)) {
      last = p;
      if (d + STEP > MAX) truncated = true;
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

let lastOrsAt = 0, lastOsrmAt = 0;
async function pace(which: "ors" | "osrm") {
  const spacing = which === "ors" ? ORS_SPACING_MS : OSRM_SPACING_MS;
  const last = which === "ors" ? lastOrsAt : lastOsrmAt;
  const wait = spacing - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (which === "ors") lastOrsAt = Date.now();
  else lastOsrmAt = Date.now();
}
function orsKey(): string {
  if (process.env.ORS_API_KEY) return process.env.ORS_API_KEY;
  const env = readFileSync(join(REPO, ".env"), "utf8");
  return env.match(/^ORS_API_KEY=(.*)$/m)![1]!.trim().replace(/^["']|["']$/g, "");
}
const KEY = orsKey();

async function orsCar(lat: number, lng: number, rangesS: number[]) {
  await pace("ors");
  const res = await fetch(`${ORS_BASE}/v2/isochrones/driving-car`, {
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
/** OSRM driving duration (minutes) origin → target, or null if unroutable. */
async function osrmDriveMin(origin: [number, number], target: [number, number]): Promise<number | null> {
  await pace("osrm");
  const url = `${OSRM_BASE}/route/v1/driving/${origin[0]},${origin[1]};${target[0]},${target[1]}?overview=false&alternatives=false`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const body = (await res.json()) as { code?: string; routes?: { duration?: number }[] };
  const d = body.routes?.[0]?.duration;
  return typeof d === "number" && d > 0 ? d / 60 : null;
}

async function main(): Promise<number> {
  const receiptDir = join(HERE, "receipts");
  mkdirSync(receiptDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const logPath = join(receiptDir, `car-spotcheck-${stamp}.log`);
  const log = (s: string) => { process.stdout.write(s + "\n"); appendFileSync(logPath, s + "\n"); };
  log(`# CAR preset free-flow spot-check — ${new Date().toISOString()}`);
  log(`# served free-flow ranges: ${CAR_MIN.map((m, i) => `${m}min=${RANGES_S[i]}s`).join(" ")}  (ruler: public OSRM driving)`);

  const receipt: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    method: "ORS driving-car isochrone at the SHIPPED free-flow ranges [600,1500]s; public OSRM /route/v1/driving ruler origin→boundary; congestion factor applied downstream in serving (shrinks reach), NOT here",
    freeFlowRangesS: Object.fromEntries(CAR_MIN.map((m, i) => [m, RANGES_S[i]])),
    origins: ORIGINS,
    bearings: BEARINGS,
    perOrigin: {},
  };

  let grossOverclaims = 0;
  let anyCoverageGap = false;
  for (const origin of ORIGINS) {
    log(`\n## ${origin.name} (${origin.lat},${origin.lng})`);
    const geoms = await orsCar(origin.lat, origin.lng, RANGES_S);
    const perMin: Record<string, unknown> = {};
    for (let i = 0; i < CAR_MIN.length; i++) {
      const target = CAR_MIN[i]!;
      const geom = geoms.get(RANGES_S[i]!);
      if (!geom) { log(`  ${target}min: NO geometry`); anyCoverageGap = true; continue; }
      const osrmMins: number[] = [];
      let n = 0;
      for (const b of BEARINGS) {
        const bp = boundaryPointAtBearing(origin.lat, origin.lng, geom, b);
        if (!bp || bp.truncated) continue; // a truncated ray is a coverage gap, not a sample
        const dm = await osrmDriveMin([origin.lng, origin.lat], bp.pt);
        if (dm == null) continue;
        n++;
        osrmMins.push(dm);
      }
      if (n < BEARINGS.length) { log(`  ${target}min: coverage ${n}/${BEARINGS.length} (dropped sector)`); anyCoverageGap = true; }
      // OVER-CLAIM = the ORS boundary point actually takes LONGER to drive to than the
      // label promises: OSRM minutes > target + tol ⇒ ORS drew the polygon too far out.
      // The SAFE (accurate-to-conservative) direction is OSRM minutes <= target — ORS
      // placed the boundary at or INSIDE the ruler's T-min reach. (The served path then
      // shrinks this further with the congestion factor, so served ⊆ free-flow ⊆ safe.)
      const OVER_TOL = 2; // min: OSRM > target+2 at the boundary = an over-claim sample
      const over = osrmMins.filter((m) => m > target + OVER_TOL).length;
      const overRate = n ? over / n : 0;
      // Conservatism (OSRM < target) is SAFE and reported for context, not failed.
      const conservativeRate = n ? osrmMins.filter((m) => m < target).length / n : 0;
      if (overRate > 0.1) grossOverclaims++;
      const med = median(osrmMins);
      perMin[target] = { n, osrmMedianMin: med, overRate, conservativeRate, minOsrmMin: Math.min(...osrmMins), maxOsrmMin: Math.max(...osrmMins) };
      log(`  ${target}min (${RANGES_S[i]}s free-flow): OSRM median ${med.toFixed(1)}min at boundary  over(>T+${OVER_TOL}) ${(overRate * 100).toFixed(0)}%  conservative(<T) ${(conservativeRate * 100).toFixed(0)}%  range [${Math.min(...osrmMins).toFixed(1)},${Math.max(...osrmMins).toFixed(1)}]  (n=${n})`);
    }
    (receipt.perOrigin as Record<string, unknown>)[origin.name] = perMin;
  }

  receipt.grossOverclaimContours = grossOverclaims;
  receipt.coverageComplete = !anyCoverageGap;
  const receiptPath = join(receiptDir, `car-spotcheck-${stamp}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  const pass = grossOverclaims === 0 && !anyCoverageGap;
  log(`\n${pass ? "PASS" : "REVIEW"} — free-flow contours with >10% over-claim samples: ${grossOverclaims}; coverage ${anyCoverageGap ? "incomplete" : "complete"} — receipt: ${receiptPath}`);
  // Exit 0 only when NO contour grossly over-claims by the OSRM ruler AND coverage is
  // complete (every origin×contour×bearing sampled) — a dropped sector could be the
  // unsafe one, so an incomplete spot-check is never a clean pass.
  return pass ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
