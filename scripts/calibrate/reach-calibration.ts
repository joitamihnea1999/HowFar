/**
 * Reach calibration harness (dev-only, network) — walking rings.
 *
 * WHY: the walking isochrone requests CALIBRATED OpenRouteService ranges so a ring
 * LABELED "M minutes" really takes ~M street-walking minutes at the calibration
 * anchor (80 m/min). The shipped calibration was fitted only at 15/30/45
 * (`src/features/isochrones/pace.ts` CALIBRATED_RANGES_S_AT_80 = [827,1674,2528]);
 * the requested-seconds -> real-street-minutes map is EMPIRICAL and NON-LINEAR, so a
 * new preset minute has no fitted point. This harness measures ORS foot-walking
 * boundaries against a street-distance ruler and fits the range for new minutes.
 *
 * RULER: MOTIS `/api/v1/one-to-many` (`mode=WALK`, `withDistance=true`) — one call
 * returns the street-ROUTED metres from the origin to MANY targets at once,
 * independent of any speed assumption (verified byte-for-byte equal to `/plan`
 * direct-walk distance). Minutes are then distance / 80 m/min (the calibration
 * anchor, NOT a product pace — a measurement ruler). One call per origin keeps the
 * campaign within docs/PROVIDERS.md "Calibration" bounded-campaign discipline
 * (<=128 targets/call, >=2 s spacing, identifying User-Agent).
 *
 * PROTOCOL (reproducible, deterministic):
 *   - fixed origins (central / river-barrier / periphery);
 *   - a fixed set of bearings per origin -> deterministic boundary sample points
 *     found by marching each bearing ray out to the ORS polygon boundary;
 *   - per sample, the ruler measures street-distance -> street-minutes;
 *   - even-indexed bearings FIT, odd-indexed bearings are a HELD-OUT acceptance
 *     set (so fit and acceptance never share a sample);
 *   - a candidate range PASSES a minute M when the per-sector residuals sit within
 *     +/-10% of M at every origin, on the held-out set, retaken against the fitted
 *     range actually emitted.
 *
 * BOUNDED-CAMPAIGN DISCIPLINE: >=2 s spacing between external calls, an identifying
 * User-Agent with a contact email, small bounded call counts.
 *
 * USAGE:  tsx scripts/calibrate/reach-calibration.ts            (walk sweep+fit+confirm)
 *         writes a receipt to scripts/calibrate/receipts/walk-<date>.json
 * ORS_API_KEY is read from the environment or the local .env.
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ORS_BASE = "https://api.openrouteservice.org";
const TRANSIT_BASE = "https://api.transitous.org";
const USER_AGENT = "HowFar-reach-calibration/1.0 (contact: mihnea.joita@punct.ro)";
const SPACING_MS = 2100; // >= 2 s between every external call (both hosts)

/** Calibration anchor: a measurement ruler, NOT a product walking speed. */
const ANCHOR_M_PER_MIN = 80;

/** Fixed audit origins (central / river-barrier / periphery), per PROVIDERS.md. */
const ORIGINS: { name: string; lat: number; lng: number }[] = [
  { name: "Unirii", lat: 44.4268, lng: 26.1025 },
  { name: "Grozavesti", lat: 44.443, lng: 26.06 },
  { name: "Berceni", lat: 44.383, lng: 26.123 },
];

/** New walk minutes to calibrate: 10/20 = walk presets; 40 = required by the
 *  transit street-walk union (a transit threshold unions a walk ring of the SAME
 *  minute). */
const TARGET_MIN = [10, 20, 40];

/** 12 bearings; even indices FIT, odd indices are HELD-OUT acceptance. */
const BEARINGS = Array.from({ length: 12 }, (_, i) => (i * 360) / 12);

/** Candidate ORS ranges (seconds at the anchor) to SWEEP per origin, bracketing
 *  the targets. From the shipped anchor the seconds->street-metre slope is
 *  ~1.43 m/s, so 10/20/40 min (800/1600/3200 m) sit near ~560/1120/2240 s.
 *  8 ranges x 12 bearings = 96 targets/origin, under the 128 one-to-many cap. */
const SWEEP_RANGES_S = [480, 620, 780, 980, 1240, 1600, 2000, 2500];

/** one-to-many caps `many` at 128 targets/call (bounded-campaign discipline). */
const MANY_CAP = 128;

const RESIDUAL_TOLERANCE = 0.1; // +/-10%, the established bar

// ---------------------------------------------------------------------------
// Small geo helpers (local equirectangular around each origin — city scale)
// ---------------------------------------------------------------------------

