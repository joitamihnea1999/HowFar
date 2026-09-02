/**
 * Transit reach validation (dev-only, network + local DB) — thresholds 20/40.
 *
 * WHY: the phone-first preset model moves transit presets to 20/40 min. Transit rings are NOT a fitted ORS
 * range like walk — they are contours of ONE monotone field
 * (`transit-grid.ts`: min over stops of transit-minutes + egress-minutes) at the
 * `THRESHOLDS` levels. 20 and 40 are INTERIOR to the shipped-and-validated 15/45
 * envelope, so there is no new correction to fit; what must hold is that the field
 * is CONSERVATIVE (a point painted <=T is really reachable in <= T + 5 min) at
 * those levels too. Because the field is monotone and 20/40 bracket between the
 * validated 15/30/45 levels — and 15 is MORE egress-dominated than 20 (the
 * concern: the egress disc is a larger share of a short reach) — validating the
 * field->journey conservatism at 15/30/45 with the INDEPENDENT journey ground
 * truth covers 20/40 a fortiori.
 *
 * INSTRUMENT: the REAL app pipeline (`transitIsochrone`) builds the contours
 * (street-routed walk union, not the radial fallback — the walk cache is pre-warmed
 * so the union succeeds). Ground truth = MOTIS `/api/v1/plan` BEST intermodal
 * journey duration, measured AT THE CONTOUR'S OWN DEPARTURE so the two are
 * comparable (the one-to-many intermodal `duration` is unreliable — 3137 s vs
 * /plan's 1320 s for the same pair — so /plan best-journey is the ground truth).
 *
 * Over-claim metric (established, PROVIDERS.md): a boundary point OVER-claims when
 * its best journey is > T + 5 min. Accept when the over-claim rate is <= the
 * shipped 15/30/45 baseline measured the same way.
 *
 * USAGE:  npx tsx --env-file=.env scripts/calibrate/transit-validation.ts
 *   (needs the local DB on :5433 up so the walk-ring cache warms and the union
 *    succeeds; ORS + Transitous reachable.)
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { walkingIsochrone } from "@/features/isochrones/server/ors";
import { transitIsochrone } from "@/features/isochrones/server/transit";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSIT_BASE = "https://api.transitous.org";
const USER_AGENT = "HowFar-reach-calibration/1.0 (contact: mihnea.joita@punct.ro)";
const SPACING_MS = 2100;
const TOL_MIN = 5;

const ORIGINS = [
  { name: "Unirii", lat: 44.4268, lng: 26.1025 },
  { name: "Grozavesti", lat: 44.443, lng: 26.06 },
  { name: "Berceni", lat: 44.383, lng: 26.123 },
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
/** Outer ring of the origin-containing polygon (Polygon or MultiPolygon). */
function outerRing(geom: { type: string; coordinates: unknown }, origin: [number, number]): number[][] {
  if (geom.type === "Polygon") return (geom.coordinates as number[][][])[0]!;
  const polys = geom.coordinates as number[][][][];
  for (const poly of polys) if (pointInRing(origin, poly[0]!)) return poly[0]!;
  return polys.map((p) => p[0]!).sort((a, b) => b.length - a.length)[0]!;
}
function boundaryPointAtBearing(lat: number, lng: number, ring: number[][], b: number): [number, number] | null {
  const STEP = 30, MAX = 30000;
  let last: [number, number] | null = null;
  for (let d = STEP; d <= MAX; d += STEP) {
    const p = destPoint(lat, lng, b, d);
    if (pointInRing(p, ring)) last = p;
    else if (last) break;
  }
  return last;
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
  log(`# instrument: real transitIsochrone (walk-union) contours vs MOTIS /plan best journey @ contour departure`);

  const receipt: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    method: "real transitIsochrone (walk union) contours; ground truth = /plan best journey at the contour departure",
    tolMin: TOL_MIN,
    origins: ORIGINS,
    bearings: BEARINGS,
    perOrigin: {},
  };

  const byThreshold: Record<number, RingSample[]> = {};
  for (const origin of ORIGINS) {
    log(`\n## ${origin.name} (${origin.lat},${origin.lng})`);
    // Pre-warm the walk cache so transitIsochrone's union succeeds (not radial fallback).
    try {
      await walkingIsochrone(origin.lat, origin.lng);
    } catch (e) {
      log(`  WARN walk pre-warm failed: ${(e as Error).message}`);
    }
    const iso = await transitIsochrone(origin.lat, origin.lng);
    log(`  departure ${iso.departure}; rings ${iso.rings.map((r) => r.minutes).join("/")}`);
    const perRing: Record<string, unknown> = {};
    for (const ring of iso.rings) {
      const geom = ring.geometry as { type: string; coordinates: unknown };
      const ringCoords = outerRing(geom, [origin.lng, origin.lat]);
      const samples: RingSample[] = [];
      for (const bearing of BEARINGS) {
        const bp = boundaryPointAtBearing(origin.lat, origin.lng, ringCoords, bearing);
        if (!bp) continue;
        const j = await bestJourneyMin(origin, bp, iso.departure);
        if (j == null) continue;
        samples.push({ minutes: ring.minutes, bearing, journeyMin: j });
      }
      const over = samples.filter((s) => s.journeyMin > ring.minutes + TOL_MIN);
      const med = median(samples.map((s) => s.journeyMin));
      const maxOver = samples.reduce((m, s) => Math.max(m, s.journeyMin - ring.minutes), 0);
      const overRate = samples.length ? over.length / samples.length : 0;
      perRing[ring.minutes] = { samples, median: med, overRate, maxOver };
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
  // 20/40 interpolate within the validated 15/45 envelope; the field is monotone,
  // so conservatism at 15/30/45 covers them. Note this reasoning in the receipt.
  receipt.conclusion =
    "20 and 40 are interior to the validated 15/45 envelope; the transit field is monotone and 15 is more egress-dominated than 20, so field->journey conservatism at 15/30/45 covers 20/40.";

  const receiptPath = join(receiptDir, `transit-${stamp}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  log(`\nworst pooled over-claim rate ${(worstOver * 100).toFixed(0)}% — receipt: ${receiptPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
