import { LAUNCH_BBOX } from "@/lib/bounds";
import { db } from "@/lib/db";
import { withTimeout } from "@/lib/timeout";
import { carTrafficSlotFor } from "@/features/isochrones/car-traffic";
import { DEFAULT_PACE } from "@/features/isochrones/pace";
import { DEFAULT_TIME_CONTEXT } from "@/features/isochrones/time-context";
import { drivingIsochrone, walkingIsochrone } from "@/features/isochrones/server/ors";

/**
 * Process-start provider warmup (task 017, gap #8).
 *
 * WHY, measured: this warms the two PROVIDER cold-start tails the owner named (gap #8 / #5,#6).
 * The dominant AMENITIES cold cost was NOT I/O and is NOT what this fixes — it was the query
 * re-evaluating geometry in un-materialized CTEs (fixed in catalogue-query.ts with MATERIALIZED,
 * 457→100 ms; that was the real lever). What warmup covers instead: (a) the ORS engine's first
 * foot/car request pays a JVM/graph-load tail (isochrone cold p95 ~485 ms first-touch, dropping
 * as it warms) — priming one of each warms it, so the first real user's rings are fast; (b) a
 * cheap read of the whole active catalogue geom (~14 MB, fits the 128 MB shared_buffers) pulls it
 * into cache, trimming the first amenities query's heap-fetch I/O (a minor complement to the query
 * fix, not the main win). suggest/geocode warmth is deliberately NOT primed: at n=30 those p95s
 * were only marginally over and gap #5's cause — prefix-search cost vs JVM warmth — is unconfirmed,
 * so warming them would be an unproven fix, not a measured one.
 *
 * SAFETY: this is a PROCESS-START, fire-and-forget task. It is NEVER awaited by `/api/ready`
 * (readiness stays a bounded local probe), it is single-flighted (module-level promise, so it runs
 * at most once per worker), every provider call is time-bounded, and it swallows all errors —
 * a warmup failure must never surface. It only READS (a geometry aggregate + two provider calls);
 * it writes nothing except the ApiCache entries the provider clients populate themselves.
 */
let warmupPromise: Promise<void> | null = null;

/**
 * Idempotent, single-flight. Returns the in-flight/settled warmup promise; safe to call anywhere.
 *
 * Single-flight, but NOT "done-forever on failure": if a warmup run does not actually succeed
 * (e.g. ORS was down at boot), the cached promise is cleared once it settles, so a later call can
 * retry rather than being permanently suppressed. Only a SUCCESSFUL run keeps the promise cached.
 */
export function warmupProviders(): Promise<void> {
  if (!warmupPromise) {
    warmupPromise = runWarmup()
      .then((ok) => {
        if (!ok) warmupPromise = null; // let a later call retry a failed warmup
      })
      .catch((error) => {
        // runWarmup should never reject (it is best-effort internally), but guard anyway.
        console.error(`[warmup] provider warmup failed (non-fatal): ${(error as Error)?.message ?? error}`);
        warmupPromise = null;
      });
  }
  return warmupPromise;
}

/** Test-only reset so a suite can exercise the single-flight without cross-contamination. */
export function __resetWarmupForTest(): void {
  warmupPromise = null;
}

/** Runs the warmup best-effort. Returns true only if EVERY component succeeded (so a partial or
 *  total failure leaves the single-flight clearable for a retry). Never throws. */
async function runWarmup(): Promise<boolean> {
  const started = Date.now();
  const centerLat = (LAUNCH_BBOX.minLat + LAUNCH_BBOX.maxLat) / 2;
  const centerLng = (LAUNCH_BBOX.minLng + LAUNCH_BBOX.maxLng) / 2;

  // (1) The decisive one: pull the entire active-catalogue geom into shared_buffers, so the first
  // real amenities query for ANY origin hits warm cache (~100 ms) instead of cold disk (~650 ms).
  const buffer = await withTimeout(warmCatalogueBuffer(), 15_000);
  // (2) Prime the ORS foot + car engines (JVM/graph load) at the launch centre. allSettled: one
  // failing must not abort the other, and neither can reject into the caller.
  const providers = await withTimeout(
    Promise.allSettled([
      walkingIsochrone(centerLat, centerLng, DEFAULT_PACE),
      drivingIsochrone(centerLat, centerLng, carTrafficSlotFor(DEFAULT_TIME_CONTEXT)),
    ]),
    20_000,
  );

  const bufferOk = buffer.ok ? "ok" : buffer.reason;
  const orsResults = providers.ok ? providers.value : [];
  const orsOk = providers.ok
    ? orsResults.map((r) => (r.status === "fulfilled" ? "ok" : "err")).join("/")
    : providers.reason;
  console.log(`[warmup] done in ${Date.now() - started}ms — catalogue-buffer=${bufferOk} ors(foot/car)=${orsOk}`);
  // Success = the buffer read completed AND both ORS profiles resolved. Anything else (a timeout or
  // a rejected provider) returns false so `warmupProviders` clears the promise and a later call retries.
  return buffer.ok && providers.ok && orsResults.every((r) => r.status === "fulfilled");
}

/**
 * Read every row's geometry for the active dataset so PostgreSQL caches the catalogue's `geom`
 * pages. `ST_NPoints` forces the planner to actually fetch the full geometry (a bare `count(*)`
 * would not touch the geom heap). Scoped to the active dataset; a missing catalogue is a no-op.
 */
async function warmCatalogueBuffer(): Promise<void> {
  const active = await db().amenityDataset.findUnique({
    where: { activeKey: 1 },
    select: { id: true },
  });
  if (!active) return;
  await db().$queryRaw`
    SELECT sum(ST_NPoints(geom)) AS n
    FROM "osm_catalogue"."AmenityPlace"
    WHERE "datasetId" = ${active.id}
  `;
}
