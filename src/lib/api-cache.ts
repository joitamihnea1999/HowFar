import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

/**
 * Server-side cache for external provider responses (Nominatim/ORS/
 * Open-Meteo) and hot local results (amenities catalogue summaries) so the
 * app stays inside free-tier quotas and avoids repeat PostGIS/provider work
 * (brief §10). Backed by the `ApiCache` table; `cacheKey` is the caller-chosen
 * identity of a request.
 *
 * A small process-local L1 sits in front of Postgres so warm keys in the same
 * Node process avoid a DB round-trip (single-instance friendly). L1 is
 * best-effort and bounded; multi-instance deployments still share via Postgres.
 */

/**
 * Read a cached response. A row is a HIT only while it has not expired
 * (`expiresAt > now`); exactly at or after `expiresAt` it is a miss.
 *
 * Expired rows are intentionally NOT deleted here — keeping this a pure read
 * avoids a race where a concurrent `setCached` writes a fresh value between
 * another caller's read and delete, and that fresh value gets erased. Reaping is
 * the separate `deleteExpired` sweep (below), which uses `@@index([expiresAt])`
 * and re-checks the expiry predicate INSIDE the DELETE so it cannot erase a
 * refreshed row. It runs on a cadence (see `deleteExpired`), not on the read
 * path; superseded `configCacheTag`/`PROVIDER_DATA_REVISION` namespaces are
 * reclaimed by the same sweep once their rows expire.
 *
 * `<T>` is caller-trust — the stored JSON is returned unchecked; provider
 * clients re-validate shape at their seams (the `normalize` functions in
 * providers/*.ts). The caller also owns the timeout boundary: wrap the
 * call in `withTimeout` if a stalled DB must not hang the request (this repo
 * has no driver-side query timeout by design).
 */

/** Bound memory so a long-lived process cannot retain unbounded keys. */
const L1_MAX_ENTRIES = 256;
const l1 = new Map<string, { value: unknown; expiresAtMs: number }>();

/** Test/reset hook — not for product call sites. */
export function __resetApiCacheL1ForTests(): void {
  l1.clear();
}

function l1Get(key: string, nowMs: number): unknown | null {
  const row = l1.get(key);
  if (!row) return null;
  if (row.expiresAtMs <= nowMs) {
    l1.delete(key);
    return null;
  }
  // Refresh insertion order for a crude LRU: re-set moves to map tail.
  l1.delete(key);
  l1.set(key, row);
  return row.value;
}

function l1Set(key: string, value: unknown, expiresAtMs: number): void {
  if (l1.has(key)) l1.delete(key);
  l1.set(key, { value, expiresAtMs });
  while (l1.size > L1_MAX_ENTRIES) {
    const oldest = l1.keys().next().value;
    if (oldest === undefined) break;
    l1.delete(oldest);
  }
}

export async function getCached<T>(key: string, now: Date = new Date()): Promise<T | null> {
  const nowMs = now.getTime();
  const mem = l1Get(key, nowMs);
  if (mem !== null) return mem as T;

  const row = await db().apiCache.findUnique({ where: { cacheKey: key } });
  if (!row) return null;
  if (row.expiresAt <= now) return null;
  l1Set(key, row.value, row.expiresAt.getTime());
  return row.value as unknown as T;
}

/**
 * Insert or replace a cached response under `key`, valid until `expiresAt`.
 * `value` is caller-trust (like getCached's `<T>`): it must be JSON-serialisable
 * — it lands in a PostgreSQL `JSONB` column — but the type is `unknown` so callers can
 * store normalized provider payloads (with loosely-typed nested geometry, etc.)
 * without fighting Prisma's strict InputJsonValue at every seam.
 */
export async function setCached(key: string, value: unknown, expiresAt: Date): Promise<void> {
  l1Set(key, value, expiresAt.getTime());
  await db().apiCache.upsert({
    where: { cacheKey: key },
    create: { cacheKey: key, value: value as Prisma.InputJsonValue, expiresAt },
    update: { value: value as Prisma.InputJsonValue, expiresAt },
  });
}

/**
 * Best-effort cache accessors for the provider layer: the cache is an
 * optimisation, not a hard dependency, so a cache/DB failure must degrade to
 * "uncached" (the core map flow keeps working per brief §10) rather than fail
 * the request. Use these from provider clients; use the strict getCached/
 * setCached where a DB error genuinely should surface (e.g. saved searches).
 */

