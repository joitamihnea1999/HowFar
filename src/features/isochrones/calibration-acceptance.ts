/**
 * Calibration-campaign acceptance + coverage policy — PURE, so the guards that
 * keep a live measurement campaign from FALSE-GREENING are unit-tested (rule 13)
 * instead of living only inside a dev script nobody re-runs in CI.
 *
 * Two failure classes a naive campaign hides, both in the reassuring direction:
 *   1. DROPPED SECTORS — a missing ORS geometry, a ray that never crosses the
 *      boundary, or a failed ruler query silently shrinks the sample set, so an
 *      UNSAFE bearing can vanish and turn a fail into a pass. `coverageShortfalls`
 *      demands the full origin×target×bearing grid; any shortfall fails the run.
 *   2. RELAXED-AFTER-THE-FACT ACCEPTANCE — pooling across origins hides a single
 *      barrier/periphery origin that over-claims. `perOriginFailures` enforces a
 *      PRE-DECLARED per-origin bar (median accuracy AND over-claim rate AND an
 *      over-claim MAGNITUDE ceiling) that cannot be widened once the numbers are in.
 *
 * The scripts under `scripts/calibrate/` import these and exit non-zero when they
 * report anything, so a cron/CI re-run cannot announce a false success.
 */

/** Per-(origin,target) measured rates on the held-out acceptance sample. */
export interface OriginTargetRate {
  /** Number of accepted samples in this cell (should equal the expected bearings). */
  n: number;
  /** Fraction of samples that OVER-claim (measured > target + tolerance) — unsafe. */
  overRate: number;
  /** Worst over-claim magnitude in minutes (measured − target, ≥0). */
  maxOverMin: number;
  /** Median measured minutes for the cell. */
  medMin: number;
}

/** One (origin,target) cell's realized sample count vs what full coverage requires. */
export interface CoverageCell {
  origin: string;
  target: number;
  n: number;
}

/**
 * Cells whose sample count falls short of full coverage. A non-empty result MUST
 * fail the campaign: a dropped sector could be exactly the unsafe one, so an
 * incomplete run is never a pass, however good the surviving samples look.
 */
export function coverageShortfalls(cells: CoverageCell[], expectedPerCell: number): string[] {
  return cells
    .filter((c) => c.n < expectedPerCell)
    .map((c) => `${c.origin}@${c.target}min: ${c.n}/${expectedPerCell} samples (dropped sector)`);
}

/** Pre-declared per-origin acceptance bar for a SERVED preset. Set BEFORE the
 *  re-measurement; not relaxable afterwards. */
export interface PerOriginBar {
  /** Allowed |median − target|/target (e.g. 0.10 = ±10%). */
  medTolerance: number;
  /** Allowed over-claim RATE per origin (e.g. the shipped control's ≥6% pooled bar). */
  overRateBar: number;
  /** Allowed over-claim MAGNITUDE per origin, minutes (e.g. the shipped control's
   *  worst per-origin over-claim + a margin). Catches a bad tail a rate bar misses. */
  maxOverMinCeil: number;
}

export interface OriginFailure {
  origin: string;
  reason: string;
}

/**
 * The origins where a served preset breaches the pre-declared bar (empty = pass).
 * Checked in priority order median → rate → magnitude so the reported reason is the
 * first breach, not a pile-up.
 */
export function perOriginFailures(
  target: number,
  perOrigin: Record<string, OriginTargetRate>,
  bar: PerOriginBar,
): OriginFailure[] {
  const out: OriginFailure[] = [];
  for (const [origin, r] of Object.entries(perOrigin)) {
    if (r.n === 0) {
      out.push({ origin, reason: "no samples (coverage gap)" });
    } else if (Math.abs(r.medMin - target) / target > bar.medTolerance) {
      out.push({ origin, reason: `median ${r.medMin.toFixed(1)}min off >±${(bar.medTolerance * 100).toFixed(0)}% of ${target}` });
    } else if (r.overRate > bar.overRateBar) {
      out.push({ origin, reason: `over-claim ${(r.overRate * 100).toFixed(0)}% > bar ${(bar.overRateBar * 100).toFixed(0)}%` });
    } else if (r.maxOverMin > bar.maxOverMinCeil) {
      out.push({ origin, reason: `maxOver +${r.maxOverMin.toFixed(1)}min > ceiling +${bar.maxOverMinCeil.toFixed(1)}min` });
    }
  }
  return out;
}

/**
 * Campaign exit code: 0 ONLY when coverage is complete AND no served preset has a
 * per-origin failure. Anything else is 1 so a re-run cannot report a false success.
 */
export function campaignExitCode(coverageOk: boolean, servedFailureCount: number): number {
  return coverageOk && servedFailureCount === 0 ? 0 : 1;
}