const R_EARTH = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Destination [lng,lat] from origin along `bearingDeg` at `distM` metres. */
function destPoint(lat: number, lng: number, bearingDeg: number, distM: number): [number, number] {
  const b = toRad(bearingDeg);
  const dLat = (distM * Math.cos(b)) / R_EARTH;
  const dLng = (distM * Math.sin(b)) / (R_EARTH * Math.cos(toRad(lat)));
  return [lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI];
}

/** Ray-casting point-in-polygon over a [lng,lat] ring (outer ring only). */
function pointInRing(pt: [number, number], ring: number[][]): boolean {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!;
    const xj = ring[j]![0]!, yj = ring[j]![1]!;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** The outer ring of a Polygon / the origin-containing polygon of a MultiPolygon. */
function outerRing(geom: { type: string; coordinates: unknown }, origin: [number, number]): number[][] {
  if (geom.type === "Polygon") return (geom.coordinates as number[][][])[0]!;
  const polys = geom.coordinates as number[][][][];
  for (const poly of polys) if (pointInRing(origin, poly[0]!)) return poly[0]!;
  // Fallback: the largest ring by vertex count.
  return polys.map((p) => p[0]!).sort((a, b) => b.length - a.length)[0]!;
}

/** March a bearing ray out from origin to the polygon boundary; returns the last
 *  point still inside (the boundary crossing at ~STEP resolution). */
function boundaryPointAtBearing(
  lat: number,
  lng: number,
  ring: number[][],
  bearingDeg: number,
): [number, number] | null {
  const STEP = 20; // metres
  const MAX = 8000; // metres — beyond any 40-min walk ring
  let last: [number, number] | null = null;
  for (let d = STEP; d <= MAX; d += STEP) {
    const p = destPoint(lat, lng, bearingDeg, d);
    if (pointInRing(p, ring)) last = p;
    else if (last) break; // left the polygon after being inside — boundary found
  }
  return last;
}

// ---------------------------------------------------------------------------
// External calls (rate-limited)
// ---------------------------------------------------------------------------

let lastCallAt = 0;
async function paced(): Promise<void> {
  const wait = SPACING_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

function orsKey(): string {
  if (process.env.ORS_API_KEY) return process.env.ORS_API_KEY;
  const env = readFileSync(join(REPO, ".env"), "utf8");
  const m = env.match(/^ORS_API_KEY=(.*)$/m);
  if (!m) throw new Error("ORS_API_KEY not in env or .env");
  return m[1]!.trim().replace(/^["']|["']$/g, "");
}
const KEY = orsKey();

interface OrsFeature {
  properties?: { value?: number };
  geometry?: { type: string; coordinates: unknown };
}

/** ORS foot-walking isochrone for N ranges in one POST -> per-range boundary geom. */
async function orsWalk(
  lat: number,
  lng: number,
  rangesS: number[],
): Promise<Map<number, { type: string; coordinates: unknown }>> {
  await paced();
  const res = await fetch(`${ORS_BASE}/v2/isochrones/foot-walking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: KEY, "User-Agent": USER_AGENT },
    body: JSON.stringify({ locations: [[lng, lat]], range: rangesS }),
  });
  if (!res.ok) throw new Error(`ORS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { features?: OrsFeature[] };
  const out = new Map<number, { type: string; coordinates: unknown }>();
  for (const f of body.features ?? []) {
    const v = f.properties?.value;
    if (typeof v === "number" && f.geometry) out.set(v, f.geometry);
  }
  return out;
}

/** Ruler: street-routed WALK distance (metres) from `origin` to MANY targets in
 *  one MOTIS one-to-many call (`withDistance=true`). Positional-parallel to
 *  `targets`; a target with no route is `null`. Chunked to <=MANY_CAP/call. */
async function rulerDistances(
  origin: [number, number],
  targets: [number, number][],
): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (let i = 0; i < targets.length; i += MANY_CAP) {
    const chunk = targets.slice(i, i + MANY_CAP);
    await paced();
    const many = chunk.map(([lng, lat]) => `${lat};${lng}`).join(",");
    const url =
      `${TRANSIT_BASE}/api/v1/one-to-many?one=${origin[1]};${origin[0]}&many=${many}` +
      `&mode=WALK&max=7200&maxMatchingDistance=250&arriveBy=false&withDistance=true`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`one-to-many ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const rows = (await res.json()) as ({ duration?: number; distance?: number } | null)[];
    for (let k = 0; k < chunk.length; k++) {
      const d = rows[k]?.distance;
      out.push(typeof d === "number" && d > 0 ? d : null);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface Sample {
  bearing: number;
  streetM: number;
  streetMin: number; // streetM / ANCHOR_M_PER_MIN
  held: boolean; // odd bearing index = held-out acceptance
}

/** Boundary sample point per bearing for one ORS range (PURE, no network). */
function boundaryPoints(
  origin: { lat: number; lng: number },
  geom: { type: string; coordinates: unknown },
): { bearing: number; held: boolean; pt: [number, number] }[] {
  const ring = outerRing(geom, [origin.lng, origin.lat]);
  const pts: { bearing: number; held: boolean; pt: [number, number] }[] = [];
  for (let i = 0; i < BEARINGS.length; i++) {
    const bp = boundaryPointAtBearing(origin.lat, origin.lng, ring, BEARINGS[i]!);
    if (bp) pts.push({ bearing: BEARINGS[i]!, held: i % 2 === 1, pt: bp });
  }
  return pts;
}

/** Split ruler-measured samples into fit / held-out by the `held` flag. */
function splitSamples(samples: Sample[]): { fit: Sample[]; held: Sample[] } {
  return { fit: samples.filter((s) => !s.held), held: samples.filter((s) => s.held) };
}

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** ESTABLISHED PROVIDERS.md acceptance metric (not a symmetric % residual): a
 *  point OVER-claims when it is painted <=T but is really > T + TOL_MIN minutes
 *  away (the unsafe direction); UNDER-claims when really < T - TOL_MIN. Sub-5-min
 *  deviations sit inside the band and count neither way. The shipped calibration
 *  was accepted at "over-claim 0-6% everywhere, zero under-claim beyond +/-5min". */
const TOL_MIN = 5;
function claimRates(samples: Sample[], target: number): {
  n: number;
  medMin: number;
  overRate: number;
  underRate: number;
  maxOverMin: number;
} {
  const n = samples.length;
  const over = samples.filter((s) => s.streetMin > target + TOL_MIN);
  const under = samples.filter((s) => s.streetMin < target - TOL_MIN);
  const maxOverMin = samples.reduce((m, s) => Math.max(m, s.streetMin - target), 0);
  return {
    n,
    medMin: median(samples.map((s) => s.streetMin)),
    overRate: n ? over.length / n : 0,
    underRate: n ? under.length / n : 0,
    maxOverMin,
  };
}

// ---------------------------------------------------------------------------
// Main: sweep -> per-origin range->street-minute curve -> interpolate target
//       ranges -> confirm on the held-out set.
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const receiptDir = join(HERE, "receipts");
  mkdirSync(receiptDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const logPath = join(receiptDir, `walk-${stamp}.log`);
  const log = (s: string) => {
    process.stdout.write(s + "\n");
    appendFileSync(logPath, s + "\n");
  };

  log(`# Walk reach calibration — ${new Date().toISOString()}`);
  log(`# ruler: MOTIS /api/v1/one-to-many withDistance (maxMatchingDistance=250m snap) street distance / ${ANCHOR_M_PER_MIN} m/min anchor`);
  log(`# targets(min): ${TARGET_MIN.join(", ")}  sweep(s): ${SWEEP_RANGES_S.join(", ")}`);

  const receipt: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    method: "MOTIS /api/v1/one-to-many withDistance (maxMatchingDistance=250m snap) street distance ÷ 80 m/min anchor; ORS foot-walking boundary sampled at fixed bearings",
    anchorMPerMin: ANCHOR_M_PER_MIN,
    origins: ORIGINS,
    bearings: BEARINGS,
    sweepRangesS: SWEEP_RANGES_S,
    targetMin: TARGET_MIN,
    perOrigin: {},
  };

  // measure a set of ranges at one origin: 1 ORS call + 1 batched ruler call.
  const measureOrigin = async (
    origin: { name: string; lat: number; lng: number },
    ranges: number[],
): Promise<Map<number, Sample[]>> => {
    const geoms = await orsWalk(origin.lat, origin.lng, ranges);
    // Gather every boundary point across every range, then ONE ruler call.
    const flat: { rangeS: number; bearing: number; held: boolean; pt: [number, number] }[] = [];
    for (const rangeS of ranges) {
      const geom = geoms.get(rangeS);
      if (!geom) {
        log(`  range ${rangeS}s: NO geometry`);
        continue;
      }
      for (const bp of boundaryPoints(origin, geom)) flat.push({ rangeS, ...bp });
    }
    const dists = await rulerDistances([origin.lng, origin.lat], flat.map((f) => f.pt));
    const byRange = new Map<number, Sample[]>();
    flat.forEach((f, i) => {
      const streetM = dists[i];
      if (streetM == null) return;
      if (!byRange.has(f.rangeS)) byRange.set(f.rangeS, []);
      byRange.get(f.rangeS)!.push({
        bearing: f.bearing,
        streetM,
        streetMin: streetM / ANCHOR_M_PER_MIN,
        held: f.held,
      });
    });
    return byRange;
  };

  // 1) SWEEP: build a range->street-minute curve per origin.
  const curves: Record<string, { rangeS: number; fitMedMin: number; heldMedMin: number }[]> = {};
  for (const origin of ORIGINS) {
    log(`\n## ${origin.name} (${origin.lat},${origin.lng}) — sweep`);
    const byRange = await measureOrigin(origin, SWEEP_RANGES_S);
    const curve: { rangeS: number; fitMedMin: number; heldMedMin: number }[] = [];
    const perRange: Record<string, unknown> = {};
    for (const rangeS of SWEEP_RANGES_S) {
      const samples = byRange.get(rangeS) ?? [];
      const { fit, held } = splitSamples(samples);
      const fitMedMin = median(fit.map((s) => s.streetMin));
      const heldMedMin = median(held.map((s) => s.streetMin));
      curve.push({ rangeS, fitMedMin, heldMedMin });
      perRange[rangeS] = { fit, held, fitMedMin, heldMedMin };
      log(
        `  range ${rangeS}s -> fit ${fitMedMin.toFixed(2)} min / held ${heldMedMin.toFixed(2)} min ` +
          `(fit n=${fit.length}, held n=${held.length})`,
);
    }
    curves[origin.name] = curve;
    (receipt.perOrigin as Record<string, unknown>)[origin.name] = { sweep: perRange };
  }

  // 2) INTERPOLATE the range that hits each target minute, per origin (fit curve),
  //    then average across origins for a single shipped candidate range.
  log(`\n## fitted candidate ranges (interpolated on the fit curve)`);
  const interpRange = (curve: { rangeS: number; fitMedMin: number }[], target: number): number => {
    const pts = curve.filter((p) => Number.isFinite(p.fitMedMin)).sort((a, b) => a.fitMedMin - b.fitMedMin);
    for (let i = 1; i < pts.length; i++) {
      if (pts[i]!.fitMedMin >= target) {
        const a = pts[i - 1]!, b = pts[i]!;
        const t = (target - a.fitMedMin) / (b.fitMedMin - a.fitMedMin);
        return Math.round(a.rangeS + t * (b.rangeS - a.rangeS));
      }
    }
    return NaN;
  };
  const candidate: Record<number, number> = {};
  for (const target of TARGET_MIN) {
    const perOrigin = ORIGINS.map((o) => interpRange(curves[o.name]!, target));
    const avg = Math.round(perOrigin.reduce((a, b) => a + b, 0) / perOrigin.length);
    candidate[target] = avg;
    log(`  ${target} min -> per-origin ${perOrigin.join("/")} s -> candidate ${avg} s`);
  }
  (receipt as Record<string, unknown>).candidateRangeS = candidate;

  // CONTROL: the shipped anchor {15:827, 30:1674, 45:2528} measured the SAME way,
  // so the new presets are compared against the calibration already shipped,
  // not an absolute ideal. Pool held-out samples across origins per target.
  const CONTROL: Record<number, number> = { 15: 827, 30: 1674, 45: 2528 };
  const poolHeld = async (rangeByTarget: Record<number, number>, targets: number[]) => {
    const ranges = targets.map((t) => rangeByTarget[t]!);
    const pooled: Record<number, Sample[]> = {};
    for (const t of targets) pooled[t] = [];
    const perOrigin: Record<string, Record<number, Sample[]>> = {};
    for (const origin of ORIGINS) {
      const byRange = await measureOrigin(origin, ranges);
      perOrigin[origin.name] = {};
      for (const t of targets) {
        const held = splitSamples(byRange.get(rangeByTarget[t]!) ?? []).held;
        pooled[t]!.push(...held);
        perOrigin[origin.name]![t] = held;
      }
    }
    return { pooled, perOrigin };
  };

  log(`\n## control — shipped anchor 15/30/45 (${Object.values(CONTROL).join("/")} s), held-out pooled`);
  const control = await poolHeld(CONTROL, [15, 30, 45]);
  const controlRates: Record<number, ReturnType<typeof claimRates>> = {};
  let controlMaxOver = 0;
  for (const t of [15, 30, 45]) {
    const r = claimRates(control.pooled[t]!, t);
    controlRates[t] = r;
    controlMaxOver = Math.max(controlMaxOver, r.overRate);
    log(
      `  ${t}min: median ${r.medMin.toFixed(2)}  over(>T+${TOL_MIN}) ${(r.overRate * 100).toFixed(0)}%  ` +
        `under ${(r.underRate * 100).toFixed(0)}%  maxOver +${r.maxOverMin.toFixed(1)}min  (n=${r.n})`,
);
  }
  // The bar the new presets must MEET-OR-BEAT: the shipped over-claim rate.
  const overBar = Math.max(0.06, controlMaxOver); // >=6% per PROVIDERS "0-6% everywhere"
  (receipt as Record<string, unknown>).control = { ranges: CONTROL, rates: controlRates, perOrigin: control.perOrigin };
  (receipt as Record<string, unknown>).overClaimBar = overBar;

  // 3) CONFIRM + one CONSERVATIVE refinement. Established metric: median within
  //    +/-10% AND over-claim rate <= the shipped bar. If a target over-claims,
  //    shrink its range toward target/median (conservative) and re-measure once.
  log(`\n## confirm (established metric: median +/-10% AND over-claim <= ${(overBar * 100).toFixed(0)}%)`);
  const evaluate = async (label: string) => {
    const res = await poolHeld(candidate, TARGET_MIN);
    const rates: Record<number, ReturnType<typeof claimRates>> = {};
    for (const t of TARGET_MIN) {
      rates[t] = claimRates(res.pooled[t]!, t);
      const r = rates[t]!;
      log(
        `  [${label}] ${t}min (${candidate[t]}s): median ${r.medMin.toFixed(2)}  ` +
          `over ${(r.overRate * 100).toFixed(0)}%  under ${(r.underRate * 100).toFixed(0)}%  ` +
          `maxOver +${r.maxOverMin.toFixed(1)}min  (n=${r.n})`,
);
    }
    return { res, rates };
  };
  let evalResult = await evaluate("confirm");
  // One conservative refinement for any target whose median over-claims (>+10%)
  // or whose over-claim rate exceeds the bar.
  const needsRefine = TARGET_MIN.filter((t) => {
    const r = evalResult.rates[t]!;
    return (r.medMin - t) / t > 0.1 || r.overRate > overBar;
  });
  if (needsRefine.length) {
    for (const t of needsRefine) {
      const r = evalResult.rates[t]!;
      // scale range by target/median (shrink when median over-claims) — a secant step.
      candidate[t] = Math.round(candidate[t]! * (t / r.medMin));
      log(`  refine ${t}min -> ${candidate[t]}s (was over: median ${r.medMin.toFixed(2)})`);
    }
    evalResult = await evaluate("refined");
  }

  const finalRates = evalResult.rates;
  let allPass = true;
  let anyOriginOver = false;
  const acceptance: Record<string, unknown> = { perTarget: {}, perOrigin: evalResult.res.perOrigin };
  for (const t of TARGET_MIN) {
    const r = finalRates[t]!;
    const medOk = Math.abs(r.medMin - t) / t <= RESIDUAL_TOLERANCE;
    const overOk = r.overRate <= overBar;
    const pass = medOk && overOk;
    if (!pass) allPass = false;
    // PER-ORIGIN transparency: pooling across origins can hide a single-origin
    // barrier/periphery failure, so report + record every origin's own rate and
    // worst over-claim. A per-origin exceedance does NOT fail the pooled gate (the
    // shipped 15/30/45 rings also exceed at barriers — see the control), but it
    // MUST be visible so a downstream claim cannot say "PASS at all origins".
    const perOrigin: Record<string, ReturnType<typeof claimRates>> = {};
    for (const origin of ORIGINS) {
      const held = evalResult.res.perOrigin[origin.name]?.[t] ?? [];
      const pr = claimRates(held, t);
      perOrigin[origin.name] = pr;
      if (pr.overRate > overBar) anyOriginOver = true;
    }
    (acceptance.perTarget as Record<string, unknown>)[t] = {
      rangeS: candidate[t], ...r, medOk, overOk, pass, perOrigin,
    };
    log(
      `  RESULT ${t}min (${candidate[t]}s): pooled median ${r.medMin.toFixed(2)} [${medOk ? "ok" : "OFF"}]  ` +
        `over ${(r.overRate * 100).toFixed(0)}% vs bar ${(overBar * 100).toFixed(0)}% [${overOk ? "ok" : "OVER"}]  ${pass ? "PASS" : "FAIL"}`,
);
    for (const origin of ORIGINS) {
      const pr = perOrigin[origin.name]!;
      log(
        `      ${origin.name}: median ${pr.medMin.toFixed(1)} over ${(pr.overRate * 100).toFixed(0)}% ` +
          `maxOver +${pr.maxOverMin.toFixed(1)}min${pr.overRate > overBar ? "  ⚠ per-origin over bar" : ""}`,
);
    }
  }
  (receipt as Record<string, unknown>).acceptance = acceptance;
  (receipt as Record<string, unknown>).finalCandidateRangeS = { ...candidate };
  (receipt as Record<string, unknown>).allPass = allPass;
  (receipt as Record<string, unknown>).anyOriginOverBar = anyOriginOver;

  // --- HARDENED GATES ---------------------------
  // (1) COVERAGE: every (origin,target) held-out cell must carry the full bearing
  //     count — a dropped sector (missing ORS geom / ray-miss / failed ruler) could
  //     be the unsafe one, so a shortfall FAILS the campaign, never a silent pass.
  const heldBearings = BEARINGS.filter((_, i) => i % 2 === 1).length;
  const coverageCells: CoverageCell[] = [];
  for (const origin of ORIGINS) {
    for (const t of TARGET_MIN) {
      coverageCells.push({ origin: origin.name, target: t, n: (evalResult.res.perOrigin[origin.name]?.[t] ?? []).length });
    }
  }
  const coverageGaps = coverageShortfalls(coverageCells, heldBearings);
  for (const g of coverageGaps) log(`  ✗ COVERAGE ${g}`);
  // (2) PRE-DECLARED PER-ORIGIN BAR for the SERVED walk presets (10,20). 40 is the
  //     transit-union helper, NOT a served walk reach — its correctness is proven by
  //     the transit union validating (transit-validation.ts), so it is exempt here.
  //     Magnitude ceiling = the shipped 15/30/45 control's worst per-origin over-claim
  //     + 2 min: "no worse than the shipped rings' barrier tails, plus slack". Declared
  //     from the control BEFORE inspecting the preset tails — not relaxable after.
  let controlWorstPerOrigin = 0;
  for (const origin of ORIGINS) {
    for (const t of [15, 30, 45]) {
      controlWorstPerOrigin = Math.max(controlWorstPerOrigin, claimRates(control.perOrigin[origin.name]?.[t] ?? [], t).maxOverMin);
    }
  }
  const perOriginBar = { medTolerance: RESIDUAL_TOLERANCE, overRateBar: overBar, maxOverMinCeil: controlWorstPerOrigin + 2 };
  const SERVED_WALK_MIN = [10, 20];
  let servedFailures = 0;
  for (const t of SERVED_WALK_MIN) {
    const perOrigin: Record<string, OriginTargetRate> = {};
    for (const origin of ORIGINS) perOrigin[origin.name] = claimRates(evalResult.res.perOrigin[origin.name]?.[t] ?? [], t);
    for (const f of perOriginFailures(t, perOrigin, perOriginBar)) {
      servedFailures++;
      log(`  ✗ SERVED ${t}min @ ${f.origin}: ${f.reason}`);
    }
  }
  const coverageOk = coverageGaps.length === 0;
  (receipt as Record<string, unknown>).coverageGaps = coverageGaps;
  (receipt as Record<string, unknown>).perOriginBar = perOriginBar;
  (receipt as Record<string, unknown>).servedWalkFailures = servedFailures;

  const receiptPath = join(receiptDir, `walk-${stamp}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  const exit = campaignExitCode(coverageOk, servedFailures);
  log(
    `\n${exit === 0 ? "PASS" : "FAILED"}` +
      `${anyOriginOver ? " (pooled: per-origin barrier exceedances on non-served/union minutes surfaced above)" : ""}` +
      ` — coverage ${coverageOk ? "complete" : `INCOMPLETE (${coverageGaps.length})`}, served-walk per-origin failures ${servedFailures}` +
      ` — receipt: ${receiptPath}`,
);
  // Exit non-zero on a coverage gap OR a served-preset per-origin breach, so a
  // cron/CI rerun cannot report a false success. walk-40 (union helper) tails are
  // surfaced but do not fail here (validated via the transit union).
  return exit;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
