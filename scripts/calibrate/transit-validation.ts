/**
 * Transit reach validation (dev-only, network + local DB) — the SERVED preset
 * thresholds [20,40], measured DIRECTLY.
 *
 * WHY: the phone-first preset model serves transit reach at 20/40 min. This
 * validates those contours DIRECTLY on the shipped preset pipeline
 * (`transitPresetIsochrone`, thresholds [20,40], field kept at 45 for exact
 * invariance) — replacing the earlier by-inheritance argument (task 019 measured
 * only 15/30/45 and reasoned 20/40 a fortiori; a direct measurement is required
 * before the preset thresholds serve a user-facing claim).
 *
 * INSTRUMENT: the REAL app pipeline `transitPresetIsochrone` builds the contours
 * (street-routed walk UNION — the fail-closed preset path throws rather than serve
 * the radial fallback, so a successful run is provably a unioned measurement; the
 * preset walk cache is pre-warmed). Ground truth = MOTIS `/api/v1/plan` BEST
 * intermodal journey duration, measured AT THE CONTOUR'S OWN DEPARTURE so the two
 * are comparable (the one-to-many intermodal `duration` is unreliable — 3137 s vs
 * /plan's 1320 s for the same pair — so /plan best-journey is the ground truth).
 *
 * ACCEPTANCE (pre-declared): a boundary point OVER-claims when its best
 * journey is > T + 5 min (unsafe direction). CENTRAL origins (Unirii, Grozavesti)
 * must hold over-claim ≤ 6% (the shipped central profile was ~0%). Berceni
 * (periphery) has a KNOWN pre-existing field over-claim (task 019, parked) —
 * recorded and fed to the 2b honest-copy precondition, not a fresh hard-stop.
 * FULL coverage is required (a dropped ray/journey fails the run). Exits non-zero
 * on a central breach OR a coverage gap so a re-run can't false-green.
 *
 * USAGE:  npx tsx --env-file=.env scripts/calibrate/transit-validation.ts
 *   (needs the local DB on :5433 up so the walk-ring cache warms and the union
 *    succeeds; ORS + Transitous reachable.)
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { campaignExitCode, coverageShortfalls, type CoverageCell } from "@/features/isochrones/calibration-acceptance";
import { walkingPresetIsochrone } from "@/features/isochrones/server/ors";
import { transitPresetIsochrone } from "@/features/isochrones/server/transit";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSIT_BASE = "https://api.transitous.org";
const USER_AGENT = "HowFar-reach-calibration/1.0 (contact: mihnea.joita@punct.ro)";
const SPACING_MS = 2100;
const TOL_MIN = 5;

const ORIGINS = [
  { name: "Unirii", lat: 44.4268, lng: 26.1025 },
  { name: "Grozavesti", lat: 44.443, lng: 26.06 },
  { name: "Berceni", lat: 44.383, lng: 26.123 },
  { name: "Militari", lat: 44.4319, lng: 26.0206 }, // west/A1: the transit-40 walk-union covers this barrier corridor
];
const BEARINGS = Array.from({ length: 8 }, (_, i) => (i * 360) / 8);

// --- geo helpers (same as reach-calibration.ts) ---
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
/** Farthest-inside point along a bearing (up to MAX), whole-geometry, no break at the
 *  first exit — the OUTERMOST reachable point is where an over-claim lives. `truncated`
 *  = still inside at MAX (reported as a coverage gap, never a shortened boundary). */