// Swallowed failures must stay observable — a dead cache silently forfeits the
// free-tier protection and slows every request. Warn at most once per interval
// so a database outage does not also flood the logs (2 lines per request).
const WARN_INTERVAL_MS = 60_000;
let lastWarnAt = -Infinity;

function warnCacheFailure(op: "read" | "write", err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.warn(`[api-cache] best-effort ${op} failed; serving uncached (${detail})`);
}

export async function getCachedSafe<T>(key: string, now: Date = new Date()): Promise<T | null> {
  try {
    return await getCached<T>(key, now);
  } catch (err) {
    warnCacheFailure("read", err);
    return null;
  }
}

export async function setCachedSafe(key: string, value: unknown, expiresAt: Date): Promise<void> {
  try {
    await setCached(key, value, expiresAt);
  } catch (err) {
    warnCacheFailure("write", err);
  }
}

/** Drop expired entries from the in-process L1 (best-effort; L1 also self-expires
 *  on read, so this only reclaims memory for keys never read again). */
function purgeExpiredL1(nowMs: number): number {
  let n = 0;
  for (const [k, v] of l1) {
    if (v.expiresAtMs <= nowMs) {
      l1.delete(k);
      n++;
    }
  }
  return n;
}

/**
 * Reaper: delete expired `ApiCache` rows. Nothing deletes them on the read path
 * (getCached ignores but keeps them), so without this sweep a long-lived
 * deployment accumulates dead rows and superseded config/revision namespaces.
 * There is no in-process auto-run; the production cadence is a cron running
 * `scripts/reap-cache.ts` (npm `reap:cache`) — see docs/SELFHOST.md.
 *
 * RACE SAFETY (the whole point of the atomic form): the expiry predicate lives
 * INSIDE the DELETE statement, never a select-ids-then-
 * delete-by-id pattern. `setCached` upserts a fresh `expiresAt` in place
 * (getCached/setCached above), so a select-then-delete could erase a row another
 * caller just refreshed to a future expiry. Here the DELETE re-evaluates
 * `expiresAt <= now` at execution under PostgreSQL's snapshot + EvalPlanQual, so a
 * concurrently-refreshed row (now future-dated) is not removed. This safety is by
 * SQL construction (the predicate is IN the DELETE); the tests
 * (`api-cache-reaper.integration.test.ts`) prove predicate correctness and the
 * upsert-either-ordering property, not the microsecond select↔delete interleaving
 * (single-process Promise.all cannot force it) — so the guarantee rests on the
 * statement shape, argued not exhaustively unit-proven. Bounded batches keep the
 * lock footprint small on a large table; each batch is its own atomic conditional
 * delete, so the loop is safe to interrupt/retry and idempotent for concurrent reapers.
 *
 * Best-effort: a DB error is swallowed (like the cache itself) and the count so far
 * returned — the reaper is an optimisation, never a hard dependency.
 */
export async function deleteExpired(opts?: {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}): Promise<{ deleted: number; l1Purged: number; errored: boolean; error?: string }> {
  const now = opts?.now ?? new Date();
  const batchSize = Math.max(1, opts?.batchSize ?? 1000);
  const maxBatches = Math.max(1, opts?.maxBatches ?? 10_000);
  let deleted = 0;
  let errored = false;
  let error: string | undefined;
  try {
    for (let i = 0; i < maxBatches; i++) {
      // Atomic conditional bounded delete: the inner select bounds the batch; the
      // OUTER `"expiresAt" <= now` re-checks the predicate at delete time so a
      // row refreshed between the select and the delete is NOT removed.
      const n = await db().$executeRaw`
        DELETE FROM "ApiCache"
        WHERE "cacheKey" IN (
          SELECT "cacheKey" FROM "ApiCache"
          WHERE "expiresAt" <= ${now}
          ORDER BY "expiresAt" ASC
          LIMIT ${batchSize}
        ) AND "expiresAt" <= ${now}`;
      deleted += n;
      if (n < batchSize) break;
    }
  } catch (err) {
    // Best-effort like the cache itself (a serving path calling this must not
    // throw), but the failure is SURFACED so an operational caller (the reap
    // cron) can exit non-zero instead of reporting a silent, misleading success.
    warnCacheFailure("write", err);
    errored = true;
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  const l1Purged = purgeExpiredL1(now.getTime());
  return { deleted, l1Purged, errored, ...(error ? { error } : {}) };
}
