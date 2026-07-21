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
 * Node process avoid a DB round-trip (Railway single-instance friendly). L1 is
 * best-effort and bounded; multi-instance deployments still share via Postgres.
 */

/**
 * Read a cached response. A row is a HIT only while it has not expired
 * (`expiresAt > now`); exactly at or after `expiresAt` it is a miss.
 *
 * Expired rows are intentionally NOT deleted here: cleanup is a separate sweep
 * keyed on the `expiresAt` index. Keeping this a pure read avoids a race where
 * a concurrent `setCached` writes a fresh value between another caller's read
 * and delete, and that fresh value gets erased.
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