function boundaryPointAtBearing(
  lat: number,
  lng: number,
  geom: { type: string; coordinates: unknown },
  b: number,
): { pt: [number, number]; truncated: boolean } | null {
  const STEP = 30, MAX = 30000;
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

let lastCallAt = 0;
async function paced() {
  const wait = SPACING_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** Ground truth: best intermodal journey minutes origin->pt at the given departure. */
async function bestJourneyMin(
  origin: { lat: number; lng: number },
  pt: [number, number],
  departureIso: string,
): Promise<number | null> {
  await paced();
  const url =
    `${TRANSIT_BASE}/api/v1/plan?fromPlace=${origin.lat},${origin.lng}&toPlace=${pt[1]},${pt[0]}` +
    `&time=${encodeURIComponent(departureIso)}&arriveBy=false&maxPostTransitTime=2700` +
    `&pedestrianSpeed=1.389&useRoutedTransfers=true`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    itineraries?: { duration?: number }[];
    direct?: { duration?: number }[];
  };
  const durs = [
    ...(body.itineraries ?? []).map((i) => i.duration),
    ...(body.direct ?? []).map((i) => i.duration),
  ].filter((d): d is number => typeof d === "number" && d > 0);
  return durs.length ? Math.min(...durs) / 60 : null;
}

interface RingSample {
  minutes: number;
  bearing: number;
  journeyMin: number;
}

async function main() {
  const receiptDir = join(HERE, "receipts");
  mkdirSync(receiptDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const logPath = join(receiptDir, `transit-${stamp}.log`);
  const log = (s: string) => {
    process.stdout.write(s + "\n");
    appendFileSync(logPath, s + "\n");
  };
  log(`# Transit reach validation — ${new Date().toISOString()}`);
  log(`# instrument: transitPresetIsochrone [20,40] (street-routed walk union, fail-closed) vs MOTIS /plan best journey @ contour departure`);

  const receipt: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    method: "DIRECT measurement of the SERVED preset thresholds [20,40] via transitPresetIsochrone (street-routed walk union, fail-closed); ground truth = MOTIS /plan best journey at the contour departure",
    tolMin: TOL_MIN,
    origins: ORIGINS,
    bearings: BEARINGS,
    perOrigin: {},
  };

  // DIRECT measurement of the SERVED preset thresholds [20,40] on the SHIPPED
  // preset pipeline — not the legacy 15/30/45 by
  // inheritance. Central origins carry the pre-declared bar; Berceni (periphery)
  // has a KNOWN pre-existing field over-claim (task 019, parked) — recorded, and it
  // feeds the 2b honest-copy precondition, but is not a fresh hard-stop here.
  const CENTRAL = new Set(["Unirii", "Grozavesti"]);
  const CENTRAL_OVER_BAR = 0.06; // shipped central profile was ~0%
  const byThreshold: Record<number, RingSample[]> = {};
  const coverageCells: CoverageCell[] = [];
  const perOriginOver: Record<string, Record<number, number>> = {};
  for (const origin of ORIGINS) {
    log(`\n## ${origin.name} (${origin.lat},${origin.lng})`);
    // Pre-warm the PRESET walk cache so the preset union succeeds (fail-closed
    // path: no union ⇒ transitPresetIsochrone throws ⇒ this run errors, never a
    // radial-fallback measurement).
    try {
      await walkingPresetIsochrone(origin.lat, origin.lng);
    } catch (e) {
      log(`  WARN preset walk pre-warm failed: ${(e as Error).message}`);
    }
    const iso = await transitPresetIsochrone(origin.lat, origin.lng);
    log(`  departure ${iso.departure}; rings ${iso.rings.map((r) => r.minutes).join("/")} (street-routed union — fail-closed)`);
    const perRing: Record<string, unknown> = {};
    perOriginOver[origin.name] = {};
    for (const ring of iso.rings) {
      const geom = ring.geometry as { type: string; coordinates: unknown };
      const samples: RingSample[] = [];
      let dropped = 0;
      for (const bearing of BEARINGS) {
        const bp = boundaryPointAtBearing(origin.lat, origin.lng, geom, bearing);
        if (!bp || bp.truncated) { dropped++; continue; } // truncated ray = coverage gap, not a sample
        const j = await bestJourneyMin(origin, bp.pt, iso.departure);
        if (j == null) { dropped++; continue; }
        samples.push({ minutes: ring.minutes, bearing, journeyMin: j });
      }
      // COVERAGE (a recorded precondition): a ray-miss or failed journey is a DROPPED sector,
      // recorded so an incomplete run fails rather than false-greens on survivors.
      coverageCells.push({ origin: origin.name, target: ring.minutes, n: samples.length });
      if (dropped) log(`  ⚠ ${ring.minutes}min: ${dropped} sector(s) dropped (ray-miss/failed journey)`);
      const over = samples.filter((s) => s.journeyMin > ring.minutes + TOL_MIN);
      const med = median(samples.map((s) => s.journeyMin));
      const maxOver = samples.reduce((m, s) => Math.max(m, s.journeyMin - ring.minutes), 0);
      const overRate = samples.length ? over.length / samples.length : 0;
      perRing[ring.minutes] = { samples, median: med, overRate, maxOver };
      perOriginOver[origin.name]![ring.minutes] = overRate;
      (byThreshold[ring.minutes] ??= []).push(...samples);
      log(
        `  ${ring.minutes}min: median journey ${med.toFixed(1)}  over(>T+${TOL_MIN}) ${(overRate * 100).toFixed(0)}%  ` +
          `maxOver +${maxOver.toFixed(1)}min  (n=${samples.length})`,
);
    }
    (receipt.perOrigin as Record<string, unknown>)[origin.name] = perRing;
  }

  log(`\n## pooled over-claim by threshold (conservative direction: journey <= T means safe)`);
  const pooled: Record<string, unknown> = {};
  let worstOver = 0;
  for (const t of Object.keys(byThreshold).map(Number).sort((a, b) => a - b)) {
    const ss = byThreshold[t]!;
    const over = ss.filter((s) => s.journeyMin > t + TOL_MIN);
    const overRate = ss.length ? over.length / ss.length : 0;
    worstOver = Math.max(worstOver, overRate);
    pooled[t] = { n: ss.length, median: median(ss.map((s) => s.journeyMin)), overRate };
    log(`  ${t}min: median ${median(ss.map((s) => s.journeyMin)).toFixed(1)}  over ${(overRate * 100).toFixed(0)}%  (n=${ss.length})`);
  }
  receipt.pooled = pooled;
  receipt.worstOverRate = worstOver;

  // --- HARDENED GATES (a recorded precondition): coverage + a PRE-DECLARED central-origin bar.
  const EXPECTED = BEARINGS.length; // every bearing must yield a sample
  const coverageGaps = coverageShortfalls(coverageCells, EXPECTED);
  for (const g of coverageGaps) log(`  ✗ COVERAGE ${g}`);
  let centralFailures = 0;
  const centralBreaches: string[] = [];
  for (const [name, byT] of Object.entries(perOriginOver)) {
    if (!CENTRAL.has(name)) continue;
    for (const [t, rate] of Object.entries(byT)) {
      if (rate > CENTRAL_OVER_BAR) {
        centralFailures++;
        centralBreaches.push(`${name}@${t}min over-claims ${(rate * 100).toFixed(0)}% > bar ${(CENTRAL_OVER_BAR * 100).toFixed(0)}%`);
      }
    }
  }
  for (const b of centralBreaches) log(`  ✗ CENTRAL ${b}`);
  const coverageOk = coverageGaps.length === 0;
  const berceniOver = perOriginOver["Berceni"] ?? {};
  const militariOver = perOriginOver["Militari"] ?? {};
  // Conclusion computed from what was MEASURED, not asserted.
  receipt.conclusion =
    `Direct measurement of the SERVED preset thresholds [20,40] on transitPresetIsochrone. ` +
    `Central origins (Unirii, Grozavesti) held the pre-declared ≤${CENTRAL_OVER_BAR * 100}% over-claim bar: ${centralFailures === 0 ? "PASS" : "FAIL — " + centralBreaches.join("; ")}. ` +
    `Periphery/barrier origins measured, reported not hard-gated (accepted street-network anisotropy — the reach can overstate at the edges; feeds the 2b honest-copy precondition): ` +
    `Berceni over-claim by threshold ${JSON.stringify(berceniOver)}; Militari (west/A1, the transit-40 walk-union barrier corridor) over-claim by threshold ${JSON.stringify(militariOver)}. ` +
    `Coverage: ${coverageOk ? "complete" : "INCOMPLETE — " + coverageGaps.join("; ")}.`;
  receipt.centralOverBar = CENTRAL_OVER_BAR;
  receipt.centralFailures = centralFailures;
  receipt.coverageGaps = coverageGaps;

  const receiptPath = join(receiptDir, `transit-${stamp}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  const exit = campaignExitCode(coverageOk, centralFailures);
  log(
    `\nworst pooled over-claim ${(worstOver * 100).toFixed(0)}% — central bar ${centralFailures === 0 ? "held" : "BREACHED"}, coverage ${coverageOk ? "complete" : "INCOMPLETE"} — ${exit === 0 ? "PASS" : "FAILED"} — receipt: ${receiptPath}`,
);
  process.exit(exit);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
